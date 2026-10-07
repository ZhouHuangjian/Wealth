"""Synthetic standard fund files reconcile evidence without inventing cash or NAV."""

import csv
import io
import json
from datetime import date
from decimal import Decimal as D
from uuid import uuid4

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client
from openpyxl import Workbook
from test_dca_automation_v264 import book as shared_book
from test_dca_automation_v264 import plan, quote
from wealth.common import DomainError, tenant_context
from wealth.dca_automation import run_plan
from wealth.fund_orders import detail, save_order
from wealth.fund_reconciliation import (
    apply,
    batch_preview,
    event_evidence,
    preview,
    settings,
)
from wealth.imports import create_batch, reverse_batch
from wealth.ledger import balance, position, post_event
from wealth.models import (
    Audit,
    Event,
    EvidenceLink,
    Occurrence,
    Price,
    Resource,
    SourceFact,
)

book = shared_book
pytestmark = pytest.mark.django_db
FIELDS = [
    "code",
    "payment_date",
    "confirmation_date",
    "amount",
    "quantity",
    "nav",
    "fee",
    "external_id",
]


def estimated(book, amount="10"):
    if not Price.objects.filter(tenant=book.space).exists():
        quote(book)
    value = save_order(
        book.space,
        book.user,
        {
            "instrument_id": str(book.instrument.pk),
            "account_id": str(book.holding.pk),
            "cash_account_id": str(book.source.pk),
            "application_date": "2026-09-23",
            "amount": amount,
            "status": "paid",
            "auto_estimate": True,
            "fee_mode": "zero",
        },
    )
    return Resource.objects.get(pk=value["id"])


def statement(book, rows=None, filename="actual.csv", xlsx=False, **body):
    if rows is None:
        rows = [
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "10",
                "5.56",
                "1.7987",
                "0",
                "order-A",
            ]
        ]
    if xlsx:
        wb = Workbook()
        wb.active.append(FIELDS)
        for row in rows:
            wb.active.append(row)
        stream = io.BytesIO()
        wb.save(stream)
        content = stream.getvalue()
        filename = "actual.xlsx"
    else:
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(FIELDS)
        writer.writerows(rows)
        content = stream.getvalue().encode()
    batch = create_batch(
        book.space,
        book.user,
        SimpleUploadedFile(filename, content),
        "standard_fund",
        book.holding.pk,
    )
    result = preview(
        book.space,
        book.user,
        batch,
        {"account_id": str(book.holding.pk), "save_mapping": True, **body},
    )
    return batch, result


def command(p, **extra):
    return {
        key: p[key] for key in ("preview_version", "ledger_revision", "preview_hash")
    } | extra


def test_exact_unique_confirmation_links_actual_evidence_without_money_or_public_nav(
    book,
):
    order = estimated(book)
    batch, p = statement(book)
    assert p["rows"][0]["status"] == "exact_match"
    before = Event.objects.count(), Price.objects.count()
    result = apply(book.space, book.user, batch, command(p))
    assert result["linked"] == 1
    assert (Event.objects.count(), Price.objects.count()) == before
    assert balance(book.space, book.source) == D(90)
    assert position(book.space, book.holding, book.instrument) == (D("5.56"), D(10))
    event = Event.objects.get(pk=order.data["confirmation_event_id"])
    assert (
        event.payload["automatic_estimate"] is True
    )  # Immutable historical source remains intact.
    assert event_evidence(book.space, event)["status"] == "institution_confirmed"
    assert detail(order)["status"] == "confirmed"
    assert settings(book.space, book.holding.pk)["mapping"]["quantity"] == "quantity"
    reverse_batch(book.space, book.user, batch, "撤销错误来源关联")
    assert event_evidence(book.space, event)["basis"] == "estimated"
    assert Event.objects.count() == before[0]
    assert balance(book.space, book.source) == D(90)


