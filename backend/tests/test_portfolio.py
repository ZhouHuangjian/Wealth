"""Economic examples for wealth comparisons, exclusive targets and tag baskets."""

from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth.common import DomainError, tenant_context
from wealth.investments import record_holding
from wealth.ledger import post_event
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
from wealth.portfolio import net_worth_comparison, portfolio_analysis, tag_series

pytestmark = pytest.mark.django_db
D = Decimal
YESTERDAY = "2026-05-06"
TODAY = "2026-05-07"


@pytest.fixture
def book():
    user = get_user_model().objects.create_user(
        username="portfolio-owner", password="portfolio-test-password"
    )
    space = Workspace.objects.create(name="投资配置集成测试")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        bank = Account.objects.create(tenant=space, name="银行", kind="bank")
        broker = Account.objects.create(tenant=space, name="基金平台", kind="fund")
        instrument = Instrument.objects.create(
            tenant=space, name="产品甲", code="PORTFOLIO-A", kind="fund"
        )
        yield SimpleNamespace(
            user=user, space=space, bank=bank, broker=broker, instrument=instrument
        )


def post(book, kind, account=None, when=YESTERDAY, **values):
    return post_event(
        book.space,
        book.user,
        {
            "kind": kind,
            "account_id": str((account or book.bank).pk),
            "economic_date": when,
            **values,
        },
    )


def hold(book, instrument=None, account=None, quantity="10", when=YESTERDAY):
    return post(
        book,
        "opening",
        account or book.broker,
        when=when,
        quantity=quantity,
        cost="100",
        instrument_id=str((instrument or book.instrument).pk),
    )


def price(book, amount="10", when=YESTERDAY, instrument=None, kind="official_nav"):
    return Price.objects.create(
        tenant=book.space,
        instrument=instrument or book.instrument,
        value=amount,
        economic_date=when,
        kind=kind,
        source="test_quote",
    )


def tag(book, name="配置标签", instruments=(), target="100"):
    return Resource.objects.create(
        tenant=book.space,
        kind="investment_tags",
        data={
            "name": name,
            "color": "#345678",
            "target_weight": target,
            "instrument_ids": [str(item.pk) for item in instruments],
        },
    )


def primary(instrument, tag):
    instrument.specification = {"allocation_tag_id": str(tag.pk)}
    instrument.save(update_fields=["specification"])


def test_comparison_includes_recorded_cash_liability_and_reference_once(book):
    post(book, "opening", amount="1000")
    loan = Account.objects.create(tenant=book.space, name="贷款", kind="loan")
    post(book, "opening", loan, amount="200")
    hold(book)
    price(book)
    post(book, "income", when=TODAY, amount="200")
    post(book, "expense", when=TODAY, amount="50")
    price(book, "12", TODAY, kind="reference")
    result = net_worth_comparison(book.space, TODAY)
    assert D(result["previous"]["net_assets"]) == D("900")
    assert D(result["estimated"]["net_assets"]) == D("1070")
    assert D(result["estimated"]["reference_delta"]) == D("20")
    assert D(result["change"]["amount"]) == D("170")
    assert D(result["change"]["known_amount"]) == D("170")
    assert result["change"]["includes_cashflows"] is True
    assert result["change"]["is_investment_return"] is False


def test_each_side_uses_its_own_fx_day_and_preserves_nav_date(book):
    usd = Account.objects.create(
        tenant=book.space, name="美元券商", kind="broker", currency="USD"
    )
    instrument = Instrument.objects.create(
        tenant=book.space, name="美元基金", code="USD-A", currency="USD"
    )
    hold(book, instrument, usd)
    price(book, "10", YESTERDAY, instrument)
    price(book, "11", TODAY, instrument, "reference")
    for when, value in [(YESTERDAY, "7"), (TODAY, "7.2")]:
        FxRate.objects.create(
            tenant=book.space,
            base="USD",
            quote="CNY",
            rate=value,
            economic_date=when,
            source="test_fx",
        )
    result = net_worth_comparison(book.space, TODAY)
    assert D(result["previous"]["net_assets"]) == D("700")
    assert D(result["estimated"]["net_assets"]) == D("792")
    assert D(result["estimated"]["reference_delta"]) == D("72")
    assert D(result["change"]["amount"]) == D("92")
    source = next(
        x
        for x in result["previous"]["source_dates"]
        if x["instrument_id"] == str(instrument.pk)
    )
    assert source["date"] == YESTERDAY
    assert source["data_state"] == "official"
    display = net_worth_comparison(book.space, TODAY, currency="USD")
    assert D(display["estimated"]["net_assets"]) == D("110")


