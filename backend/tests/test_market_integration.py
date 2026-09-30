"""HTTP authorization, durable refresh and scoped investment onboarding."""

from datetime import timedelta
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.utils import timezone

from wealth import market_sync, models as m
from wealth.common import tenant_context

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(settings, monkeypatch):
    from wealth import market_data

    # Service tests must not fetch live history when quote behavior is mocked.
    # Real provider reachability is checked separately during deployment.
    monkeypatch.setattr(market_data, "fetch_history", lambda *args, **kwargs: [])
    settings.WEALTH_MARKET_DATA_ENABLED = True
    settings.WEALTH_MARKET_INLINE = True
    owner = get_user_model().objects.create_user(
        "market-owner", password="Synthetic-password-3398"
    )
    viewer = get_user_model().objects.create_user(
        "market-viewer", password="Synthetic-password-3398"
    )
    space = m.Workspace.objects.create(name="行情隔离测试")
    for user, role in [(owner, "owner"), (viewer, "viewer")]:
        m.Membership.objects.create(workspace=space, user=user, role=role)
    with tenant_context(space.pk):
        account = m.Account.objects.create(
            tenant=space, name="基金账户", kind="fund", currency="CNY"
        )
        instrument = m.Instrument.objects.create(
            tenant=space, name="合成基金", code="000001", kind="fund", currency="CNY"
        )
    client = Client()
    client.force_login(owner)
    return SimpleNamespace(
        owner=owner,
        viewer=viewer,
        space=space,
        account=account,
        instrument=instrument,
        client=client,
        base=f"/api/v1/spaces/{space.pk}",
    )


def send(book, path, body, key=None):
    return book.client.post(
        book.base + path,
        json.dumps(body),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=key or str(uuid4()),
    )


def quote(**extra):
    return {
        "status": "ok",
        "price": "1.25",
        "kind": "official_nav",
        "economic_date": str(timezone.localdate()),
        "published_at": timezone.now().isoformat(),
        "source": "synthetic-provider",
        "currency": "CNY",
        "message": "",
        **extra,
    }


def test_historical_holding_manual_profit_idempotent_and_optional_proof(book):
    today = timezone.localdate()
    body = {
        "account_id": str(book.account.pk),
        "instrument_id": str(book.instrument.pk),
        "quantity": "100",
        "cost": "100",
        "purchase_date": str(today - timedelta(days=100)),
        "history_mode": "unchanged_holding",
        "current_profit": "17",
    }
    first = send(book, "/holdings", body, "one-holding")
    assert first.status_code == 200, first.content
    assert first.json()["holding"]["market_value"] == "117"
    second = send(book, "/holdings", body, "one-holding")
    assert second.json()["event"]["id"] == first.json()["event"]["id"]
    assert (
        send(book, "/holdings", {**body, "cost": "101"}, "one-holding").status_code
        == 409
    )
    overview = book.client.get(book.base + "/overview").json()
    assert overview["net_assets"] == "117"
    calendar = book.client.get(
        book.base + "/profit-calendar", {"start": str(today), "end": str(today)}
    ).json()
    assert calendar["days"][0]["amount"] is None
    assert book.client.get(book.base + "/events").json()["count"] == 1
    # A routine manual cash record has no compulsory source/evidence field.
    expense = send(
        book,
        "/events",
        {
            "kind": "expense",
            "account_id": str(book.account.pk),
            "amount": "1",
            "economic_date": str(today),
        },
    )
    assert expense.status_code == 200, expense.content


def test_product_link_validated_and_returned_and_snapshot_future_scope(book):
    body = {
        "name": "股指合约",
        "code": "IF2610",
        "kind": "future",
        "currency": "CNY",
        "market": "CFFEX",
        "account_ids": [str(book.account.pk)],
    }
    assert send(book, "/instruments", body).status_code == 422
    with tenant_context(book.space.pk):
        futures = m.Account.objects.create(
            tenant=book.space,
            name="期货公司",
            kind="futures",
            currency="CNY",
            valuation_mode="snapshot",
        )
    created = send(book, "/instruments", {**body, "account_ids": [str(futures.pk)]})
    assert created.status_code == 200, created.content
    product = book.client.get(book.base + "/instruments/" + created.json()["id"]).json()
    assert product["account_ids"] == [str(futures.pk)]
    assert product["account_names"] == ["期货公司"]
    filtered = book.client.get(
        book.base + "/accounts", {"kind": "futures", "q": "公司"}
    ).json()
    assert [x["id"] for x in filtered["items"]] == [str(futures.pk)]
    snapshot = {
        "account_id": str(book.account.pk),
        "asset_kind": "future",
        "economic_date": str(timezone.localdate()),
        "currency": "CNY",
        "equity": "1000",
        "coverage": "期货客户权益",
    }
    assert send(book, "/snapshots", snapshot).status_code == 422
    valid = send(book, "/snapshots", {**snapshot, "account_id": str(futures.pk)})
    assert valid.status_code == 200, valid.content


