"""Cash-only daily assumptions agree with the recorded equity projection."""

from decimal import Decimal as D

import pytest
from test_empty_account_defaults import book as shared_book
from test_empty_account_defaults import movement, snapshot
from wealth.daily_returns import daily_return_overview
from wealth.ledger import post_event
from wealth.models import Event, JournalLine, Snapshot
from wealth.portfolio import net_worth_comparison

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


@pytest.mark.parametrize(
    "restricted", ["frozen", "scope", "round_trip", "unknown_basis"]
)
def test_uncertain_or_restricted_accounts_do_not_infer_zero_return(book, restricted):
    anchor = snapshot(book)
    if restricted == "frozen":
        anchor.details["frozen_cash"] = "100"
        anchor.save(update_fields=["details"])
    elif restricted == "scope":
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