def test_unknown_yesterday_is_not_presented_as_zero_net_worth(book):
    post(book, "opening", when=TODAY, amount="1000")
    result = net_worth_comparison(book.space, TODAY)
    assert result["previous"]["net_assets"] is None
    assert result["previous"]["completeness"] == "partial"
    assert D(result["estimated"]["net_assets"]) == D("1000")
    assert result["change"]["amount"] is None
    assert result["change"]["known_amount"] is None


@pytest.mark.parametrize("history_mode", ["snapshot_only", "unchanged_holding"])
def test_existing_holding_onboarding_does_not_invent_yesterday_zero_inside_known_account(
    book, history_mode
):
    post(book, "opening", book.broker, amount="1000")
    price(book, "10", YESTERDAY)
    price(book, "10", TODAY)
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.broker.pk),
            "instrument_id": str(book.instrument.pk),
            "as_of": TODAY,
            "purchase_date": YESTERDAY,
            "quantity": "10",
            "cost": "100",
            "history_mode": history_mode,
        },
    )
    result = net_worth_comparison(book.space, TODAY)
    assert result["previous"]["net_assets"] is None
    assert D(result["previous"]["known_net_assets"]) == D("1000")
    assert any("补录存量持仓" in gap for gap in result["previous"]["gaps"])
    assert D(result["estimated"]["net_assets"]) == D("1100")
    assert result["change"]["amount"] is None
    assert result["change"]["known_amount"] is None


def test_new_fx_coverage_is_not_presented_as_known_wealth_increase(book):
    usd = Account.objects.create(
        tenant=book.space, name="美元账户", kind="bank", currency="USD"
    )
    post(book, "opening", usd, amount="100")
    FxRate.objects.create(
        tenant=book.space,
        base="USD",
        quote="CNY",
        rate="7",
        economic_date=TODAY,
        source="new_fx",
    )
    result = net_worth_comparison(book.space, TODAY)
    assert result["previous"]["net_assets"] is None
    assert D(result["previous"]["known_net_assets"]) == D("0")
    assert D(result["estimated"]["net_assets"]) == D("700")
    assert result["change"]["amount"] is None
    assert result["change"]["known_amount"] is None
    assert result["change"]["message"]


def test_missing_formal_can_be_priced_in_estimate_without_inventing_reference_delta(
    book,
):
    post(book, "opening", amount="1000")
    hold(book)
    price(book, "12", TODAY, kind="reference")
    result = net_worth_comparison(book.space, TODAY)
    assert result["previous"]["net_assets"] is None
    assert D(result["previous"]["known_net_assets"]) == D("1000")
    assert D(result["estimated"]["net_assets"]) == D("1120")
    assert result["estimated"]["reference_delta"] is None
    assert result["change"]["amount"] is None
    assert result["change"]["known_amount"] is None


def test_futures_roll_forward_stays_partial_and_never_adds_contract_quote(book):
    post(book, "opening", amount="1000")
    futures = Account.objects.create(
        tenant=book.space, name="银河期货", kind="futures", valuation_mode="snapshot"
    )
    Snapshot.objects.create(
        tenant=book.space,
        account=futures,
        economic_date=YESTERDAY,
        equity="1000",
        currency="CNY",
        coverage="全部",
        complete=True,
        includes_options=True,
    )
    contract = Instrument.objects.create(
        tenant=book.space, name="期货合约", code="AU2612", kind="future"
    )
    price(book, "80000", TODAY, contract, "reference")
    transfer = post(
        book, "transfer", when=TODAY, amount="500", target_account_id=str(futures.pk)
    )
    result = net_worth_comparison(book.space, TODAY)
    assert D(result["previous"]["net_assets"]) == D("2000")
    assert result["estimated"]["net_assets"] is None
    assert D(result["estimated"]["known_net_assets"]) == D("2000")
    assert result["change"]["amount"] is None
    allocation = portfolio_analysis(book.space, TODAY)
    assert allocation["total_value"] is None
    assert D(allocation["known_total_value"]) == D("1500")
    assert allocation["items"][0]["instrument_id"] is None
    assert allocation["items"][0]["primary_tag_id"] is None
    Snapshot.objects.create(
        tenant=book.space,
        account=futures,
        economic_date=TODAY,
        equity="1480",
        currency="CNY",
        coverage="全部",
        complete=True,
        includes_options=True,
        included_event_ids=[str(transfer.pk)],
    )
    final = net_worth_comparison(book.space, TODAY)
    assert D(final["estimated"]["net_assets"]) == D("1980")