def test_strong_order_identity_across_files_is_duplicate_not_new_debit(book):
    estimated(book)
    batch, p = statement(book)
    apply(book.space, book.user, batch, command(p))
    # Extra unrelated trailing column changes file digest, not source facts.
    content = b"code,payment_date,confirmation_date,amount,quantity,nav,fee,external_id,unused\n020602,2026-09-23,2026-09-24,10.00,5.560,1.798700,0.00,order-A,note\n"
    other = create_batch(
        book.space,
        book.user,
        SimpleUploadedFile("second.csv", content),
        "standard_fund",
        book.holding.pk,
    )
    p = preview(book.space, book.user, other, {"account_id": str(book.holding.pk)})
    assert p["rows"][0]["status"] == "duplicate"
    apply(book.space, book.user, other, command(p))
    assert SourceFact.objects.count() == 1
    assert Event.objects.filter(kind="fund_debit").count() == 1
    reverse_batch(book.space, book.user, batch, "取消一份文件")
    confirm = Event.objects.get(kind="fund_confirm")
    assert event_evidence(book.space, confirm)["basis"] == "actual"


def test_same_day_amount_only_is_candidate_and_never_automatic_match(book):
    estimated(book)
    batch, p = statement(
        book, rows=[["020602", "2026-09-23", "", "10", "", "", "", "order-B"]]
    )
    row = p["rows"][0]
    assert row["status"] == "review" and row["missing_fields"]
    assert row["candidates"][0]["link_allowed"] is True
    assert row["candidates"][0]["exact"] is False
    assert row["suggested_action"] is None
    result = apply(book.space, book.user, batch, command(p))
    assert result["linked"] == 0 and not EvidenceLink.objects.exists()
    fresh = batch_preview(book.space, batch)
    apply(
        book.space,
        book.user,
        batch,
        command(
            fresh,
            decisions=[
                {
                    "row_id": row["id"],
                    "action": "link",
                    "debit_event_id": row["candidates"][0]["debit_event_id"],
                }
            ],
        ),
    )
    assert (
        event_evidence(book.space, Event.objects.get(kind="fund_debit"))["basis"]
        == "actual"
    )
    assert (
        event_evidence(book.space, Event.objects.get(kind="fund_confirm"))["basis"]
        == "estimated"
    )


def test_two_identical_plan_purchases_require_explicit_choice(book):
    estimated(book)
    estimated(book)
    batch, p = statement(book)
    assert p["rows"][0]["status"] == "review"
    assert len(p["rows"][0]["candidates"]) == 2
    apply(book.space, book.user, batch, command(p))
    assert not EvidenceLink.objects.exists()
    fresh = batch_preview(book.space, batch)
    row = fresh["rows"][0]
    apply(
        book.space,
        book.user,
        batch,
        command(
            fresh,
            decisions=[
                {
                    "row_id": row["id"],
                    "action": "link",
                    "debit_event_id": row["candidates"][1]["debit_event_id"],
                }
            ],
        ),
    )
    assert balance(book.space, book.source) == D(80)


def test_different_order_ids_cannot_merge_same_exact_financial_facts(book):
    estimated(book)
    batch, p = statement(book)
    apply(book.space, book.user, batch, command(p))
    other, p = statement(
        book,
        rows=[
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "10",
                "5.56",
                "1.7987",
                "0",
                "order-B",
            ]
        ],
    )
    assert p["rows"][0]["status"] == "review"
    row = p["rows"][0]
    assert row["candidates"][0]["link_allowed"] is False
    with pytest.raises(DomainError, match="另一来源订单号"):
        apply(
            book.space,
            book.user,
            other,
            command(
                p,
                decisions=[
                    {
                        "row_id": row["id"],
                        "action": "link",
                        "debit_event_id": row["candidates"][0]["debit_event_id"],
                    }
                ],
            ),
        )
    assert Event.objects.filter(kind="fund_debit").count() == 1


