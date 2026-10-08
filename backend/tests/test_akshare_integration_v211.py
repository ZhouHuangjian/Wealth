"""Policy, fallback and independent publisher accounting for the new SDK channel."""

from datetime import datetime, timezone

import pytest
from wealth import fund_sources as fs
from wealth import market_data as md
from wealth import market_quality as quality
from wealth import provider_policy as policy


@pytest.fixture(autouse=True)
def public_cache_and_clock(monkeypatch):
    fs._DATA_CACHE.clear()
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
    )


def fund():
    return md._instrument(
        {"kind": "fund", "code": "019172", "market": "CN", "currency": "CNY"}
    )


def nav(provider, price="1.25", day="2026-09-30"):
    row = md._quote(
        fund(),
        price=price,
        kind="official_nav",
        source=provider,
        economic_date=day,
        historical=True,
    )
    row["provider_id"] = provider
    return row


@pytest.mark.parametrize("version", [1, 2])
def test_legacy_policy_adds_fallback_without_reordering_or_reenabling_sources(version):
    old = {
        "schema_version": version,
        "enabled": {"sina": False},
        "priority": {"stock": ["yahoo", "tencent"], "future": ["sina"], "fund": []},
    }
    upgraded = policy.validate_provider_config(old)
    assert upgraded["schema_version"] == 3
    assert upgraded["priority"]["stock"] == ["yahoo", "tencent", "akshare"]
    assert upgraded["priority"]["future"] == ["sina"]
    assert upgraded["priority"]["fund"] == []
    assert upgraded["enabled"]["sina"] is False
    assert policy.validate_provider_config(upgraded) == upgraded


def test_new_policy_can_omit_or_disable_sdk_without_implicit_access():
    config = {
        "schema_version": 3,
        "enabled": {"akshare": False},
        "priority": {"stock": ["akshare"]},
    }
    assert policy.provider_chain(config, "stock") == []
    assert policy.provider_chain(
        {"schema_version": 3, "priority": {"stock": ["tencent"]}}, "stock"
    ) == ["tencent"]


def test_same_eastmoney_nav_is_single_independent_source(monkeypatch):
    monkeypatch.setattr(
        fs,
        "_cached_provider_call",
        lambda provider, inst, operation, *args: nav(provider),
    )
    result = fs.compare_quote(fund(), ["eastmoney_fund", "akshare"])
    assert result["data_quality"]["status"] == "single_source"
    assert result["data_quality"]["independent_source_count"] == 1
    assert result["data_quality"]["agreeing_source_groups"] == ["eastmoney_fund"]
    assert {r["source_group"] for r in result["provider_observations"]} == {
        "eastmoney_fund"
    }
    assert result["economic_date"] == "2026-09-30"
    assert result["published_at"] is None


def test_sdk_and_official_fund_manager_agreement_is_independent(monkeypatch):
    monkeypatch.setattr(
        fs,
        "_cached_provider_call",
        lambda provider, inst, operation, *args: nav(provider),
    )
    result = fs.compare_quote(fund(), ["akshare", "cifm_official"])
    assert result["data_quality"]["status"] == "consistent"
    assert result["data_quality"]["independent_source_count"] == 2


def test_conflicting_same_origin_observation_is_still_quarantined():
    result = fs._reconcile([nav("eastmoney_fund"), nav("akshare", "1.26")], [])
    assert result["price"] is None
    assert result["status"] == "conflict"
    assert result["data_quality"]["independent_source_count"] == 1


def test_wrapped_same_origin_cannot_clear_quarantine_even_for_legacy_quality():
    row = nav("akshare")
    row["data_quality"] = {
        "status": "consistent",
        "usable_for_accounting": True,
        "agreeing_providers": ["eastmoney_fund", "akshare"],
    }
    previous = {"2026-09-30": {"status": "conflict"}}
    assert quality.updated_quarantine(previous, [row], "2026-10-08") == previous
    row["data_quality"]["agreeing_providers"] = ["akshare", "cifm_official"]
    assert quality.updated_quarantine(previous, [row], "2026-10-08") == {}


def test_history_counts_underlying_sources_and_keeps_qdii_date(monkeypatch):
    monkeypatch.setattr(
        fs,
        "_cached_provider_call",
        lambda provider, inst, operation, *args: [nav(provider)],
    )
    rows = fs.compare_history(
        fund(),
        ["eastmoney_fund", "akshare"],
        md._date("2026-09-29"),
        md._date("2026-10-08"),
    )
    assert len(rows) == 1 and rows[0]["economic_date"] == "2026-09-30"
    assert rows[0]["data_quality"]["status"] == "single_source"


def test_actual_sdk_quote_route_and_fallback(monkeypatch):
    from wealth import akshare_provider as ak

    inst = {"kind": "stock", "code": "000001", "market": "CN", "currency": "CNY"}
    calls = []

    def legacy(product):
        calls.append("tencent")
        raise md.MarketDataError("provider_unavailable", "offline")

    def sdk(product):
        calls.append("akshare")
        return md._quote(
            product,
            price="12.34",
            kind="close",
            source="AKShare",
            economic_date="2026-10-08",
            historical=True,
        )

    monkeypatch.setattr(md, "_legacy_fetch_quote", legacy)
    monkeypatch.setattr(ak, "quote", sdk)
    config = {"schema_version": 3, "priority": {"stock": ["tencent", "akshare"]}}
    result = md.fetch_quote(inst, config)
    assert calls == ["tencent", "akshare"]
    assert result["price"] == "12.34" and result["provider_id"] == "akshare"
    assert result["source_group"] == "eastmoney"
    assert result["provider_attempts"][-1]["source_group"] == "eastmoney"


def test_sdk_failure_preserves_stale_first_quote_without_zero(monkeypatch):
    from wealth import akshare_provider as ak

    inst = {"kind": "stock", "code": "000001", "market": "CN", "currency": "CNY"}
    old = md._quote(
        md._instrument(inst),
        price="12.34",
        kind="close",
        source="old",
        economic_date="2026-09-25",
    )
    assert old["status"] == "stale"
    monkeypatch.setattr(md, "_legacy_fetch_quote", lambda product: old.copy())

    def failed(product):
        raise md.MarketDataError("provider_unavailable", "timeout")

    monkeypatch.setattr(ak, "quote", failed)
    result = md.fetch_quote(
        inst, {"schema_version": 3, "priority": {"stock": ["tencent", "akshare"]}}
    )
    assert result["price"] == "12.34" and result["provider_id"] == "tencent"
    assert result["provider_attempts"][-1]["status"] == "unavailable"


def test_directory_advertises_no_personal_import_no_foreign_or_settlement_capability():
    provider = next(
        row for row in policy.provider_directory() if row["id"] == "akshare"
    )
    assert provider["requires_credentials"] is False
    assert set(provider["operations"]) == {"quote", "history"}
    assert all(cap["markets"] == ["CN"] for cap in provider["capabilities"])
    assert next(cap for cap in provider["capabilities"] if cap["kind"] == "future")[
        "operations"
    ] == ["quote"]
