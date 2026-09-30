"""Minimal fund entry still preserves distinct facts, cash, lineage and retries."""

import json
from datetime import date
from decimal import Decimal as D
from uuid import uuid4

import pytest
from django.test import Client
from test_dca_automation_v264 import book as shared_book
from test_dca_automation_v264 import quote
from wealth.common import DomainError
from wealth.fund_orders import preferences, save_order, scan_orders, transition
from wealth.ledger import balance, position, post_event
from wealth.models import Event, JournalLine, Resource, ResourceRevision
from wealth.reporting import positions

book = shared_book
pytestmark = pytest.mark.django_db


def order(b, **kw):
    return save_order(
        b.space,
        b.user,
        {
            "instrument_id": str(b.instrument.pk),
            "account_id": str(b.holding.pk),
            "application_date": "2026-09-23",
            "amount": "10",
            **kw,
        },
    )


def row(b, result):
    return Resource.objects.get(tenant=b.space, pk=result["id"])


def test_application_is_not_payment_or_holding(book):
    result = order(book)
    assert result["status"] == "submitted"
    assert Event.objects.count() == 1
    assert balance(book.space, book.holding) == 0
    assert position(book.space, book.holding, book.instrument) == (D(0), D(0))


def test_untracked_funding_never_debits_bank_or_creates_income(book):
    result = order(book, status="paid", funding_source="untracked")
    assert result["status"] == "paid"
    assert balance(book.space, book.source, "cash") == 100
    assert balance(book.space, book.holding, "cash") == 0
    assert balance(book.space, book.holding, "fund_transit") == 10
    assert JournalLine.objects.filter(code="income").count() == 0
    debit = Event.objects.get(pk=result["debit_event_id"])
    assert sum(l.amount for l in debit.lines.all()) == 0
    assert debit.payload["untracked_funding"]


def test_explicit_payment_from_selected_account_and_separate_confirmation(book):
    initial = order(book, cash_account_id=str(book.source.pk))
    current = row(book, initial)
    transition(
        book.space, book.user, current, {"action": "paid", "payment_date": "2026-09-23"}
    )
    assert balance(book.space, book.source, "cash") == 90
    assert current.data["status"] == "paid"
    transition(
        book.space,
        book.user,
        current,
        {
            "action": "confirm",
            "fee_mode": "zero",
            "quantity": "5",
            "price": "2",
            "confirmation_date": "2026-09-24",
        },
    )
    assert balance(book.space, book.source, "fund_transit") == 0
    assert position(book.space, book.holding, book.instrument) == (D(5), D(10))
    assert ResourceRevision.objects.filter(resource=current).count() >= 2


def test_estimate_only_after_opt_in_exact_nav_and_fee_rule(book):
    quote(book)
    initial = order(book, status="paid", funding_source="untracked", auto_estimate=True)
    current = row(book, initial)
    assert current.data["status"] == "paid"
    assert "费用" in current.data["note"]
    transition(
        book.space,
        book.user,
        current,
        {"action": "estimate", "fee_mode": "zero", "auto_estimate": True},
    )
    assert current.data["status"] == "estimated"
    assert position(book.space, book.holding, book.instrument) == (D("5.56"), D(10))
    assert positions(book.space, date(2026, 9, 24))[0]["contains_automatic_estimates"]
    count = Event.objects.count()
    scan_orders(book.space, book.user)
    assert Event.objects.count() == count


def test_missing_nav_keeps_payment_and_last_good_data(book):
    result = order(
        book,
        status="paid",
        funding_source="untracked",
        auto_estimate=True,
        fee_mode="zero",
    )
    assert result["status"] == "paid"
    assert "净值" in result["note"]
    assert balance(book.space, book.holding, "fund_transit") == 10


def test_confirmation_failure_rolls_back_entire_new_purchase(book):
    count = Event.objects.count()
    with pytest.raises(DomainError):
        order(
            book,
            status="confirmed",
            cash_account_id=str(book.source.pk),
            fee_mode="zero",
            quantity="999",
            price="2",
            confirmation_date="2026-09-24",
        )
    assert Event.objects.count() == count
    assert Resource.objects.filter(kind="fund_orders").count() == 0
    assert balance(book.space, book.source, "cash") == 100


def test_cancel_reverses_confirmation_then_payment_preserving_history(book):
    result = order(
        book,
        status="confirmed",
        funding_source="untracked",
        fee_mode="zero",
        quantity="5",
        price="2",
        confirmation_date="2026-09-24",
    )
    current = row(book, result)
    transition(book.space, book.user, current, {"action": "cancel"})
    assert balance(book.space, book.holding) == 0
    assert position(book.space, book.holding, book.instrument) == (D(0), D(0))
    assert Event.objects.filter(kind="reversal").count() == 2
    assert current.data["status"] == "cancelled"


