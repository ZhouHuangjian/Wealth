"""User-supplied fund figures remain evidence, never inferred money movements."""

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from wealth.common import DomainError, tenant_context
from wealth.holding_checks import save_holding_check
from wealth.holding_corrections import correct_holding
from wealth.investments import holdings_summary, profit_calendar, record_holding
from wealth.ledger import balance, post_event, reverse_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    Membership,
    Price,
    Resource,
    Workspace,
)
from wealth.portfolio import net_worth_comparison, portfolio_analysis
from wealth.reporting import overview, performance, positions

pytestmark = pytest.mark.django_db
D = Decimal
DATE = "2026-09-24"


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("holding-correction-owner")
    space = Workspace.objects.create(name="更正与核对")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, kind="fund", name="基金公司")
        bank = Account.objects.create(tenant=space, kind="bank", name="资金来源")
        instrument = Instrument.objects.create(
            tenant=space, kind="fund", name="基金", code="FUND"
        )
        yield SimpleNamespace(
            space=space,
            user=user,
            account=account,
            bank=bank,
            instrument=instrument,
            client=client,
        )


def payload(book, **extra):
    return {
        "account_id": str(book.account.pk),
        "instrument_id": str(book.instrument.pk),
        "as_of": DATE,
        "purchase_date": "2026-09-01",
        "quantity": "337.67",
        "cost": "345",
        "current_value": "361.41",
        "valuation_basis": "formal",
        "valuation_date": DATE,
        "funding_mode": "external",
        **extra,
    }


def save(book, **extra):
    return record_holding(book.space, book.user, payload(book, **extra))


def cash(book, account, amount):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "amount": amount,
            "economic_date": DATE,
        },
    )


def correct(book, item, **extra):
    book.space.refresh_from_db()
    initial = item["holding"]["correction"]["initial_values"]
    return correct_holding(
        book.space,
        book.user,
        item["event"]["id"],
        {
            **initial,
            "expected_revision": book.space.revision,
            "reason": "按原凭据核实取得成本",
            **extra,
        },
    )


def send(book, path, body, key=None):
    return book.client.post(
        f"/api/v1/spaces/{book.space.pk}{path}",
        data=json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"institution_profit": "-3.60", "reference_nav": "1.0703"},
        {"reference_nav": "1.0"},
        {
            "current_value": None,
            "current_profit": "16.41",
            "institution_profit": "-3.60",
        },
    ],
)
def test_contradictory_scope_rejects_before_any_financial_fact(book, extra):
    with pytest.raises(DomainError) as caught:
        save(book, **extra)
    assert caught.value.code == "holding_reconciliation_mismatch"
    assert not Event.objects.exists()
    assert not Resource.objects.exists()


@pytest.mark.parametrize("profit", ["16.39", "16.43"])
def test_two_cent_rounding_accepted_without_altering_cost_or_quantity(book, profit):
    result = save(book, institution_profit=profit, reference_nav="1.0703")
    assert D(result["holding"]["profit"]) == D("16.41")
    assert D(result["holding"]["quantity"]) == D("337.67")
    assert D(result["holding"]["cost"]) == D("345")
    assert not Price.objects.exists()


@pytest.mark.parametrize(
    "extra",
    [
        {"confirm_unreconciled": False, "institution_profit": "-3.60"},
        {"confirm_unreconciled": "true", "institution_profit": "-3.60"},
        {"confirm_unreconciled": True},
    ],
)
def test_pending_is_explicit_and_requires_institution_profit(book, extra):
    with pytest.raises(DomainError) as caught:
        save(book, reconciliation_mode="pending", **extra)
    assert caught.value.code == "holding_reconciliation_confirmation"
    assert not Event.objects.exists()


