"""Pending subscriptions are existing transit money, never shares or profits."""

from datetime import date
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext
from wealth.common import tenant_context
from wealth.investments import holdings_summary
from wealth.ledger import post_event, reverse_event
from wealth.models import (
    Account,
    Event,
    FxRate,
    Instrument,
    JournalLine,
    Membership,
    Occurrence,
    Price,
    Resource,
    Workspace,
)
from wealth.pending_purchases import PendingPurchases
from wealth.portfolio import net_worth_comparison, portfolio_analysis
from wealth.reporting import overview

pytestmark = pytest.mark.django_db
WHEN = date(2026, 9, 24)


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("pending-purchases")
    space = Workspace.objects.create(name="待确认回归")
    Membership.objects.create(workspace=space, user=user, role="owner")
    client = Client()
    client.force_login(user)
    with tenant_context(space.pk):
        source = Account.objects.create(tenant=space, name="付款银行", kind="bank")
        target = Account.objects.create(tenant=space, name="基金账户", kind="fund")
        fund = Instrument.objects.create(
            tenant=space, name="红利基金", kind="fund", code="020602", market="CN"
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(source.pk),
                "amount": "100",
                "economic_date": "2026-09-01",
            },
        )
        yield SimpleNamespace(
            user=user,
            space=space,
            source=source,
            target=target,
            fund=fund,
            client=client,
            base=f"/api/v1/spaces/{space.pk}",
        )


def debit(book, **extra):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.source.pk),
            "holding_account_id": str(book.target.pk),
            "instrument_id": str(book.fund.pk),
            "amount": "40",
            "economic_date": "2026-09-23",
            **extra,
        },
    )


def confirm(book, event, **extra):
    return post_event(
        book.space,
        book.user,
        {
            "kind": "fund_confirm",
            "account_id": str(book.target.pk),
            "instrument_id": str(book.fund.pk),
            "related_event_id": str(event.pk),
            "quantity": "10",
            "price": "2",
            "economic_date": str(WHEN),
            **extra,
        },
    )


def projection(book, when=WHEN):
    return PendingPurchases(book.space, when)


def test_partial_confirmation_and_refund_use_remaining_posted_transit(book):
    event = debit(book)
    confirm(book, event)
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_refund",
            "account_id": str(book.source.pk),
            "related_event_id": str(event.pk),
            "amount": "5",
            "economic_date": str(WHEN),
        },
    )
    summary = projection(book).summary()
    assert summary["amount"] == 15
    assert summary["count"] == 1
    item = summary["items"][0]
    assert item["original_amount"] == 40
    assert item["source_account_id"] == str(book.source.pk)
    assert item["holding_account_id"] == str(book.target.pk)
    assert projection(book, date(2026, 9, 23)).summary()["amount"] == 40
    Price.objects.create(
        tenant=book.space,
        instrument=book.fund,
        economic_date=WHEN,
        value="2",
        kind="official_nav",
    )
    row = holdings_summary(book.space, WHEN)["items"][0]
    assert D(row["quantity"]) == 10
    assert D(row["market_value"]) == 20
    assert D(row["pending_purchases"]["amount"]) == 15
    assert row["pending_purchases"]["count"] == 1
    assert D(row["profit"]) == 0


def test_fully_confirmed_or_refunded_and_reversed_debit_disappear(book):
    confirmed = debit(book, amount="20")
    confirm(book, confirmed)
    refunded = debit(book, amount="10")
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_refund",
            "account_id": str(book.source.pk),
            "related_event_id": str(refunded.pk),
            "amount": "10",
            "economic_date": str(WHEN),
        },
    )
    reversed_debit = debit(book, amount="10")
    reverse_event(book.space, book.user, reversed_debit, "合成撤销")
    assert projection(book).summary()["count"] == 0
    row = holdings_summary(book.space, WHEN)["items"][0]
    assert D(row["pending_purchases"]["amount"]) == 0
    assert row["pending_purchases"]["items"] == []


def test_reversed_confirmation_restores_pending_without_double_count(book):
    event = debit(book)
    confirmation = confirm(book, event)
    reverse_event(book.space, book.user, confirmation, "份额录错")
    assert projection(book).summary()["amount"] == 40
    rows = holdings_summary(book.space, WHEN)["items"]
    assert len(rows) == 1 and rows[0]["pending_only"] is True


