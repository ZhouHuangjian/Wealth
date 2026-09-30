"""Real-DB regressions for historical holdings, scoped values and profit calendar."""

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth.common import DomainError, tenant_context
from wealth.investments import (
    holdings_summary,
    profit_calendar,
    record_holding,
    validate_investment_account,
)
from wealth.ledger import balance, post_event, reverse_event
from wealth.models import Account, Event, Instrument, Membership, Price, Workspace
from wealth.reporting import overview

pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book():
    user = get_user_model().objects.create_user(
        username="holdings-owner", password="investment-test-password"
    )
    space = Workspace.objects.create(name="存量投资测试")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        acct = Account.objects.create(
            tenant=space, created_by=user, name="基金账户", kind="fund"
        )
        instrument = Instrument.objects.create(
            tenant=space, created_by=user, name="测试基金", code="INV-TEST", kind="fund"
        )
        yield SimpleNamespace(
            user=user, space=space, account=acct, instrument=instrument
        )


def holding(book, **values):
    return record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "quantity": "100",
            "cost": "100",
            "purchase_date": "2026-05-06",
            "as_of": "2026-06-01",
            **values,
        },
    )


def quote(book, value, when, kind="official_nav"):
    return Price.objects.create(
        tenant=book.space,
        created_by=book.user,
        instrument=book.instrument,
        value=D(value),
        economic_date=when,
        kind=kind,
        source="fixture",
    )


def post(book, kind, when="2026-06-02", **values):
    return post_event(
        book.space,
        book.user,
        {
            "kind": kind,
            "account_id": str(book.account.pk),
            "instrument_id": str(book.instrument.pk),
            "economic_date": when,
            **values,
        },
    )


def test_manual_existing_holding_does_not_spend_current_cash_or_rewrite_history(book):
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(book.account.pk),
            "amount": "200",
            "economic_date": "2026-06-01",
        },
    )
    result = holding(book, current_profit="10")
    assert D(result["holding"]["market_value"]) == D("110")
    assert D(result["holding"]["profit"]) == D("10")
    assert D(result["holding"]["profit_rate"]) == D("0.1")
    assert balance(book.space, book.account, "cash") == D("200")
    assert Event.objects.get(pk=result["event"]["id"]).economic_date == date(2026, 6, 1)
    assert D(overview(book.space, "2026-06-01")["net_assets"]) == D("310")
    assert overview(book.space, "2026-05-06")["positions"] == []


def test_manual_total_never_changes_another_accounts_price(book):
    other = Account.objects.create(
        tenant=book.space, name="另一个基金账户", kind="fund"
    )
    quote(book, "1.2", "2026-06-01")
    holding(book, current_value="150")
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(other.pk),
            "instrument_id": str(book.instrument.pk),
            "quantity": "100",
            "cost": "100",
            "as_of": "2026-06-01",
        },
    )
    rows = holdings_summary(book.space, "2026-06-01")["items"]
    by_account = {row["account_id"]: row for row in rows}
    assert D(by_account[str(book.account.pk)]["market_value"]) == D("150")
    assert D(by_account[str(other.pk)]["market_value"]) == D("120")
    assert Price.objects.filter(tenant=book.space).count() == 1


@pytest.mark.parametrize(
    "field,value", [("current_profit", "-100"), ("current_value", "0")]
)
def test_zero_value_and_complete_loss_are_valid(book, field, value):
    result = holding(book, **{field: value})["holding"]
    assert D(result["market_value"]) == D(0)
    assert D(result["profit"]) == D("-100")
    assert D(result["profit_rate"]) == D("-1")


def test_invalid_manual_loss_is_atomic(book):
    with pytest.raises(DomainError, match="市值不能小于零"):
        holding(book, current_profit="-101")
    assert Event.objects.filter(tenant=book.space).count() == 0


def test_subsequent_position_change_invalidates_manual_total(book):
    quote(book, "1", "2026-06-01")
    holding(book, current_value="110")
    post(book, "buy", quantity="10", price="1")
    row = holdings_summary(book.space, "2026-06-02")["items"][0]
    assert row["manual_value"] is None
    assert D(row["market_value"]) == D("110")
    assert row["status"] == "official"


