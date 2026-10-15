"""Independent closure regressions: activity and incomplete evidence stay visible.

Most scenarios use unsaved model values and in-memory observations. The explicitly
DB-marked scenarios cover caller queries rather than bypassing their filters.
"""

from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from test_daily_returns_v263 import book as shared_book
from test_daily_returns_v263 import price, trade
from wealth.daily_returns import ReturnEvidence, daily_return_overview
from wealth.investments import _aggregate_days, _calendar_item, profit_calendar
from wealth.ledger import post_event
from wealth.models import Account, Instrument, Resource, Snapshot

book = shared_book
ANCHOR = date(2026, 9, 24)
HOLIDAY = date(2026, 9, 25)
WEEKEND = date(2026, 9, 26)


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch):
    monkeypatch.setattr("django.utils.timezone.localdate", lambda: date(2026, 10, 14))
    monkeypatch.setattr(
        "django.utils.timezone.now",
        lambda: datetime(2026, 10, 14, 4, tzinfo=timezone.utc),
    )


def daily_row(status, *, amount=None, known=None, missing=0, closed=0):
    return {
        "status": status,
        "amount": amount,
        "known_amount": known,
        "return_rate": D("0.01") if amount is not None else None,
        "missing_count": missing,
        "market_closed_count": closed,
    }


@pytest.mark.parametrize("known", [D(5), D(0), D(-5)])
def test_period_keeps_mixed_known_and_closed_day_partial(known):
    result = _aggregate_days([daily_row("partial", known=known, closed=1)])
    assert result["status"] == "partial"
    assert result["amount"] is result["return_rate"] is None
    assert result["known_amount"] == known
    assert result["missing_days"] == 0
    assert result["market_closed_days"] == 1


def test_a_wholly_closed_day_does_not_erase_another_complete_observed_day():
    result = _aggregate_days(
        [
            daily_row("confirmed", amount=D(5), known=D(5)),
            daily_row("market_closed", closed=1),
        ]
    )
    assert result["status"] == "confirmed" and result["amount"] == 5
    assert result["observed_days"] == result["market_closed_days"] == 1
    assert result["missing_days"] == 0
    assert result["return_rate"] is None


def test_open_day_missing_evidence_is_not_cancelled_by_a_closed_day():
    result = _aggregate_days(
        [daily_row("unavailable", missing=1), daily_row("market_closed", closed=1)]
    )
    assert result["status"] == "unavailable" and result["amount"] is None
    assert result["missing_days"] == result["market_closed_days"] == 1


def snapshot_evidence(*, includes_options=True):
    account = Account(name="合成机构账户", currency="CNY", valuation_mode="snapshot")
    aid = str(account.pk)
    previous = Snapshot(
        account=account,
        economic_date=ANCHOR,
        equity=D(1000),
        currency="CNY",
        complete=True,
        includes_options=includes_options,
        details={
            "valuation_basis": "settlement",
            "calendar_id": "CN_EXCHANGE",
            "no_option_positions": not includes_options,
            "margin": "50",
        },
    )
    evidence = object.__new__(ReturnEvidence)
    evidence.space = SimpleNamespace(pk="synthetic-space")
    evidence.snapshot_accounts = {aid: account}
    evidence.snapshots = {aid: [previous]}
    evidence.recording_modes = {aid: "transactions"}
    evidence.movements = defaultdict(list)
    evidence.flows = defaultdict(list)
    evidence.option_versions = defaultdict(list)
    return evidence, aid


def test_institution_with_no_intervening_activity_can_report_closed():
    evidence, aid = snapshot_evidence()
    result = evidence.snapshot(aid, WEEKEND, allow_cash_carry_forward=False)
    assert result["status"] == "market_closed"
    assert result["amount"] is None and result["missing_reason_code"] is None


