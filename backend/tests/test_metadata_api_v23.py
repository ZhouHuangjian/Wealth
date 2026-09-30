import json
import uuid
from types import SimpleNamespace
import pytest
from django.test import Client
from django.contrib.auth import get_user_model
from django.utils import timezone
from wealth import models as m
from wealth.common import tenant_context
from wealth.catalog_models import MarketSymbol

pytestmark = pytest.mark.django_db


@pytest.fixture
def app():
    user = get_user_model().objects.create_user("metadata-test-user")
    space = m.Workspace.objects.create(name="产品识别验收")
    m.Membership.objects.create(user=user, workspace=space, role="owner")
    other = m.Workspace.objects.create(name="其他用户空间")
    with tenant_context(other.pk):
        foreign = m.Instrument.objects.create(
            tenant=other, code="110022", name="秘密持仓"
        )
    c = Client()
    c.force_login(user)
    return SimpleNamespace(
        client=c,
        user=user,
        space=space,
        foreign=foreign,
        base=f"/api/v1/spaces/{space.pk}",
    )


def send(app, endpoint, data):
    return app.client.post(
        app.base + endpoint,
        data=json.dumps(data),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


def test_resolve_derivative_exchange_independent_of_form_default(app):
    response = send(
        app,
        "/market/resolve",
        {"code": "m2701-P-3300", "kind": "option", "market": "SHFE", "currency": "CNY"},
    )
    assert response.status_code == 200, response.content
    assert response.json()["exchange"] == "DCE"
    assert response.json()["market"] == "CN"
    assert response.json()["specification"]["is_derivative"] is True


def test_product_create_persists_auto_exchange_without_financial_event(app):
    response = send(
        app,
        "/instruments",
        {
            "code": "m2701-P-3300",
            "name": "豆粕期权",
            "kind": "option",
            "market": "SHFE",
            "currency": "CNY",
        },
    )
    assert response.status_code == 200, response.content
    assert response.json()["specification"]["exchange"] == "DCE"
    assert response.json()["market"] == "CN"
    with tenant_context(app.space.pk):
        assert m.Event.objects.filter(tenant=app.space).count() == 0


def test_cached_fund_type_enriches_t_plus_without_network(app, monkeypatch):
    MarketSymbol.objects.create(
        code="005827",
        name="测试QDII基金",
        kind="fund",
        market="CN",
        currency="CNY",
        source="test_public_metadata",
        refreshed_at=timezone.now(),
        specification={"fund_type": "QDII-股票型"},
        search_text="005827",
    )
    from wealth import market_data

    monkeypatch.setattr(
        market_data,
        "_get",
        lambda *a, **kw: pytest.fail("Resolve should use server metadata cache"),
    )
    response = send(
        app, "/market/resolve", {"code": "005827", "kind": "fund", "market": "CN"}
    )
    assert response.status_code == 200, response.content
    assert response.json()["settlement_rule"]["confirmation_days"] == 2
    assert response.json()["settlement_rule"]["status"] == "estimated"
    assert response.json()["specification"]["is_qdii"] is True


def test_trade_date_preview_after_cutoff_skips_published_holiday(app):
    response = send(
        app,
        "/market/trade-dates",
        {
            "instrument": {"kind": "fund", "code": "110022"},
            "application_at": "2026-09-24T15:01:00+08:00",
        },
    )
    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload["trade_date"] == "2026-09-28"
    assert payload["expected_confirmation_date"] == "2026-09-29"
    assert payload["is_forecast"] is True and payload["creates_ledger_event"] is False
    with tenant_context(app.space.pk):
        assert not m.Event.objects.exists()


def test_changed_product_discards_old_rules_before_cached_fund_enrichment(app):
    previous = send(
        app, "/market/resolve", {"code": "m2701-P-3300", "kind": "option"}
    ).json()
    MarketSymbol.objects.create(
        code="005827",
        name="缓存测试基金",
        kind="fund",
        market="CN",
        currency="CNY",
        source="test_public_metadata",
        refreshed_at=timezone.now(),
        specification={"fund_type": "QDII-股票型"},
        search_text="005827",
    )
    response = send(
        app,
        "/market/resolve",
        {
            "code": "005827",
            "kind": "fund",
            "market": "CN",
            "specification": previous["specification"],
        },
    )
    assert response.status_code == 200, response.content
    result = response.json()
    assert result["exchange"] == "OTC"
    assert result["calendar"]["id"] == "CN_EXCHANGE"
    assert result["settlement_rule"]["confirmation_days"] == 2
    assert result["specification"]["is_qdii"] is True
    assert not result["specification"].get("is_derivative")


def test_resolve_scopes_private_instrument_by_workspace(app):
    assert (
        send(app, "/market/resolve", {"instrument_id": str(app.foreign.pk)}).status_code
        == 404
    )
    assert (
        send(
            app,
            "/market/trade-dates",
            {"instrument_id": str(app.foreign.pk), "application_date": "2026-09-24"},
        ).status_code
        == 404
    )


def test_etf_kind_survives_auto_identification(app):
    response = send(
        app,
        "/instruments",
        {
            "code": "510300",
            "name": "沪深300ETF",
            "kind": "etf",
            "market": "CN",
            "currency": "CNY",
        },
    )
    assert response.status_code == 200, response.content
    assert response.json()["kind"] == "etf"
    assert response.json()["specification"]["exchange"] == "SSE"
    assert (
        response.json()["specification"]["settlement_rule"]["confirmation_days"] is None
    )


def test_catalog_browse_returns_public_products_without_creating_holdings(app):
    from wealth.catalog import seed_catalog

    seed_catalog()
    response = app.client.get(app.base + "/market/catalog?kind=index&limit=50")
    assert response.status_code == 200, response.content
    assert len(response.json()["items"]) >= 10
    with tenant_context(app.space.pk):
        assert m.Instrument.objects.filter(tenant=app.space).count() == 0
