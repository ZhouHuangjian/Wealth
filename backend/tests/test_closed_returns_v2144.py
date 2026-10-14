"""Closed sessions are distinct from missing observations and zero earnings."""

from datetime import date, datetime, timezone
from decimal import Decimal as D

import pytest
from test_daily_returns_v263 import book as shared_book
from test_daily_returns_v263 import price, trade
from wealth.daily_returns import daily_return_overview
from wealth.investments import profit_calendar
from wealth.models import Event, JournalLine, Price, Resource, Snapshot

pytestmark = pytest.mark.django_db
book = shared_book


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr("django.utils.timezone.localdate", lambda: date(2026, 10, 14))
    monkeypatch.setattr(
        "django.utils.timezone.now",
        lambda: datetime(2026, 10, 14, 4, tzinfo=timezone.utc),
    )


def observed(book, when):
    return (
        daily_return_overview(book.space, when)[0],
        profit_calendar(book.space, when, when),
    )


@pytest.mark.parametrize("when", [date(2026, 9, 25), date(2026, 9, 26)])
def test_domestic_holiday_and_weekend_are_closed_on_home_and_calendar(book, when):
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 24))
    counts = [model.objects.count() for model in (Event, JournalLine, Price, Snapshot)]
    home, calendar = observed(book, when)
    for result in (home, calendar["days"][0]):
        assert result["status"] == "market_closed"
        assert result["amount"] is None
        assert result["known_count"] == result["missing_count"] == 0
        assert result["market_closed_count"] == 1
        assert result["items"][0]["missing_reason_code"] is None
        assert "休市" in result["items"][0]["message"]
    assert calendar["summary"]["status"] == "market_closed"
    assert calendar["summary"]["missing_days"] == 0
    assert calendar["summary"]["market_closed_days"] == 1
    assert counts == [
        model.objects.count() for model in (Event, JournalLine, Price, Snapshot)
    ]


def test_missing_open_day_is_not_hidden_by_the_following_holiday(book):
    trade(book, when=date(2026, 9, 22))
    price(book, when=date(2026, 9, 23))
    home, calendar = observed(book, date(2026, 9, 25))
    for result in (home, calendar["days"][0]):
        assert result["status"] == "unavailable"
        assert result["missing_count"] == 1
        assert result["market_closed_count"] == 0


def test_formal_return_on_calendar_closed_date_stays_an_actual_observation(book):
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 24))
    price(book, when=date(2026, 9, 25), value="11")
    home, calendar = observed(book, date(2026, 9, 25))
    for result in (home, calendar["days"][0]):
        assert result["status"] == "confirmed"
        assert D(result["amount"]) == 10
        assert result["market_closed_count"] == 0


def test_mixed_market_closure_does_not_hide_missing_open_market_quote(book):
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 24))
    book.stock.market = "US"
    book.stock.save(update_fields=["market"])
    trade(book, book.stock, when=date(2026, 9, 23))
    price(book, book.stock, when=date(2026, 9, 24), kind="close")
    home, calendar = observed(book, date(2026, 9, 25))
    for result in (home, calendar["days"][0]):
        assert result["status"] == "unavailable"
        assert result["missing_count"] == result["market_closed_count"] == 1
        assert result["amount"] is None


def test_known_return_with_closed_market_is_disclosed_as_partial(book):
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 24))
    book.stock.market = "US"
    book.stock.save(update_fields=["market"])
    trade(book, book.stock, when=date(2026, 9, 23))
    price(book, book.stock, when=date(2026, 9, 24), kind="close")
    price(book, book.stock, when=date(2026, 9, 25), value="11", kind="close")
    home, calendar = observed(book, date(2026, 9, 25))
    for result in (home, calendar["days"][0]):
        assert result["status"] == "partial"
        assert result["missing_count"] == 0
        assert result["market_closed_count"] == result["known_count"] == 1
        assert result["amount"] is None
        assert D(result["known_amount"]) == 10
    assert calendar["summary"]["amount"] is None
    assert calendar["summary"]["status"] == "partial"
    assert D(calendar["summary"]["known_amount"]) == 10
    assert calendar["summary"]["return_rate"] is None
    assert calendar["summary"]["missing_days"] == 0


def test_no_price_or_unknown_calendar_does_not_become_closed(book):
    trade(book, when=date(2026, 9, 23))
    home, calendar = observed(book, date(2026, 9, 26))
    assert home["status"] == calendar["days"][0]["status"] == "unavailable"


def test_unverified_qdii_domestic_default_does_not_claim_domestic_closure(book):
    book.fund.name = "合成海外QDII"
    book.fund.specification = {"calendar_id": "CN_EXCHANGE", "qdii": True}
    book.fund.save(update_fields=["name", "specification"])
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 24))
    home, calendar = observed(book, date(2026, 9, 25))
    assert home["status"] == calendar["days"][0]["status"] == "unavailable"


def test_current_holiday_reference_is_not_used_as_formal_earnings(book):
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 24))
    price(book, when=date(2026, 9, 25), value="11", kind="estimate")
    home, _ = observed(book, date(2026, 9, 25))
    assert home["status"] == "market_closed"
    assert home["amount"] is None
    assert home["missing_count"] == 0


@pytest.mark.parametrize("scope_ok", [True, False])
def test_institution_closed_label_requires_complete_statement_scope(book, scope_ok):
    book.account.valuation_mode = "snapshot"
    book.account.save(update_fields=["valuation_mode"])
    Snapshot.objects.create(
        tenant=book.space,
        account=book.account,
        economic_date="2026-09-24",
        equity="1000",
        currency="CNY",
        complete=scope_ok,
        includes_options=True,
        details={
            "valuation_basis": "settlement",
            "calendar_id": "CN_EXCHANGE",
            "margin": "50",
        },
    )
    home, calendar = observed(book, date(2026, 9, 25))
    for result in (home, calendar["days"][0]):
        assert result["status"] == ("market_closed" if scope_ok else "unavailable")
        assert result["amount"] is None


def test_holiday_trade_keeps_its_missing_price_instead_of_being_hidden(book):
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 24))
    trade(book, when=date(2026, 9, 25))
    home, calendar = observed(book, date(2026, 9, 25))
    assert home["status"] == calendar["days"][0]["status"] == "unavailable"


def test_first_purchase_is_not_blocked_by_a_conflict_before_any_holding(book):
    price(book, when=date(2026, 9, 24))
    trade(book, when=date(2026, 9, 28))
    price(book, when=date(2026, 9, 28))
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.fund.pk),
            "nav_quarantine": {"2026-09-25": {"status": "conflict"}},
        },
    )
    home, calendar = observed(book, date(2026, 9, 28))
    for result in (home, calendar["days"][0]):
        assert result["status"] == "confirmed"
        assert D(result["amount"]) == 0