def test_two_file_rows_for_one_candidate_are_review_not_silent_dedup(book):
    estimated(book)
    rows = [
        ["020602", "2026-09-23", "2026-09-24", "10", "5.56", "1.7987", "0", ""],
        ["020602", "2026-09-23", "2026-09-24", "10", "5.56", "1.7987", "0", ""],
    ]
    batch, p = statement(book, rows=rows)
    assert [r["status"] for r in p["rows"]] == ["review", "review"]
    assert apply(book.space, book.user, batch, command(p))["linked"] == 0


def test_correction_reverses_latest_estimate_and_retains_auditable_replacement(book):
    order = estimated(book)
    old = Event.objects.get(pk=order.data["confirmation_event_id"])
    batch, p = statement(
        book,
        rows=[["020602", "2026-09-23", "2026-09-24", "10", "5", "2", "0", "actual-2"]],
    )
    row = p["rows"][0]
    assert row["candidates"][0]["link_allowed"] is False
    assert row["status"] == "review" and row["candidates"][0]["correction_allowed"]
    result = apply(
        book.space,
        book.user,
        batch,
        command(
            p,
            decisions=[
                {"row_id": row["id"], "action": "correct", "reason": "以机构确认单为准"}
            ],
        ),
    )
    assert result["corrected"] == 1
    assert Event.objects.filter(reverses=old).count() == 1
    assert Event.objects.get(pk=old.pk).payload == old.payload
    assert Resource.objects.filter(kind="fund_statement_corrections").count() == 1
    assert Audit.objects.filter(action="import.fund_event_corrected").exists()
    assert balance(book.space, book.source) == D(90)
    assert position(book.space, book.holding, book.instrument) == (D(5), D(10))
    order.refresh_from_db()
    assert order.data["status"] == "confirmed"
    assert Price.objects.filter(kind="official_nav").count() == 1
    with pytest.raises(DomainError, match="资金事实"):
        reverse_batch(book.space, book.user, batch, "撤销文件不应抹掉更正")


def test_actual_amount_correction_adjusts_cash_only_by_difference_and_dca_scans_once(
    book,
):
    quote(book)
    pplan = plan(book)
    run_plan(book.space, book.user, pplan.pk)
    batch, p = statement(
        book,
        rows=[
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "20",
                "10",
                "2",
                "0",
                "actual-amount",
            ]
        ],
    )
    row = p["rows"][0]
    apply(
        book.space,
        book.user,
        batch,
        command(
            p,
            decisions=[
                {"row_id": row["id"], "action": "correct", "reason": "实际扣款为20"}
            ],
        ),
    )
    assert balance(book.space, book.source) == D(80)
    assert position(book.space, book.holding, book.instrument) == (D(10), D(20))
    before = Event.objects.count()
    run_plan(book.space, book.user, pplan.pk)
    assert Event.objects.count() == before
    occurrence = Occurrence.objects.get(plan=pplan)
    assert occurrence.details["automation"]["status"] == "already_recorded"
    assert occurrence.amount == 20


def test_later_cost_dependencies_block_correction_atomically(book):
    estimated(book)
    estimated(book, amount="20")
    batch, p = statement(
        book,
        rows=[
            ["020602", "2026-09-23", "2026-09-24", "10", "5", "2", "0", "actual-late"]
        ],
    )
    row = p["rows"][0]
    candidate = next(c for c in row["candidates"] if c["debit_amount"] == "10")
    assert not candidate["correction_allowed"]
    before = Event.objects.count()
    with pytest.raises(DomainError, match="后续|之后"):
        apply(
            book.space,
            book.user,
            batch,
            command(
                p,
                decisions=[
                    {
                        "row_id": row["id"],
                        "action": "correct",
                        "debit_event_id": candidate["debit_event_id"],
                        "reason": "修正",
                    }
                ],
            ),
        )
    assert Event.objects.count() == before


