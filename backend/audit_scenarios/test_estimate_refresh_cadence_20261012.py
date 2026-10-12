"""Opt-in diagnosis of the cache/beat boundary; not default regression acceptance.

Only fixed synthetic observations are used. The two expected_business assertions
intentionally fail on the current implementation; no xfail/skip masks the result.
Run this file explicitly in the independently migrated audit database.
"""

import json
from contextlib import nullcontext
from datetime import date, datetime, timedelta
from datetime import timezone as tz
from decimal import Decimal
from types import SimpleNamespace

import pytest
from wealth import fund_sources, market_data, market_sync
from wealth.common import tenant_context
from wealth.daily_returns import daily_return_overview
from wealth.investment_trades import record_trade
from wealth.ledger import post_event
from wealth.models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Membership,
    PositionMovement,
    Price,
    Workspace,
)

TODAY = date(2026, 10, 12)
PRIOR = date(2026, 10, 9)
START = datetime(2026, 10, 12, 4, 5, tzinfo=tz.utc)
CONFIG = {"schema_version": 3, "priority": {"fund": ["eastmoney_fund"]}}
PRODUCT = {
    "kind": "fund",
    "code": "123456",
    "market": "CN",
    "currency": "CNY",
}


@pytest.fixture
def controlled_source(monkeypatch):
    clock = {"elapsed": 0.0, "quote_age": 0.0, "calls": 0}

    def now():
        return START + timedelta(seconds=clock["elapsed"])

    monkeypatch.setattr(fund_sources, "_DATA_CACHE", {})
    monkeypatch.setattr(fund_sources, "_IN_FLIGHT", {})
    monkeypatch.setattr(fund_sources.time, "monotonic", lambda: 1000 + clock["elapsed"])
    monkeypatch.setattr(market_data, "_now", now)
    monkeypatch.setattr("django.utils.timezone.now", now)
    monkeypatch.setattr("django.utils.timezone.localdate", lambda *a, **k: TODAY)
    monkeypatch.setattr("wealth.planning.today", lambda space: TODAY)
    monkeypatch.setattr(market_sync, "get_provider_config", lambda: CONFIG)
    monkeypatch.setattr(market_data, "fetch_history", lambda *a, **k: [])
    monkeypatch.setattr(
        market_data, "_get", lambda *a, **k: pytest.fail("Unexpected live HTTP")
    )
    monkeypatch.setattr(
        market_data, "_post", lambda *a, **k: pytest.fail("Unexpected live HTTP POST")
    )

    def is_open(value, calendar_id="CN_EXCHANGE"):
        assert calendar_id == "CN_EXCHANGE"
        return date.fromisoformat(str(value)).weekday() < 5

    for module in ("trading_calendar", "subscription_calendar", "valuation_calendar"):
        monkeypatch.setattr(f"wealth.{module}.is_trading_day", is_open)

    def provider_quote(provider, product):
        assert provider == "eastmoney_fund"
        clock["calls"] += 1
        quote = market_data._quote(
            product,
            price="1",
            kind="official_nav",
            source="synthetic-formal-nav",
            economic_date=str(PRIOR),
        )
        quote["estimate"] = market_data._quote(
            product,
            price="1.02",
            kind="estimate",
            source="synthetic-intraday-estimate",
            published_at=now() - timedelta(seconds=clock["quote_age"]),
        )
        return quote

    monkeypatch.setattr(market_data, "_provider_quote", provider_quote)
    return clock


@pytest.mark.parametrize("seconds, expected_calls", [(599.8, 1), (600.0, 2)])
def test_property_cache_keeps_real_fetch_time_until_exact_ttl(
    controlled_source, seconds, expected_calls
):
    clock = controlled_source
    first = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    clock["elapsed"] = seconds
    second = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    assert clock["calls"] == expected_calls
    if expected_calls == 1:
        assert second["fetched_at"] == first["fetched_at"]
        assert second["estimate"]["published_at"] == first["estimate"]["published_at"]
    else:
        assert second["fetched_at"] != first["fetched_at"]
        assert second["estimate"]["published_at"] != first["estimate"]["published_at"]


class MemoryRows:
    """No database: only substitute the scanner's inventory and writer boundary."""

    def __init__(self, row):
        self.row = row

    def filter(self, **kwargs):
        return self

    def order_by(self, *args):
        return self

    def select_related(self, *args):
        return self

    def select_for_update(self):
        return self

    def first(self):
        return self.row

    def get(self, **kwargs):
        return self.row

    def __iter__(self):
        return iter([self.row])


@pytest.mark.parametrize("worker_offset", [0.0, 0.2])
def test_expected_business_each_five_minute_beat_is_not_lost_to_worker_offset(
    controlled_source, monkeypatch, worker_offset
):
    clock = controlled_source
    space = SimpleNamespace(pk="synthetic-space", deleted_at=None)
    product = SimpleNamespace(pk="synthetic-product")
    owner = SimpleNamespace(user=SimpleNamespace())
    state = SimpleNamespace(
        data={
            "refresh_status": "ready",
            "last_attempt_at": (START + timedelta(seconds=worker_offset)).isoformat(),
        },
        save=lambda **kwargs: None,
    )
    monkeypatch.setattr(market_sync, "enabled", lambda: True)
    monkeypatch.setattr(market_sync, "tenant_context", lambda *a: nullcontext())
    monkeypatch.setattr(
        market_sync, "Workspace", SimpleNamespace(objects=MemoryRows(space))
    )
    monkeypatch.setattr(
        market_sync, "Membership", SimpleNamespace(objects=MemoryRows(owner))
    )
    monkeypatch.setattr(market_sync, "catalog_queryset", lambda *a: MemoryRows(product))
    monkeypatch.setattr(market_sync, "_state", lambda *a: state)
    published = []
    monkeypatch.setattr(market_sync, "_publish", lambda *args: published.append(args))
    clock["elapsed"] = market_sync.INTERVAL
    result = market_sync.refresh_due()
    assert result["scheduled"] == 1, {
        "expected_business": "One configured beat must not be lost to 0.2s worker latency",
        "worker_offset_seconds": worker_offset,
        "scanner_elapsed_seconds": clock["elapsed"],
        "actual": result,
    }
    assert len(published) == 1


