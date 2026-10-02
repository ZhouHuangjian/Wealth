"""Trading dates, publication dates and computed holdings retain separate meaning."""

from datetime import date, datetime, timezone
from decimal import Decimal as D

import pytest
from test_daily_returns_v263 import book as shared_book
from test_daily_returns_v263 import price, result, trade
from wealth import market_data
from wealth.daily_returns import daily_return_overview
from wealth.fund_orders import detail, list_orders, save_order
from wealth.models import Resource
from wealth.reporting import overview
from wealth.valuation_calendar import open_days_between, valuation_calendar

book = shared_book
pytestmark = pytest.mark.django_db


def test_long_chinese_holiday_preserves_last_nav_and_next_daily_return(
    book, monkeypatch
):
    monkeypatch.setattr(
        market_data, "_now", lambda: datetime(2026, 10, 8, 2, tzinfo=timezone.utc)
    )
    observed = market_data._quote(
        book.fund, price="10", kind="official_nav", economic_date="2026-09-30"
    )
    assert observed["status"] == "ok"
    assert observed["economic_date"] == "2026-09-30"
    trade(book, when=date(2026, 9, 29))
    price(book, when=date(2026, 9, 30))
    price(book, when=date(2026, 10, 8), value="11")
    assert D(result(book, date(2026, 10, 8))["amount"]) == 10


def test_qdii_nav_uses_overseas_valuation_calendar_not_cn_subscription_closure(
    book, monkeypatch
):
    book.fund.name, book.fund.code = "摩根标普500指数(QDII)", "017641"
    book.fund.save()
    assert valuation_calendar(book.fund) == "US_EQUITIES"
    assert open_days_between(date(2026, 9, 30), date(2026, 10, 9), "US_EQUITIES") == 7
    monkeypatch.setattr(
        market_data, "_now", lambda: datetime(2026, 10, 9, 20, tzinfo=timezone.utc)
    )
    quote = market_data._quote(
        book.fund, price="10", kind="official_nav", economic_date="2026-09-30"
    )
    assert quote["status"] == "ok"
    assert quote["data_state"] == "latest_available"
    assert quote["economic_date"] == "2026-09-30"
    book.fund.specification = {"trading_channel": "exchange"}
    assert valuation_calendar(book.fund) == "CN_EXCHANGE"


def test_unknown_calendar_never_guesses_a_weekday(book, monkeypatch):
    monkeypatch.setattr(
        market_data, "_now", lambda: datetime(2027, 1, 12, 2, tzinfo=timezone.utc)
    )
    quote = market_data._quote(
        book.fund, price="10", kind="official_nav", economic_date="2027-01-04"
    )
    assert quote["data_state"] == "calendar_unknown"
    assert quote["price"] is not None
    assert open_days_between(date(2027, 1, 4), date(2027, 1, 12), "CN_EXCHANGE") is None


def order(book, **extra):
    book.fund.code = "020602"
    book.fund.save(update_fields=["code"])
    return save_order(
        book.space,
        book.user,
        {
            "instrument_id": str(book.fund.pk),
            "account_id": str(book.account.pk),
            "application_date": "2026-09-23",
            "amount": "10",
            "status": "paid",
            "funding_source": "untracked",
            "auto_estimate": True,
            "fee_mode": "zero",
            **extra,
        },
    )


def test_normal_wait_and_computed_shares_do_not_require_period_confirmation(book):
    pending = order(book)
    assert pending["status"] == "paid"
    assert not pending["requires_action"], pending.get("note")
    assert list_orders(book.space, pending=True)["count"] == 0
    price(book, value="2")
    completed = order(book)
    assert completed["status"] == "estimated"
    assert not completed["requires_action"]
    assert list_orders(book.space, pending=True)["count"] == 0
    assert not [
        r for r in overview(book.space)["todos"] if r.get("kind") == "fund_order"
    ]
    price(book, when=date(2026, 9, 24), value="2.1")
    _, holdings = daily_return_overview(book.space, date(2026, 9, 24))
    latest = holdings[(str(book.account.pk), str(book.fund.pk))][
        "latest_confirmed_return"
    ]
    assert latest["status"] == "estimated"
    assert latest["observation_kind"] == "formal"
    assert latest["quantity_source"] == "automatic_estimate"
    assert latest["amount"] is not None


def test_unknown_fee_or_real_conflict_remains_one_action(book):
    missing_fee = order(book, fee_mode="unknown")
    assert missing_fee["requires_action"]
    current = Resource.objects.get(pk=missing_fee["id"])
    current.data.update(fee_mode="zero", needs_review=True)
    current.save()
    assert detail(current)["requires_action"]
    assert list_orders(book.space, pending=True)["count"] == 1


def test_return_calendar_does_not_spread_missing_open_days_into_one_day(book):
    from wealth.investments import profit_calendar

    trade(book, when=date(2026, 9, 29))
    price(book, when=date(2026, 9, 30))
    price(book, when=date(2026, 10, 13), value="11")
    calendar = profit_calendar(book.space, "2026-10-01", "2026-10-13")
    observed = next(row for row in calendar["days"] if row["date"] == "2026-10-13")
    assert observed["amount"] is None