@pytest.mark.parametrize("date_key", ["purchase_date", "as_of", "closed_date"])
def test_option_activity_after_statement_prevents_institution_closed_label(date_key):
    evidence, aid = snapshot_evidence()
    data = {"as_of": str(ANCHOR), "status": "active", date_key: str(HOLIDAY)}
    evidence.option_versions[aid] = [[(1, data)]]
    result = evidence.snapshot(aid, WEEKEND, allow_cash_carry_forward=False)
    assert result["status"] == "unavailable" and result["amount"] is None


def test_statement_excluding_options_cannot_close_an_account_with_active_options():
    evidence, aid = snapshot_evidence(includes_options=False)
    evidence.option_versions[aid] = [[(1, {"as_of": str(ANCHOR), "status": "active"})]]
    result = evidence.snapshot(aid, WEEKEND, allow_cash_carry_forward=False)
    assert result["status"] == "unavailable"


def test_position_activity_after_statement_prevents_institution_closed_label():
    evidence, aid = snapshot_evidence()
    evidence.movements[(aid, "product")] = [{"date": HOLIDAY}]
    result = evidence.snapshot(aid, WEEKEND, allow_cash_carry_forward=False)
    assert result["status"] == "unavailable"


def test_dividend_after_statement_prevents_institution_closed_label():
    evidence, aid = snapshot_evidence()
    evidence.flows[aid] = [
        SimpleNamespace(event=SimpleNamespace(economic_date=HOLIDAY, kind="dividend"))
    ]
    result = evidence.snapshot(aid, WEEKEND, allow_cash_carry_forward=False)
    assert result["status"] == "unavailable"


def test_pending_corporate_action_inside_closed_interval_remains_actionable():
    instrument = Instrument(
        name="合成国内基金", code="QA-CLOSED", kind="fund", market="CN"
    )
    account = Account(name="合成账户")
    movement = {
        "date": date(2026, 9, 23),
        "quantity": D(10),
        "reconstructed": False,
        "event": SimpleNamespace(kind="buy"),
    }
    previous = SimpleNamespace(
        economic_date=ANCHOR,
        kind="official_nav",
        published_at=None,
        created_at=None,
    )
    result = _calendar_item(
        None,
        account,
        instrument,
        [movement],
        [previous],
        [],
        WEEKEND,
        [{"date": HOLIDAY, "description": "待核对分红", "source": "synthetic"}],
        check_reader=lambda *args: None,
    )
    assert result["status"] == "unavailable"
    assert result["missing_reason_code"] == "corporate_action"


@pytest.mark.django_db
@pytest.mark.parametrize("conflict_date", [HOLIDAY, WEEKEND])
def test_nav_conflict_on_or_inside_closed_interval_stays_visible(book, conflict_date):
    trade(book, when=date(2026, 9, 23))
    price(book, when=ANCHOR)
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.fund.pk),
            "nav_quarantine": {str(conflict_date): {"status": "conflict"}},
        },
    )
    home = daily_return_overview(book.space, WEEKEND)[0]
    calendar = profit_calendar(book.space, WEEKEND, WEEKEND)
    for result in (home, calendar["days"][0]):
        assert result["status"] == "unavailable"
        assert result["market_closed_count"] == 0 and result["missing_count"] == 1
        assert result["items"][0]["missing_reason_code"] == "nav_conflict"


@pytest.mark.django_db
def test_dividend_before_query_start_is_still_in_closure_evidence(book):
    trade(book, when=date(2026, 9, 23))
    price(book, when=ANCHOR)
    post_event(
        book.space,
        book.user,
        {
            "kind": "dividend",
            "economic_date": str(HOLIDAY),
            "account_id": str(book.account.pk),
            "instrument_id": str(book.fund.pk),
            "amount": "2",
        },
    )
    home = daily_return_overview(book.space, WEEKEND)[0]
    calendar = profit_calendar(book.space, WEEKEND, WEEKEND)
    for result in (home, calendar["days"][0]):
        assert result["status"] == "unavailable"
        assert result["market_closed_count"] == 0 and result["missing_count"] == 1