def test_pending_preserves_original_money_and_suppresses_only_unverified_profit(book):
    cash(book, book.account, "500")
    result = save(
        book,
        funding_mode="allocate",
        institution_profit="-3.60",
        reference_nav="1.0703",
        reconciliation_mode="pending",
        confirm_unreconciled=True,
    )
    row = result["holding"]
    assert row["profit"] is None
    assert row["cost_status"] == "unreconciled"
    assert D(row["reconciliation"]["computed_profit"]) == D("16.41")
    assert D(row["institution_profit"]) == D("-3.60")
    assert D(row["cost"]) == D("345")
    assert D(row["quantity"]) == D("337.67")
    assert balance(book.space, book.account, "cash") == D("138.59")
    assert D(overview(book.space, DATE)["net_assets"]) == D("500")
    assert overview(book.space, DATE)["gaps"]
    assert performance(book.space, DATE, DATE)["net_profit"] is None
    comparison = net_worth_comparison(book.space, DATE)
    assert D(comparison["estimated"]["known_net_assets"]) == D("500")
    assert comparison["estimated"]["gaps"]
    assert positions(book.space, DATE)[0]["unrealized_profit"] is None
    assert not Price.objects.exists()


def test_reference_estimate_is_not_allowed_to_restore_unverified_profit(book):
    item = save(book)
    save_holding_check(
        book.space,
        book.user,
        item["event"]["id"],
        {"version": 0, "institution_profit": "-3.60"},
    )
    Price.objects.create(
        tenant=book.space,
        instrument=book.instrument,
        economic_date=DATE,
        kind="estimate",
        value="1.1",
    )
    row = holdings_summary(book.space, DATE)["items"][0]
    assert D(row["estimate_value"]) == D("371.437")
    assert row["estimate_profit"] is None
    assert D(row["estimated_profit"]) == D("26.437")


def test_auto_mode_needs_a_real_comparison_baseline(book):
    with pytest.raises(DomainError) as caught:
        save(book, current_value=None, reference_nav="1.0703")
    assert caught.value.code == "holding_check_baseline_missing"
    with pytest.raises(DomainError) as caught:
        save(
            book, current_value=None, reference_nav="1.0703", institution_profit="-3.60"
        )
    assert caught.value.code == "holding_reconciliation_mismatch"


def test_check_dates_must_describe_the_same_valuation(book):
    with pytest.raises(DomainError) as caught:
        save(book, reference_nav="1.0703", reference_date="2026-09-23")
    assert caught.value.code == "holding_check_date_mismatch"


def test_correction_changes_only_initial_facts_and_keeps_allocated_cash(book):
    cash(book, book.account, "500")
    original = save(book, funding_mode="allocate")
    revised = correct(
        book, original, quantity="330", cost="350", purchase_date="2026-09-02"
    )
    assert D(revised["holding"]["quantity"]) == D("330")
    assert D(revised["holding"]["cost"]) == D("350")
    assert D(revised["holding"]["market_value"]) == D("361.41")
    assert D(revised["holding"]["profit"]) == D("11.41")
    assert balance(book.space, book.account, "cash") == D("138.59")
    assert D(overview(book.space, DATE)["net_assets"]) == D("500")
    assert Event.objects.get(
        pk=revised["correction"]["reversal_event_id"]
    ).reverses_id == uuid.UUID(original["event"]["id"])
    old = Event.objects.get(pk=original["event"]["id"])
    assert old.payload["cost"] == "345"


def test_correction_preserves_original_topup_and_its_reverse_dependency(book):
    cash(book, book.account, "100")
    cash(book, book.bank, "1000")
    original = save(book, funding_mode="allocate", funding_account_id=str(book.bank.pk))
    transfer_id = original["funding"]["transfer_event_id"]
    # The selected source can become archived after funds already moved. A
    # correction must neither reuse nor debit this account again.
    book.bank.archived = True
    book.bank.save()
    revised = correct(book, original, cost="350")
    assert revised["funding"]["transfer_event_id"] == transfer_id
    assert Event.objects.filter(kind="transfer").count() == 1
    assert balance(book.space, book.account, "cash") == 0
    assert balance(book.space, book.bank, "cash") == D("738.59")
    new_event = Event.objects.get(pk=revised["event"]["id"])
    assert str(new_event.related_id) == transfer_id
    with pytest.raises(DomainError, match="后续阶段"):
        reverse_event(
            book.space, book.user, Event.objects.get(pk=transfer_id), "不能遗失资金依赖"
        )


