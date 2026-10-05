"""Reporting integration: formal valuations, portfolio boundaries, snapshot coverage."""

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth.common import tenant_context
from wealth.ledger import post_event, reverse_event
from wealth.models import (
    Account,
    FxRate,
    Instrument,
    Membership,
    Price,
    Resource,
    Snapshot,
    Workspace,
)
from wealth.portfolio import net_worth_comparison
from wealth.reporting import fx, overview, performance, positions

pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def book():
    user = get_user_model().objects.create_user(
        username="report-owner", password="test-password-reporting"
    )
    space = Workspace.objects.create(name="收益与资产报告", base_currency="CNY")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        bank = Account.objects.create(
            tenant=space, created_by=user, name="银行", kind="bank", currency="CNY"
        )
        broker = Account.objects.create(
            tenant=space,
            created_by=user,
            name="投资账户",
            kind="broker",
            currency="CNY",
        )
        instrument = Instrument.objects.create(
            tenant=space,
            created_by=user,
            name="合成基金",
            code="REPORT-FUND",
            kind="fund",
            currency="CNY",
        )
        yield SimpleNamespace(
            user=user, space=space, bank=bank, broker=broker, instrument=instrument
        )


def account(book, name, kind="bank", currency="CNY", valuation_mode="detailed"):
    return Account.objects.create(
        tenant=book.space,
        created_by=book.user,
        name=name,
        kind=kind,
        currency=currency,
        valuation_mode=valuation_mode,
    )


def post(book, kind, acct=None, **kwargs):
    data = {
        "kind": kind,
        "account_id": str((acct or book.bank).pk),
        "economic_date": "2026-01-01",
        **kwargs,
    }
    for key in ("target_account_id", "instrument_id", "related_event_id"):
        if key in data:
            data[key] = str(getattr(data[key], "pk", data[key]))
    return post_event(book.space, book.user, data)


def quote(book, value, when, kind="official_nav", instrument=None):
    return Price.objects.create(
        tenant=book.space,
        created_by=book.user,
        instrument=instrument or book.instrument,
        value=D(value),
        economic_date=when,
        kind=kind,
        source="synthetic-test",
    )


def rate(book, value, when, base="USD", target="CNY", purpose="valuation"):
    return FxRate.objects.create(
        tenant=book.space,
        created_by=book.user,
        base=base,
        quote=target,
        rate=D(value),
        economic_date=when,
        source="synthetic-test",
        purpose=purpose,
    )


def snapshot(
    book, acct, equity, when, included=None, complete=True, options=False, **details
):
    # Default fixtures are confirmed futures-only accounts, not omitted option value.
    details.setdefault("no_option_positions", options is False)
    return Snapshot.objects.create(
        tenant=book.space,
        created_by=book.user,
        account=acct,
        economic_date=when,
        equity=D(equity),
        currency=acct.currency,
        coverage="全部客户权益（含持仓浮盈亏）",
        complete=complete,
        includes_options=options,
        included_event_ids=included or [],
        details=details,
    )


def item_for(result, acct):
    return next(row for row in result["accounts"] if row["id"] == str(acct.pk))


def test_appendix_a1_formal_value_is_distinct_from_fee_inclusive_cost(book):
    post(book, "opening", amount="10000")
    debit = post(book, "fund_debit", amount="1000", economic_date="2026-01-02")
    transit = overview(book.space, "2026-01-02")
    assert D(transit["net_assets"]) == D("10000")
    assert transit["positions"] == []
    confirm = post(
        book,
        "fund_confirm",
        quantity="495",
        price="2.00",
        fee="10",
        instrument_id=book.instrument,
        target_account_id=book.broker,
        related_event_id=debit,
        economic_date="2026-01-04",
    )
    quote(book, "2.00", "2026-01-04")
    confirmed = overview(book.space, "2026-01-04")
    assert D(confirmed["net_assets"]) == D("9990")
    assert D(confirmed["positions"][0]["cost"]) == D("1000")
    assert D(confirmed["positions"][0]["market_value"]) == D("990")
    assert D(confirmed["positions"][0]["unrealized_profit"]) == D("-10")
    quote(book, "2.02", "2026-01-05")
    valued = overview(book.space, "2026-01-05")
    assert D(valued["net_assets"]) == D("9999.90")
    redeem = post(
        book,
        "fund_redeem",
        book.broker,
        quantity="495",
        price="2.04",
        fee="5",
        instrument_id=book.instrument,
        related_event_id=confirm,
        economic_date="2026-01-06",
    )
    receivable = overview(book.space, "2026-01-06")
    assert D(receivable["net_assets"]) == D("10004.80")
    assert D(item_for(receivable, book.broker)["value"]) == D("1004.80")
    post(book, "settlement", related_event_id=redeem, economic_date="2026-01-08")
    final = overview(book.space, "2026-01-08")
    assert D(final["net_assets"]) == D("10004.80")
    assert final["positions"] == []
    result = performance(book.space, "2026-01-01", "2026-01-08")
    assert result["completeness"] == "complete"
    assert D(result["external_inflows"]) == D("1000")
    assert D(result["external_outflows"]) == D("1004.80")
    assert D(result["realized_profit"]) == D("4.80")
    assert D(result["fees"]) == D("15")
    assert D(result["net_profit"]) == D("4.80")
    assert result["fees_already_in_net_profit"] is True
    assert result["xirr"]["status"] == "ok"