@pytest.mark.parametrize(
    "event_kind, expected", [("income", "1050"), ("expense", "950")]
)
def test_institution_cash_income_and_expense_need_statement_coverage(
    book, event_kind, expected
):
    futures = Account.objects.create(
        tenant=book.space, name="期货权益", kind="futures", valuation_mode="snapshot"
    )
    Snapshot.objects.create(
        tenant=book.space,
        account=futures,
        economic_date=YESTERDAY,
        equity="1000",
        currency="CNY",
        complete=True,
        includes_options=True,
    )
    event = post(book, event_kind, futures, when=TODAY, amount="50")
    rolled = net_worth_comparison(book.space, TODAY)
    assert rolled["estimated"]["net_assets"] is None
    assert D(rolled["estimated"]["known_net_assets"]) == D(expected)
    assert D(portfolio_analysis(book.space, TODAY)["known_total_value"]) == D(expected)
    statement = Snapshot.objects.create(
        tenant=book.space,
        account=futures,
        economic_date=TODAY,
        equity=expected,
        currency="CNY",
        complete=True,
        includes_options=True,
    )
    unconfirmed = net_worth_comparison(book.space, TODAY)
    assert unconfirmed["estimated"]["net_assets"] is None
    assert any("实际资金收支" in gap for gap in unconfirmed["estimated"]["gaps"])
    statement.included_event_ids = [str(event.pk)]
    statement.save(update_fields=["included_event_ids"])
    confirmed = net_worth_comparison(book.space, TODAY)
    assert D(confirmed["estimated"]["net_assets"]) == D(expected)
    assert D(confirmed["change"]["amount"]) == D(expected) - D("1000")


def test_trade_settlement_is_not_cash_only_rollforward_of_institution_equity(book):
    book.broker.valuation_mode = "snapshot"
    book.broker.save(update_fields=["valuation_mode"])
    Snapshot.objects.create(
        tenant=book.space,
        account=book.broker,
        economic_date=YESTERDAY,
        equity="1000",
        currency="CNY",
        complete=True,
        includes_options=True,
    )
    purchase = post(
        book,
        "buy",
        book.broker,
        when=TODAY,
        instrument_id=str(book.instrument.pk),
        quantity="10",
        price="10",
    )
    post(book, "settlement", book.broker, when=TODAY, related_event_id=str(purchase.pk))
    result = net_worth_comparison(book.space, TODAY)
    assert result["estimated"]["net_assets"] is None
    assert D(result["estimated"]["known_net_assets"]) == D("1000")
    assert any("settlement" in gap for gap in result["estimated"]["gaps"])


def test_overlapping_labels_do_not_duplicate_allocation_value(book):
    second = Instrument.objects.create(
        tenant=book.space, name="产品乙", code="PORTFOLIO-B"
    )
    third = Instrument.objects.create(
        tenant=book.space, name="产品丙", code="PORTFOLIO-C"
    )
    for instrument, value in [(book.instrument, "10"), (second, "20"), (third, "10")]:
        hold(book, instrument)
        price(book, value, TODAY, instrument)
    a = tag(book, "核心", [book.instrument, second], "60")
    b = tag(book, "红利", [book.instrument, third], "40")
    primary(book.instrument, a)
    primary(second, b)
    result = portfolio_analysis(book.space, TODAY)
    groups = {row["tag_id"]: row for row in result["groups"]}
    assert D(result["total_value"]) == D("400")
    assert D(groups[str(a.pk)]["value"]) == D("100")
    # The third product has only the red-dividend label and is auto-assigned.
    assert D(groups[str(b.pk)]["value"]) == D("300")
    assert D(groups[None]["value"]) == D("0")
    assert D(groups[str(a.pk)]["current_weight"]) == D("25")
    assert D(groups[str(a.pk)]["deviation_pp"]) == D("-35")
    assert D(groups[str(b.pk)]["deviation_pp"]) == D("35")
    assert (
        len(
            next(
                row
                for row in result["items"]
                if row["instrument_id"] == str(book.instrument.pk)
            )["labels"]
        )
        == 2
    )
    assert D(result["target_weight_total"]) == D("100")


