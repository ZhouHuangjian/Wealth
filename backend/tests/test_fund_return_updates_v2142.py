"""A closed overseas session is a dated reference, never today's formal P&L."""

from datetime import date, datetime, timedelta
from datetime import timezone as dtz
from decimal import Decimal as D

import pytest
from django.db import connection
from django.test import Client
from test_daily_returns_v263 import book as shared_book
from test_daily_returns_v263 import price, trade
from test_overview_projection_version import reject_writes, saved_state
from wealth.daily_returns import daily_return_overview
from wealth.holding_checks import save_holding_check
from wealth.investments import record_holding
from wealth.ledger import post_event
from wealth.models import Account, Event, JournalLine, Membership, Price, Resource

pytestmark = pytest.mark.django_db
book = shared_book
DAY = date(2026, 10, 13)
BASE = date(2026, 10, 9)
NOW = datetime(2026, 10, 13, 10, tzinfo=dtz.utc)


@pytest.fixture
def observed(book, monkeypatch):
    monkeypatch.setattr("django.utils.timezone.now", lambda: NOW)
    monkeypatch.setattr("django.utils.timezone.localdate", lambda: DAY)
    monkeypatch.setattr(
        "wealth.valuation_calendar.is_trading_day", lambda d, *args: d.weekday() < 5
    )
    monkeypatch.setattr(
        "wealth.trading_calendar.is_trading_day", lambda d, *args: d.weekday() < 5
    )
    book.fund.code = "017641"
    book.fund.specification = {"is_qdii": True, "calendar_id": "US_EQUITIES"}
    book.fund.save()
    trade(book, when=date(2026, 10, 8), quantity="100", price="1.7")
    price(book, when=date(2026, 10, 8), value="1.71")
    base = price(book, when=BASE, value="1.7251")
    state = Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.fund.pk),
            "refresh_status": "idle",
            "reference_estimate": {
                "kind": "reference_estimate",
                "status": "reference_only",
                "code": book.fund.code,
                "currency": "CNY",
                "price": "1.7203",
                "base_nav": "1.7251",
                "base_nav_date": str(BASE),
                "published_at": "2026-10-13T05:04:00+08:00",
                "fetched_at": NOW.isoformat(),
                "source": "synthetic overseas reference",
                "base_ratio_consistent": True,
            },
        },
    )
    return book, state, base


def read(observed, currency="CNY"):
    book, _, _ = observed
    return daily_return_overview(book.space, DAY, currency)[0]


def update(observed, **values):
    _, state, _ = observed
    state.data["reference_estimate"].update(values)
    state.save()


def test_previous_overseas_session_is_a_separate_read_only_interval(observed):
    before = (
        Event.objects.count(),
        JournalLine.objects.count(),
        Price.objects.count(),
        Resource.objects.count(),
    )
    summary = read(observed)
    assert summary["amount"] is None
    group = summary["latest_fund_updates"]
    assert (group["known_count"], group["total_count"]) == (1, 1)
    row = group["items"][0]
    assert row["status"] == "estimated"
    assert D(row["amount"]) == D("-0.48")
    assert D(row["basis"]) == D("172.51")
    assert D(row["quantity"]) == 100
    assert row["nav_date"] is row["return_date"] is None
    assert "2026-10-09" in row["window_label"] and "05:04" in row["window_label"]
    assert "归属日待公布" in row["window_label"]
    assert before == (
        Event.objects.count(),
        JournalLine.objects.count(),
        Price.objects.count(),
        Resource.objects.count(),
    )


def test_new_formal_nav_invalidates_old_reference_without_moving_its_return_day(
    observed,
):
    book, _, _ = observed
    price(book, when=date(2026, 10, 12), value="1.73")
    result = read(observed)
    assert result["amount"] is None
    row = result["latest_fund_updates"]["items"][0]
    assert row["status"] == "formal"
    assert D(row["amount"]) == D("0.49")
    assert row["nav_date"] == row["return_date"] == "2026-10-12"
    assert row["base_nav_date"] == "2026-10-09"
    assert D(row["quote_price"]) == D("1.73")
    assert row["quoted_at"] is None
    assert "旧参考基准失效" in row["message"]
    assert D(result["latest_fund_updates"]["known_amount"]) == D("0.49")


def test_same_day_official_correction_never_multiplies_new_nav_by_old_rate(observed):
    _, _, base = observed
    base.value = D("1.7261")
    base.save()
    row = read(observed)["latest_fund_updates"]["items"][0]
    assert row["status"] == "formal"
    assert row["nav_date"] == "2026-10-09"
    assert D(row["amount"]) == D("1.61")