def test_at25_fx_changes_net_assets_only_by_fee(book):
    usd = account(book, "美元银行", currency="USD")
    post(book, "opening", amount="10000")
    rate(book, "7.00", "2026-01-01")
    post(
        book,
        "fx",
        amount="7000",
        fee="10",
        received_amount="1000",
        target_account_id=usd,
    )
    result = overview(book.space, "2026-01-01")
    assert result["completeness"] == "complete"
    assert D(result["net_assets"]) == D("9990")
    assert D(item_for(result, book.bank)["balance"]) == D("2990")
    assert D(item_for(result, usd)["balance"]) == D("1000")
    assert D(item_for(result, usd)["base_value"]) == D("7000")


def test_at26_fx_gain_and_missing_other_currency_are_separate(book):
    usd = account(book, "美元现金", currency="USD")
    post(book, "opening", usd, amount="1000")
    rate(book, "7.00", "2026-01-01")
    rate(book, "7.10", "2026-01-03")
    result = performance(book.space, "2026-01-02", "2026-01-03", account_ids=[usd.pk])
    assert D(result["opening_value"]) == D("7000")
    assert D(result["closing_value"]) == D("7100")
    assert D(result["net_profit"]) == D("100")
    hkd = account(book, "港币现金", currency="HKD")
    post(book, "opening", hkd, amount="10", economic_date="2026-01-03")
    missing = overview(book.space, "2026-01-03")
    assert missing["completeness"] == "partial"
    assert item_for(missing, hkd)["base_value"] is None
    assert D(missing["net_assets"]) == D("7100")
    assert any("HKD/CNY" in gap for gap in missing["gaps"])


def test_fx_uses_historical_valuation_rate_and_inverse_without_future_data(book):
    rate(book, "0.125", "2026-01-01", base="CNY", target="USD")
    rate(book, "7.2", "2026-01-03")
    rate(book, "999", "2026-01-02", purpose="transaction")
    assert fx(book.space, "USD", "CNY", date(2026, 1, 2)) == D("8")
    assert fx(book.space, "USD", "CNY", date(2026, 1, 3)) == D("7.2")
    assert fx(book.space, "HKD", "CNY", date(2026, 1, 3)) is None


def test_appendix_a4_snapshot_replaces_its_included_deposit_adjustment(book):
    futures = account(book, "期货权益", kind="futures", valuation_mode="snapshot")
    post(book, "opening", amount="10000")
    snapshot(
        book,
        futures,
        "10000",
        "2026-01-01",
        available="7000",
        margin="3000",
        notional="100000",
    )
    initial = overview(book.space, "2026-01-01")
    assert D(initial["net_assets"]) == D("20000")
    assert D(item_for(initial, futures)["value"]) == D("10000")
    transfer = post(
        book,
        "transfer",
        amount="500",
        target_account_id=futures,
        economic_date="2026-01-02",
    )
    rolled = overview(book.space, "2026-01-02")
    assert D(rolled["net_assets"]) == D("20000")
    assert D(item_for(rolled, futures)["value"]) == D("10500")
    assert D(item_for(rolled, futures)["roll_forward"]) == D("500")
    assert item_for(rolled, futures)["status"] == "partial"
    snapshot(
        book,
        futures,
        "10380",
        "2026-01-02",
        included=[str(transfer.pk)],
        available="7380",
        margin="3000",
    )
    final = overview(book.space, "2026-01-02")
    assert D(final["net_assets"]) == D("19880")
    assert D(item_for(final, futures)["value"]) == D("10380")
    assert D(item_for(final, futures)["roll_forward"]) == D("0")
    assert final["completeness"] == "complete"
    result = performance(
        book.space, "2026-01-02", "2026-01-02", account_ids=[futures.pk]
    )
    assert D(result["opening_value"]) == D("10000")
    assert D(result["external_inflows"]) == D("500")
    assert D(result["net_profit"]) == D("-120")