def test_same_day_amount_can_be_two_distinct_orders_and_defaults_persist(book):
    for _ in range(2):
        order(
            book,
            status="paid",
            funding_source="untracked",
            remember_defaults=True,
            fee_mode="rate",
            fee_value="0.12",
        )
    assert balance(book.space, book.holding, "fund_transit") == 20
    assert (
        preferences(book.space, str(book.instrument.pk), str(book.holding.pk))[
            "fee_value"
        ]
        == "0.12"
    )


def test_api_retry_idempotence_and_version(book):
    client = Client()
    client.force_login(book.user)
    path = f"/api/v1/spaces/{book.space.pk}/fund-orders"
    body = {
        "instrument_id": str(book.instrument.pk),
        "account_id": str(book.holding.pk),
        "application_date": "2026-09-23",
        "amount": "10",
        "status": "paid",
        "funding_source": "untracked",
    }
    key = str(uuid4())
    a = client.post(
        path,
        json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert a.status_code == 200, a.content
    b = client.post(
        path,
        json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    assert b.json() == a.json()
    assert balance(book.space, book.holding, "fund_transit") == 10
    result = a.json()
    bad = client.post(
        path + f"/{result['id']}/transition",
        json.dumps({"action": "cancel", "version": 0}),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    assert bad.status_code == 412


def test_public_event_cannot_spoof_untracked_flag(book):
    with pytest.raises(DomainError):
        post_event(
            book.space,
            book.user,
            {
                "kind": "fund_debit",
                "account_id": str(book.holding.pk),
                "instrument_id": str(book.instrument.pk),
                "amount": "100",
                "untracked_funding": True,
            },
        )


def test_link_untracked_source_changes_cash_not_shares_or_profit(book):
    result = order(
        book,
        status="confirmed",
        funding_source="untracked",
        fee_mode="zero",
        quantity="5",
        price="2",
        confirmation_date="2026-09-24",
    )
    current = row(book, result)
    transition(
        book.space,
        book.user,
        current,
        {"action": "associate", "cash_account_id": str(book.source.pk)},
    )
    assert balance(book.space, book.source, "cash") == 90
    assert position(book.space, book.holding, book.instrument) == (D(5), D(10))
    assert JournalLine.objects.filter(code__in=["income", "realized"]).count() == 0
    with pytest.raises(DomainError):
        transition(
            book.space,
            book.user,
            current,
            {"action": "associate", "cash_account_id": str(book.source.pk)},
        )
    transition(book.space, book.user, current, {"action": "cancel"})
    assert balance(book.space, book.source, "cash") == 100


def test_conversion_is_atomic_and_cancellable(book):
    from wealth.fund_orders import convert_fund
    from wealth.models import Instrument

    order(
        book,
        status="confirmed",
        funding_source="untracked",
        fee_mode="zero",
        quantity="5",
        price="2",
        confirmation_date="2026-09-23",
    )
    target = Instrument.objects.create(
        tenant=book.space, code="999270", name="目标基金", kind="fund"
    )
    body = {
        "instrument_id": str(book.instrument.pk),
        "account_id": str(book.holding.pk),
        "target_instrument_id": str(target.pk),
        "quantity": "2",
        "price": "3",
        "economic_date": "2026-09-24",
    }
    result = convert_fund(book.space, book.user, body)
    assert result["status"] == "paid"
    assert balance(book.space, book.holding, "cash") == 0
    assert balance(book.space, book.holding, "fund_transit") == 6
    assert position(book.space, book.holding, book.instrument) == (D(3), D(6))
    transition(book.space, book.user, row(book, result), {"action": "cancel"})
    assert position(book.space, book.holding, book.instrument) == (D(5), D(10))
    assert balance(book.space, book.holding, "fund_transit") == 0


def test_auto_dca_untracked_and_fee_rate(book):
    from test_dca_automation_v264 import plan, run

    quote(book)
    value = plan(
        book,
        account_id=str(book.holding.pk),
        automation={
            "enabled": True,
            "start_date": "2026-09-23",
            "holding_account_id": str(book.holding.pk),
            "funding_source": "untracked",
            "fee_mode": "rate",
            "fee_amount": "0.12",
        },
    )
    result = run(book, value)
    assert result["items"][0]["status"] == "recorded_estimate"
    assert balance(book.space, book.source, "cash") == 100
    assert balance(book.space, book.holding, "cash") == 0
    assert position(book.space, book.holding, book.instrument)[1] == 10


def test_balance_only_account_does_not_infer_return(book):
    from wealth.recording_coverage import coverage, save_coverage
    from wealth.reporting import performance

    book.holding.valuation_mode = "snapshot"
    book.holding.save()
    save_coverage(
        book.space,
        book.user,
        book.holding,
        {"recording_mode": "balance", "history_status": "unknown"},
    )
    assert coverage(book.space, book.holding)["recording_mode"] == "balance"
    report = performance(book.space, "2026-09-22", "2026-09-24", [book.holding.pk])
    assert report["xirr"]["rate"] is None


def test_estimated_shares_can_be_corrected_to_actual_with_history(book):
    quote(book)
    result = order(
        book,
        status="paid",
        funding_source="untracked",
        fee_mode="zero",
        auto_estimate=True,
    )
    current = row(book, result)
    transition(
        book.space,
        book.user,
        current,
        {
            "action": "verify",
            "fee_mode": "zero",
            "quantity": "5.55",
            "price": "1.8018",
            "confirmation_date": "2026-09-24",
        },
    )
    assert current.data["status"] == "confirmed"
    assert position(book.space, book.holding, book.instrument)[0] == D("5.55")
    assert Event.objects.filter(kind="reversal").count() == 1


def test_read_only_member_and_cross_space_identifiers_cannot_write(book):
    from django.contrib.auth import get_user_model
    from wealth.common import tenant_context
    from wealth.models import Account, Membership, Workspace

    viewer = get_user_model().objects.create_user("fund-viewer")
    Membership.objects.create(workspace=book.space, user=viewer, role="viewer")
    client = Client()
    client.force_login(viewer)
    path = f"/api/v1/spaces/{book.space.pk}/fund-orders"
    body = {
        "instrument_id": str(book.instrument.pk),
        "account_id": str(book.holding.pk),
        "amount": "10",
        "status": "paid",
        "funding_source": "untracked",
    }
    response = client.post(
        path,
        json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    assert response.status_code == 403
    assert balance(book.space, book.holding, "fund_transit") == 0
    other = Workspace.objects.create(name="另一个空间")
    with tenant_context(other.pk):
        foreign = Account.objects.create(
            tenant=other, name="另一空间基金账户", kind="fund"
        )
    client.force_login(book.user)
    body["account_id"] = str(foreign.pk)
    response = client.post(
        path,
        json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    assert response.status_code == 404


def test_linked_pending_keeps_transit_attribution_and_updates_cash_source(book):
    from wealth.pending_purchases import PendingPurchases

    result = order(book, status="paid", funding_source="untracked")
    current = row(book, result)
    transition(
        book.space,
        book.user,
        current,
        {"action": "associate", "cash_account_id": str(book.source.pk)},
    )
    pending = PendingPurchases(book.space, "2026-09-24").items[0]
    assert pending["funding_source"] == "account"
    assert pending["actual_funding_account_id"] == str(book.source.pk)
    assert pending["source_account_id"] == str(book.holding.pk)
    assert pending["amount"] == D(10)
    assert balance(book.space, book.holding, "fund_transit") == 10


def test_scan_adopts_manual_confirmation_without_posting_it_twice(book):
    initial = order(book, status="paid", funding_source="untracked")
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_confirm",
            "account_id": str(book.holding.pk),
            "instrument_id": str(book.instrument.pk),
            "related_event_id": initial["debit_event_id"],
            "economic_date": "2026-09-24",
            "quantity": "5",
            "price": "2",
            "fee": "0",
        },
    )
    count = Event.objects.count()
    scan_orders(book.space, book.user)
    assert row(book, initial).data["status"] == "confirmed"
    assert Event.objects.count() == count


def test_history_edit_does_not_change_existing_recording_mode(book):
    from wealth.recording_coverage import coverage, save_coverage

    book.holding.valuation_mode = "snapshot"
    book.holding.save()
    save_coverage(
        book.space,
        book.user,
        book.holding,
        {"recording_mode": "transactions", "history_status": "partial"},
    )
    save_coverage(
        book.space, book.user, book.holding, {"history_status": "complete_since_start"}
    )
    assert coverage(book.space, book.holding)["recording_mode"] == "transactions"


def test_order_pagination_keeps_separate_same_day_applications(book):
    from wealth.fund_orders import list_orders

    ids = {order(book)["id"] for _ in range(3)}
    first = list_orders(book.space, limit=2)
    second = list_orders(book.space, limit=2, offset=2)
    assert first["count"] == 3 and first["has_more"]
    assert not second["has_more"]
    assert {i["id"] for i in first["items"] + second["items"]} == ids
    with pytest.raises(DomainError):
        list_orders(book.space, offset="invalid")


def test_holdings_keep_fund_channel_for_correct_trade_form(book):
    from wealth.investment_trades import record_trade

    book.instrument.specification = {"trading_channel": "exchange"}
    book.instrument.save()
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(book.holding.pk),
            "economic_date": "2026-09-23",
            "amount": "100",
        },
    )
    record_trade(
        book.space,
        book.user,
        {
            "side": "buy",
            "account_id": str(book.holding.pk),
            "instrument_id": str(book.instrument.pk),
            "quantity": "5",
            "price": "2",
            "economic_date": "2026-09-23",
        },
    )
    assert (
        positions(book.space, "2026-09-24")[0]["specification"]["trading_channel"]
        == "exchange"
    )