def test_future_reversal_does_not_erase_historical_pending(book):
    event = debit(book)
    # Importers may store a reversal at its actual later economic date. This
    # fixture creates that immutable fact directly, without changing the debit.
    reversal = Event.objects.create(
        tenant=book.space,
        kind="reversal",
        economic_date=date(2026, 9, 25),
        reverses=event,
        stage_key="synthetic-later-reversal",
        revision=999,
        payload={"original_event_id": str(event.pk)},
    )
    for line in event.lines.all():
        JournalLine.objects.create(
            tenant=book.space,
            event=reversal,
            account_id=line.account_id,
            code=line.code,
            currency=line.currency,
            amount=-line.amount,
        )
    assert projection(book).summary()["amount"] == 40
    assert projection(book, date(2026, 9, 25)).summary()["amount"] == 0


def test_pending_only_product_has_no_fake_units_and_net_assets_do_not_change(book):
    before = overview(book.space, WHEN)
    old_comparison = net_worth_comparison(book.space, WHEN)
    debit(book)
    count = Event.objects.filter(tenant=book.space).count()
    response = holdings_summary(book.space, WHEN)
    row = response["items"][0]
    assert row["id"] == f"{book.target.pk}:{book.fund.pk}"
    assert row["pending_only"] is True and row["contributes"] is False
    for field in (
        "quantity",
        "cost",
        "market_value",
        "profit",
        "profit_rate",
        "daily_return",
        "latest_confirmed_return",
        "estimate_value",
    ):
        assert row[field] is None
    assert D(row["pending_purchases"]["amount"]) == 40
    after = overview(book.space, WHEN)
    assert before["net_assets"] == after["net_assets"]
    assert D(after["available_cash"]) == 60
    sources = {a["id"]: a for a in after["accounts"]}
    assert D(sources[str(book.source.pk)]["pending_purchases"]["amount"]) == 40
    assert D(sources[str(book.target.pk)]["pending_purchases"]["amount"]) == 0
    comparison = net_worth_comparison(book.space, WHEN)
    assert (
        comparison["estimated"]["net_assets"]
        == old_comparison["estimated"]["net_assets"]
    )
    assert comparison["estimated"]["gaps"] == old_comparison["estimated"]["gaps"]
    assert D(comparison["estimated"]["pending_purchases"]["amount"]) == 40
    assert holdings_summary(book.space, WHEN, include_pending=False)["items"] == []
    portfolio_analysis(book.space, WHEN)
    assert Event.objects.filter(tenant=book.space).count() == count


def test_unpaid_plan_never_creates_pending_assets(book):
    value = Resource.objects.create(
        tenant=book.space,
        kind="plans",
        data={
            "kind": "dca",
            "account_id": str(book.source.pk),
            "instrument_id": str(book.fund.pk),
            "automation": {"enabled": True, "holding_account_id": str(book.target.pk)},
        },
    )
    Occurrence.objects.create(
        tenant=book.space,
        plan=value,
        sequence=1,
        due_date=WHEN,
        amount="10",
        currency="CNY",
        status="pending",
    )
    assert projection(book).summary()["amount"] == 0
    assert holdings_summary(book.space, WHEN)["items"] == []


def test_unassigned_target_is_not_inferred_from_bank_and_partial_confirm_can_resolve(
    book,
):
    event = debit(book, holding_account_id=None)
    item = projection(book).summary()["items"][0]
    assert item["target_status"] == "unassigned"
    assert item["holding_account_id"] is None
    assert holdings_summary(book.space, WHEN)["items"] == []
    assert D(holdings_summary(book.space, WHEN)["pending_purchases"]["amount"]) == 40
    confirm(book, event)
    item = projection(book).summary()["items"][0]
    assert item["holding_account_id"] == str(book.target.pk)
    assert item["amount"] == 20


def test_registry_assigns_old_automatic_debit_and_preserves_assumption_source(book):
    event = debit(
        book,
        holding_account_id=None,
        automatic_estimate=True,
        entry_basis="preview_confirmed",
        dca_import_date="2026-09-23",
    )
    Resource.objects.create(
        tenant=book.space,
        kind="dca_import_periods",
        data={
            "debit_event_id": str(event.pk),
            "holding_account_id": str(book.target.pk),
            "funding_account_id": str(book.source.pk),
            "instrument_id": str(book.fund.pk),
            "scheduled_date": "2026-09-23",
            "debit_entry_basis": "preview_confirmed",
        },
    )
    item = projection(book).summary()["items"][0]
    assert item["holding_account_id"] == str(book.target.pk)
    assert item["is_dca"] is True and item["automatic_estimate"] is True
    assert item["entry_basis"] == "preview_confirmed"
    assert item["scheduled_date"] == "2026-09-23"
    assert item["expected_confirmation_date"] is not None
    assert (
        holdings_summary(book.space, WHEN)["items"][0]["contains_automatic_estimates"]
        is True
    )