def test_snapshot_does_not_add_margin_notional_or_detailed_positions(book):
    futures = account(book, "综合期货权益", kind="futures", valuation_mode="snapshot")
    post(
        book, "buy", futures, quantity="10", price="100", instrument_id=book.instrument
    )
    quote(book, "110", "2026-01-01")
    snapshot(
        book,
        futures,
        "10000",
        "2026-01-01",
        options=True,
        available="7000",
        margin="3000",
        notional="90000",
    )
    result = overview(book.space, "2026-01-01")
    assert D(result["net_assets"]) == D("10000")
    assert D(item_for(result, futures)["value"]) == D("10000")
    assert result["positions"][0]["contributes"] is False


def test_snapshot_unknown_coverage_is_never_complete(book):
    futures = account(
        book, "未核实覆盖的期货账户", kind="futures", valuation_mode="snapshot"
    )
    snapshot(
        book,
        futures,
        "10000",
        "2026-01-01",
        complete=False,
        options=None,
        available="7000",
    )
    result = overview(book.space, "2026-01-01")
    assert D(result["net_assets"]) == D("10000")
    assert result["completeness"] == "partial"
    assert any("包含范围" in gap for gap in result["gaps"])


@pytest.mark.parametrize(
    "no_positions,expected", [(True, "complete"), (False, "partial")]
)
def test_excluded_options_are_distinct_from_confirmed_no_option_positions(
    book, no_positions, expected
):
    futures = account(book, "期权覆盖检查", kind="futures", valuation_mode="snapshot")
    snapshot(
        book,
        futures,
        "10000",
        "2026-01-01",
        options=False,
        no_option_positions=no_positions,
        available="7000",
    )
    result = overview(book.space, "2026-01-01")
    assert D(result["net_assets"]) == D("10000")
    assert result["completeness"] == expected
    assert any("不包含期权价值" in gap for gap in result["gaps"]) is not no_positions


def test_snapshot_must_explicitly_cover_same_day_transfer(book):
    futures = account(book, "期货账户", kind="futures", valuation_mode="snapshot")
    snapshot(book, futures, "10000", "2026-01-01", available="7000")
    post(
        book,
        "transfer",
        amount="500",
        target_account_id=futures,
        economic_date="2026-01-02",
    )
    snapshot(book, futures, "10380", "2026-01-02", available="7380")
    result = overview(book.space, "2026-01-02")
    assert item_for(result, futures)["status"] == "partial"
    assert any("是否包含出入金" in gap for gap in result["gaps"])


def test_historical_snapshot_does_not_include_future_deposit(book):
    futures = account(book, "期货账户", kind="futures", valuation_mode="snapshot")
    post(book, "opening", amount="10000")
    snapshot(book, futures, "10000", "2026-01-01", available="7000")
    post(
        book,
        "transfer",
        amount="500",
        target_account_id=futures,
        economic_date="2026-01-03",
    )
    historical = overview(book.space, "2026-01-01")
    assert D(historical["net_assets"]) == D("20000")
    assert D(item_for(historical, futures)["roll_forward"]) == D("0")
    assert historical["completeness"] == "complete"


def test_reversed_deposit_does_not_remain_in_snapshot_roll_forward(book):
    futures = account(book, "期货账户", kind="futures", valuation_mode="snapshot")
    post(book, "opening", amount="10000")
    snapshot(book, futures, "10000", "2026-01-01", available="7000")
    transfer = post(
        book,
        "transfer",
        amount="500",
        target_account_id=futures,
        economic_date="2026-01-02",
    )
    reverse_event(book.space, book.user, transfer, "重复的机构入金证据")
    result = overview(book.space, "2026-01-02")
    assert D(result["net_assets"]) == D("20000")
    assert D(item_for(result, futures)["roll_forward"]) == D("0")


