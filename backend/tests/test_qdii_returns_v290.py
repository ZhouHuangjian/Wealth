"""Known confirmations backfill economic returns, never historical cash facts."""

from datetime import date, datetime, timezone
from decimal import Decimal as D

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from test_daily_returns_v263 import book as shared_book
from test_daily_returns_v263 import price, result, trade
from wealth.daily_returns import daily_return_overview
from wealth.investments import profit_calendar
from wealth.ledger import balance, position, post_event, reverse_event
from wealth.models import Event, JournalLine, PositionMovement
from wealth.pending_purchases import PendingPurchases
from wealth.valuation_calendar import return_calendar, valuation_calendar

book = shared_book
pytestmark = pytest.mark.django_db
BUY, NEXT, CONFIRM = date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30)


def subscription(
    book, *, nav_date=str(BUY), fee="0", automatic=False, confirm=True, debit=None
):
    if debit is None:
        debit = post_event(
            book.space,
            book.user,
            {
                "kind": "fund_debit",
                "account_id": str(book.account.pk),
                "instrument_id": str(book.fund.pk),
                "amount": "100",
                "economic_date": str(BUY),
            },
        )
    if not confirm:
        return debit, None
    data = {
        "kind": "fund_confirm",
        "account_id": str(book.account.pk),
        "instrument_id": str(book.fund.pk),
        "related_event_id": str(debit.pk),
        "economic_date": str(CONFIRM),
        "quantity": str(D(100) - D(fee)),
        "price": "1",
        "fee": fee,
    }
    if nav_date is not None:
        data["nav_date"] = nav_date
    extra = {}
    if automatic:
        data.update(automatic_estimate=True, fund_order_id="synthetic-order")
        extra["stage_key"] = f"{book.space.pk}:fund-order:synthetic-order:confirm:1"
    return debit, post_event(book.space, book.user, data, **extra)


def navs(book):
    price(book, when=BUY, value="1")
    price(book, when=NEXT, value="1.1")
    return price(book, when=CONFIRM, value="1.2")


def set_qdii(book):
    book.fund.code, book.fund.name = "017641", "摩根标普500指数(QDII)"
    book.fund.save(update_fields=["code", "name"])


@pytest.mark.parametrize("qdii", [False, True])
def test_confirmed_fund_backfills_nav_day_returns_without_moving_cash(book, qdii):
    if qdii:
        set_qdii(book)
    _, confirmation = subscription(book)
    navs(book)
    counts = (
        Event.objects.count(),
        JournalLine.objects.count(),
        PositionMovement.objects.count(),
    )
    assert position(book.space, book.account, book.fund, NEXT)[0] == 0
    assert balance(book.space, book.account, "fund_transit", NEXT) == 100
    assert PendingPurchases(book.space, NEXT).items[0]["amount"] == 100
    calendar = profit_calendar(book.space, str(BUY), str(CONFIRM))
    assert [D(row["amount"]) for row in calendar["days"]] == [0, 10, 10]
    for row in calendar["days"]:
        summary = result(book, date.fromisoformat(row["date"]))
        assert D(summary["amount"]) == D(row["amount"])
        assert summary["items"][0]["return_date"] == row["date"]
        assert summary["items"][0]["uses_trade_nav_dates"]
    confirmation.refresh_from_db()
    assert confirmation.economic_date == CONFIRM
    assert balance(book.space, book.account, "fund_transit", NEXT) == 100
    assert balance(book.space, book.account, "cash", NEXT) == 9900
    assert counts == (
        Event.objects.count(),
        JournalLine.objects.count(),
        PositionMovement.objects.count(),
    )


def test_backfilled_purchase_fee_occurs_once_on_trade_nav_day(book):
    subscription(book, fee="1")
    navs(book)
    calendar = profit_calendar(book.space, str(BUY), str(CONFIRM))
    assert [D(row["amount"]) for row in calendar["days"]] == [-1, D("9.9"), D("9.9")]
    assert D(calendar["summary"]["amount"]) == D("18.8")


def test_unconfirmed_and_reversed_shares_do_not_backfill_returns(book):
    _, confirmed = subscription(book)
    navs(book)
    reverse_event(book.space, book.user, confirmed, "错误确认撤销")
    assert result(book, NEXT)["status"] == "no_position"
    assert result(book, CONFIRM)["status"] == "no_position"
    calendar = profit_calendar(book.space, str(BUY), str(CONFIRM))
    assert all(row["status"] == "no_position" for row in calendar["days"])
    assert PendingPurchases(book.space, CONFIRM).items[0]["amount"] == 100


@pytest.mark.parametrize(
    "nav_date", ["invalid", "2026-10-01", "2026-09-01", "2026-07-01"]
)
def test_invalid_nav_date_is_not_guessed_or_given_false_profit(book, nav_date):
    _, confirmation = subscription(book, nav_date=nav_date)
    navs(book)
    assert result(book, NEXT)["status"] == "no_position"
    observed = result(book, CONFIRM)
    assert observed["amount"] is None
    assert "净值日期" in observed["items"][0]["message"]
    calendar = profit_calendar(book.space, str(CONFIRM), str(CONFIRM))
    assert calendar["days"][0]["amount"] is None
    assert result(book, date(2026, 9, 1))["status"] == "no_position"
    confirmation.refresh_from_db()
    assert confirmation.payload["nav_date"] == nav_date
    assert confirmation.economic_date == CONFIRM


def test_legacy_confirmation_without_nav_date_keeps_recorded_date(book):
    subscription(book, nav_date=None)
    navs(book)
    assert result(book, NEXT)["status"] == "no_position"
    assert not result(book, CONFIRM)["items"][0]["uses_trade_nav_dates"]


