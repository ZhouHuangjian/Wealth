"""Daily P&L must not relabel capital, old NAVs or uncovered equity as earnings."""

from datetime import date, timedelta
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from wealth.common import tenant_context
from wealth.daily_returns import daily_return_overview
from wealth.investment_trades import record_trade
from wealth.investments import holdings_summary, record_holding
from wealth.ledger import post_event
from wealth.models import (
    Account,
    Event,
    FxRate,
    Instrument,
    Membership,
    Price,
    Resource,
    Snapshot,
    Workspace,
)
from wealth.portfolio import net_worth_comparison

pytestmark = pytest.mark.django_db
TODAY = date(2026, 9, 24)
PRIOR = TODAY - timedelta(days=1)


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    user = get_user_model().objects.create_user("daily-return-owner")
    space = Workspace.objects.create(name="日收益回归")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(tenant=space, name="证券账户", kind="broker")
        fund = Instrument.objects.create(
            tenant=space, name="境内基金", code="QA263", kind="fund", market="CN"
        )
        stock = Instrument.objects.create(
            tenant=space, name="合成股票", code="QA263S", kind="stock", market="CN"
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(account.pk),
                "amount": "10000",
                "economic_date": "2026-08-03",
            },
        )
        yield SimpleNamespace(
            space=space, user=user, account=account, fund=fund, stock=stock
        )


def trade(book, instrument=None, when=PRIOR, **extra):
    return record_trade(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str((instrument or book.fund).pk),
            "side": "buy",
            "quantity": "10",
            "price": "10",
            "economic_date": str(when),
            **extra,
        },
    )


def price(book, instrument=None, when=PRIOR, value="10", kind="official_nav"):
    return Price.objects.create(
        tenant=book.space,
        instrument=instrument or book.fund,
        economic_date=when,
        value=value,
        kind=kind,
        source="synthetic",
    )


def result(book, when=TODAY, currency=None):
    return daily_return_overview(book.space, when, currency)[0]


def test_today_estimate_excludes_cashflows_pending_buys_and_cost_returns(book):
    trade(book)
    price(book)
    price(book, when=TODAY, value="11", kind="estimate")
    post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(book.account.pk),
            "amount": "500",
            "economic_date": str(TODAY),
        },
    )
    post_event(
        book.space,
        book.user,
        {
            "kind": "fund_debit",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "amount": "70",
            "economic_date": str(TODAY),
        },
    )
    observed = result(book)
    assert observed["status"] == "estimated"
    assert D(observed["amount"]) == 10
    assert D(observed["return_rate"]) == D("0.1")
    assert D(net_worth_comparison(book.space, TODAY)["daily_return"]["amount"]) == 10
    holding = holdings_summary(book.space, TODAY)["items"][0]
    assert D(holding["daily_return"]["amount"]) == 10
    assert holding["latest_confirmed_return"]["date"] == str(PRIOR)


def test_same_day_buy_and_sale_deduct_actual_capital_and_keep_closed_profit(book):
    trade(book, book.stock)
    price(book, book.stock, kind="close")
    trade(book, book.stock, when=TODAY, quantity="5", price="10")
    trade(book, book.stock, when=TODAY, side="sell", quantity="3", price="12", fee="1")
    price(book, book.stock, when=TODAY, value="11", kind="market")
    # 12*11 - 10*10 - (50 - 35) = 17, not change in cost or household cash.
    assert D(result(book)["amount"]) == 17
    trade(book, book.stock, when=TODAY, side="sell", quantity="12", price="11")
    assert D(result(book)["amount"]) == 17


def test_formal_today_supersedes_estimate_and_partial_has_known_subtotal(book):
    trade(book)
    price(book)
    price(book, when=TODAY, value="11", kind="estimate")
    price(book, when=TODAY, value="10.5")
    assert result(book)["status"] == "confirmed"
    assert D(result(book)["amount"]) == 5
    trade(book, book.stock)
    observed = result(book)
    assert observed["status"] == "partial" and observed["amount"] is None
    assert D(observed["known_amount"]) == 5
    assert (
        observed["known_count"],
        observed["total_count"],
        observed["missing_count"],
    ) == (1, 2, 1)