@pytest.mark.parametrize("valuation_mode", ["snapshot", "detailed"])
@pytest.mark.parametrize(
    "event_kind, expected", [("income", "1050"), ("expense", "950")]
)
def test_overview_and_comparison_share_institution_cashflow_coverage(
    book, valuation_mode, event_kind, expected
):
    futures = account(
        book, "收支核对期货账户", kind="futures", valuation_mode=valuation_mode
    )
    snapshot(book, futures, "1000", "2026-01-01", available="700")
    event = post(book, event_kind, futures, amount="50", economic_date="2026-01-02")
    rolled = overview(book.space, "2026-01-02")
    comparison = net_worth_comparison(book.space, "2026-01-02")
    assert (
        D(rolled["net_assets"])
        == D(comparison["estimated"]["known_net_assets"])
        == D(expected)
    )
    assert (
        rolled["completeness"] == comparison["estimated"]["completeness"] == "complete"
    )
    assert D(item_for(rolled, futures)["available"]) == D("700")
    assert D(item_for(rolled, futures)["roll_forward"]) == D(expected) - D("1000")
    statement = snapshot(book, futures, expected, "2026-01-02", available="700")
    unconfirmed = overview(book.space, "2026-01-02")
    assert unconfirmed["completeness"] == "partial"
    assert D(item_for(unconfirmed, futures)["available"]) == D("0")
    assert (
        net_worth_comparison(book.space, "2026-01-02")["estimated"]["net_assets"]
        is None
    )
    statement.included_event_ids = [str(event.pk)]
    statement.save(update_fields=["included_event_ids"])
    confirmed = overview(book.space, "2026-01-02")
    comparison = net_worth_comparison(book.space, "2026-01-02")
    assert (
        confirmed["completeness"]
        == comparison["estimated"]["completeness"]
        == "complete"
    )
    assert (
        D(confirmed["net_assets"])
        == D(comparison["estimated"]["net_assets"])
        == D(expected)
    )
    assert D(item_for(confirmed, futures)["roll_forward"]) == D("0")


@pytest.mark.parametrize(
    "price_kind", ["estimate", "reference", "reference_estimate", "trade"]
)
def test_reference_price_never_becomes_official_asset_value(book, price_kind):
    post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="100",
        instrument_id=book.instrument,
    )
    quote(book, "200", "2026-01-01", kind=price_kind)
    result = overview(book.space, "2026-01-01")
    assert result["positions"][0]["market_value"] is None
    assert result["positions"][0]["status"] == "unknown"
    assert result["completeness"] == "partial"
    assert any("缺正式价格" in gap for gap in result["gaps"])
    report = performance(book.space, "2026-01-01", "2026-01-02")
    assert report["net_profit"] is None
    assert report["xirr"]["status"] == "insufficient_data"


def test_future_price_is_not_used_but_recent_formal_price_can_be_used(book):
    post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="100",
        instrument_id=book.instrument,
    )
    quote(book, "150", "2026-01-03")
    assert positions(book.space, "2026-01-02")[0]["market_value"] is None
    quote(book, "101", "2026-01-01")
    quote(book, "999", "2026-01-02", kind="estimate")
    result = positions(book.space, "2026-01-02")[0]
    assert result["market_value"] == D("1010")
    assert result["price_date"] == date(2026, 1, 1)
    stale = overview(book.space, "2026-01-20")
    assert stale["completeness"] == "partial"
    assert any("陈旧" in gap for gap in stale["gaps"])


def test_xirr_uses_period_opening_value_and_excludes_internal_transfer(book):
    second = account(book, "第二投资账户", kind="broker")
    post(book, "opening", book.broker, amount="1000", economic_date="2024-12-31")
    post(
        book,
        "transfer",
        book.broker,
        amount="400",
        target_account_id=second,
        economic_date="2025-06-01",
    )
    post(book, "dividend", second, amount="100", economic_date="2026-01-01")
    result = performance(
        book.space, "2025-01-01", "2026-01-01", account_ids=[book.broker.pk, second.pk]
    )
    assert D(result["opening_value"]) == D("1000")
    assert D(result["closing_value"]) == D("1100")
    assert D(result["external_inflows"]) == D("0")
    assert D(result["external_outflows"]) == D("0")
    assert D(result["net_profit"]) == D("100")
    assert result["xirr"]["status"] == "ok"
    assert abs(D(result["xirr"]["rate"]) - D("0.1")) < D("1e-18")


