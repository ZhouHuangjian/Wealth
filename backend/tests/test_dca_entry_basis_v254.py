"""Preview-approved imports retain their evidence source without relaxing money rules."""

import io
import json
import uuid
import zipfile
from decimal import Decimal

import pytest
from test_dca_import_v253 import body, confirmed, facts, period, send, submit
from test_dca_import_v253 import (
    book as book,  # noqa: PLC0414 -- pytest fixture registration
)
from wealth.common import DomainError
from wealth.dca_import import KIND, commit_import, import_status, validate_import
from wealth.investments import holdings_summary
from wealth.ledger import balance, position, post_event, reverse_event
from wealth.models import (
    Audit,
    Event,
    Membership,
    Occurrence,
    Resource,
    ResourceRevision,
)
from wealth.reporting import overview, positions

pytestmark = pytest.mark.django_db
D = Decimal


def prepared(book, rows, **flags):
    data = body(book, rows)
    checked = validate_import(book.space, book.plan.pk, data)
    assert checked["ready"], checked
    return {
        **data,
        "expected_revision": checked["data_revision"],
        "expected_plan_version": checked["plan_version"],
        "validation_digest": checked["validation_digest"],
        **flags,
    }


def preview_submit(book, rows, **flags):
    return commit_import(
        book.space,
        book.user,
        book.plan.pk,
        prepared(book, rows, confirm_preview_entries=True, **flags),
    )


def test_preview_import_persists_stage_source_audit_and_holding_without_changing_math(
    book,
):
    row = confirmed(book, entry_basis="preview_confirmed")
    before = facts(book)
    checked = validate_import(book.space, book.plan.pk, body(book, [row]))
    assert checked["ready"] and facts(book) == before
    assert checked["rows"][0]["normalized"]["entry_basis"] == "preview_confirmed"
    result = preview_submit(book, [row])
    saved = result["items"][0]["period"]
    assert saved["entry_basis"] == saved["debit_entry_basis"] == "preview_confirmed"
    assert saved["confirmation_entry_basis"] == "preview_confirmed"
    assert saved["contains_preview_entries"] is True
    for key in ("debit_event_id", "confirmation_event_id"):
        event = Event.objects.get(pk=saved[key])
        assert event.payload["entry_basis"] == "preview_confirmed"
        assert "按预览补录" in event.payload["description"]
    resource = Resource.objects.get(pk=saved["id"])
    assert resource.data["entry_basis"] == "preview_confirmed"
    assert (
        ResourceRevision.objects.get(resource=resource).data["entry_basis"]
        == "preview_confirmed"
    )
    trace = Audit.objects.get(action="dca.period_imported", object_id=saved["id"])
    assert trace.detail["debit_entry_basis"] == "preview_confirmed"
    assert trace.detail["confirmation_entry_basis"] == "preview_confirmed"
    assert (
        Occurrence.objects.get(plan=book.plan).details["dca_entry_basis"]
        == "preview_confirmed"
    )
    assert import_status(book.space, book.plan.pk)["items"][0] == saved
    holding = holdings_summary(book.space, "2026-09-24")["items"][0]
    assert holding["contains_preview_entries"] is True
    assert holding["entry_basis"] == "preview_confirmed"
    assert holding["price_kind"] == "official_nav"
    assert balance(book.space, book.bank, "cash") == 990
    assert balance(book.space, book.bank, "fund_transit") == 0
    assert position(book.space, book.fund, book.instrument) == (D(5), D(10))
    assert D(overview(book.space, "2026-09-24")["net_assets"]) == 1015


@pytest.mark.parametrize("flag", [None, False, "true", 1])
def test_preview_requires_literal_overall_confirmation_even_with_actual_flag(
    book, flag
):
    data = prepared(
        book,
        [confirmed(book, entry_basis="preview_confirmed")],
        confirm_actual_records=True,
    )
    if flag is not None:
        data["confirm_preview_entries"] = flag
    before = facts(book)
    with pytest.raises(DomainError) as caught:
        commit_import(book.space, book.user, book.plan.pk, data)
    assert caught.value.code == "preview_confirmation_required"
    assert facts(book) == before


def test_mixed_batch_needs_both_explicit_confirmation_modes(book):
    rows = [period(book, entry_basis="preview_confirmed"), period(book, "2026-09-22")]
    before = facts(book)
    with pytest.raises(DomainError) as caught:
        preview_submit(book, rows)
    assert caught.value.code == "actual_confirmation_required"
    assert facts(book) == before
    result = preview_submit(book, rows, confirm_actual_records=True)
    assert result["summary"]["new_debits"] == 2
    assert {item["period"]["entry_basis"] for item in result["items"]} == {
        "institution",
        "preview_confirmed",
    }