def test_stale_preview_can_refresh_without_remapping_or_changing_facts(book):
    estimated(book)
    batch, p = statement(book)
    post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(book.source.pk),
            "amount": "1",
            "economic_date": "2026-09-24",
        },
    )
    with pytest.raises(DomainError, match="已更新"):
        apply(book.space, book.user, batch, command(p))
    fresh = preview(book.space, book.user, batch, {"refresh_only": True})
    apply(book.space, book.user, batch, command(fresh))
    p = preview(book.space, book.user, batch, {"refresh_only": True})
    assert p["rows"][0]["status"] == "applied"


def test_xlsx_numeric_code_and_known_only_data_preserve_unknowns(book):
    estimated(book)
    _batch, p = statement(
        book, rows=[[20602, "2026-09-23", "", "10", "", "", "", "xlsx-1"]], xlsx=True
    )
    row = p["rows"][0]
    assert row["normalized"]["code"] == "020602"
    assert row["normalized"]["quantity"] is None and row["normalized"]["fee"] is None
    assert row["status"] == "review"
    assert not SourceFact.objects.exists()


def test_official_nav_conflict_blocks_auto_shares_but_not_actual_evidence(book):
    quote(book)
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.instrument.pk),
            "nav_quarantine": {"2026-09-23": {"status": "conflict"}},
        },
    )
    order = estimated(book)
    assert order.data["status"] == "paid" and "差异" in order.data["note"]
    assert not Event.objects.filter(kind="fund_confirm").exists()
    batch, p = statement(
        book,
        rows=[
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "10",
                "5",
                "2",
                "0",
                "direct-confirmation",
            ]
        ],
    )
    row = p["rows"][0]
    # A manually acknowledged debit is paid, even if not itself automatically guessed.
    assert row["candidates"][0]["correction_allowed"] is True
    apply(
        book.space,
        book.user,
        batch,
        command(
            p,
            decisions=[
                {
                    "row_id": row["id"],
                    "action": "correct",
                    "reason": "机构已确认，使用实际记录",
                }
            ],
        ),
    )
    assert position(book.space, book.holding, book.instrument) == (D(5), D(10))
    assert Event.objects.filter(kind="fund_debit").count() == 1
    assert Price.objects.filter(kind="official_nav").count() == 1
    assert (
        event_evidence(book.space, Event.objects.get(kind="fund_confirm"))["basis"]
        == "actual"
    )


def test_same_order_can_supplement_actual_confirmation_after_payment_only(book):
    estimated(book)
    partial, p = statement(
        book, rows=[["020602", "2026-09-23", "", "10", "", "", "", "order-step"]]
    )
    row = p["rows"][0]
    apply(
        book.space,
        book.user,
        partial,
        command(p, decisions=[{"row_id": row["id"], "action": "link"}]),
    )
    assert (
        event_evidence(book.space, Event.objects.get(kind="fund_confirm"))["basis"]
        == "estimated"
    )
    full, p = statement(
        book,
        rows=[
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "10",
                "5.56",
                "1.7987",
                "0",
                "order-step",
            ]
        ],
    )
    assert p["rows"][0]["status"] == "duplicate"
    apply(book.space, book.user, full, command(p))
    assert SourceFact.objects.count() == 1
    assert (
        event_evidence(book.space, Event.objects.get(kind="fund_confirm"))["basis"]
        == "actual"
    )
    assert balance(book.space, book.source) == D(90)


def test_same_order_added_actual_shares_can_correct_estimate_after_actual_payment(book):
    estimated(book)
    partial, p = statement(
        book,
        rows=[["020602", "2026-09-23", "", "10", "", "", "", "order-step-correct"]],
    )
    apply(
        book.space,
        book.user,
        partial,
        command(p, decisions=[{"row_id": p["rows"][0]["id"], "action": "link"}]),
    )
    full, p = statement(
        book,
        rows=[
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "10",
                "5",
                "2",
                "0",
                "order-step-correct",
            ]
        ],
    )
    row = p["rows"][0]
    assert row["status"] == "review"
    apply(
        book.space,
        book.user,
        full,
        command(
            p,
            decisions=[
                {"row_id": row["id"], "action": "correct", "reason": "新增机构确认份额"}
            ],
        ),
    )
    assert SourceFact.objects.count() == 1
    assert position(book.space, book.holding, book.instrument) == (D(5), D(10))