def test_all_new_paths_authorized_and_cross_space_ids_denied(book):
    other = m.Workspace.objects.create(name="其他空间")
    with tenant_context(other.pk):
        foreign = m.Account.objects.create(tenant=other, name="不可见账户")
        product = m.Instrument.objects.create(
            tenant=other, name="不可见产品", code="secret"
        )
    assert (
        send(book, "/market/refresh", {"instrument_ids": [str(product.pk)]}).status_code
        == 404
    )
    assert (
        book.client.get(
            book.base + "/holdings", {"account_id": str(foreign.pk)}
        ).status_code
        == 404
    )
    assert (
        book.client.get(
            book.base + "/profit-calendar", {"instrument_id": str(product.pk)}
        ).status_code
        == 404
    )
    book.client.force_login(book.viewer)
    assert send(book, "/market/refresh", {}).status_code == 403
    assert send(book, "/holdings", {}).status_code == 403
    assert book.client.get(book.base + "/market/quotes").status_code == 200
    book.client.logout()
    for path in (
        "/holdings",
        "/market/quotes",
        "/market/search?q=000001",
        "/market/valuation",
        "/profit-calendar",
    ):
        assert book.client.get(book.base + path).status_code == 401


def test_market_refresh_is_observation_only_and_idempotent(book, monkeypatch):
    from wealth import market_data

    monkeypatch.setattr(
        market_data,
        "fetch_quote",
        lambda instrument, **kwargs: quote(
            estimate=quote(kind="estimate", price="1.27")
        ),
    )
    yesterday = timezone.localdate() - timedelta(days=1)
    monkeypatch.setattr(
        market_data,
        "fetch_history",
        lambda *args, **kwargs: [quote(price="1.20", economic_date=str(yesterday))],
    )
    response = send(
        book,
        "/market/refresh",
        {"instrument_ids": [str(book.instrument.pk)], "history": True},
    )
    assert response.status_code == 200, response.content
    with tenant_context(book.space.pk):
        state = market_sync._state(book.space, book.instrument)
        token = state.data["request_token"]
    result = market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), token)
    assert result == {"status": "ready", "prices_added": 3, "history_rows": 1}
    assert (
        market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), token)[
            "status"
        ]
        == "already_completed"
    )
    with tenant_context(book.space.pk):
        assert m.Event.objects.filter(tenant=book.space).count() == 0
        assert m.Price.objects.filter(tenant=book.space, kind="reference").count() == 1
        assert (
            m.Price.objects.filter(tenant=book.space, kind="official_nav").count() == 2
        )
    quotes = book.client.get(book.base + "/market/quotes").json()["items"]
    assert quotes[0]["price_kind"] == "official_nav"
    assert quotes[0]["kind"] == "fund"
    assert quotes[0]["estimate"]["price"] == "1.27"
    assert book.client.get(book.base + "/overview").json()["net_assets"] == "0"


def test_failed_refresh_retains_last_price_and_never_relabels_currency(
    book, monkeypatch
):
    from wealth import market_data

    monkeypatch.setattr(
        market_data, "fetch_quote", lambda instrument, **kwargs: quote(currency="USD")
    )
    send(book, "/market/refresh", {"instrument_ids": [str(book.instrument.pk)]})
    with tenant_context(book.space.pk):
        state = market_sync._state(book.space, book.instrument)
        token = state.data["request_token"]
    assert (
        market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), token)[
            "status"
        ]
        == "failed"
    )
    item = book.client.get(book.base + "/market/quotes").json()["items"][0]
    assert item["price"] is None and "币种" in item["message"]
    with tenant_context(book.space.pk):
        assert not m.Price.objects.filter(tenant=book.space).exists()
        state.refresh_from_db()
        state.data.update(
            quote=quote(),
            fetched_at=timezone.now().isoformat(),
            refresh_status="pending",
            request_token="retry",
        )
        state.save()

    def unavailable(_, **kwargs):
        raise TimeoutError("provider failed")

    monkeypatch.setattr(market_data, "fetch_quote", unavailable)
    market_sync.refresh_one(str(book.space.pk), str(book.instrument.pk), "retry")
    item = book.client.get(book.base + "/market/quotes").json()["items"][0]
    assert item["price"] == "1.25" and item["status"] == "stale"


def test_refresh_pending_intent_survives_broker_outage(book, monkeypatch, settings):
    settings.WEALTH_MARKET_INLINE = False
    from wealth.tasks import refresh_market_instrument

    def unavailable(*args, **kwargs):
        raise ConnectionError("isolated test broker outage")

    monkeypatch.setattr(refresh_market_instrument, "apply_async", unavailable)
    with tenant_context(book.space.pk):
        response = market_sync.queue_refresh(
            book.space, book.owner, [str(book.instrument.pk)]
        )
        assert response["status"] == "queued"
    assert (
        market_sync._publish(str(book.space.pk), str(book.instrument.pk), "ignored")
        is False
    )
    with tenant_context(book.space.pk):
        state = market_sync._state(book.space, book.instrument)
        assert state.data["refresh_status"] == "pending"
    assert market_sync.refresh_due()["scheduled"] == 1


def test_market_valuation_does_not_add_futures_notional(book):
    with tenant_context(book.space.pk):
        future = m.Instrument.objects.create(
            tenant=book.space, name="合约", code="RB2701", kind="future", currency="CNY"
        )
        m.Resource.objects.create(
            tenant=book.space,
            kind="market_quotes",
            data={
                "instrument_id": str(future.pk),
                "quote": quote(kind="market", price="3000"),
                "fetched_at": timezone.now().isoformat(),
            },
        )
    response = book.client.get(book.base + "/market/valuation")
    assert response.status_code == 200, response.content
    future_card = next(x for x in response.json()["items"] if x["kind"] == "future")
    assert future_card["estimated_value"] is None
    assert future_card["status"] == "quotes_only"
    assert future_card["quotes"][0]["price"] == "3000"