@pytest.mark.parametrize("basis", ["other", "mixed", None, True, [], {}])
def test_unknown_or_non_string_basis_is_rejected(book, basis):
    checked = validate_import(
        book.space, book.plan.pk, body(book, [period(book, entry_basis=basis)])
    )
    assert not checked["ready"]
    assert checked["rows"][0]["errors"][0]["code"] == "dca_entry_basis"


@pytest.mark.parametrize(
    "start_basis,end_basis",
    [("preview_confirmed", "institution"), ("institution", "preview_confirmed")],
)
def test_pending_resumption_retains_both_stage_sources_and_never_redebits(
    book, start_basis, end_basis
):
    first = preview_submit(
        book, [period(book, entry_basis=start_basis)], confirm_actual_records=True
    )
    debit_id = first["items"][0]["period"]["debit_event_id"]
    second = preview_submit(
        book, [confirmed(book, entry_basis=end_basis)], confirm_actual_records=True
    )
    saved = second["items"][0]["period"]
    assert saved["debit_event_id"] == debit_id
    assert saved["debit_entry_basis"] == start_basis
    assert saved["confirmation_entry_basis"] == saved["entry_basis"] == end_basis
    assert saved["contains_preview_entries"] is True
    assert Event.objects.get(pk=debit_id).payload["entry_basis"] == start_basis
    assert balance(book.space, book.bank, "cash") == 990
    assert Event.objects.filter(kind="fund_debit").count() == 1
    holding = positions(book.space, "2026-09-24")[0]
    assert holding["entry_basis"] == "mixed" and holding["contains_preview_entries"]
    before = facts(book)
    duplicate = preview_submit(
        book, [confirmed(book, entry_basis=end_basis)], confirm_actual_records=True
    )
    assert duplicate["summary"]["skipped"] == 1 and facts(book) == before


@pytest.mark.parametrize("status", ["confirmed", "debited"])
def test_existing_stage_cannot_be_relabelled_institution_to_hide_preview(book, status):
    row = (
        confirmed(book, entry_basis="preview_confirmed")
        if status == "confirmed"
        else period(book, entry_basis="preview_confirmed")
    )
    preview_submit(book, [row])
    before = facts(book)
    checked = validate_import(
        book.space, book.plan.pk, body(book, [{**row, "entry_basis": "institution"}])
    )
    assert not checked["ready"]
    assert checked["rows"][0]["errors"][0]["code"] == "dca_entry_basis_conflict"
    assert facts(book) == before


def test_legacy_no_basis_record_read_and_retry_is_institution_without_rewrite(
    book, monkeypatch
):
    import wealth.dca_import as module

    original_post = module.post_event

    def legacy_post(space, user, body, **kwargs):
        payload = dict(body)
        payload.pop("entry_basis", None)
        payload.pop("debit_entry_basis", None)
        return original_post(space, user, payload, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(module, "post_event", legacy_post)
        first = submit(book, [confirmed(book)])["items"][0]["period"]
    # Simulate the deployed 2.5.3 shape; defaults are read-time only.
    resource = Resource.objects.get(pk=first["id"])
    for key in ("entry_basis", "debit_entry_basis", "confirmation_entry_basis"):
        resource.data.pop(key, None)
    resource.save()
    before = facts(book)
    old = import_status(book.space, book.plan.pk)["items"][0]
    assert (
        old["entry_basis"]
        == old["debit_entry_basis"]
        == old["confirmation_entry_basis"]
        == "institution"
    )
    assert old["contains_preview_entries"] is False
    assert submit(book, [confirmed(book)])["summary"]["skipped"] == 1
    assert facts(book) == before
    holding = positions(book.space, "2026-09-24")[0]
    assert holding["contains_preview_entries"] is False and "entry_basis" not in holding


def test_basis_is_in_validation_digest_and_event_registry_identity(book):
    data = prepared(
        book, [period(book)], confirm_actual_records=True, confirm_preview_entries=True
    )
    data["rows"][0]["entry_basis"] = "preview_confirmed"
    with pytest.raises(DomainError) as caught:
        commit_import(book.space, book.user, book.plan.pk, data)
    assert caught.value.code == "version_conflict"
    saved = preview_submit(book, [period(book, entry_basis="preview_confirmed")])[
        "items"
    ][0]["period"]
    resource = Resource.objects.get(pk=saved["id"])
    resource.data.update(entry_basis="institution", debit_entry_basis="institution")
    resource.save()
    checked = validate_import(book.space, book.plan.pk, body(book, [confirmed(book)]))
    assert not checked["ready"]
    assert any(
        error["code"] == "dca_registry_conflict" for error in checked["blockers"]
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"quantity": None},
        {"nav": None},
        {"fee": None},
        {"confirmation_date": None},
        {"confirmation_date": "2099-01-01"},
        {"debit_date": None},
    ],
)
def test_preview_confirmation_never_fills_missing_financial_facts(book, extra):
    checked = validate_import(
        book.space,
        book.plan.pk,
        body(book, [confirmed(book, entry_basis="preview_confirmed", **extra)]),
    )
    assert not checked["ready"]
    assert not Event.objects.filter(kind__in=["fund_debit", "fund_confirm"]).exists()


