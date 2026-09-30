"""Public-only persistent directory and local-first search boundaries."""

from unittest.mock import ANY, Mock

import pytest
from wealth import catalog, market_data
from wealth.models import MarketSymbol

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr(
        market_data, "_get", lambda *a, **k: pytest.fail("Unexpected network request")
    )


def test_empty_local_search_does_not_seed_or_request_network():
    assert MarketSymbol.objects.count() == 0
    result = catalog.search_catalog("红利低波", "index", "CN")
    assert result["items"] == [] and result["source"] == "local"
    assert MarketSymbol.objects.count() == 0


def test_explicit_seed_fuzzy_alias_and_market_separation():
    count = catalog.seed_catalog()
    assert count > 20
    assert catalog.seed_catalog() == 0
    assert (
        catalog.search_catalog("nasdaq-100", "index", "US")["items"][0]["code"] == "NDX"
    )
    assert catalog.search_catalog("苹果", "stock", "US")["items"][0]["code"] == "AAPL"
    assert catalog.search_catalog("苹果", "stock", "CN")["items"] == []
    assert catalog.search_catalog("豆粕", "future", "CN")["items"][0]["code"] == "M0"
    assert catalog.search_catalog("红利低波", "index", "CN")["local_count"] == 3
    assert (
        catalog.search_catalog("红利低波", "index", "CN", limit=1)["items"][0]["status"]
        == "metadata_only"
    )


def test_local_search_bounds_and_sql_metacharacters_are_literal():
    catalog.seed_catalog()
    assert catalog.search_catalog("' OR 1=1 --", "stock", "CN")["items"] == []
    assert catalog.search_catalog("%", "stock", "CN")["items"] == []
    assert catalog.search_catalog("a" * 81, "stock", "US")["status"] == "empty"
    assert len(catalog.search_catalog("红利", "index", "CN", limit=1)["items"]) == 1


def test_parsed_contract_is_not_falsely_persisted_as_listed():
    result = catalog.search_catalog("2701豆粕沽3300", "option", "CN")
    row = result["items"][0]
    assert row["code"] == "m2701-P-3300"
    assert row["status"] == "unverified" and row["source"] == "notation"
    assert MarketSymbol.objects.count() == 0


def test_remote_verified_option_then_offline_search(monkeypatch):
    source = Mock(
        return_value=[market_data.normalize_commodity_contract("m2701-P-3300")]
    )
    monkeypatch.setattr(market_data, "search_products", source)
    result = catalog.search_catalog("2701豆粕沽3300", "option", "CN", remote=True)
    source.assert_called_once_with("m2701-P-3300", "option", "CN", provider_config=ANY)
    assert result["remote_status"] == "ok"
    assert result["items"][0]["status"] == "verified"
    assert MarketSymbol.objects.count() == 1
    local = catalog.search_catalog("豆粕2701认沽3300", "option", "CN")
    assert local["source"] == "local" and local["local_count"] == 1
    assert source.call_count == 1


def test_remote_flag_requires_explicit_boolean(monkeypatch):
    source = Mock(side_effect=AssertionError("Must not query provider"))
    monkeypatch.setattr(market_data, "search_products", source)
    assert (
        catalog.search_catalog("AAPL", "stock", "US", remote="false")[
            "remote_requested"
        ]
        is False
    )
    source.assert_not_called()


def test_remote_matches_do_not_need_to_contain_raw_query(monkeypatch):
    row = {
        "kind": "stock",
        "market": "US",
        "code": "ABCD",
        "name": "Provider official name",
        "currency": "USD",
    }
    monkeypatch.setattr(market_data, "search_products", lambda *a, **kwargs: [row])
    result = catalog.search_catalog(
        "private lookup wording", "stock", "US", remote=True
    )
    assert result["items"][0]["code"] == "ABCD"
    assert "private" not in MarketSymbol.objects.get().search_text


def test_provider_refresh_preserves_verified_public_aliases(monkeypatch):
    catalog.seed_catalog()
    row = {
        "kind": "stock",
        "market": "US",
        "code": "AAPL",
        "name": "苹果",
        "currency": "USD",
        "aliases": ["PG"],
    }
    monkeypatch.setattr(market_data, "search_products", lambda *a, **kwargs: [row])
    catalog.search_catalog("AAPL", "stock", "US", remote=True)
    assert catalog.search_catalog("apple", "stock", "US")["items"][0]["code"] == "AAPL"
    assert catalog.search_catalog("pg", "stock", "US")["items"][0]["code"] == "AAPL"