@pytest.mark.parametrize(
    "extra",
    [
        {"current_value": "1"},
        {"as_of": "2026-09-23"},
        {"funding_mode": "allocate"},
        {"instrument_id": str(uuid.uuid4())},
        {"valuation_basis": "estimate"},
        {"history_mode": "unchanged_holding"},
        {"valuation_date": "2026-09-23"},
    ],
)
def test_correction_locks_money_identity_and_valuation(book, extra):
    original = save(book)
    before = Event.objects.count()
    with pytest.raises(DomainError) as caught:
        correct(book, original, **extra)
    assert caught.value.code == "holding_correction_locked"
    assert Event.objects.count() == before


def test_failure_after_reversal_rolls_back_original_and_all_balances(book):
    cash(book, book.account, "500")
    original = save(book, funding_mode="allocate")
    before = Event.objects.count()
    with pytest.raises(DomainError):
        correct(book, original, quantity="0")
    assert Event.objects.count() == before
    assert not Event.objects.filter(reverses_id=original["event"]["id"]).exists()
    assert balance(book.space, book.account, "cash") == D("138.59")
    assert D(holdings_summary(book.space, DATE)["items"][0]["cost"]) == D("345")


def test_unknown_original_value_and_later_trades_are_ineligible(book):
    original = save(book, current_value=None)
    assert original["holding"]["correction"]["eligible"] is False
    assert original["holding"]["reconciliation_eligibility"]["eligible"] is True
    post_event(
        book.space,
        book.user,
        {
            "kind": "split",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "economic_date": "2026-09-25",
            "ratio": "2",
        },
    )
    row = holdings_summary(book.space, "2026-09-25")["items"][0]
    assert row["correction"]["eligible"] is False


def test_previous_unresolved_evidence_cannot_be_erased_with_null_fields(book):
    original = save(book)
    save_holding_check(
        book.space,
        book.user,
        original["event"]["id"],
        {"version": 0, "institution_profit": "-3.60", "reference_nav": "1.0703"},
    )
    before = Event.objects.count()
    with pytest.raises(DomainError) as caught:
        correct(book, original, cost="345", institution_profit=None, reference_nav=None)
    assert caught.value.code == "holding_reconciliation_mismatch"
    assert Event.objects.count() == before
    assert holdings_summary(book.space, DATE)["items"][0]["profit"] is None


def test_verified_cost_correction_rechecks_and_resolves_old_evidence(book):
    original = save(book)
    save_holding_check(
        book.space,
        book.user,
        original["event"]["id"],
        {"version": 0, "institution_profit": "-3.60", "reference_nav": "1.0703"},
    )
    # Explicit user input from verified evidence, never inferred by the system.
    revised = correct(book, original, cost="365.01")
    assert D(revised["holding"]["profit"]) == D("-3.60")
    assert D(revised["holding"]["market_value"]) == D("361.41")
    assert revised["holding"].get("cost_status") == "known"
    assert Resource.objects.filter(kind="holding_checks").count() == 1


def test_version_protected_idempotent_correction_api(book):
    original = save(book)
    body = {
        **original["holding"]["correction"]["initial_values"],
        "cost": "350",
        "expected_revision": book.space.revision,
        "reason": "按凭据更正",
    }
    url = f"/holdings/{original['event']['id']}/correct"
    stale = send(book, url, {**body, "expected_revision": 0})
    assert stale.status_code == 412
    key = str(uuid.uuid4())
    first = send(book, url, body, key)
    assert first.status_code == 200, first.content
    count = Event.objects.count()
    again = send(book, url, body, key)
    assert again.status_code == 200, again.content
    assert first.json() == again.json()
    assert Event.objects.count() == count


def test_check_api_and_viewer_cannot_write_corrections(book):
    original = save(book)
    response = send(
        book,
        f"/holdings/{original['event']['id']}/check",
        {"version": 0, "institution_profit": "-3.60"},
    )
    assert response.status_code == 200, response.content
    Membership.objects.filter(workspace=book.space, user=book.user).update(
        role="viewer"
    )
    response = send(
        book,
        f"/holdings/{original['event']['id']}/correct",
        {"expected_revision": book.space.revision, "reason": "无写权限"},
    )
    assert response.status_code == 403