def test_foreign_portfolio_does_not_need_a_rate_for_zero_opening_value(book):
    usd = account(book, "首笔美元投资", kind="broker", currency="USD")
    post(book, "opening", usd, amount="100", economic_date="2025-01-01")
    rate(book, "7", "2025-01-01")
    post(book, "dividend", usd, amount="10", economic_date="2026-01-01")
    result = performance(book.space, "2025-01-01", "2026-01-01", account_ids=[usd.pk])
    assert result["completeness"] == "complete"
    assert D(result["net_profit"]) == D("70")
    assert result["xirr"]["status"] == "ok"
    assert abs(D(result["xirr"]["rate"]) - D("0.1")) < D("1e-18")


def test_position_transferred_into_scope_is_external_flow_at_market_value(book):
    outside = account(book, "范围外证券账户", kind="broker")
    post(book, "buy", outside, quantity="10", price="10", instrument_id=book.instrument)
    quote(book, "12", "2026-01-02")
    post(
        book,
        "position_transfer",
        outside,
        quantity="10",
        target_account_id=book.broker,
        instrument_id=book.instrument,
        economic_date="2026-01-02",
    )
    result = performance(
        book.space, "2026-01-02", "2026-01-02", account_ids=[book.broker.pk]
    )
    assert D(result["closing_value"]) == D("120")
    assert D(result["external_inflows"]) == D("120")
    assert D(result["net_profit"]) == D("0")


def test_sell_tax_is_disclosed_but_not_deducted_twice(book):
    post(book, "opening", book.broker, amount="1000")
    buy = post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="10",
        fee="1",
        instrument_id=book.instrument,
    )
    post(book, "settlement", book.broker, related_event_id=buy)
    sell = post(
        book,
        "sell",
        book.broker,
        quantity="10",
        price="12",
        fee="2",
        tax="3",
        instrument_id=book.instrument,
        economic_date="2026-01-02",
    )
    post(
        book,
        "settlement",
        book.broker,
        related_event_id=sell,
        economic_date="2026-01-02",
    )
    result = performance(book.space, "2026-01-01", "2026-01-02")
    assert D(result["net_profit"]) == D("14")
    assert D(result["fees"]) == D("3")
    assert D(result["taxes"]) == D("3")
    assert D(result["realized_profit"]) == D("14")


def test_unknown_repayment_allocation_marks_net_worth_incomplete(book):
    loan = account(book, "贷款", kind="loan")
    post(book, "opening", amount="10000")
    post(book, "opening", loan, amount="2000")
    repayment = post(book, "repayment", amount="520", target_account_id=loan)
    before = overview(book.space, "2026-01-01")
    assert before["completeness"] == "partial"
    assert any("待分配清算" in gap for gap in before["gaps"])
    post(
        book,
        "repayment_allocate",
        amount="520",
        principal="500",
        interest="20",
        related_event_id=repayment,
        target_account_id=loan,
    )
    after = overview(book.space, "2026-01-01")
    assert after["completeness"] == "complete"
    assert D(after["net_assets"]) == D("7980")


def test_internal_transfer_fee_remains_a_loss_instead_of_external_withdrawal(book):
    second = account(book, "第二券商", kind="broker")
    post(book, "opening", book.broker, amount="1000", economic_date="2025-12-31")
    post(
        book,
        "transfer",
        book.broker,
        amount="300",
        fee="2",
        target_account_id=second,
        economic_date="2026-01-01",
    )
    result = performance(
        book.space, "2026-01-01", "2026-01-01", account_ids=[book.broker.pk, second.pk]
    )
    assert D(result["external_inflows"]) == D("0")
    assert D(result["external_outflows"]) == D("0")
    assert D(result["net_profit"]) == D("-2")
    assert D(result["fees"]) == D("2")