def test_provider_results_cannot_copy_portfolio_fields_into_shared_metadata(
    monkeypatch,
):
    row = {
        "kind": "stock",
        "market": "US",
        "code": "AAPL",
        "name": "苹果",
        "currency": "USD",
        "tenant_id": "private",
        "account_id": "private",
        "specification": {
            "quote_unit": "每股",
            "account_id": "private",
            "quantity": "150",
            "purchase_date": "2026-01-01",
        },
    }
    monkeypatch.setattr(market_data, "search_products", lambda *a, **kwargs: [row])
    result = catalog.search_catalog("苹果", "stock", "US", remote=True)
    assert result["items"][0]["specification"] == {"quote_unit": "每股"}
    assert {f.name for f in MarketSymbol._meta.fields}.isdisjoint(
        {"tenant", "account", "user", "quantity", "cost"}
    )
    assert MarketSymbol.objects.get().search_text == "aapl 苹果"


def test_remote_failure_preserves_local_metadata_with_explicit_failure(monkeypatch):
    catalog.seed_catalog()

    def failure(*args, **kwargs):
        raise market_data.MarketDataError("provider_unavailable", "源暂不可用")

    monkeypatch.setattr(market_data, "search_products", failure)
    result = catalog.search_catalog("AAPL", "stock", "US", remote=True)
    assert result["items"][0]["code"] == "AAPL"
    assert (
        result["status"] == "unavailable" and result["remote_status"] == "unavailable"
    )
    assert result["message"] == "源暂不可用"


def test_empty_remote_response_does_not_claim_refreshed_seed(monkeypatch):
    catalog.seed_catalog()
    monkeypatch.setattr(market_data, "search_products", lambda *a, **kwargs: [])
    result = catalog.search_catalog("AAPL", "stock", "US", remote=True)
    assert result["items"][0]["status"] == "metadata_only"
    assert result["remote_status"] == "unavailable"


def test_background_fund_directory_has_pinyin_and_correct_share_currency(monkeypatch):
    urls = []

    def get(url, **kwargs):
        urls.append((url, kwargs))
        return 'var r=[["110022","YFDXFHYGP","易方达消费行业股票","股票型","YIFANGDAXIAOFEIHANGYEGUPIAO"],["005000","ABC","某美元债基金人民币A","债券型","USDDEBT"],["005001","ABC","某基金(美元现汇)A","债券型","USDSHARE"]];'

    monkeypatch.setattr(market_data, "_get", get)
    result = catalog.refresh_catalog(limit=100)
    assert result["status"] == "ready" and result["updated"] == 3
    assert urls[0][1]["max_bytes"] == 8_000_000
    assert (
        catalog.search_catalog("xiaofei", "fund", "CN")["items"][0]["code"] == "110022"
    )
    assert MarketSymbol.objects.get(code="005000").currency == "CNY"
    assert MarketSymbol.objects.get(code="005001").currency == "USD"
    assert catalog.refresh_catalog(limit=100)["status"] == "up_to_date"
    assert len(urls) == 1


def test_background_failure_retains_previously_seeded_catalog(monkeypatch):
    def fail(*args, **kwargs):
        raise market_data.MarketDataError("provider_unavailable", "目录不可用")

    monkeypatch.setattr(market_data, "_get", fail)
    result = catalog.refresh_catalog()
    assert result["status"] == "unavailable"
    assert result["seeded"] > 0
    assert catalog.search_catalog("NDX", "index", "US")["items"]


def test_upsert_keeps_public_identity_stable(monkeypatch):
    row = {
        "kind": "stock",
        "market": "US",
        "code": "AAPL",
        "name": "苹果",
        "currency": "USD",
    }
    monkeypatch.setattr(market_data, "search_products", lambda *a, **kwargs: [row])
    first = catalog.search_catalog("AAPL", "stock", "US", remote=True)
    second = catalog.search_catalog("AAPL", "stock", "US", remote=True)
    assert first["items"][0]["catalog_id"] == second["items"][0]["catalog_id"]
    assert MarketSymbol.objects.count() == 1