def test_later_formal_date_replaces_manual_total(book):
    holding(book, current_profit="10")
    quote(book, "1.3", "2026-06-02")
    row = holdings_summary(book.space, "2026-06-02")["items"][0]
    assert row["manual_value"] is None
    assert D(row["profit"]) == D("30")


def test_confirmed_unchanged_holding_uses_purchase_date_only_in_analytics(book):
    quote(book, "1", "2026-05-06")
    quote(book, "1.1", "2026-05-07")
    quote(book, "1.2", "2026-05-08")
    holding(book, history_mode="unchanged_holding")
    report = profit_calendar(
        book.space, "2026-05-06", "2026-05-08", selected_day="2026-05-07"
    )
    assert [D(row["amount"]) for row in report["days"]] == [D("0"), D("10"), D("10")]
    assert D(report["summary"]["amount"]) == D("20")
    assert abs(D(report["summary"]["return_rate"]) - D("0.2")) < D("1e-30")
    assert report["details"][0]["history_reconstructed"] is True
    assert Event.objects.filter(tenant=book.space).count() == 1
    assert balance(book.space, book.account, "cash") == D("0")


def test_manual_profit_does_not_invent_daily_gains(book):
    holding(book, current_profit="20")
    past = profit_calendar(book.space, "2026-05-06", "2026-05-07")
    assert all(
        row["status"] == "no_position" and row["amount"] is None for row in past["days"]
    )
    present = profit_calendar(book.space, "2026-06-01", "2026-06-01")
    assert present["days"][0]["amount"] is None
    assert present["days"][0]["status"] == "unavailable"


def test_live_estimate_is_separate_and_cannot_become_official_daily_profit(book):
    quote(book, "1.7", "2026-06-01", kind="estimate")
    row = holding(book)["holding"]
    assert row["market_value"] is None
    assert D(row["estimate_value"]) == D("170")
    assert D(row["estimate_profit"]) == D("70")
    assert (
        profit_calendar(book.space, "2026-06-01", "2026-06-01")["days"][0]["amount"]
        is None
    )


def test_actual_buy_and_partial_sale_do_not_treat_capital_as_profit(book):
    post(book, "buy", when="2026-05-06", quantity="10", price="10", fee="1")
    quote(book, "10", "2026-05-06")
    quote(book, "12", "2026-05-07")
    post(book, "sell", when="2026-05-07", quantity="5", price="12", fee="2", tax="1")
    result = profit_calendar(book.space, "2026-05-06", "2026-05-07")
    assert D(result["days"][0]["amount"]) == D("-1")
    assert D(result["days"][1]["amount"]) == D("17")
    assert D(result["summary"]["amount"]) == D("16")


def test_missing_observation_is_null_and_period_reports_partial(book):
    quote(book, "1", "2026-05-06")
    quote(book, "1.1", "2026-05-08")
    holding(book, history_mode="unchanged_holding")
    result = profit_calendar(book.space, "2026-05-06", "2026-05-08", period="week")
    assert result["days"][1]["amount"] is None
    assert result["summary"]["status"] == "partial"
    assert result["summary"]["amount"] is None
    assert D(result["summary"]["known_amount"]) == D("10")
    assert result["days"][2]["items"][0]["interval_start"] == "2026-05-06"


def test_reversed_holding_removes_manual_asset_and_historical_analytics(book):
    result = holding(book, current_profit="10", history_mode="unchanged_holding")
    event = Event.objects.get(pk=result["event"]["id"])
    reverse_event(book.space, book.user, event, "录入重复")
    assert holdings_summary(book.space, "2026-06-01")["items"] == []
    assert (
        profit_calendar(book.space, "2026-05-06", "2026-06-01")["summary"]["status"]
        == "no_position"
    )


def test_future_product_rejects_nonfuture_account_and_nominal_equity(book):
    book.instrument.kind = "future"
    with pytest.raises(DomainError, match="只能关联期货账户"):
        validate_investment_account(book.account, book.instrument)
    book.instrument.save(update_fields=["kind"])
    book.account.kind = "futures"
    book.account.save(update_fields=["kind"])
    with pytest.raises(DomainError, match="名义价值不能计入资产"):
        holding(book)