def test_exchange_fund_confirmation_does_not_use_offexchange_backfill(book):
    book.fund.specification = {"trading_channel": "exchange"}
    book.fund.save(update_fields=["specification"])
    subscription(book)
    navs(book)
    assert result(book, NEXT)["status"] == "no_position"


def test_computed_shares_keep_same_provenance_in_calendar_and_latest_return(book):
    subscription(book, automatic=True)
    navs(book)
    summary, holdings = daily_return_overview(book.space, NEXT)
    calendar = profit_calendar(book.space, str(NEXT), str(NEXT))
    latest = holdings[(str(book.account.pk), str(book.fund.pk))][
        "latest_confirmed_return"
    ]
    for item in (summary["items"][0], latest, calendar["days"][0]["items"][0]):
        assert item["status"] == "estimated"
        assert item["price_basis"] == "formal"
        assert item["quantity_source"] == "automatic_estimate"
        assert D(item["amount"]) == 10
    assert calendar["days"][0]["status"] == "estimated"
    assert calendar["buckets"][0]["status"] == "estimated"
    assert calendar["summary"]["status"] == "estimated"


def test_recent_nav_return_is_visible_without_entering_today_total(book):
    set_qdii(book)
    subscription(book)
    quote = navs(book)
    quote.published_at = datetime(2026, 10, 2, 2, tzinfo=timezone.utc)
    quote.save(update_fields=["published_at"])
    observed = result(book, date(2026, 10, 2))
    assert observed["amount"] is None and observed["known_amount"] is None
    item = observed["items"][0]
    latest = item["latest_formal_return"]
    assert "latest_formal_return" not in latest
    assert D(latest["amount"]) == 10
    assert latest["return_date"] == latest["nav_date"] == str(CONFIRM)
    assert latest["published_at"] == str(quote.published_at)
    assert latest["observed_at"] == str(quote.created_at)
    quote.published_at = None
    quote.save(update_fields=["published_at"])
    refreshed = result(book, date(2026, 10, 2))["items"][0]["latest_formal_return"]
    assert refreshed["published_at"] is None
    assert refreshed["observed_at"] == str(quote.created_at)


def test_qdii_formal_gap_does_not_infer_cadence_but_reference_remains_usable(book):
    set_qdii(book)
    assert return_calendar(book.fund) is None
    assert (
        valuation_calendar(book.fund)
        == return_calendar(book.fund, estimated=True)
        == "US_EQUITIES"
    )
    trade(book, when=date(2026, 9, 23))
    price(book, when=date(2026, 9, 25), value="10")
    estimate = price(book, when=BUY, value="11", kind="estimate")
    assert D(result(book, BUY)["amount"]) == 10
    estimate.delete()
    price(book, when=BUY, value="11")
    assert result(book, BUY)["amount"] is None
    assert profit_calendar(book.space, str(BUY), str(BUY))["days"][0]["amount"] is None
    book.fund.specification = {"calendar_id": "US_EQUITIES"}
    book.fund.save(update_fields=["specification"])
    assert D(result(book, BUY)["amount"]) == 10


def test_unconfirmed_payment_alone_is_pending_and_has_no_position_return(book):
    subscription(book, confirm=False)
    navs(book)
    assert result(book, CONFIRM)["status"] == "no_position"
    assert PendingPurchases(book.space, CONFIRM).items[0]["amount"] == 100


def test_existing_holding_sale_and_dividend_during_confirmation_delay(book):
    trade(book, when=date(2026, 9, 24), quantity="50", price="1")
    price(book, when=date(2026, 9, 24), value="1")
    debit, _ = subscription(book, confirm=False)
    trade(book, when=NEXT, side="sell", quantity="20", price="1.1", fee="1")
    post_event(
        book.space,
        book.user,
        {
            "kind": "dividend",
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "amount": "5",
            "economic_date": str(NEXT),
        },
    )
    subscription(book, debit=debit)
    navs(book)
    calendar = profit_calendar(book.space, str(BUY), str(CONFIRM))
    # 150 shares appreciate by .10, less 1 sale fee, plus 5 cash dividend.
    # The 130 remaining shares gain another .10 on the confirmation date.
    assert [D(row["amount"]) for row in calendar["days"]] == [0, 19, 13]
    assert D(result(book, NEXT)["amount"]) == 19
    assert D(result(book, CONFIRM)["amount"]) == 13
    assert position(book.space, book.account, book.fund, NEXT)[0] == 30
    assert PendingPurchases(book.space, NEXT).items[0]["amount"] == 100


def test_future_confirmation_never_backfills_before_it_is_known(book, monkeypatch):
    subscription(book)
    navs(book)
    monkeypatch.setattr("django.utils.timezone.localdate", lambda *args, **kwargs: NEXT)
    assert result(book, NEXT)["status"] == "no_position"
    calendar = profit_calendar(book.space, str(BUY), str(NEXT))
    assert all(row["status"] == "no_position" for row in calendar["days"])
    assert PendingPurchases(book.space, NEXT).items[0]["amount"] == 100
    monkeypatch.setattr(
        "django.utils.timezone.localdate", lambda *args, **kwargs: CONFIRM
    )
    assert D(result(book, NEXT)["amount"]) == 10


def test_confirmation_relationships_are_loaded_in_a_single_batch(book):
    subscription(book)
    navs(book)
    with CaptureQueriesContext(connection) as before:
        first = result(book, NEXT)
    for _ in range(9):
        subscription(book)
    with CaptureQueriesContext(connection) as after:
        many = result(book, NEXT)
    assert D(first["amount"]) == 10 and D(many["amount"]) == 100
    assert len(after) == len(before)