def test_unknown_price_disables_allocation_percentages_instead_of_shrinking_denominator(
    book,
):
    second = Instrument.objects.create(
        tenant=book.space, name="缺价格基金", code="PORTFOLIO-MISSING"
    )
    hold(book)
    hold(book, second)
    price(book)
    a = tag(book, instruments=[book.instrument, second])
    primary(book.instrument, a)
    result = portfolio_analysis(book.space, TODAY)
    assert result["total_value"] is None
    assert D(result["known_total_value"]) == D("100")
    assert all(row["current_weight"] is None for row in result["groups"])
    assert result["status"] == "partial"


def test_reference_and_formal_mix_retains_each_items_basis(book):
    second = Instrument.objects.create(
        tenant=book.space, name="正式净值产品", code="PORTFOLIO-FORMAL"
    )
    hold(book)
    hold(book, second)
    price(book)
    price(book, "12", TODAY, kind="reference")
    price(book, "20", TODAY, second)
    result = portfolio_analysis(book.space, TODAY)
    assert D(result["total_value"]) == D("320")
    assert {row["basis"] for row in result["items"]} == {"formal", "reference"}


def test_foreign_tag_and_member_ids_cannot_expose_another_workspace(book):
    other = Workspace.objects.create(name="机密空间")
    with tenant_context(other.pk):
        hidden = Instrument.objects.create(
            tenant=other, name="不可泄露产品", code="SECRET"
        )
        foreign_tag = Resource.objects.create(
            tenant=other,
            kind="investment_tags",
            data={"name": "不可泄露标签", "instrument_ids": [str(hidden.pk)]},
        )
    hold(book)
    price(book)
    own = tag(book, instruments=[book.instrument])
    own.data["instrument_ids"].append(str(hidden.pk))
    own.save(update_fields=["data"])
    book.instrument.specification = {"allocation_tag_id": str(foreign_tag.pk)}
    book.instrument.save(update_fields=["specification"])
    result = portfolio_analysis(book.space, TODAY)
    assert "不可泄露" not in str(result)
    assert result["items"][0]["primary_tag_id"] is None
    with pytest.raises(DomainError) as rejected:
        tag_series(book.space, foreign_tag.pk, YESTERDAY, TODAY)
    assert rejected.value.status == 404


def test_tag_series_freezes_current_quantity_and_does_not_report_added_capital_as_gain(
    book,
):
    post(
        book,
        "buy",
        book.broker,
        quantity="10",
        price="10",
        instrument_id=str(book.instrument.pk),
    )
    post(
        book,
        "buy",
        book.broker,
        when=TODAY,
        quantity="10",
        price="10",
        instrument_id=str(book.instrument.pk),
    )
    price(book, "10", YESTERDAY)
    price(book, "10", TODAY)
    a = tag(book, instruments=[book.instrument])
    result = tag_series(book.space, a.pk, YESTERDAY, TODAY)
    assert [D(row["value"]) for row in result["days"]] == [D("200"), D("200")]
    assert D(result["quantity_basis"][0]["quantity"]) == D("20")
    assert D(result["summary"]["return_percent"]) == D("0")
    assert D(result["summary"]["max_drawdown_percent"]) == D("0")
    assert result["method"] == "frozen_current_quantity_formal_price"


def test_tag_series_blocks_false_split_drawdown_from_raw_nav(book):
    hold(book)
    post(
        book,
        "split",
        book.broker,
        when=TODAY,
        instrument_id=str(book.instrument.pk),
        ratio="2",
    )
    price(book, "10", YESTERDAY)
    price(book, "5", TODAY)
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.instrument.pk),
            "corporate_actions": [
                {"date": TODAY, "description": "份额折算", "source": "test_quote"}
            ],
        },
    )
    a = tag(book, instruments=[book.instrument])
    result = tag_series(book.space, a.pk, YESTERDAY, TODAY)
    assert result["status"] == "partial"
    assert result["days"][-1]["value"] is None
    assert result["summary"]["max_drawdown_percent"] is None
    assert result["summary"]["return_percent"] is None
    assert result["corporate_actions"][0]["date"] == TODAY


