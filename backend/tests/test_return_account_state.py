"""A later empty observation cannot erase realised activity or unknown scope."""

from datetime import date
from decimal import Decimal as D

import pytest
from test_empty_account_defaults import book as shared_book
from test_empty_account_defaults import movement, option_reference, snapshot
from wealth.daily_returns import ReturnEvidence, daily_return_overview
from wealth.investments import profit_calendar
from wealth.ledger import post_event
from wealth.models import Account, Event, JournalLine, PositionMovement, Snapshot
from wealth.option_positions import save_option_position
from wealth.return_account_state import cash_only_daily_return

book = shared_book
pytestmark = pytest.mark.django_db
TODAY = date(2026, 10, 2)


def observe(book):
    evidence = ReturnEvidence(book.space, TODAY)
    aid = str(book.account.pk)
    return cash_only_daily_return(
        book.space,
        book.account,
        TODAY,
        snapshots=evidence.snapshots[aid],
        cash_flows=evidence.flows[aid],
    )


@pytest.mark.parametrize("explicit_positions", [False, True])
@pytest.mark.parametrize("later_date", ["2026-09-30", "2026-10-02"])
def test_consistent_later_empty_intraday_observation_does_not_block_zero(
    book, explicit_positions, later_date
):
    details = {"positions": []} if explicit_positions else {}
    snapshot(book, valuation_basis="settlement", **details)
    latest = snapshot(book, when=later_date, valuation_basis="intraday", **details)
    models = (Event, JournalLine, PositionMovement, Snapshot)
    before = [list(model.objects.values()) for model in models]
    item = observe(book)
    assert item["amount"] == 0
    assert item["status"] == "estimated"
    assert item["basis"] == D(10000)
    assert item["quantity_source"] == "no_recorded_positions"
    assert item["price_date"] == date(2026, 9, 28)
    assert item["latest_observation_date"] == date.fromisoformat(later_date)
    assert item["observed_at"] == latest.created_at
    assert item["published_at"] is None
    assert [list(model.objects.values()) for model in models] == before


@pytest.mark.parametrize("basis", ["settlement", "intraday", "unknown"])
def test_first_same_day_empty_snapshot_is_not_proof_of_zero_day_profit(book, basis):
    snapshot(book, when=TODAY, valuation_basis=basis, positions=[])
    assert observe(book) is None


@pytest.mark.parametrize(
    "uncertainty",
    ["scope", "incomplete", "currency", "margin", "positions", "unknown", "equity"],
)
def test_later_intraday_uncertainty_cannot_be_ignored(book, uncertainty):
    snapshot(book, valuation_basis="settlement", positions=[])
    current = snapshot(book, when=TODAY, valuation_basis="intraday", positions=[])
    if uncertainty == "scope":
        current.includes_options = None
    elif uncertainty == "incomplete":
        current.complete = False
    elif uncertainty == "currency":
        current.currency = "USD"
    elif uncertainty == "equity":
        current.equity = D(10001)
    elif uncertainty == "unknown":
        current.details["valuation_basis"] = "unknown"
    elif uncertainty == "positions":
        current.details["positions"] = [{"quantity": "1"}]
    else:
        current.details["margin"] = "100"
    current.save()
    assert observe(book) is None


def test_closed_round_trip_does_not_look_like_continuous_empty_account(book):
    snapshot(book)
    instrument, _ = movement(book, "1", "2026-09-29")
    movement(book, "-1", "2026-09-30", instrument)
    snapshot(book, when=TODAY, valuation_basis="intraday", positions=[])
    assert observe(book) is None


