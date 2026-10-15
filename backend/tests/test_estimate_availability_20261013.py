"""Availability explanations and native currency remain separate from totals."""

from datetime import datetime, timedelta, timezone as tz
from decimal import Decimal

import pytest

from tests.test_daily_returns_v263 import (
    TODAY,
    book,  # noqa: F401 -- isolated book, no network
    price,
    result,
    trade,
)
from wealth.investments import holdings_summary
from wealth.models import Event, FxRate, JournalLine, PositionMovement, Resource

pytestmark = pytest.mark.django_db
NOW = datetime(2026, 9, 24, 4, 0, tzinfo=tz.utc)


@pytest.fixture(autouse=True)
def fixed_market_clock(monkeypatch):
    monkeypatch.setattr("django.utils.timezone.now", lambda: NOW)
    monkeypatch.setattr("django.utils.timezone.localdate", lambda *a, **k: TODAY)
    for module in ("trading_calendar", "subscription_calendar", "valuation_calendar"):
        monkeypatch.setattr(
            f"wealth.{module}.is_trading_day", lambda d, *a, **k: d.weekday() < 5
        )


def estimate(book, *, published=NOW, fetched=NOW, status="ready"):
    row = price(book, when=TODAY, value="11", kind="estimate")
    row.published_at = published
    row.save(update_fields=["published_at"])
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.fund.pk),
            "refresh_status": status,
            "fetched_at": fetched.isoformat(),
        },
    )
    return row


def ledger_facts():
    return {
        model.__name__: list(model.objects.order_by("pk").values())
        for model in (Event, JournalLine, PositionMovement)
    }


def test_missing_intraday_is_explained_without_moving_previous_nav_return(book):
    trade(book, when=TODAY - timedelta(days=2))
    price(book, when=TODAY - timedelta(days=2), value="9")
    price(book)
    before = ledger_facts()
    observed = result(book)
    item = observed["items"][0]
    assert observed["amount"] is None and observed["known_count"] == 0
    assert item["amount"] is None and item["missing_reason_code"] == "no_estimate"
    assert "未取得该日估值" in item["message"]
    assert item["latest_formal_return"]["date"] == str(TODAY - timedelta(days=1))
    assert Decimal(item["latest_formal_return"]["amount"]) == 10
    assert ledger_facts() == before


@pytest.mark.parametrize(
    "published,fetched,status,reason",
    [
        (NOW, NOW, "failed", "refresh_failed"),
        (NOW, NOW - timedelta(seconds=601), "ready", "fetch_expired"),
        (None, NOW, "ready", "quote_time_missing"),
        (NOW - timedelta(seconds=1201), NOW, "ready", "quote_delayed"),
        # The shared approved-price selector excludes future observations
        # before a daily return is evaluated; no usable price remains.
        (NOW + timedelta(seconds=1), NOW, "ready", "no_estimate"),
    ],
)
def test_invalid_estimates_keep_specific_reason_and_never_become_zero(
    book, published, fetched, status, reason
):
    trade(book)
    price(book)
    estimate(book, published=published, fetched=fetched, status=status)
    item = result(book)["items"][0]
    assert item["amount"] is None and item["missing_reason_code"] == reason


def test_baseline_gap_is_not_relabelled_as_missing_estimate(book):
    trade(book)
    estimate(book)
    item = result(book)["items"][0]
    assert item["amount"] is None
    assert item["missing_reason_code"] == "missing_baseline"


@pytest.mark.parametrize("formal", [False, True])
@pytest.mark.parametrize("fx_age", [None, 8])
def test_missing_or_old_fx_preserves_native_return_without_filling_total(
    book, formal, fx_age
):
    trade(book)
    price(book)
    if formal:
        price(book, when=TODAY, value="11")
    else:
        estimate(book)
    if fx_age is not None:
        FxRate.objects.create(
            tenant=book.space,
            base="CNY",
            quote="HKD",
            rate="1.1",
            economic_date=TODAY - timedelta(days=fx_age),
        )
    before = ledger_facts()
    observed = result(book, currency="HKD")
    item = observed["items"][0]
    assert observed["amount"] is None and observed["known_count"] == 0
    assert item["status"] == "unavailable" and item["base_amount"] is None
    assert item["native_status"] == ("confirmed" if formal else "estimated")
    assert Decimal(item["amount"]) == 10 and item["currency"] == "CNY"
    assert item["missing_reason_code"] == "fx_missing"
    # A current FX observation completes the selected-currency total; it does
    # not reclassify or change the native investment earnings.
    FxRate.objects.create(
        tenant=book.space, base="CNY", quote="HKD", rate="1.2", economic_date=TODAY
    )
    recovered = result(book, currency="HKD")
    assert Decimal(recovered["amount"]) == 12
    assert recovered["items"][0]["missing_reason_code"] is None
    assert Decimal(recovered["items"][0]["amount"]) == 10
    assert ledger_facts() == before