def test_tag_series_never_substitutes_realtime_quote_for_missing_formal_history(book):
    hold(book)
    price(book, "10", TODAY, kind="reference")
    a = tag(book, instruments=[book.instrument])
    result = tag_series(book.space, a.pk, YESTERDAY, TODAY)
    assert result["status"] == "partial"
    assert all(row["value"] is None for row in result["days"])
    assert result["summary"]["current_drawdown_percent"] is None


def test_missing_foreign_currency_conversion_is_partial_everywhere(book):
    usd = Account.objects.create(
        tenant=book.space, name="美元投资", kind="broker", currency="USD"
    )
    instrument = Instrument.objects.create(
        tenant=book.space, name="美元产品", code="PORTFOLIO-USD", currency="USD"
    )
    hold(book, instrument, usd)
    price(book, "10", YESTERDAY, instrument)
    a = tag(book, instruments=[instrument])
    assert net_worth_comparison(book.space, TODAY)["estimated"]["net_assets"] is None
    assert portfolio_analysis(book.space, TODAY)["total_value"] is None
    assert tag_series(book.space, a.pk, YESTERDAY, TODAY)["status"] == "partial"


def test_zero_foreign_holding_needs_neither_missing_nor_fresh_fx_for_allocation(book):
    hold(book)
    price(book, "10", TODAY)
    usd = Account.objects.create(
        tenant=book.space, name="零市值美元账户", kind="broker", currency="USD"
    )
    instrument = Instrument.objects.create(
        tenant=book.space, name="已归零产品", code="ZERO-USD", currency="USD"
    )
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(usd.pk),
            "instrument_id": str(instrument.pk),
            "as_of": TODAY,
            "purchase_date": YESTERDAY,
            "quantity": "10",
            "cost": "100",
            "current_value": "0",
        },
    )
    zero_tag = tag(book, instruments=[instrument])
    primary(instrument, zero_tag)
    without_fx = portfolio_analysis(book.space, TODAY)
    assert without_fx["status"] == "complete"
    assert D(without_fx["total_value"]) == D("100")
    FxRate.objects.create(
        tenant=book.space,
        base="USD",
        quote="CNY",
        rate="7",
        economic_date="2026-04-01",
        source="stale_fx",
    )
    stale_fx = portfolio_analysis(book.space, TODAY)
    assert stale_fx["status"] == "complete"
    assert D(stale_fx["total_value"]) == D("100")
    zero_group = next(
        row for row in stale_fx["groups"] if row["tag_id"] == str(zero_tag.pk)
    )
    assert D(zero_group["value"]) == D("0")
    assert D(zero_group["current_weight"]) == D("0")


def test_tag_series_weekend_keeps_last_formal_economic_date_without_false_gap(book):
    hold(book)
    price(book, "10", "2026-05-07")
    price(book, "11", "2026-05-08")
    a = tag(book, instruments=[book.instrument])
    result = tag_series(book.space, a.pk, "2026-05-07", "2026-05-10")
    assert result["status"] == "complete"
    assert result["as_of"] == "2026-05-08"
    assert result["days"][-1]["date"] == "2026-05-10"
    assert result["days"][-1]["observation_date"] == "2026-05-08"
    assert D(result["summary"]["return_percent"]) == D("10")


def test_repeated_carried_price_does_not_fabricate_two_distinct_observations(book):
    hold(book)
    price(book, "10", "2026-05-08")
    a = tag(book, instruments=[book.instrument])
    result = tag_series(book.space, a.pk, "2026-05-08", "2026-05-10")
    assert result["status"] == "partial"
    assert result["summary"]["return_percent"] is None
    assert result["as_of"] == "2026-05-08"


def test_weekend_change_uses_last_two_effective_observations(book):
    hold(book)
    price(book, "10", "2026-05-07")
    price(book, "11", "2026-05-08")
    a = tag(book, instruments=[book.instrument])
    result = tag_series(book.space, a.pk, "2026-05-07", "2026-05-10")
    assert len(result["effective_points"]) == 2
    assert D(result["change_percent"]) == D("10")
    assert D(result["summary"]["change_percent"]) == D("10")
    assert result["days"][-1]["change_percent"] is None
    assert result["days"][-1]["is_new_observation"] is False