def test_conflicting_destinations_stay_unassigned(book):
    event = debit(book)
    other = Account.objects.create(tenant=book.space, kind="fund", name="另一基金账户")
    Resource.objects.create(
        tenant=book.space,
        kind="dca_import_periods",
        data={
            "debit_event_id": str(event.pk),
            "holding_account_id": str(other.pk),
            "funding_account_id": str(book.source.pk),
            "instrument_id": str(book.fund.pk),
        },
    )
    item = projection(book).summary()["items"][0]
    assert item["target_status"] == "conflict" and item["holding_account_id"] is None
    assert holdings_summary(book.space, WHEN)["items"] == []


def test_currency_partial_totals_and_snapshot_scope_are_explicit(book):
    debit(book, amount="20")
    foreign = Account.objects.create(
        tenant=book.space,
        name="美元机构",
        kind="fund",
        currency="USD",
        valuation_mode="snapshot",
    )
    fund = Instrument.objects.create(
        tenant=book.space,
        name="美元基金",
        code="USD265",
        currency="USD",
        kind="fund",
        market="US",
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(foreign.pk),
            "amount": "100",
            "economic_date": "2026-09-01",
            "currency": "USD",
        },
    )
    debit(
        book,
        account_id=str(foreign.pk),
        holding_account_id=str(foreign.pk),
        instrument_id=str(fund.pk),
        amount="10",
        currency="USD",
    )
    summary = projection(book).summary(currency="CNY")
    assert summary["amount"] is None and summary["known_amount"] == 20
    assert summary["completeness"] == "partial"
    assert summary["included_in_assets"] is None
    assert summary["added_to_net_assets"] is False
    assert {row["currency"]: row["amount"] for row in summary["by_currency"]} == {
        "CNY": D(20),
        "USD": D(10),
    }
    FxRate.objects.create(
        tenant=book.space,
        base="USD",
        quote="CNY",
        rate="7",
        economic_date=WHEN,
        purpose="valuation",
    )
    assert projection(book).summary(currency="CNY")["amount"] == 90
    usd = projection(book).summary(currency="USD")
    assert usd["amount"] == D(20) / 7 + 10
    assert usd["items"][0]["currency"] == "CNY"
    assert usd["items"][0]["base_currency"] == "USD"


def test_projection_queries_are_batched_and_tenant_scoped(book):
    debit(book, amount="1")
    with CaptureQueriesContext(connection) as first:
        projection(book).summary()
    for _ in range(8):
        debit(book, amount="1")
    with CaptureQueriesContext(connection) as many:
        result = projection(book)
        result.summary()
        result.summary(source_account_id=book.source.pk)
        result.summary(holding_account_id=book.target.pk)
    assert len(many) == len(first)
    other = Workspace.objects.create(name="隔离账簿")
    with tenant_context(other.pk):
        assert PendingPurchases(other, WHEN).summary()["amount"] == 0
    assert projection(book).summary()["amount"] == 9


def test_plans_query_uses_holding_destination_and_legacy_registry(book):
    common = {
        "kind": "dca",
        "account_id": str(book.source.pk),
        "instrument_id": str(book.fund.pk),
    }
    automatic = Resource.objects.create(
        tenant=book.space,
        kind="plans",
        data={
            **common,
            "automation": {"holding_account_id": str(book.target.pk)},
        },
    )
    legacy = Resource.objects.create(tenant=book.space, kind="plans", data=common)
    Resource.objects.create(
        tenant=book.space,
        kind="dca_import_periods",
        data={
            "plan_id": str(legacy.pk),
            "holding_account_id": str(book.target.pk),
        },
    )
    simple = Resource.objects.create(
        tenant=book.space,
        kind="plans",
        data={
            **common,
            "account_id": str(book.target.pk),
        },
    )
    other = Resource.objects.create(tenant=book.space, kind="plans", data=common)
    response = book.client.get(
        book.base + "/plans",
        {
            "kind": "dca",
            "instrument_id": str(book.fund.pk),
            "holding_account_id": str(book.target.pk),
        },
    )
    assert response.status_code == 200
    assert {row["id"] for row in response.json()["items"]} == {
        str(automatic.pk),
        str(legacy.pk),
        str(simple.pk),
    }
    source_response = book.client.get(
        book.base + "/plans", {"holding_account_id": str(book.source.pk)}
    )
    assert {row["id"] for row in source_response.json()["items"]} == {str(other.pk)}