def test_old_qdii_nav_remains_on_its_day_and_missing_open_day_blocks_today(book):
    book.fund.name = "摩根标普500指数"
    book.fund.code = "017641"
    book.fund.save()
    trade(book, when=date(2026, 9, 22))
    price(book, when=PRIOR)
    price(book, when=TODAY, value="10.5")
    monday = date(2026, 9, 28)
    observed = result(book, monday)
    assert observed["amount"] is None
    holding = holdings_summary(book.space, monday)["items"][0]
    assert holding["latest_confirmed_return"]["date"] == str(TODAY)
    assert D(holding["latest_confirmed_return"]["amount"]) == 5
    price(book, when=monday, value="11", kind="estimate")
    observed = result(book, monday)
    assert (
        observed["amount"] is None
        and "缺少交易日行情" in observed["items"][0]["message"]
    )
    # September 25 is a US open day despite China's Mid-Autumn closure.
    price(book, when=date(2026, 9, 25), value="10.8")
    assert D(result(book, monday)["amount"]) == 2


def test_known_chinese_holiday_crossing_allowed_but_holiday_quote_not_today(book):
    trade(book)
    price(book)
    price(book, when=TODAY, value="10.5")
    monday = date(2026, 9, 28)
    price(book, when=monday, value="11", kind="estimate")
    assert D(result(book, monday)["amount"]) == 5
    holiday = date(2026, 9, 25)
    price(book, when=holiday, value="11", kind="estimate")
    observed = result(book, holiday)
    assert observed["amount"] is None and "休市" in observed["items"][0]["message"]


def test_stale_quote_and_missing_baseline_never_become_zero(book):
    trade(book)
    price(book, when=TODAY, value="11", kind="estimate")
    assert result(book)["known_amount"] is None
    price(book)
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={"instrument_id": str(book.fund.pk), "refresh_status": "failed"},
    )
    observed = result(book)
    assert observed["status"] == "unavailable" and observed["amount"] is None


def test_display_currency_converts_native_return_without_fx_gain(book):
    book.stock.currency, book.stock.market = "USD", "US"
    book.stock.save()
    # An independently opened USD account avoids mixed-currency cash records.
    account = Account.objects.create(
        tenant=book.space, name="美元证券", kind="broker", currency="USD"
    )
    book.account = account
    post_event(
        book.space,
        book.user,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "currency": "USD",
            "amount": "1000",
            "economic_date": str(PRIOR),
        },
    )
    trade(book, book.stock)
    price(book, book.stock, kind="close")
    price(book, book.stock, when=TODAY, value="11", kind="market")
    FxRate.objects.create(
        tenant=book.space, base="USD", quote="CNY", rate="7", economic_date=PRIOR
    )
    FxRate.objects.create(
        tenant=book.space, base="USD", quote="CNY", rate="7.1", economic_date=TODAY
    )
    observed = result(book)
    assert D(observed["amount"]) == 71 and D(observed["items"][0]["amount"]) == 10
    assert D(result(book, currency="USD")["amount"]) == 10
    assert (
        D(net_worth_comparison(book.space, TODAY, "USD")["daily_return"]["amount"])
        == 10
    )
    missing = result(book, currency="HKD")
    assert missing["amount"] is None and D(missing["items"][0]["amount"]) == 10


def test_institution_return_subtracts_external_income_but_keeps_dividend_once(book):
    account = Account.objects.create(
        tenant=book.space, name="机构总权益", kind="broker", valuation_mode="snapshot"
    )
    Snapshot.objects.create(
        tenant=book.space,
        account=account,
        economic_date=PRIOR,
        equity="1000",
        currency="CNY",
        complete=True,
        includes_options=True,
        coverage="全部",
        details={"valuation_basis": "settlement", "calendar_id": "CN_EXCHANGE"},
    )
    inflow = post_event(
        book.space,
        book.user,
        {
            "kind": "transfer",
            "account_id": str(book.account.pk),
            "target_account_id": str(account.pk),
            "amount": "100",
            "economic_date": str(TODAY),
        },
    )
    income = post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(account.pk),
            "amount": "50",
            "economic_date": str(TODAY),
        },
    )
    dividend = post_event(
        book.space,
        book.user,
        {
            "kind": "dividend",
            "account_id": str(account.pk),
            "amount": "10",
            "economic_date": str(TODAY),
        },
    )
    current = Snapshot.objects.create(
        tenant=book.space,
        account=account,
        economic_date=TODAY,
        equity="1180",
        currency="CNY",
        complete=True,
        includes_options=True,
        coverage="全部",
        included_event_ids=[str(inflow.pk), str(income.pk), str(dividend.pk)],
        details={"valuation_basis": "intraday", "calendar_id": "CN_EXCHANGE"},
    )
    observed = result(book)
    assert observed["status"] == "estimated" and D(observed["amount"]) == 30
    assert observed["total_count"] == 1
    current.includes_options = None
    current.save()
    assert result(book)["amount"] is None
    current.includes_options = True
    current.included_event_ids = [str(inflow.pk)]
    current.save()
    assert "资金流水" in result(book)["items"][0]["message"]