@pytest.mark.parametrize(
    "changed",
    [
        {"code": "foreign"},
        {"currency": "USD"},
        {"base_nav_date": None},
        {"base_nav_date": "2026-10-08"},
        {"base_nav": "0"},
        {"base_ratio_consistent": False},
        {"published_at": None},
        {"published_at": "2026-10-12T05:04:00+08:00"},
        {"published_at": "2026-10-13T20:04:00+08:00"},
        {"fetched_at": (NOW - timedelta(seconds=601)).isoformat()},
        {"fetched_at": (NOW + timedelta(seconds=1)).isoformat()},
    ],
)
def test_missing_wrong_old_future_or_unmatched_reference_stays_unknown(
    observed, changed
):
    update(observed, **changed)
    row = read(observed)["latest_fund_updates"]["items"][0]
    # A genuinely newer formal observation is displayed separately, never an
    # estimate computed from the unmatched old baseline.
    assert row["status"] != "estimated"
    if row["status"] != "formal":
        assert row["amount"] is row["base_amount"] is None


@pytest.mark.parametrize("operation", ["buy", "sell", "dividend", "split"])
def test_interval_movements_and_distributions_disable_reference_amount(
    observed, operation
):
    book, _, _ = observed
    if operation in {"buy", "sell"}:
        trade(
            book, when=date(2026, 10, 12), side=operation, quantity="10", price="1.73"
        )
    else:
        post_event(
            book.space,
            book.user,
            {
                "kind": operation,
                "account_id": str(book.account.pk),
                "instrument_id": str(book.fund.pk),
                "economic_date": "2026-10-12",
                "amount": "1",
                "quantity": "200",
                "ratio": "2",
            },
        )
    row = read(observed)["latest_fund_updates"]["items"][0]
    assert row["amount"] is None
    assert row["missing_reason_code"] == "reference_movement"


def test_original_currency_survives_missing_conversion(observed):
    group = read(observed, "USD")["latest_fund_updates"]
    row = group["items"][0]
    assert row["status"] == "unavailable" and row["native_status"] == "estimated"
    assert D(row["amount"]) == D("-0.48")
    assert row["base_amount"] is None
    assert group["known_count"] == 0 and group["known_amount"] is None


def test_source_refresh_failure_does_not_create_estimates(observed):
    _, state, _ = observed
    state.data["refresh_status"] = "failed"
    state.save()
    row = read(observed)["latest_fund_updates"]["items"][0]
    assert row["amount"] is None and row["missing_reason_code"] == "reference_refresh"


def test_announced_unrecorded_action_keeps_interval_unknown(observed):
    _, state, _ = observed
    state.data["corporate_actions"] = [
        {"date": "2026-10-12", "description": "合成分红公告"}
    ]
    state.save()
    row = read(observed)["latest_fund_updates"]["items"][0]
    assert row["amount"] is None
    assert row["missing_reason_code"] == "reference_movement"


@pytest.mark.parametrize("as_of", ["2026-10-09", "2026-10-12"])
def test_existing_holding_requires_eligible_baseline_and_resolved_scope(
    observed, as_of
):
    book, _, _ = observed
    account = Account.objects.create(
        tenant=book.space, name="合成补录账户", kind="fund"
    )
    opening = record_holding(
        book.space,
        book.user,
        {
            "account_id": str(account.pk),
            "instrument_id": str(book.fund.pk),
            "quantity": "100",
            "cost": "172",
            "current_value": "172.51",
            "as_of": as_of,
            "valuation_date": as_of,
            "valuation_basis": "formal",
            "funding_mode": "external",
        },
    )
    if as_of == str(BASE):
        save_holding_check(
            book.space,
            book.user,
            opening["event"]["id"],
            {
                "version": 0,
                "institution_profit": "-1",
                "reference_nav": "1.7251",
                "reference_date": as_of,
                "available_quantity": "100",
            },
        )
    row = next(
        item
        for item in read(observed)["latest_fund_updates"]["items"]
        if item["account_id"] == str(account.pk)
    )
    assert row["amount"] is row["base_amount"] is None
    assert row["missing_reason_code"] == (
        "holding_reconciliation" if as_of == str(BASE) else "reference_movement"
    )


def test_viewer_homepage_returns_reference_without_writing_ledger_quotes_or_caches(
    observed,
):
    book, _, _ = observed
    Membership.objects.filter(workspace=book.space, user=book.user).update(
        role="viewer"
    )
    client = Client()
    client.force_login(book.user)
    before = saved_state(book.space)
    quote_rows = list(Price.objects.filter(tenant=book.space).values())
    with connection.execute_wrapper(reject_writes):
        overview = client.get(
            f"/api/v1/spaces/{book.space.pk}/overview", {"as_of": str(DAY)}
        )
        response = client.get(
            f"/api/v1/spaces/{book.space.pk}/net-worth-comparison", {"as_of": str(DAY)}
        )
    assert overview.status_code == 200, overview.content
    assert response.status_code == 200, response.content
    group = response.json()["daily_return"]["latest_fund_updates"]
    assert D(group["items"][0]["amount"]) == D("-0.48")
    assert saved_state(book.space) == before
    assert list(Price.objects.filter(tenant=book.space).values()) == quote_rows
