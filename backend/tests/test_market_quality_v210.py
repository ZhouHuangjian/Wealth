"""NAV quarantine preserves raw observations and isolates each household."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from wealth import market_data, market_quality, market_sync
from wealth import models as m
from wealth.common import tenant_context

pytestmark = pytest.mark.django_db
DATE = "2026-09-30"


@pytest.fixture
def clock(monkeypatch):
    clock = {"now": datetime(2026, 10, 6, 8, tzinfo=timezone.utc)}
    monkeypatch.setattr(market_sync.timezone, "now", lambda: clock["now"])
    return clock


@pytest.fixture
def books(settings, monkeypatch, clock):
    settings.WEALTH_MARKET_DATA_ENABLED = True
    settings.WEALTH_MARKET_INLINE = True
    monkeypatch.setattr(
        market_data, "fetch_quote", lambda *a, **k: pytest.fail("Quote not stubbed")
    )
    monkeypatch.setattr(market_data, "fetch_history", lambda *a, **k: [])
    rows = []
    for label in ("one", "two"):
        user = get_user_model().objects.create_user("quality-owner-" + label)
        space = m.Workspace.objects.create(name="quality-" + label)
        m.Membership.objects.create(workspace=space, user=user, role="owner")
        with tenant_context(space.pk):
            instrument = m.Instrument.objects.create(
                tenant=space,
                created_by=user,
                name="公开基金份额",
                code="020602",
                kind="fund",
                market="CN",
                currency="CNY",
            )
        rows.append(SimpleNamespace(user=user, space=space, instrument=instrument))
    return rows


def quote(value="1.2", when=DATE, quality="single_source", providers=None):
    sources = providers or (
        ["eastmoney_fund", "efunds_official"]
        if quality in {"consistent", "conflict"}
        else ["eastmoney_fund"]
    )
    return {
        "status": "conflict" if quality == "conflict" else "ok",
        "price": None if quality == "conflict" else value,
        "kind": "official_nav",
        "code": "020602",
        "currency": "CNY",
        "economic_date": when,
        "published_at": None,
        "source": "quality-fixture",
        "message": "冲突" if quality == "conflict" else "",
        "data_quality": {
            "status": quality,
            "usable_for_accounting": quality != "conflict",
            "compared_date": when,
            "agreeing_providers": [] if quality == "conflict" else sources,
            "conflicting_providers": sources if quality == "conflict" else [],
        },
        "provider_observations": [
            {
                "provider_id": p,
                "economic_date": when,
                "price": str(Decimal(value) + i / Decimal(10))
                if quality == "conflict"
                else value,
            }
            for i, p in enumerate(sources)
        ],
    }


def refresh(book, clock, monkeypatch, observation, history=None):
    clock["now"] += timedelta(minutes=1)
    monkeypatch.setattr(
        market_data, "fetch_quote", lambda *a, **k: deepcopy(observation)
    )
    monkeypatch.setattr(
        market_data, "fetch_history", lambda *a, **k: deepcopy(history or [])
    )
    with tenant_context(book.space.pk):
        market_sync.queue_refresh(
            book.space,
            book.user,
            [str(book.instrument.pk)],
            history=history is not None,
            start="2026-09-01",
        )
        token = market_sync._state(book.space, book.instrument).data["request_token"]
    return market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), token)


def state(book):
    return market_sync._state(book.space, book.instrument).data


def test_conflict_keeps_raw_prior_price_and_quarantines_it(books, clock, monkeypatch):
    book = books[0]
    assert refresh(book, clock, monkeypatch, quote())["status"] == "ready"
    assert (
        refresh(book, clock, monkeypatch, quote(quality="conflict"))["status"]
        == "failed"
    )
    with tenant_context(book.space.pk):
        raw = m.Price.objects.filter(tenant=book.space, instrument=book.instrument)
        assert raw.count() == 1 and raw.get().value == Decimal("1.2")
        assert market_quality.approved_prices(raw, book.space).count() == 0
        assert market_quality.nav_is_blocked(book.space, book.instrument.pk, DATE)
        data = state(book)
        assert (
            data["quote"]["price"] == "1.2" and data["retained_previous_quote"] is True
        )
        assert market_sync.quote_list(book.space)["items"][0]["status"] == "conflict"


def test_single_source_cannot_clear_quarantine_or_replace_displayed_previous_value(
    books, clock, monkeypatch
):
    book = books[0]
    refresh(book, clock, monkeypatch, quote())
    refresh(book, clock, monkeypatch, quote(quality="conflict"))
    result = refresh(book, clock, monkeypatch, quote("1.4"))
    with tenant_context(book.space.pk):
        assert result["status"] == "failed"
        assert state(book)["quote"]["price"] == "1.2"
        assert DATE in state(book)["nav_quarantine"]
        assert (
            m.Price.objects.filter(
                tenant=book.space, instrument=book.instrument
            ).count()
            == 1
        )
        assert market_sync.quote_list(book.space)["items"][0]["status"] == "conflict"


def test_two_independent_sources_agree_release_date_and_add_new_fact(
    books, clock, monkeypatch
):
    book = books[0]
    refresh(book, clock, monkeypatch, quote())
    refresh(book, clock, monkeypatch, quote(quality="conflict"))
    assert (
        refresh(book, clock, monkeypatch, quote("1.3", quality="consistent"))["status"]
        == "ready"
    )
    with tenant_context(book.space.pk):
        assert state(book)["nav_quarantine"] == {}
        raw = m.Price.objects.filter(
            tenant=book.space, instrument=book.instrument
        ).order_by("created_at")
        assert list(raw.values_list("value", flat=True)) == [
            Decimal("1.2"),
            Decimal("1.3"),
        ]
        assert market_quality.approved_prices(raw, book.space).count() == 2
        assert market_sync.quote_list(book.space)["items"][0]["status"] == "ok"


def test_duplicate_provider_ids_do_not_satisfy_two_source_release(
    books, clock, monkeypatch
):
    book = books[0]
    refresh(book, clock, monkeypatch, quote(quality="conflict"))
    refresh(
        book,
        clock,
        monkeypatch,
        quote(
            "1.3", quality="consistent", providers=["eastmoney_fund", "eastmoney_fund"]
        ),
    )
    with tenant_context(book.space.pk):
        assert DATE in state(book)["nav_quarantine"]
        assert not m.Price.objects.filter(
            tenant=book.space, instrument=book.instrument
        ).exists()


def test_old_quote_does_not_roll_back_last_successful_display(
    books, clock, monkeypatch
):
    book = books[0]
    refresh(book, clock, monkeypatch, quote("1.3"))
    result = refresh(book, clock, monkeypatch, quote("1.1", when="2026-09-29"))
    assert result["status"] == "failed"
    with tenant_context(book.space.pk):
        data = state(book)
        assert (
            data["quote"]["economic_date"] == DATE and data["quote"]["price"] == "1.3"
        )
        assert data["retained_previous_quote"] is True
        assert m.Price.objects.filter(
            tenant=book.space,
            instrument=book.instrument,
            economic_date=DATE,
            value=Decimal("1.3"),
        ).exists()


def test_historical_conflict_blocks_earlier_date_without_destroying_other_days(
    books, clock, monkeypatch
):
    book = books[0]
    refresh(
        book,
        clock,
        monkeypatch,
        quote("1.3"),
        history=[quote("1.1", when="2026-09-29"), quote("1.3")],
    )
    refresh(
        book,
        clock,
        monkeypatch,
        quote("1.3"),
        history=[quote(when="2026-09-29", quality="conflict"), quote("1.3")],
    )
    with tenant_context(book.space.pk):
        raw = m.Price.objects.filter(tenant=book.space, instrument=book.instrument)
        assert raw.count() == 2
        assert list(
            market_quality.approved_prices(raw, book.space).values_list(
                "economic_date", flat=True
            )
        ) == [datetime.fromisoformat(DATE).date()]
        assert (
            "2026-09-29" in state(book)["nav_quarantine"]
            and DATE not in state(book)["nav_quarantine"]
        )


def test_conflicting_history_wins_over_same_batch_consistent_quote(
    books, clock, monkeypatch
):
    book = books[0]
    refresh(book, clock, monkeypatch, quote())
    refresh(
        book,
        clock,
        monkeypatch,
        quote("1.3", quality="consistent"),
        history=[quote(quality="conflict")],
    )
    with tenant_context(book.space.pk):
        assert DATE in state(book)["nav_quarantine"]
        assert (
            m.Price.objects.filter(
                tenant=book.space, instrument=book.instrument
            ).count()
            == 1
        )
        assert state(book)["quote"]["price"] == "1.2"


def test_quarantine_is_tenant_scoped_even_for_identical_public_product(
    books, clock, monkeypatch
):
    one, two = books
    refresh(one, clock, monkeypatch, quote())
    refresh(two, clock, monkeypatch, quote())
    refresh(one, clock, monkeypatch, quote(quality="conflict"))
    with tenant_context(one.space.pk):
        assert market_quality.nav_is_blocked(one.space, one.instrument.pk, DATE)
        assert not market_quality.nav_quarantine(two.space)
        assert not m.Price.objects.filter(tenant=two.space).exists()
    with tenant_context(two.space.pk):
        assert not market_quality.nav_is_blocked(two.space, two.instrument.pk, DATE)
        assert (
            market_quality.approved_prices(
                m.Price.objects.filter(tenant=two.space), two.space
            ).count()
            == 1
        )
        assert market_sync.quote_list(two.space)["items"][0]["status"] == "ok"


def test_reference_estimate_does_not_clear_formal_nav_quarantine(
    books, clock, monkeypatch
):
    book = books[0]
    refresh(book, clock, monkeypatch, quote(quality="conflict"))
    estimate = {**quote("1.5", quality="consistent"), "kind": "estimate"}
    latest = quote(quality="conflict")
    latest["estimate"] = estimate
    refresh(book, clock, monkeypatch, latest)
    with tenant_context(book.space.pk):
        assert DATE in state(book)["nav_quarantine"]
        assert not m.Price.objects.filter(
            tenant=book.space, kind="official_nav"
        ).exists()
        assert m.Price.objects.filter(
            tenant=book.space, kind="reference", value=Decimal("1.5")
        ).exists()


def test_invalid_future_and_non_nav_observations_do_not_modify_quarantine():
    old = {DATE: {"status": "conflict"}}
    observations = [
        quote(when="2099-01-01", quality="conflict"),
        {**quote(quality="consistent"), "kind": "estimate"},
        quote(when="not-a-date", quality="conflict"),
    ]
    assert (
        market_quality.updated_quarantine(old, observations, "2026-10-06T08:00:00Z")
        == old
    )
    assert old == {DATE: {"status": "conflict"}}


def test_cached_provider_fetch_time_is_not_replaced_with_refresh_time(
    books, clock, monkeypatch
):
    book = books[0]
    observation = quote()
    observation["fetched_at"] = "2026-10-06T07:55:00+00:00"
    refresh(book, clock, monkeypatch, observation)
    clock["now"] += timedelta(minutes=30)
    refresh(book, clock, monkeypatch, observation)
    with tenant_context(book.space.pk):
        assert state(book)["fetched_at"] == observation["fetched_at"]
        listed = market_sync.quote_list(book.space)["items"][0]
        assert (
            listed["fetched_at"] == observation["fetched_at"]
            and listed["status"] == "stale"
        )
