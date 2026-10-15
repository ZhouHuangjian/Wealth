"""Cash-only daily assumptions agree with the recorded equity projection."""

from datetime import date
from decimal import Decimal as D

import pytest
from test_empty_account_defaults import book as shared_book
from test_empty_account_defaults import movement, snapshot
from wealth.daily_returns import daily_return_overview
from wealth.investments import profit_calendar
from wealth.ledger import post_event
from wealth.models import Event, JournalLine, Snapshot
from wealth.portfolio import _institution_value, net_worth_comparison

book = shared_book
pytestmark = pytest.mark.django_db
TODAY = "2026-10-02"


def observe(book):
    return daily_return_overview(book.space, TODAY)[0]


def test_cash_only_old_statement_does_not_make_today_return_incomplete(book):
    snapshot(book)
    before = (
        Event.objects.count(),
        JournalLine.objects.count(),
        Snapshot.objects.count(),
    )
    summary = observe(book)
    assert summary["status"] == "estimated" and D(summary["amount"]) == 0
    item = summary["items"][0]
    assert item["quantity_source"] == "no_recorded_positions"
    assert item["price_date"] == "2026-09-28"
    assert item["return_date"] == TODAY
    assert item["published_at"] is None and item["observed_at"]
    assert D(item["settlement_pnl"]) == 0
    assert D(net_worth_comparison(book.space, TODAY)["daily_return"]["amount"]) == 0
    assert before == (
        Event.objects.count(),
        JournalLine.objects.count(),
        Snapshot.objects.count(),
    )


def test_legacy_futures_account_mode_keeps_calendar_and_home_consistent(book):
    from wealth.investments import profit_calendar

    book.account.valuation_mode = "detailed"
    book.account.save(update_fields=["valuation_mode"])
    snapshot(book)
    home = observe(book)
    calendar = profit_calendar(book.space, TODAY, TODAY)["days"][0]
    assert home["status"] == calendar["status"] == "estimated"
    assert D(home["amount"]) == D(calendar["amount"]) == 0


def test_cash_only_funding_is_not_profit_and_recorded_dividend_is_preserved(book):
    snapshot(book)
    for kind, amount in [("income", "500"), ("dividend", "10")]:
        post_event(
            book.space,
            book.user,
            {
                "kind": kind,
                "account_id": str(book.account.pk),
                "amount": amount,
                "economic_date": TODAY,
            },
        )
    observed = observe(book)
    assert D(observed["amount"]) == 10
    item = observed["items"][0]
    assert D(item["capital_flow"]) == 500
    assert D(item["basis"]) == 10500
    assert D(item["settlement_pnl"]) == 0


@pytest.mark.parametrize("restricted", ["scope", "round_trip", "unknown_basis"])
def test_uncertain_or_restricted_accounts_do_not_infer_zero_return(book, restricted):
    anchor = snapshot(book)
    if restricted == "scope":
        anchor.includes_options = None
        anchor.save(update_fields=["includes_options"])
    elif restricted == "unknown_basis":
        anchor.details["valuation_basis"] = "unknown"
        anchor.save(update_fields=["details"])
    else:
        instrument, _ = movement(book, "1", "2026-09-29")
        movement(book, "-1", "2026-09-30", instrument)
    observed = observe(book)
    assert observed["amount"] is None
    assert observed["status"] == "unavailable"


@pytest.mark.parametrize("restriction", ["snapshot_frozen", "account_frozen"])
def test_frozen_cash_limits_withdrawal_but_does_not_create_trading_profit(
    book, restriction
):
    snapshot(book, frozen_cash="100" if restriction == "snapshot_frozen" else "0")
    if restriction == "account_frozen":
        book.account.frozen = D(100)
        book.account.save(update_fields=["frozen"])
    observed = observe(book)
    assert observed["status"] == "estimated"
    assert D(observed["amount"]) == 0
    assert D(observed["items"][0]["settlement_pnl"]) == 0
    available = _institution_value(book.space, book.account, date.fromisoformat(TODAY))
    assert available["available"] is None
    assert available["available_eligible"] is False


def test_calendar_shows_the_same_cash_only_zero_without_writing_settlements(book):
    statement = snapshot(book, valuation_basis="settlement", calendar_id="CN_FUTURES")
    facts_before = [
        list(model.objects.values()) for model in (Event, JournalLine, Snapshot)
    ]
    calendar = profit_calendar(book.space, TODAY, TODAY)
    result = calendar["days"][0]
    assert result["status"] == "estimated"
    assert D(result["amount"]) == D(observe(book)["amount"]) == 0
    item = result["items"][0]
    assert item["quantity_source"] == "no_recorded_positions"
    assert item["source"] == "cash_only_carry_forward"
    assert item["price_date"] == "2026-09-28"
    assert item["return_date"] == TODAY
    assert item["published_at"] is None
    assert [
        list(model.objects.values()) for model in (Event, JournalLine, Snapshot)
    ] == facts_before
    statement.refresh_from_db()
    assert statement.economic_date == date(2026, 9, 28)


def test_calendar_empty_after_closing_keeps_actual_profit_and_fees(book):
    snapshot(book, when="2026-10-01", positions=[{"quantity": "1"}])
    current = snapshot(book, when=TODAY, positions=[])
    current.equity = D(10097)  # 100 realised profit less 3 institution fees.
    current.save(update_fields=["equity"])
    calendar = profit_calendar(book.space, TODAY, TODAY)["days"][0]
    assert calendar["status"] == "confirmed"
    assert D(calendar["amount"]) == D(observe(book)["amount"]) == D(97)
    assert calendar["items"][0]["source"] == "institution_snapshot"