def test_fx_crossing_portfolio_boundary_is_external_capital_not_profit(book):
    usd_broker = account(book, "美元券商", kind="broker", currency="USD")
    post(book, "opening", amount="10000", economic_date="2025-12-31")
    rate(book, "7", "2025-12-31")
    post(
        book,
        "fx",
        amount="7000",
        fee="10",
        received_amount="1000",
        target_account_id=usd_broker,
        economic_date="2026-01-01",
    )
    result = performance(
        book.space, "2026-01-01", "2026-01-01", account_ids=[usd_broker.pk]
    )
    assert D(result["closing_value"]) == D("7000")
    assert D(result["external_inflows"]) == D("7000")
    assert D(result["net_profit"]) == D("0")


def test_only_active_scenario_reservations_reduce_available_cash(book):
    post(book, "opening", amount="10000")
    goal = Resource.objects.create(
        tenant=book.space, created_by=book.user, kind="goals", data={"name": "买房"}
    )
    active = Resource.objects.create(
        tenant=book.space,
        created_by=book.user,
        kind="scenarios",
        data={"name": "已选方案", "goal_id": str(goal.pk), "status": "active"},
    )
    draft = Resource.objects.create(
        tenant=book.space,
        created_by=book.user,
        kind="scenarios",
        data={"name": "对照方案", "goal_id": str(goal.pk), "status": "draft"},
    )
    for scenario, amount, paid in [
        (active, "2000", False),
        (draft, "5000", False),
        (active, "1000", True),
    ]:
        Resource.objects.create(
            tenant=book.space,
            created_by=book.user,
            kind="reservations",
            data={
                "account_id": str(book.bank.pk),
                "amount": amount,
                "currency": "CNY",
                "status": "active",
                "scenario_id": str(scenario.pk),
                "paid": paid,
            },
        )
    result = overview(book.space, "2026-01-01")
    assert D(result["reserved"]) == D("2000")
    assert D(result["allocatable"]) == D("8000")


def test_internal_fx_has_no_external_cashflow_and_retains_spread_and_fee(book):
    usd = account(book, "组合内美元", kind="broker", currency="USD")
    post(book, "opening", book.broker, amount="10000", economic_date="2025-12-31")
    rate(book, "7.1", "2025-12-31")
    post(
        book,
        "fx",
        book.broker,
        amount="7000",
        fee="10",
        received_amount="1000",
        target_account_id=usd,
        economic_date="2026-01-01",
    )
    result = performance(
        book.space, "2026-01-01", "2026-01-01", account_ids=[book.broker.pk, usd.pk]
    )
    assert D(result["external_inflows"]) == D("0")
    assert D(result["external_outflows"]) == D("0")
    assert D(result["closing_value"]) == D("10090")
    assert D(result["net_profit"]) == D("90")
    assert D(result["fees"]) == D("10")


def test_initial_holding_is_opening_capital_at_market_value_not_acquisition_cost(book):
    post(
        book,
        "opening",
        book.broker,
        amount="0",
        quantity="10",
        cost="100",
        instrument_id=book.instrument,
    )
    quote(book, "12", "2026-01-01")
    result = performance(
        book.space, "2026-01-01", "2026-01-01", account_ids=[book.broker.pk]
    )
    assert D(result["external_inflows"]) == D("120")
    assert D(result["closing_value"]) == D("120")
    assert D(result["net_profit"]) == D("0")


def test_unknown_cost_disposal_keeps_actual_cash_but_does_not_invent_realized_profit(
    book,
):
    post(
        book,
        "opening",
        book.broker,
        amount="0",
        quantity="10",
        instrument_id=book.instrument,
    )
    quote(book, "100", "2026-01-01")
    sale = post(
        book,
        "sell",
        book.broker,
        quantity="10",
        price="110",
        fee="1",
        instrument_id=book.instrument,
        economic_date="2026-01-02",
    )
    assert sale.payload["cost_unknown"] is True
    post(
        book,
        "settlement",
        book.broker,
        related_event_id=sale,
        economic_date="2026-01-02",
    )
    assets = overview(book.space, "2026-01-02")
    assert D(assets["net_assets"]) == D("1099")
    assert assets["positions"] == []
    report = performance(
        book.space, "2026-01-02", "2026-01-02", account_ids=[book.broker.pk]
    )
    assert report["completeness"] == "partial"
    assert report["net_profit"] is None
    assert report["realized_profit"] is None
    assert report["xirr"]["status"] == "insufficient_data"
    assert D(report["fees"]) == D("1")