def test_only_affected_fund_calendar_days_are_unavailable(book):
    save(
        book,
        reconciliation_mode="pending",
        confirm_unreconciled=True,
        institution_profit="-3.60",
    )
    clean = Instrument.objects.create(
        tenant=book.space, kind="fund", name="已核对基金", code="CLEAN"
    )
    save(
        book, instrument_id=str(clean.pk), quantity="10", cost="10", current_value="10"
    )
    for instrument in [clean, book.instrument]:
        for when, value in [(DATE, "1"), ("2026-09-25", "1.1")]:
            Price.objects.create(
                tenant=book.space,
                instrument=instrument,
                economic_date=when,
                kind="official_nav",
                value=value,
            )
    calendar = profit_calendar(
        book.space, start="2026-09-25", end="2026-09-25", selected_day="2026-09-25"
    )
    items = calendar["details"]
    indexed = {row["instrument_id"]: row for row in items}
    assert indexed[str(book.instrument.pk)]["amount"] is None
    assert indexed[str(clean.pk)]["status"] == "confirmed"
    assert D(indexed[str(clean.pk)]["amount"]) == D("1")
    analysis = portfolio_analysis(book.space, "2026-09-25")
    assert analysis["gaps"]


def test_unreconciled_historical_reconstruction_cannot_claim_confirmed_returns(book):
    save(
        book,
        history_mode="unchanged_holding",
        purchase_date="2026-09-01",
        reconciliation_mode="pending",
        confirm_unreconciled=True,
        institution_profit="-3.60",
    )
    for when, value in [("2026-09-01", "1"), ("2026-09-02", "1.1")]:
        Price.objects.create(
            tenant=book.space,
            instrument=book.instrument,
            economic_date=when,
            kind="official_nav",
            value=value,
        )
    calendar = profit_calendar(
        book.space, start="2026-09-01", end="2026-09-02", selected_day="2026-09-02"
    )
    assert calendar["details"][0]["status"] == "unavailable"
    assert calendar["details"][0]["amount"] is None
    assert all(row["amount"] is None for row in calendar["days"])


def test_generic_event_correction_cannot_refund_an_allocated_holding(book):
    cash(book, book.account, "500")
    item = save(book, funding_mode="allocate")
    event = Event.objects.get(pk=item["event"]["id"])
    replacement = {
        key: value
        for key, value in event.payload.items()
        if key not in {"funding_mode", "funding_amount"}
    }
    before = Event.objects.count()
    response = send(
        book,
        f"/events/{event.pk}/correct",
        {"replacement": replacement, "reason": "尝试旧入口"},
    )
    assert response.status_code == 422, response.content
    assert response.json()["code"] == "holding_correction_required"
    assert Event.objects.count() == before
    assert balance(book.space, book.account, "cash") == D("138.59")


def test_home_valuation_has_amount_but_explicitly_marks_unreconciled_profit(book):
    from wealth.market_sync import valuation_summary

    save(
        book,
        reconciliation_mode="pending",
        confirm_unreconciled=True,
        institution_profit="-3.60",
    )
    row = valuation_summary(book.space)["items"][0]
    assert D(row["display_value"]) == D("361.41")
    assert row["display_profit"] is None
    assert row["status"] == "needs_reconciliation"
    assert row["unreconciled_count"] == 1


def test_explicit_pending_scope_is_not_auto_resolved_by_matching_arithmetic(book):
    row = save(
        book,
        reconciliation_mode="pending",
        confirm_unreconciled=True,
        institution_profit="16.41",
    )["holding"]
    assert row["profit"] is None
    assert row["reconciliation"]["status"] == "unresolved"


def test_correction_does_not_silently_confirm_previously_unknown_scope(book):
    original = save(
        book,
        reconciliation_mode="pending",
        confirm_unreconciled=True,
        institution_profit="-3.60",
    )
    revised = correct(book, original, cost="365.01")
    assert revised["holding"]["profit"] is None
    check = revised["holding"]["reconciliation"]
    assert check["scope_unconfirmed"] is True
    assert D(check["computed_profit"]) == D("-3.60")
