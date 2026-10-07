"""Safe source configuration and compatible failover, without network or database."""

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from wealth import market_data as md
from wealth import provider_policy as policy


@pytest.fixture(autouse=True)
def offline_clock(monkeypatch):
    from wealth import fund_sources

    fund_sources._DATA_CACHE.clear()
    fund_sources._CACHE.clear()
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 9, 25, 16, tzinfo=timezone.utc)
    )
    monkeypatch.setattr(
        md, "_get", lambda *a, **k: pytest.fail("Unexpected network request")
    )


def inst(kind="index", code="NDX", market="US", currency="USD"):
    return {"kind": kind, "code": code, "market": market, "currency": currency}


def fixtures(name="index_fallback_responses.json"):
    return json.loads(
        (Path(__file__).parent / "fixtures/market_data" / name).read_text()
    )


@pytest.mark.parametrize(
    "config",
    [
        [],
        {"url": "https://127.0.0.1"},
        {"enabled": {"custom": True}},
        {"schema_version": True},
        {"schema_version": 3},
        {"enabled": {"yahoo": "false"}},
        {"priority": {"fund": ["yahoo"]}},
        {"priority": {"stock": ["yahoo", "yahoo"]}},
        {"priority": {"unknown": []}},
        {"priority": {"index": "yahoo"}},
        {"enabled": {"secret": "x"}},
        {"version": 1},
    ],
)
def test_rejects_unsafe_or_ambiguous_config(config):
    with pytest.raises(ValueError):
        policy.validate_provider_config(config)


def test_defaults_are_independent_and_capabilities_are_honest():
    config = policy.default_provider_config()
    config["enabled"]["sina"] = False
    assert policy.default_provider_config()["enabled"]["sina"] is True
    assert policy.provider_chain(config, "future") == []
    assert policy.provider_chain({}, "fund") == [
        "eastmoney_fund",
        *policy._NEW_PUBLIC_FUND,
    ]
    assert policy.provider_chain({}, "option") == ["sina"]
    assert "yahoo" not in policy.provider_chain({}, "gold")
    providers = policy.provider_directory()
    assert set(config["enabled"]) == {row["id"] for row in providers}
    for kind, chain in config["priority"].items():
        assert all(
            any(row["id"] == p and kind in row["kinds"] for row in providers)
            for p in chain
        )
    providers[0]["hosts"].append("attacker.test")
    assert "attacker.test" not in policy.provider_directory()[0]["hosts"]


@pytest.mark.parametrize(
    ("product", "source"),
    [
        (inst("fund", "110022", "CN", "CNY"), "eastmoney_fund"),
        (inst("future", "RB2701", "CN", "CNY"), "sina"),
        (inst("option", "m2701-P-3300", "CN", "CNY"), "sina"),
        (inst("gold", "XAU", "CN", "USD"), "sina"),
    ],
)
def test_single_source_disabled_has_no_network_or_zero(product, source):
    config = {
        "schema_version": 2,
        "priority": {product["kind"]: [source]},
        "enabled": {source: False},
    }
    result = md.fetch_quote(product, provider_config=config)
    assert result["price"] is None and result["error_code"] == "provider_disabled"
    with pytest.raises(md.MarketDataError):
        md.fetch_history(
            product,
            "2026-09-01",
            "2026-09-24",
            provider_config=config,
        )


def test_all_index_sources_disabled_cannot_reenter_hardcoded_fallback():
    config = policy.default_provider_config()
    config["enabled"] = dict.fromkeys(config["enabled"], False)
    assert md.fetch_quote(inst(), provider_config=config)["price"] is None
    with pytest.raises(md.MarketDataError, match="没有已启用"):
        md.fetch_history(inst(), "2026-09-01", "2026-09-24", provider_config=config)


def test_reordered_index_provider_is_called_first_without_yahoo(monkeypatch):
    urls = []

    def get(url, **kwargs):
        urls.append(url)
        return fixtures()["ndx_quote"]

    monkeypatch.setattr(md, "_get", get)
    result = md.fetch_quote(
        inst(), provider_config={"priority": {"index": ["tencent", "yahoo"]}}
    )
    assert result["provider_id"] == "tencent" and result["price"] is not None
    assert len(urls) == 1 and "qt.gtimg.cn" in urls[0]


def test_disabled_tencent_is_not_used_after_yahoo_failure(monkeypatch):
    urls = []

    def get(url, **kwargs):
        urls.append(url)
        raise md.MarketDataError("provider_unavailable", "rate limited")

    monkeypatch.setattr(md, "_get", get)
    result = md.fetch_quote(inst(), provider_config={"enabled": {"tencent": False}})
    assert result["price"] is None
    assert len(urls) == 1 and "yahoo" in urls[0]