def test_actual_conflict_is_not_silently_overwritten_and_inconsistent_math_is_error(
    book,
):
    estimated(book)
    one, p = statement(book)
    apply(book.space, book.user, one, command(p))
    _two, p = statement(
        book,
        rows=[["020602", "2026-09-23", "2026-09-24", "10", "5", "2", "0", "order-A"]],
    )
    assert p["rows"][0]["status"] == "review" and p["rows"][0]["errors"]
    _bad, p = statement(
        book,
        rows=[["020602", "2026-09-23", "2026-09-24", "10", "50", "2", "", "bad-math"]],
    )
    assert p["rows"][0]["normalized"]["fee"] is None
    _wrong, p = statement(
        book,
        rows=[
            [
                "020602",
                "2026-09-23",
                "2026-09-24",
                "10",
                "50",
                "2",
                "0",
                "bad-math-known",
            ]
        ],
    )
    assert p["rows"][0]["status"] == "error" and "尾差" in p["rows"][0]["errors"][0]


def test_application_only_does_not_claim_actual_payment(book):
    estimated(book)
    batch, p = statement(
        book,
        rows=[["020602", "2026-09-23", "", "10", "", "", "", "application-only"]],
        mapping={
            "code": "code",
            "application_date": "payment_date",
            "amount": "amount",
            "external_id": "external_id",
        },
    )
    row = p["rows"][0]
    assert row["candidates"][0]["link_allowed"] is False
    with pytest.raises(DomainError, match="申请日期不能证明"):
        apply(
            book.space,
            book.user,
            batch,
            command(p, decisions=[{"row_id": row["id"], "action": "link"}]),
        )
    assert not EvidenceLink.objects.exists()


def test_unmatched_row_never_creates_trade_and_default_actions_ignore_it(book):
    batch, p = statement(book)
    assert p["rows"][0]["status"] == "unmatched"
    before = Event.objects.count()
    assert apply(book.space, book.user, batch, command(p))["linked"] == 0
    assert Event.objects.count() == before


def test_api_preview_apply_replay_and_viewer_or_other_tenant_denial(book):
    from django.contrib.auth import get_user_model
    from wealth.models import Account, Membership, Workspace

    estimated(book)
    batch, p = statement(book)
    client = Client()
    client.force_login(book.user)
    url = f"/api/v1/spaces/{book.space.pk}/imports/{batch.pk}/fund-apply"
    body = json.dumps(command(p))
    key = str(uuid4())
    first = client.post(
        url, body, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key
    )
    assert first.status_code == 200, first.content
    second = client.post(
        url, body, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key
    )
    assert second.json() == first.json()
    assert Event.objects.filter(kind="fund_debit").count() == 1
    viewer = get_user_model().objects.create_user("fund-viewer")
    Membership.objects.create(user=viewer, workspace=book.space, role="viewer")
    client.force_login(viewer)
    assert client.get(url.replace("fund-apply", "fund-preview")).status_code == 403
    assert (
        client.post(
            url, body, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key
        ).status_code
        == 403
    )
    outsider = get_user_model().objects.create_user("fund-outsider")
    other = Workspace.objects.create(name="another tenant")
    Membership.objects.create(user=outsider, workspace=other, role="owner")
    client.force_login(outsider)
    assert client.get(url.replace("fund-apply", "fund-preview")).status_code == 404
    with tenant_context(other.pk):
        foreign = Account.objects.create(tenant=other, name="foreign fund", kind="fund")
    client.force_login(book.user)
    resp = client.get(
        f"/api/v1/spaces/{book.space.pk}/fund-reconciliation/settings?account_id={foreign.pk}"
    )
    assert resp.status_code == 404


