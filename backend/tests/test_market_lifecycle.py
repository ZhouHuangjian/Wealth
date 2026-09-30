"""Lifecycle regressions: current observations, daily closes, leases and identity."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth import market_data, market_sync
from wealth import models as m
from wealth.common import tenant_context
from wealth.investments import holdings_summary, record_holding

pytestmark = pytest.mark.django_db


@pytest.fixture
def clock(monkeypatch):
    value = {"now": datetime(2026, 9, 25, 1, tzinfo=timezone.utc)}
    monkeypatch.setattr(market_sync.timezone, "now", lambda: value["now"])
    return value


@pytest.fixture
def book(settings, monkeypatch, clock):
    settings.WEALTH_MARKET_DATA_ENABLED = True
    settings.WEALTH_MARKET_INLINE = True
    user = get_user_model().objects.create_user("market-lifecycle-owner")
    space = m.Workspace.objects.create(name="行情生命周期隔离测试")
    m.Membership.objects.create(user=user, workspace=space, role="owner")
    with tenant_context(space.pk):
        account = m.Account.objects.create(
            tenant=space,
            created_by=user,
            name="测试券商",
            kind="broker",
            currency="CNY",
        )
        instrument = m.Instrument.objects.create(
            tenant=space,
            created_by=user,
            name="测试证券",
            code="600519",
            kind="stock",
            market="CN",
            currency="CNY",
            specification={"account_ids": [str(account.pk)]},
        )
    monkeypatch.setattr(market_data, "fetch_history", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        market_data,
        "fetch_quote",
        lambda *args, **kwargs: pytest.fail("Provider must be stubbed"),
    )
    return SimpleNamespace(
        user=user, space=space, account=account, instrument=instrument
    )


def observation(value, stamp, *, kind="market", economic_date=None, code="600519"):
    return {
        "status": "ok",
        "price": value,
        "kind": kind,
        "source": "lifecycle-fixture",
        "economic_date": economic_date or stamp[:10],
        "published_at": stamp,
        "currency": "CNY",
        "code": code,
        "message": "",
    }


def refresh(book, *, history=False, start=None):
    with tenant_context(book.space.pk):
        market_sync.queue_refresh(
            book.space,
            book.user,
            [str(book.instrument.pk)],
            history=history,
            start=start,
        )
        token = market_sync._state(book.space, book.instrument).data["request_token"]
    result = market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), token)
    return token, result


def test_reference_price_returning_to_earlier_value_is_still_the_latest(
    book, clock, monkeypatch
):
    with tenant_context(book.space.pk):
        record_holding(
            book.space,
            book.user,
            {
                "account_id": str(book.account.pk),
                "instrument_id": str(book.instrument.pk),
                "quantity": "2",
                "cost": "180",
                "purchase_date": "2026-09-25",
                "history_mode": "snapshot_only",
            },
        )
    for hour, price in [(9, "100"), (10, "101"), (11, "100")]:
        clock["now"] = datetime(2026, 9, 25, hour - 8, tzinfo=timezone.utc)
        stamp = f"2026-09-25T{hour:02}:00:00+08:00"
        monkeypatch.setattr(
            market_data,
            "fetch_quote",
            lambda _inst, p=price, t=stamp, **kwargs: observation(p, t),
        )
        token, result = refresh(book)
        assert result["status"] == "ready"
    with tenant_context(book.space.pk):
        row = holdings_summary(book.space)["items"][0]
        assert Decimal(row["estimate_price"]) == Decimal(100)
        assert Decimal(row["estimate_value"]) == Decimal(200)
        assert datetime.fromisoformat(row["estimate_published_at"]) == datetime(
            2026, 9, 25, 3, tzinfo=timezone.utc
        )
        count = m.Price.objects.filter(
            tenant=book.space, instrument=book.instrument, kind="reference"
        ).count()
        assert count == 3
    # Redelivery of a completed broker task does not add another observation.
    market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), token)
    # Nor does a new poll returning the exact same provider timestamp and price.
    clock["now"] += timedelta(hours=1)
    refresh(book)
    with tenant_context(book.space.pk):
        assert (
            m.Price.objects.filter(
                tenant=book.space, instrument=book.instrument, kind="reference"
            ).count()
            == count
        )


def test_automatic_refresh_adds_next_day_close_after_initial_backfill(
    book, clock, monkeypatch
):
    clock["now"] = datetime(2026, 9, 24, 9, tzinfo=timezone.utc)
    calls = []

    def latest(_inst, **kwargs):
        today = market_sync.day()
        return observation("105", f"{today}T17:00:00+08:00")

    def history(_inst, start, end, **kwargs):
        calls.append((str(start), str(end)))
        closing = date.fromisoformat(str(end))
        return [
            observation(
                "104" if closing.day == 24 else "106",
                f"{closing}T15:00:00+08:00",
                kind="close",
            )
        ]

    monkeypatch.setattr(market_data, "fetch_quote", latest)
    monkeypatch.setattr(market_data, "fetch_history", history)
    refresh(book, history=True, start="2026-09-01")
    with tenant_context(book.space.pk):
        state = market_sync._state(book.space, book.instrument)
        assert state.data.get("history_requested") is False
        assert m.Price.objects.filter(
            tenant=book.space,
            instrument=book.instrument,
            kind="close",
            economic_date="2026-09-24",
        ).exists()
    # The next day's scheduler receives no user backfill request.
    clock["now"] = datetime(2026, 9, 25, 9, tzinfo=timezone.utc)
    market_sync.refresh_due(inline=True)
    assert len(calls) >= 2
    assert calls[-1][0] <= "2026-09-25" <= calls[-1][1]
    with tenant_context(book.space.pk):
        assert m.Price.objects.filter(
            tenant=book.space,
            instrument=book.instrument,
            kind="close",
            economic_date="2026-09-25",
            value=Decimal(106),
        ).exists()


def test_periodic_retry_preserves_unexpired_pending_request_token(
    book, clock, monkeypatch
):
    with tenant_context(book.space.pk):
        market_sync.queue_refresh(book.space, book.user, [str(book.instrument.pk)])
        token = market_sync._state(book.space, book.instrument).data["request_token"]
    published = []
    monkeypatch.setattr(
        market_sync, "_publish", lambda sid, iid, tok: published.append((sid, iid, tok))
    )
    clock["now"] += timedelta(seconds=60)
    market_sync.refresh_due(inline=False)
    with tenant_context(book.space.pk):
        assert (
            market_sync._state(book.space, book.instrument).data["request_token"]
            == token
        )
    assert published
    assert all(call[2] == token for call in published)
    # The original message can still complete after the periodic retry.
    monkeypatch.setattr(
        market_data,
        "fetch_quote",
        lambda _inst, **kwargs: observation("100", "2026-09-25T09:00:00+08:00"),
    )
    assert (
        market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), token)[
            "status"
        ]
        == "ready"
    )


def test_identity_change_during_network_fetch_discards_old_instrument_observation(
    book, monkeypatch
):
    old_code = book.instrument.code

    def change_during_fetch(provider_input, **kwargs):
        assert provider_input["code"] == old_code
        with tenant_context(book.space.pk):
            m.Instrument.objects.filter(
                tenant=book.space, pk=book.instrument.pk
            ).update(code="000001", name="修改后的证券")
        return observation("1234", "2026-09-25T09:00:00+08:00", code=old_code)

    monkeypatch.setattr(market_data, "fetch_quote", change_during_fetch)
    refresh(book)
    with tenant_context(book.space.pk):
        assert not m.Price.objects.filter(
            tenant=book.space, instrument=book.instrument
        ).exists()
        item = next(
            x
            for x in market_sync.quote_list(book.space)["items"]
            if x["instrument_id"] == str(book.instrument.pk)
        )
        assert item["code"] == "000001"
        assert item["price"] is None
