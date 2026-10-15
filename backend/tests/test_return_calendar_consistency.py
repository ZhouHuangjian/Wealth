"""Statement returns use the same cashflow and date evidence on every page."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal as D
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model

from wealth.common import tenant_context
from wealth.daily_returns import daily_return_overview
from wealth.investments import profit_calendar
from wealth.ledger import post_event
from wealth.models import (
    Account,
    Event,
    FxRate,
    Instrument,
    JournalLine,
    Membership,
    Price,
    Snapshot,
    Workspace,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(monkeypatch):
    monkeypatch.setattr("wealth.market_sync.enabled", lambda: False)
    monkeypatch.setattr("django.utils.timezone.localdate", lambda: date(2026, 10, 13))
    monkeypatch.setattr(
        "django.utils.timezone.now",
        lambda: datetime(2026, 10, 13, 4, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(
        "wealth.trading_calendar.is_trading_day",
        lambda when, calendar_id: (
            when.weekday() < 5 if calendar_id == "AUDIT_WEEKDAYS" else None
        ),
    )
    user = get_user_model().objects.create_user("calendar-consistency-owner")
    space = Workspace.objects.create(name="机构收益一致性回归")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(
            tenant=space, name="机构账户", kind="broker", valuation_mode="snapshot"
        )
        bank = Account.objects.create(tenant=space, name="银行", kind="bank")
        value = SimpleNamespace(space=space, user=user, account=account, bank=bank)
        for target in (account, bank):
            post(value, "opening", "2026-05-01", account=target, amount="1000")
        yield value


def post(book, kind, when, account=None, **payload):
    return post_event(
        book.space,
        book.user,
        {
            "kind": kind,
            "account_id": str((account or book.account).pk),
            "economic_date": when,
            **payload,
        },
    )


def snapshot(book, when, equity, event_ids=(), basis="settlement"):
    return Snapshot.objects.create(
        tenant=book.space,
        account=book.account,
        economic_date=when,
        equity=equity,
        currency=book.account.currency,
        complete=True,
        includes_options=True,
        coverage="全部",
        included_event_ids=[str(value) for value in event_ids],
        details={"valuation_basis": basis, "calendar_id": "AUDIT_WEEKDAYS"},
    )


def observations(book, when):
    args = {"account_id": str(book.account.pk)}
    home = daily_return_overview(book.space, when, **args)[0]
    calendar = profit_calendar(book.space, when, when, **args)["days"][0]
    return home, calendar


@pytest.mark.parametrize(
    "kind,previous,current,expected",
    [
        ("income", "1000", "1100", "0"),
        ("expense", "1000", "900", "0"),
        ("refund", "900", "1000", "0"),
        ("transfer", "1000", "1100", "0"),
        ("dividend", "1000", "1100", "100"),
    ],
)
def test_calendar_and_home_separate_external_cashflows_from_dividends(
    book, kind, previous, current, expected
):
    args = {"amount": "100"}
    if kind == "refund":
        original = post(book, "expense", "2026-05-05", amount="100")
        args["related_event_id"] = str(original.pk)
    if kind == "transfer":
        args.update(account=book.bank, target_account_id=str(book.account.pk))
    event = post(book, kind, "2026-05-07", **args)
    snapshot(book, "2026-05-06", previous)
    snapshot(book, "2026-05-07", current, [event.pk])
    fact_models = (Event, JournalLine, Price)
    facts_before = [list(model.objects.values()) for model in fact_models]

    home, calendar = observations(book, "2026-05-07")

    assert home["status"] == calendar["status"] == "confirmed"
    assert D(home["amount"]) == D(calendar["amount"]) == D(expected)
    assert calendar["items"][0]["scope"] == "account"
    assert [list(model.objects.values()) for model in fact_models] == facts_before


@pytest.mark.parametrize(
    "previous,current,expected",
    [
        ("2026-05-06", "2026-05-08", None),
        ("2026-05-08", "2026-05-11", "20"),
    ],
)
def test_statement_gap_distinguishes_missing_open_day_from_closed_days(
    book, previous, current, expected
):
    snapshot(book, previous, "1000")
    snapshot(book, current, "1020")
    home, calendar = observations(book, current)
    if expected is None:
        assert home["amount"] is calendar["amount"] is None
        assert home["status"] == calendar["status"] == "unavailable"
        assert "缺少交易日记录" in calendar["items"][0]["message"]
        assert calendar["items"][0]["base_basis"] is None
        assert calendar["return_rate"] is None
    else:
        assert D(home["amount"]) == D(calendar["amount"]) == D(expected)
        assert home["status"] == calendar["status"] == "confirmed"
    assert calendar["items"][0]["interval_start"] == previous


def test_calendar_requires_formal_statement_even_if_intraday_return_is_known(book):
    snapshot(book, "2026-05-06", "1000")
    snapshot(book, "2026-05-07", "1020", basis="intraday")
    home, calendar = observations(book, "2026-05-07")
    assert home["status"] == "estimated" and D(home["amount"]) == D("20")
    assert calendar["amount"] is None
    assert calendar["status"] == "unavailable"


def test_unrelated_product_dividend_does_not_change_snapshot_account_filter(book):
    instrument = Instrument.objects.create(
        tenant=book.space, name="其他账户产品", code="OTHER-CALENDAR-FUND", kind="fund"
    )
    post(
        book,
        "dividend",
        "2026-05-07",
        account=book.bank,
        amount="10",
        instrument_id=str(instrument.pk),
    )
    snapshot(book, "2026-05-06", "1000")
    snapshot(book, "2026-05-07", "1005")
    home, calendar = observations(book, "2026-05-07")
    assert D(home["amount"]) == D(calendar["amount"]) == D("5")
    assert len(calendar["items"]) == 1
    assert calendar["items"][0]["account_id"] == str(book.account.pk)


@pytest.mark.parametrize("age,expected", [(7, "70"), (8, None)])
def test_calendar_and_home_share_dated_fx_coverage(book, age, expected):
    book.account = Account.objects.create(
        tenant=book.space,
        name="美元机构账户",
        kind="broker",
        valuation_mode="snapshot",
        currency="USD",
    )
    snapshot(book, "2026-05-06", "1000")
    snapshot(book, "2026-05-07", "1010")
    FxRate.objects.create(
        tenant=book.space,
        base="USD",
        quote="CNY",
        rate="7",
        economic_date=date(2026, 5, 7) - timedelta(days=age),
        source="synthetic",
    )
    home, calendar = observations(book, "2026-05-07")
    for result in (home, calendar):
        assert D(result["items"][0]["amount"]) == D("10")
        assert result["items"][0]["native_status"] == "confirmed"
        if expected is None:
            assert result["amount"] is None
            assert result["status"] == "unavailable"
            assert result["items"][0]["missing_reason_code"] == "fx_missing"
        else:
            assert D(result["amount"]) == D(expected)
            assert result["status"] == "confirmed"