def test_formal_replacement_clears_estimate_failure_reason(book):
    trade(book)
    price(book)
    estimate(book, published=NOW - timedelta(hours=1))
    assert result(book)["items"][0]["missing_reason_code"] == "quote_delayed"
    price(book, when=TODAY, value="10.5")
    item = result(book)["items"][0]
    assert item["status"] == "confirmed" and item["missing_reason_code"] is None
    assert Decimal(item["amount"]) == 5
    assert (
        holdings_summary(book.space, TODAY)["items"][0]["daily_return"]["amount"]
        == item["amount"]
    )


def merged_quote(book):
    trade(book)
    price(book)
    reference = estimate(book, fetched=NOW - timedelta(seconds=650))
    state = Resource.objects.get(kind="market_quotes")
    state.data["quote"] = {
        "status": "ok",
        "kind": "official_nav",
        "source": "synthetic-official-source",
        "estimate": {
            "kind": "estimate",
            "code": book.fund.code,
            "currency": book.fund.currency,
            "economic_date": str(TODAY),
            "source": reference.source,
            "price": str(reference.value),
            "published_at": NOW.isoformat(),
            "fetched_at": NOW.isoformat(),
            "status": "ok",
            "data_state": "intraday",
        },
    }
    state.save(update_fields=["data"])
    return state


@pytest.mark.parametrize("main_status", ["ok", "stale"])
def test_fresh_intraday_uses_own_fetch_time_not_other_nav_source(book, main_status):
    state = merged_quote(book)
    state.data["quote"]["status"] = main_status
    state.save(update_fields=["data"])
    item = result(book)["items"][0]
    assert item["status"] == "estimated" and Decimal(item["amount"]) == 10
    assert datetime.fromisoformat(item["fetched_at"]) == NOW
    assert datetime.fromisoformat(state.data["fetched_at"]) != NOW


@pytest.mark.parametrize(
    "field,value",
    [
        ("code", "OTHER"),
        ("kind", "official_nav"),
        ("currency", "USD"),
        ("economic_date", "2026-09-23"),
        ("source", "different-source"),
        ("price", "12"),
        ("published_at", (NOW - timedelta(seconds=1)).isoformat()),
        ("published_at", None),
    ],
)
def test_unrelated_quote_cannot_lend_its_fresh_fetch_time(book, field, value):
    state = merged_quote(book)
    state.data["quote"]["estimate"][field] = value
    state.save(update_fields=["data"])
    item = result(book)["items"][0]
    assert (
        item["amount"] is None
        and item["missing_reason_code"] == "quote_metadata_mismatch"
    )
    # Even a recent main-NAV fetch cannot lend its timestamp to this old Price.
    state.data["fetched_at"] = NOW.isoformat()
    state.save(update_fields=["data"])
    item = result(book)["items"][0]
    assert (
        item["amount"] is None
        and item["missing_reason_code"] == "quote_metadata_mismatch"
    )


def test_current_quote_cannot_retimestamp_historical_estimate(book):
    prior = TODAY - timedelta(days=1)
    trade(book, when=prior - timedelta(days=1))
    price(book, when=prior - timedelta(days=1))
    historical = price(book, when=prior, kind="estimate", value="11")
    historical.published_at = NOW - timedelta(days=1)
    historical.save(update_fields=["published_at"])
    Resource.objects.create(
        tenant=book.space,
        kind="market_quotes",
        data={
            "instrument_id": str(book.fund.pk),
            "refresh_status": "ready",
            "fetched_at": NOW.isoformat(),
            "quote": {"kind": "official_nav", "status": "ok"},
        },
    )
    item = result(book, when=prior)["items"][0]
    assert Decimal(item["amount"]) == 10 and item["status"] == "estimated"
    assert item["fetched_at"] is None
    assert item["date"] == str(prior)


def test_matching_estimate_with_unknown_fetch_does_not_borrow_main_timestamp(book):
    state = merged_quote(book)
    state.data["quote"]["estimate"].pop("fetched_at")
    state.data["fetched_at"] = NOW.isoformat()
    state.save(update_fields=["data"])
    item = result(book)["items"][0]
    assert item["amount"] is None
    assert item["missing_reason_code"] == "quote_metadata_mismatch"
