"""Cross-process policy visibility and local-only cached market browsing."""

from unittest.mock import Mock

import pytest
from django.contrib.auth import get_user_model
from wealth import (
    catalog,
    market_data,
    market_sync,
)
from wealth import (
    models as m,
)
from wealth import (
    provider_policy as policy,
)
from wealth.common import tenant_context
from wealth.platform_models import PlatformSetting

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setattr(
        market_data, "_get", lambda *a, **k: pytest.fail("Unexpected network")
    )


def test_config_reads_current_database_on_every_request():
    assert policy.get_provider_config() == policy.default_provider_config()
    config = policy.default_provider_config()
    config["enabled"]["sina"] = False
    row = PlatformSetting.objects.create(key="market_sources", data=config, version=1)
    assert policy.provider_chain(policy.get_provider_config(), "future") == []
    config["enabled"]["sina"] = True
    row.data, row.version = config, 2
    row.save()
    # Another worker does not need an in-process invalidate notification.
    assert policy.provider_chain(policy.get_provider_config(), "future") == ["sina"]


def test_invalid_persisted_config_fails_closed():
    PlatformSetting.objects.create(
        key="market_sources", data={"url": "https://attacker.test"}
    )
    with pytest.raises(ValueError):
        policy.get_provider_config()


def test_empty_browse_never_seeds_or_reads_policy(monkeypatch):
    monkeypatch.setattr(
        catalog,
        "get_provider_config",
        lambda: pytest.fail("Local browsing read policy"),
    )
    assert catalog.browse_catalog() == {"items": [], "count": 0, "has_more": False}
    assert m.MarketSymbol.objects.count() == 0


def test_browse_seeded_candidates_filters_paginates_and_never_contacts_source(
    monkeypatch,
):
    catalog.seed_catalog()
    monkeypatch.setattr(
        catalog,
        "get_provider_config",
        lambda: pytest.fail("Local browsing read policy"),
    )
    page = catalog.browse_catalog("index", "CN", limit=2)
    assert page["count"] >= 10 and len(page["items"]) == 2 and page["has_more"]
    second = catalog.browse_catalog("index", "CN", offset=2, limit=2)
    assert {r["code"] for r in page["items"]}.isdisjoint(
        {r["code"] for r in second["items"]}
    )
    assert (
        catalog.browse_catalog("index", "US", query="道指")["items"][0]["code"] == "DJI"
    )
    assert (
        catalog.browse_catalog("index", "HK", query="恒指")["items"][0]["code"] == "HSI"
    )
    assert (
        catalog.browse_catalog("etf", "CN", query="黄金")["items"][0]["code"]
        == "518880"
    )
    assert (
        catalog.browse_catalog("gold", "CN", query="伦敦金")["items"][0]["currency"]
        == "USD"
    )
    assert catalog.browse_catalog(query="' OR 1=1 --")["count"] == 0
    assert catalog.browse_catalog(kind="invalid")["count"] == 0
    assert all(r["status"] == "metadata_only" for r in page["items"])
    assert len(catalog.browse_catalog(limit=999999)["items"]) <= 100


def test_remote_search_receives_fresh_policy_snapshot(monkeypatch):
    config = policy.validate_provider_config({"enabled": {"eastmoney_search": False}})
    PlatformSetting.objects.create(key="market_sources", data=config)
    source = Mock(return_value=[])
    monkeypatch.setattr(market_data, "search_products", source)
    catalog.search_catalog("AAPL", "stock", "US", remote=True)
    assert source.call_args.kwargs["provider_config"] == config


def test_disabled_fund_catalog_source_keeps_seeds_without_network():
    PlatformSetting.objects.create(
        key="market_sources", data={"enabled": {"eastmoney_fund": False}}
    )
    result = catalog.refresh_catalog(force=True)
    assert result["status"] == "disabled" and result["updated"] == 0
    assert m.MarketSymbol.objects.filter(kind="index", code="NDX").exists()
    assert (
        not m.MarketSymbol.objects.filter(kind="fund")
        .exclude(source="verified_public_seed")
        .exists()
    )


@pytest.fixture
def refresh_book(settings):
    settings.WEALTH_MARKET_DATA_ENABLED = True
    settings.WEALTH_MARKET_INLINE = True
    user = get_user_model().objects.create_user("provider-policy-owner")
    space = m.Workspace.objects.create(name="Policy test")
    m.Membership.objects.create(user=user, workspace=space, role="owner")
    with tenant_context(space.pk):
        instrument = m.Instrument.objects.create(
            tenant=space,
            created_by=user,
            name="Apple",
            kind="stock",
            code="AAPL",
            market="US",
            currency="USD",
        )
        market_sync.queue_refresh(
            space, user, [str(instrument.pk)], history=True, start="2026-05-06"
        )
        token = market_sync._state(space, instrument).data["request_token"]
    return space, instrument, token


@pytest.mark.parametrize(
    "config",
    [{"enabled": {"tencent": False, "yahoo": False}}, {"url": "https://attacker.test"}],
)
def test_failed_or_disabled_policy_does_not_import_prices_or_clear_history_intent(
    refresh_book, config
):
    space, instrument, token = refresh_book
    PlatformSetting.objects.create(key="market_sources", data=config)
    result = market_sync.refresh_one(str(space.pk), str(instrument.pk), token)
    assert result["status"] == "failed" and result["prices_added"] == 0
    with tenant_context(space.pk):
        state = market_sync._state(space, instrument)
        assert state.data["history_requested"] is True
        assert state.data["history_error"]
        assert not state.data.get("last_history_at")
        assert not m.Price.objects.filter(tenant=space).exists()
        assert not m.Event.objects.filter(tenant=space).exists()