def test_snapshot_products_are_not_counted_twice_and_reference_options_missing(book):
    trade(book)
    price(book)
    price(book, when=TODAY, value="11", kind="estimate")
    book.account.valuation_mode = "snapshot"
    book.account.save()
    for when, equity in [(PRIOR, "1000"), (TODAY, "1005")]:
        Snapshot.objects.create(
            tenant=book.space,
            account=book.account,
            economic_date=when,
            equity=equity,
            currency="CNY",
            complete=True,
            includes_options=True,
            coverage="全部",
        )
    # The existing fund payment is not declared in snapshot inclusion, so no invented total.
    assert result(book)["amount"] is None
    included = [
        str(ident)
        for ident in Event.objects.filter(
            tenant=book.space, kind="fund_debit"
        ).values_list("pk", flat=True)
    ]
    Snapshot.objects.filter(tenant=book.space, account=book.account).update(
        included_event_ids=included
    )
    observed = result(book)
    assert D(observed["amount"]) == 5 and observed["total_count"] == 1
    book.account.valuation_mode = "ledger"
    book.account.save()
    Resource.objects.create(
        tenant=book.space,
        kind="option_positions",
        data={
            "account_id": str(book.account.pk),
            "instrument_id": str(book.stock.pk),
            "as_of": str(PRIOR),
            "status": "active",
        },
    )
    observed = result(book)
    assert observed["status"] == "partial" and D(observed["known_amount"]) == 10


def test_batch_query_count_does_not_grow_per_product_and_spaces_are_isolated(book):
    trade(book)
    price(book)
    price(book, when=TODAY, value="11", kind="estimate")
    with CaptureQueriesContext(connection) as queries:
        observed = result(book)
    initial_count = len(queries)
    other = Workspace.objects.create(name="另一个空间")
    with tenant_context(other.pk):
        foreign = Instrument.objects.create(
            tenant=other, name="不属于本空间", code="FOREIGN", kind="fund"
        )
        Price.objects.create(
            tenant=other,
            instrument=foreign,
            economic_date=TODAY,
            value="999",
            kind="estimate",
        )
    for index in range(5):
        product = Instrument.objects.create(
            tenant=book.space,
            name=f"合成基金{index}",
            code=f"QA263{index}",
            kind="fund",
            market="CN",
        )
        trade(book, product)
        price(book, product)
        price(book, product, when=TODAY, value="11", kind="estimate")
    with CaptureQueriesContext(connection) as queries:
        observed = result(book)
    assert len(queries) == initial_count
    assert observed["total_count"] == 6 and D(observed["amount"]) == 60
    assert str(foreign.pk) not in {row["instrument_id"] for row in observed["items"]}


def test_late_tags_are_returned_without_secondary_frontend_requests(book):
    trade(book)
    tag = Resource.objects.create(
        tenant=book.space,
        kind="investment_tags",
        data={"name": "红利低波", "instrument_ids": [str(book.fund.pk)]},
    )
    assert holdings_summary(book.space, TODAY)["items"][0]["labels"] == [
        {"id": str(tag.pk), "name": "红利低波"}
    ]


def test_new_opening_without_prior_holding_does_not_invent_zero_daily_return(book):
    record_holding(
        book.space,
        book.user,
        {
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "quantity": "10",
            "cost": "100",
            "as_of": str(TODAY),
        },
    )
    price(book)
    price(book, when=TODAY, value="11", kind="estimate")
    observed = result(book)
    assert observed["amount"] is None
    assert "期初持仓" in observed["items"][0]["message"]