def test_replay_after_admin_consent_revoked_is_denied_before_cache(book):
    from django.contrib.auth import get_user_model
    from wealth.admin_access import update_access

    estimated(book)
    batch, p = statement(book)
    admin = get_user_model().objects.create_user(
        "statement-admin", is_superuser=True, is_staff=True
    )
    client = Client()
    client.force_login(admin)
    url = f"/api/v1/spaces/{book.space.pk}/imports/{batch.pk}/fund-apply"
    body = json.dumps(command(p))
    key = str(uuid4())
    assert (
        client.post(
            url, body, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key
        ).status_code
        == 403
    )
    update_access(book.user, book.space, {"enabled": True, "version": 0})
    response = client.post(
        url, body, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key
    )
    assert response.status_code == 200, response.content
    update_access(book.user, book.space, {"enabled": False, "version": 1})
    assert (
        client.post(
            url, body, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key
        ).status_code
        == 403
    )
    assert Event.objects.filter(kind="fund_debit").count() == 1


def test_actual_dca_evidence_keeps_worker_idempotent_and_clears_estimated_state(book):
    quote(book)
    pplan = plan(book)
    run_plan(book.space, book.user, pplan.pk)
    batch, p = statement(book)
    apply(book.space, book.user, batch, command(p))
    before = Event.objects.count()
    run_plan(book.space, book.user, pplan.pk)
    assert Event.objects.count() == before
    assert (
        Occurrence.objects.get(plan=pplan).details["automation"]["status"]
        == "already_recorded"
    )


def test_reconciliation_contract_upload_settings_and_pagination(book):
    estimated(book)
    client = Client()
    client.force_login(book.user)
    base = f"/api/v1/spaces/{book.space.pk}"
    content = b"code,payment_date,confirmation_date,amount,quantity,nav,fee,external_id\n020602,2026-09-23,2026-09-24,10,5.56,1.7987,0,api-1\n"
    response = client.post(
        base + "/imports",
        {
            "source": "standard_fund",
            "account_id": str(book.holding.pk),
            "file": SimpleUploadedFile("source.csv", content),
        },
    )
    assert response.status_code == 200, response.content
    url = base + "/imports/" + response.json()["id"] + "/fund-preview"
    empty = client.get(url).json()
    assert empty["rows"] == [] and empty["headers"]
    result = client.post(
        url,
        json.dumps({"account_id": str(book.holding.pk), "save_mapping": True}),
        content_type="application/json",
    )
    assert result.status_code == 200, result.content
    assert result.json()["context"]["account_id"] == str(book.holding.pk)
    page = client.get(url + "?offset=1&limit=1").json()
    assert page["count"] == 1 and page["rows"] == []
    response = client.get(
        base + "/fund-reconciliation/settings?account_id=" + str(book.holding.pk)
    )
    assert (
        response.status_code == 200
        and response.json()["mapping"]["quantity"] == "quantity"
    )


def test_position_provenance_becomes_actual_without_revaluing_holding(book):
    from wealth.reporting import positions

    estimated(book)
    before = positions(book.space, date(2026, 9, 24))[0]
    assert before["contains_automatic_estimates"]
    batch, p = statement(book)
    apply(book.space, book.user, batch, command(p))
    after = positions(book.space, date(2026, 9, 24))[0]
    assert (
        after["contains_actual_confirmations"]
        and after["actual_confirmation_count"] == 1
    )
    assert not after.get("contains_automatic_estimates", False)
    for field in ("quantity", "cost", "market_value"):
        assert after[field] == before[field]


def test_non_fund_evidence_keeps_existing_basis_without_database_queries(
    book, django_assert_num_queries
):
    opening = Event.objects.get(kind="opening")
    with django_assert_num_queries(0):
        evidence = event_evidence(book.space, opening)
    assert evidence["basis"] == "manual" and evidence["record_ids"] == []