@pytest.fixture
def synthetic_book(controlled_source, monkeypatch):
    from django.contrib.auth import get_user_model

    clock = controlled_source
    monkeypatch.setattr(market_sync, "enabled", lambda: False)
    user = get_user_model().objects.create_user("estimate-cadence-synthetic-owner")
    space = Workspace.objects.create(name="Synthetic estimate cadence diagnosis")
    Membership.objects.create(workspace=space, user=user, role="owner")
    with tenant_context(space.pk):
        account = Account.objects.create(
            tenant=space, name="Synthetic broker", kind="broker"
        )
        product = Instrument.objects.create(
            tenant=space, name="Synthetic fund", **PRODUCT
        )
        post_event(
            space,
            user,
            {
                "kind": "opening",
                "account_id": str(account.pk),
                "amount": "1000",
                "economic_date": "2026-10-08",
            },
        )
        record_trade(
            space,
            user,
            {
                "account_id": str(account.pk),
                "instrument_id": str(product.pk),
                "side": "buy",
                "quantity": "100",
                "price": "1",
                "economic_date": str(PRIOR),
            },
        )
        Price.objects.create(
            tenant=space,
            instrument=product,
            kind="official_nav",
            economic_date=PRIOR,
            value="1",
            source="synthetic-formal-nav",
        )
    monkeypatch.setattr(market_sync, "enabled", lambda: True)

    def launch_worker(space_id, instrument_id, token):
        # The first worker's small delay is independent from the global beat.
        clock["elapsed"] += 0.2
        assert (
            market_sync.refresh_one(space_id, instrument_id, token)["status"] == "ready"
        )
        return True

    monkeypatch.setattr(market_sync, "_publish", launch_worker)
    return SimpleNamespace(clock=clock, space=space, product=product)


def money_facts(space):
    return [
        list(model.objects.filter(tenant=space).order_by("pk").values())
        for model in (Event, JournalLine, PositionMovement)
    ]


@pytest.mark.django_db
def test_expected_business_successful_refresh_does_not_make_fresh_source_disappear(
    synthetic_book,
):
    book, trace = synthetic_book, []
    with tenant_context(book.space.pk):
        before = money_facts(book.space)
    for elapsed in (0.0, 300.0, 599.8):
        book.clock["elapsed"] = elapsed
        result = market_sync.refresh_due()
        with tenant_context(book.space.pk):
            state = market_sync._state(book.space, book.product).data
            trace.append(
                {
                    "beat_elapsed": elapsed,
                    "scheduled": result["scheduled"],
                    "refresh_status": state["refresh_status"],
                    "last_attempt_at": state["last_attempt_at"],
                    "fetched_at": state["fetched_at"],
                    "provider_calls": book.clock["calls"],
                }
            )
    book.clock["elapsed"] = 620.0
    with tenant_context(book.space.pk):
        interrupted = daily_return_overview(book.space, TODAY)[0]
    trace.append(
        {
            "read_elapsed": 620.0,
            "status": interrupted["status"],
            "amount": interrupted["amount"],
            "reason": interrupted["items"][0]["message"],
        }
    )
    for elapsed in (899.8, 1199.8):
        book.clock["elapsed"] = elapsed
        result = market_sync.refresh_due()
        trace.append(
            {
                "beat_elapsed": elapsed,
                "scheduled": result["scheduled"],
                "provider_calls": book.clock["calls"],
            }
        )
    with tenant_context(book.space.pk):
        recovered = daily_return_overview(book.space, TODAY)[0]
        assert recovered["status"] == "estimated"
        assert Decimal(recovered["amount"]) == Decimal(2)
        assert money_facts(book.space) == before
    trace.append(
        {
            "read_elapsed": book.clock["elapsed"],
            "status": recovered["status"],
            "amount": recovered["amount"],
        }
    )
    print("SYNTHETIC_CADENCE_TRACE=" + json.dumps(trace, ensure_ascii=False))
    assert interrupted["status"] == "estimated", {
        "expected_business": "A live source with current quotes must not vanish after successful refresh",
        "actual": interrupted["items"][0]["message"],
    }
    assert Decimal(interrupted["amount"]) == Decimal(2)


@pytest.mark.django_db
def test_property_fresh_fetch_does_not_relabel_old_provider_quote(synthetic_book):
    book = synthetic_book
    book.clock["quote_age"] = 35 * 60
    assert market_sync.refresh_due()["scheduled"] == 1
    with tenant_context(book.space.pk):
        state = market_sync._state(book.space, book.product).data
        assert state["refresh_status"] == "ready"
        assert state["fetched_at"] == (START + timedelta(seconds=0.2)).isoformat()
        assert state["quote"]["estimate"]["data_state"] == "delayed"
        result = daily_return_overview(book.space, TODAY)[0]
        assert result["amount"] is None
        assert result["items"][0]["message"] == "估值报价已经延迟或时间异常，待更新"