def test_overall_preview_confirmation_accepts_explicit_bounded_tail_without_fee_fabrication(
    book,
):
    row = confirmed(
        book,
        entry_basis="preview_confirmed",
        quantity="9.09",
        nav="1.1",
        rounding_adjustment="0.001",
        rounding_confirmed=True,
    )
    saved = preview_submit(book, [row])["items"][0]["period"]
    event = Event.objects.get(pk=saved["confirmation_event_id"])
    assert D(event.payload["fee"]) == 0
    assert D(event.payload["rounding_adjustment"]) == D("0.001")
    assert position(book.space, book.fund, book.instrument) == (D("9.09"), D(10))
    assert balance(book.space, book.bank, "cash") == 990


def test_preview_basis_does_not_bypass_funding_or_before_opening(book):
    for row, code in [
        (
            period(book, entry_basis="preview_confirmed", amount="1001"),
            "insufficient_source_cash",
        ),
        (
            period(book, entry_basis="preview_confirmed", debit_date="2026-07-31"),
            "before_opening",
        ),
    ]:
        checked = validate_import(book.space, book.plan.pk, body(book, [row]))
        assert not checked["ready"]
        assert checked["rows"][0]["errors"][0]["code"] == code


def test_marker_obeys_query_date_and_disappears_after_reversal(book):
    saved = preview_submit(book, [confirmed(book, entry_basis="preview_confirmed")])[
        "items"
    ][0]["period"]
    assert positions(book.space, "2026-09-22") == []
    assert positions(book.space, "2026-09-23")[0]["contains_preview_entries"] is True
    confirmation = Event.objects.get(pk=saved["confirmation_event_id"])
    reverse_event(book.space, book.user, confirmation, "撤销合成预览份额")
    assert positions(book.space, "2026-09-24") == []
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(book.fund.pk),
            "instrument_id": str(book.instrument.pk),
            "quantity": "5",
            "cost": "10",
            "economic_date": "2026-09-24",
        },
    )
    assert positions(book.space, "2026-09-24")[0]["contains_preview_entries"] is False


def test_preview_export_keeps_original_event_resource_and_audit_source(book):
    saved = preview_submit(book, [confirmed(book, entry_basis="preview_confirmed")])[
        "items"
    ][0]["period"]
    response = book.client.post(
        f"/api/v1/spaces/{book.space.pk}/exports",
        data="{}",
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 200, response.content
    download = book.client.get(response.json()["download_url"])
    with zipfile.ZipFile(io.BytesIO(b"".join(download.streaming_content))) as archive:
        tables = json.loads(archive.read("wealth.json"))["tables"]
    assert (
        next(row for row in tables["Resource"] if row["id"] == saved["id"])["data"][
            "entry_basis"
        ]
        == "preview_confirmed"
    )
    assert (
        next(
            row
            for row in tables["Event"]
            if row["id"] == saved["confirmation_event_id"]
        )["payload"]["entry_basis"]
        == "preview_confirmed"
    )
    assert (
        next(row for row in tables["Audit"] if row["action"] == "dca.period_imported")[
            "detail"
        ]["entry_basis"]
        == "preview_confirmed"
    )


def test_preview_overall_confirmation_cannot_bypass_viewer_role(book):
    data = prepared(
        book,
        [confirmed(book, entry_basis="preview_confirmed")],
        confirm_preview_entries=True,
    )
    Membership.objects.filter(workspace=book.space, user=book.user).update(
        role="viewer"
    )
    before = facts(book)
    assert send(book, "validate", data).status_code == 200
    assert facts(book) == before
    assert send(book, "commit", data, str(uuid.uuid4())).status_code == 403
    assert not Resource.objects.filter(kind=KIND).exists()


@pytest.mark.parametrize("value", [[], {}, "preview_confirmed"])
def test_generic_event_payload_cannot_spoof_import_provenance_or_crash_positions(
    book, value
):
    debit = post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.bank.pk),
            "instrument_id": str(book.instrument.pk),
            "economic_date": "2026-09-21",
            "amount": "10",
        },
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_confirm",
            "account_id": str(book.fund.pk),
            "instrument_id": str(book.instrument.pk),
            "economic_date": "2026-09-23",
            "related_event_id": str(debit.pk),
            "quantity": "5",
            "price": "2",
            "fee": "0",
            "entry_basis": value,
            "debit_entry_basis": value,
            "dca_import_plan_id": str(book.plan.pk),
            "dca_import_date": "2026-09-21",
        },
    )
    assert positions(book.space, "2026-09-24")[0]["contains_preview_entries"] is False