def test_foreign_tenant_product_cannot_be_used(book):
    outsider = Workspace.objects.create(name="另一账簿")
    with tenant_context(outsider.pk):
        instrument = Instrument.objects.create(
            tenant=outsider, name="外部基金", code="OUTSIDE"
        )
    with pytest.raises(DomainError) as error:
        holding(book, instrument_id=str(instrument.pk))
    assert error.value.status == 404


def test_futures_calendar_subtracts_confirmed_deposit_from_statement_equity(book):
    from wealth.models import Snapshot

    futures = Account.objects.create(
        tenant=book.space, name="广发期货", kind="futures", valuation_mode="snapshot"
    )
    Snapshot.objects.create(
        tenant=book.space,
        account=futures,
        economic_date="2026-05-06",
        equity="10000",
        currency="CNY",
        coverage="全部",
        complete=True,
        includes_options=True,
    )
    deposit = post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(book.account.pk),
            "target_account_id": str(futures.pk),
            "amount": "500",
            "economic_date": "2026-05-07",
        },
    )
    Snapshot.objects.create(
        tenant=book.space,
        account=futures,
        economic_date="2026-05-07",
        equity="10380",
        currency="CNY",
        coverage="全部",
        complete=True,
        includes_options=True,
        included_event_ids=[str(deposit.pk)],
    )
    report = profit_calendar(book.space, "2026-05-07", "2026-05-07", kind="future")
    assert D(report["days"][0]["amount"]) == D("-120")
    assert report["days"][0]["items"][0]["scope"] == "account"
    assert report["days"][0]["items"][0]["source"] == "institution_snapshot"


def test_unverified_futures_snapshot_cannot_show_profit(book):
    from wealth.models import Snapshot

    futures = Account.objects.create(
        tenant=book.space, name="银河期货", kind="futures", valuation_mode="snapshot"
    )
    for when, equity in [("2026-05-06", "10000"), ("2026-05-07", "11000")]:
        Snapshot.objects.create(
            tenant=book.space,
            account=futures,
            economic_date=when,
            equity=equity,
            currency="CNY",
            coverage="待核实",
            complete=False,
            includes_options=None,
        )
    report = profit_calendar(book.space, "2026-05-07", "2026-05-07")
    assert report["days"][0]["amount"] is None
    assert report["days"][0]["status"] == "unavailable"
    assert "包含范围" in report["days"][0]["items"][0]["message"]


@pytest.mark.parametrize("kind", ["stock", "etf", "option"])
def test_security_products_reject_unrelated_bank_account(book, kind):
    book.account.kind = "bank"
    book.instrument.kind = kind
    with pytest.raises(DomainError):
        validate_investment_account(book.account, book.instrument)


def test_partial_day_keeps_known_product_profit_in_period_summary(book):
    quote(book, "1.1", "2026-05-06")
    holding(book, history_mode="unchanged_holding")
    unknown = Instrument.objects.create(
        tenant=book.space, name="无报价基金", code="MISSING-PRICE"
    )
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(unknown.pk),
            "quantity": "100",
            "cost": "100",
            "purchase_date": "2026-05-06",
            "as_of": "2026-06-01",
            "history_mode": "unchanged_holding",
        },
    )
    report = profit_calendar(book.space, "2026-05-06", "2026-05-06")
    assert report["days"][0]["status"] == "partial"
    assert report["summary"]["amount"] is None
    assert D(report["summary"]["known_amount"]) == D("10")


def test_old_manual_snapshot_is_labelled_stale_without_erasing_value(book):
    holding(book, current_profit="10")
    row = holdings_summary(book.space, "2026-06-10")["items"][0]
    assert row["status"] == "stale"
    assert D(row["manual_value"]) == D("110")
    assert overview(book.space, "2026-06-10")["completeness"] == "partial"