def test_cash_flows_must_match_later_equity_and_included_event_scope(book):
    snapshot(book)
    past_income = post_event(
        book.space,
        book.user,
        {
            "kind": "income",
            "account_id": str(book.account.pk),
            "amount": "50",
            "economic_date": "2026-09-30",
        },
    )
    later = snapshot(book, when="2026-09-30", valuation_basis="intraday", positions=[])
    later.equity = D(10050)
    later.save(update_fields=["equity"])
    assert observe(book) is None
    later.included_event_ids = [str(past_income.pk)]
    later.save(update_fields=["included_event_ids"])
    for kind, amount in (("income", "500"), ("dividend", "10")):
        post_event(
            book.space,
            book.user,
            {
                "kind": kind,
                "account_id": str(book.account.pk),
                "amount": amount,
                "economic_date": str(TODAY),
            },
        )
    item = observe(book)
    assert item["amount"] == item["dividends"] == D(10)
    assert item["capital_flow"] == D(500)
    assert item["basis"] == D(10550)
    assert item["settlement_pnl"] == 0


def test_unexplained_cash_activity_requires_a_statement(book):
    snapshot(book)
    event = Event.objects.create(
        tenant=book.space,
        kind="fee",
        economic_date=TODAY,
        stage_key="unknown-cash-activity",
        revision=book.space.revision,
    )
    JournalLine.objects.create(
        tenant=book.space,
        event=event,
        account=book.account,
        code="cash",
        amount="-3",
        currency="CNY",
    )
    JournalLine.objects.create(
        tenant=book.space,
        event=event,
        account=book.account,
        code="expense",
        amount="3",
        currency="CNY",
    )
    assert observe(book) is None


def test_actual_current_profit_is_not_replaced_by_empty_account_zero(book):
    snapshot(book, when="2026-10-01", valuation_basis="settlement")
    current = snapshot(book, when=TODAY, valuation_basis="settlement", positions=[])
    current.equity = D(10100)
    current.save(update_fields=["equity"])
    assert observe(book) is None
    summary, _ = daily_return_overview(book.space, str(TODAY))
    assert D(summary["amount"]) == D(100)
    assert summary["status"] == "confirmed"


def test_mixed_account_batch_cannot_lend_another_account_equity(book):
    snapshot(book)
    other = Account.objects.create(tenant=book.space, name="另一账户", kind="futures")
    foreign = Snapshot.objects.create(
        tenant=book.space,
        account=other,
        economic_date="2026-09-30",
        equity="10000",
        currency="CNY",
        complete=True,
        includes_options=True,
    )
    evidence = ReturnEvidence(book.space, TODAY)
    assert (
        cash_only_daily_return(
            book.space,
            book.account,
            TODAY,
            snapshots=[*evidence.snapshots[str(book.account.pk)], foreign],
            cash_flows=[],
        )
        is None
    )


@pytest.mark.parametrize("included_options", [False, True])
@pytest.mark.parametrize("closed_after_anchor", [False, True])
def test_later_option_reference_cannot_be_hidden_by_market_closure(
    book, included_options, closed_after_anchor
):
    anchor = snapshot(
        book,
        when="2026-09-24",
        valuation_basis="settlement",
        calendar_id="CN_FUTURES",
    )
    anchor.includes_options = included_options
    anchor.save(update_fields=["includes_options"])
    reference = option_reference(book)  # Actual reference purchase/as_of: Sept 25.
    if closed_after_anchor:
        save_option_position(
            book.space,
            book.user,
            {
                "version": reference["version"],
                "status": "closed",
                "closed_date": "2026-09-26",
            },
            ident=reference["id"],
        )
    # A reference alone has no accounting entries. Its actual interval still
    # requires a later statement; neither closure nor today's flat state proves 0.
    assert not Event.objects.exists()
    assert not JournalLine.objects.exists()
    assert not PositionMovement.objects.exists()
    args = {"account_id": str(book.account.pk)}
    home, _ = daily_return_overview(book.space, "2026-09-26", **args)
    calendar = profit_calendar(book.space, "2026-09-26", "2026-09-26", **args)["days"][
        0
    ]
    for result in (home, calendar):
        assert result["status"] == "unavailable"
        assert result["amount"] is None
        assert result["market_closed_count"] == 0
        assert result["missing_count"] == 1