def test_ndx_history_skips_incompatible_tencent_and_uses_enabled_nasdaq(monkeypatch):
    urls = []

    def get(url, **kwargs):
        urls.append(url)
        return json.dumps(fixtures()["nasdaq_history"])

    monkeypatch.setattr(md, "_get", get)
    result = md.fetch_history(
        inst(),
        "2025-09-25",
        "2026-09-25",
        provider_config={"priority": {"index": ["tencent", "nasdaq"]}},
    )
    assert result[-1]["provider_id"] == "nasdaq"
    assert len(urls) == 1 and "api.nasdaq.com" in urls[0]


def test_stale_first_source_can_yield_to_fresh_compatible_source(monkeypatch):
    calls = []

    def provider(source, product):
        calls.append(source)
        return {
            "status": "stale" if source == "yahoo" else "ok",
            "price": "100",
            "kind": "market",
        }

    monkeypatch.setattr(md, "_provider_quote", provider)
    result = md.fetch_quote(inst("index", "SPX"))
    assert result["provider_id"] == "tencent" and calls == ["yahoo", "tencent"]
    assert [row["status"] for row in result["provider_attempts"]] == ["stale", "ok"]


def test_empty_history_source_tries_next_compatible_source(monkeypatch):
    calls = []

    def provider(source, product, start, end):
        calls.append(source)
        return (
            []
            if source == "yahoo"
            else [{"economic_date": "2026-09-24", "price": "7704.130", "kind": "close"}]
        )

    monkeypatch.setattr(md, "_provider_history", provider)
    rows = md.fetch_history(inst("index", "SPX"), "2026-09-01", "2026-09-24")
    assert calls == ["yahoo", "tencent"] and rows[0]["provider_id"] == "tencent"


@pytest.mark.parametrize(
    "kind,source,query",
    [
        ("fund", "eastmoney_fund", "易方达"),
        ("stock", "eastmoney_search", "苹果"),
        ("etf", "eastmoney_search", "黄金ETF"),
    ],
)
def test_disabled_metadata_source_cannot_search(kind, source, query):
    with pytest.raises(md.MarketDataError, match="停用"):
        md.search_products(
            query, kind, "CN", provider_config={"enabled": {source: False}}
        )


def test_us_stock_quote_fails_over_with_exact_identity_currency_and_source_date(
    monkeypatch,
):
    urls = []
    payload = fixtures("responses.json")["us_history"]

    def get(url, **kwargs):
        urls.append(url)
        if "gtimg" in url:
            raise md.MarketDataError("quote_unavailable", "missing")
        return json.dumps(payload)

    monkeypatch.setattr(md, "_get", get)
    result = md.fetch_quote(inst("stock", "AAPL"))
    assert result["provider_id"] == "yahoo" and result["price"] == "335.92"
    assert result["published_at"] == "2026-09-24T16:00:01-04:00"
    assert result["currency"] == "USD" and len(urls) == 2


@pytest.mark.parametrize(
    "key,value", [("symbol", "SPY"), ("currency", "CNY"), ("instrumentType", "INDEX")]
)
def test_yahoo_quote_and_history_reject_wrong_security(monkeypatch, key, value):
    payload = copy.deepcopy(fixtures("responses.json")["us_history"])
    payload["chart"]["result"][0]["meta"][key] = value
    monkeypatch.setattr(md, "_get", lambda *a, **k: json.dumps(payload))
    config = {"priority": {"stock": ["yahoo"]}}
    result = md.fetch_quote(inst("stock", "AAPL"), provider_config=config)
    assert result["price"] is None and result["error_code"] == "identity_mismatch"
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(
            inst("stock", "AAPL"), "2026-05-06", "2026-05-08", provider_config=config
        )
    assert error.value.code in {"identity_mismatch", "currency_mismatch"}


def test_yahoo_stock_timestamp_cannot_claim_future_quote(monkeypatch):
    payload = copy.deepcopy(fixtures("responses.json")["us_history"])
    payload["chart"]["result"][0]["meta"]["regularMarketTime"] = 9_999_999_999
    monkeypatch.setattr(md, "_get", lambda *a, **k: json.dumps(payload))
    result = md.fetch_quote(
        inst("stock", "AAPL"), provider_config={"priority": {"stock": ["yahoo"]}}
    )
    assert result["price"] is None and result["error_code"] == "invalid_timestamp"