@pytest.mark.parametrize(
    "code,market,spec",
    [
        ("AU2612", "CN", {}),
        ("au612", "SHFE", {}),
        ("AU0", "CN", {}),
        ("GCZ26", "COMEX", {}),
        ("CUSTOM-GOLD", "CN", {"is_derivative": True}),
    ],
)
def test_mislabelled_gold_derivative_cannot_create_full_cost_asset(
    book, code, market, spec
):
    book.instrument.kind, book.instrument.code = "gold", code
    book.instrument.market, book.instrument.specification = market, spec
    book.instrument.save(update_fields=["kind", "code", "market", "specification"])
    with pytest.raises(DomainError) as result:
        holding(book)
    assert result.value.code == "derivative_snapshot_required"
    with pytest.raises(DomainError) as legacy:
        post(book, "buy", quantity="1", price="500")
    assert legacy.value.code == "derivative_snapshot_required"
    assert Event.objects.filter(tenant=book.space).count() == 0


@pytest.mark.parametrize(
    "code,market",
    [("518880", "CN"), ("AU99.99", "SGE"), ("AU9999", "SGE"), ("XAUUSD", "GLOBAL")],
)
def test_gold_etf_and_explicit_spot_products_remain_recordable(book, code, market):
    book.instrument.kind, book.instrument.code, book.instrument.market = (
        "gold",
        code,
        market,
    )
    book.instrument.save(update_fields=["kind", "code", "market"])
    assert holding(book, current_value="110")["holding"]["kind"] == "gold"


@pytest.mark.parametrize(
    "status,seconds,expected",
    [
        ("failed", 10, "stale"),
        ("ready", 601, "stale"),
        ("ready", 300, "reference"),
    ],
)
def test_provider_failure_or_expired_fetch_marks_same_day_estimate_stale(
    book, status, seconds, expected
):
    from datetime import timedelta

    from django.utils import timezone
    from wealth.models import Resource

    quote(book, "1.2", "2026-06-01", kind="reference")
    holding(book)
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.instrument.pk),
            "refresh_status": status,
            "fetched_at": (timezone.now() - timedelta(seconds=seconds)).isoformat(),
        },
    )
    row = holdings_summary(book.space, "2026-06-01")["items"][0]
    assert row["estimate_status"] == expected
    assert D(row["estimate_value"]) == D("120")
    assert D(row["estimate_profit"]) == D("20")


def test_manual_reference_without_market_state_remains_available(book):
    quote(book, "1.2", "2026-06-01", kind="reference")
    row = holding(book)["holding"]
    assert row["estimate_status"] == "reference"


def corporate_action(book, when="2026-05-07", description="每份派现金0.10元"):
    from wealth.models import Resource

    return Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.instrument.pk),
            "corporate_actions": [
                {"date": when, "description": description, "source": "fixture"}
            ],
        },
    )


def test_unrecorded_distribution_does_not_turn_ex_dividend_nav_into_daily_loss(book):
    quote(book, "1", "2026-05-06")
    quote(book, "0.9", "2026-05-07")
    quote(book, "0.91", "2026-05-08")
    corporate_action(book)
    holding(book, history_mode="unchanged_holding")
    summary = holdings_summary(book.space, "2026-06-01")["items"][0]
    assert summary["corporate_actions"][0]["date"] == "2026-05-07"
    assert "份额未变" in summary["history_warning"]
    report = profit_calendar(
        book.space, "2026-05-06", "2026-05-08", selected_day="2026-05-07"
    )
    assert report["days"][1]["amount"] is None
    assert report["details"][0]["status"] == "unavailable"
    assert (
        report["details"][0]["message"] == "该日有分红或折算提示，请核对并补录实际记录"
    )
    assert D(report["days"][2]["amount"]) == D("1")
    assert Event.objects.filter(tenant=book.space).count() == 1


def test_recorded_distribution_restores_actual_daily_profit(book):
    post(book, "buy", when="2026-05-06", quantity="100", price="1")
    quote(book, "1", "2026-05-06")
    quote(book, "0.9", "2026-05-07")
    corporate_action(book)
    post(book, "dividend", when="2026-05-07", amount="10")
    report = profit_calendar(book.space, "2026-05-07", "2026-05-07")
    assert report["days"][0]["status"] == "confirmed"
    assert D(report["days"][0]["amount"]) == D("0")
    assert D(report["days"][0]["items"][0]["dividends"]) == D("10")