@pytest.mark.parametrize("event_kind", ["dividend", "reinvest", "split"])
def test_recorded_corporate_action_without_provider_hint_blocks_raw_price_alert(
    book, event_kind
):
    hold(book)
    price(book, "10", YESTERDAY)
    price(book, "9", TODAY)
    values = (
        {"amount": "10"}
        if event_kind == "dividend"
        else {"quantity": "1", "price": "9"}
        if event_kind == "reinvest"
        else {"ratio": "2"}
    )
    post(
        book,
        event_kind,
        book.broker,
        when=TODAY,
        instrument_id=str(book.instrument.pk),
        **values,
    )
    a = tag(book, instruments=[book.instrument])
    result = tag_series(book.space, a.pk, YESTERDAY, TODAY)
    assert result["status"] == "partial"
    assert result["summary"]["max_drawdown_percent"] is None
    assert result["change_percent"] is None
    assert result["corporate_actions"][0]["origin"] == "ledger"
    assert result["corporate_actions"][0]["source"] == "recorded_ledger"


def test_four_year_prices_and_fx_use_constant_query_count_and_exact_values(book):
    from datetime import timedelta

    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    from wealth.common import day

    when = day()
    start = when - timedelta(days=1460)
    usd = Account.objects.create(
        tenant=book.space, name="长期美元组合", kind="broker", currency="USD"
    )
    instrument = Instrument.objects.create(
        tenant=book.space, name="长期历史产品", code="PORTFOLIO-LONG", currency="USD"
    )
    hold(book, instrument, usd)
    offsets = sorted({*range(0, 1461, 7), 1460})
    Price.objects.bulk_create(
        [
            Price(
                tenant=book.space,
                instrument=instrument,
                value=D("100") + D(offset) / D("100"),
                kind="official_nav",
                economic_date=start + timedelta(days=offset),
                source="long_history",
            )
            for offset in offsets
        ]
    )
    FxRate.objects.bulk_create(
        [
            FxRate(
                tenant=book.space,
                base="USD",
                quote="CNY",
                rate="7",
                purpose="valuation",
                economic_date=start + timedelta(days=offset),
                source="long_fx",
            )
            for offset in offsets
        ]
    )
    a = tag(book, instruments=[instrument])
    with CaptureQueriesContext(connection) as short_queries:
        short = tag_series(book.space, a.pk, start, start + timedelta(days=14))
    with CaptureQueriesContext(connection) as long_queries:
        result = tag_series(book.space, a.pk, start, when)
    assert short["status"] == result["status"] == "complete"
    assert len(long_queries) <= len(short_queries) + 1
    assert len(long_queries) <= 12
    assert len(result["days"]) == 1461
    assert D(result["current_value"]) == D("8022")
    assert D(result["summary"]["return_percent"]) == D("14.6")


def test_price_and_inverse_fx_before_start_seed_carry_without_future_observations(book):
    usd = Account.objects.create(
        tenant=book.space, name="历史美元账户", kind="broker", currency="USD"
    )
    instrument = Instrument.objects.create(
        tenant=book.space, name="逆汇率产品", code="PORTFOLIO-INVERSE", currency="USD"
    )
    hold(book, instrument, usd)
    price(book, "10", "2026-05-06", instrument)
    price(book, "11", "2026-05-08", instrument)
    price(book, "999", "2026-05-11", instrument)
    FxRate.objects.create(
        tenant=book.space,
        base="CNY",
        quote="USD",
        rate="0.125",
        economic_date="2026-05-06",
    )
    FxRate.objects.create(
        tenant=book.space, base="USD", quote="CNY", rate="9", economic_date="2026-05-11"
    )
    a = tag(book, instruments=[instrument])
    result = tag_series(book.space, a.pk, "2026-05-07", "2026-05-10")
    assert result["status"] == "complete"
    assert D(result["days"][0]["value"]) == D("800")
    assert D(result["current_value"]) == D("880")
    assert result["as_of"] == "2026-05-08"


def test_tag_series_accepts_1825_days_but_rejects_larger_window(book):
    from datetime import timedelta

    from wealth.common import day

    a = tag(book, instruments=[book.instrument])
    when = day()
    result = tag_series(book.space, a.pk, when - timedelta(days=1825), when)
    assert len(result["days"]) == 1826
    assert result["status"] == "empty"
    with pytest.raises(DomainError):
        tag_series(book.space, a.pk, when - timedelta(days=1826), when)
