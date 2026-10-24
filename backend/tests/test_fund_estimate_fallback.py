"""An estimate remains its own observation when the latest NAV field is missing."""

import json
from datetime import datetime, timezone

import pytest
from wealth import fund_sources, market_data

PRODUCT = {"kind": "fund", "code": "123456", "market": "CN", "currency": "CNY"}
CONFIG = {"schema_version": 4, "priority": {"fund": ["eastmoney_fund"]}}
NOW = datetime(2026, 10, 13, 6, 0, tzinfo=timezone.utc)


@pytest.fixture
def feed(monkeypatch):
    payload = {
        "FCODE": "123456",
        "SHORTNAME": "Synthetic fund",
        "FUNDTYPE": "001",
        "NAV": None,
        "PDATE": "2026-10-12",
        "GSZ": "1.02",
        "GZTIME": "2026-10-13 14:00",
        "GSZZL": "2.00",
    }
    state = {
        "payload": payload,
        "history_failed": False,
        "history_error": "history_unavailable",
        "calls": [],
    }
    monkeypatch.setattr(market_data, "_now", lambda: NOW)
    monkeypatch.setattr(fund_sources, "_DATA_CACHE", {})
    monkeypatch.setattr(fund_sources, "_IN_FLIGHT", {})
    monkeypatch.setattr("wealth.valuation_calendar.open_days_between", lambda *a: 0)

    def get(url, **kwargs):
        state["calls"].append(url)
        if "FundValuationLast?" in url:
            return json.dumps({"data": [state["payload"]]})
        assert url == "https://fund.eastmoney.com/pingzhongdata/123456.js"
        if state["history_failed"]:
            raise market_data.MarketDataError(
                state["history_error"], "Synthetic outage"
            )
        stamp = int(datetime(2026, 10, 12, tzinfo=timezone.utc).timestamp() * 1000)
        return (
            'var fS_code="123456";var fS_name="Synthetic fund";'
            "var Data_netWorthTrend="
            + json.dumps([{"x": stamp, "y": "1", "equityReturn": "0"}])
            + ";"
        )

    monkeypatch.setattr(market_data, "_get", get)
    return state


@pytest.mark.parametrize("missing", ["NAV", "PDATE"])
def test_latest_nav_gap_uses_formal_history_without_losing_valid_estimate(
    feed, missing
):
    feed["payload"].update(NAV="1", PDATE="2026-10-12")
    feed["payload"][missing] = None
    result = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    assert result["kind"] == "official_nav"
    assert result["price"] == "1"
    assert result["economic_date"] == "2026-10-12"
    assert result["published_at"] is None
    estimate = result["estimate"]
    assert estimate["kind"] == "estimate"
    assert estimate["price"] == "1.02"
    assert estimate["economic_date"] == "2026-10-13"
    assert estimate["published_at"] == "2026-10-13T14:00:00+08:00"
    assert estimate["fetched_at"] == NOW.isoformat()


def test_missing_formal_history_does_not_invent_nav_from_estimate(feed):
    feed["history_failed"] = True
    result = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    assert result["status"] == "unavailable"
    assert result["price"] is None
    assert result["data_quality"]["usable_for_accounting"] is False
    assert result["estimate"]["kind"] == "estimate"
    assert result["estimate"]["price"] == "1.02"


def test_another_enabled_formal_source_can_use_preserved_estimate(feed, monkeypatch):
    feed["history_failed"] = True

    def official(provider, product):
        assert provider == "gffunds_official"
        return market_data._quote(
            product,
            price="1",
            kind="official_nav",
            source="Synthetic official NAV",
            economic_date="2026-10-12",
        )

    monkeypatch.setattr(fund_sources, "official_quote", official)
    config = {**CONFIG, "priority": {"fund": ["eastmoney_fund", "gffunds_official"]}}
    result = market_data.fetch_quote(PRODUCT, provider_config=config)
    assert result["kind"] == "official_nav"
    assert result["source"] == "Synthetic official NAV"
    assert result["price"] == "1"
    assert result["data_quality"]["usable_for_accounting"] is True
    assert result["estimate"]["price"] == "1.02"
    assert result["estimate"]["source"] == "天天基金·盘中估值"


def test_known_estimate_is_not_replaced_by_later_history_fetch_timestamp(
    feed, monkeypatch
):
    original_get = market_data._get

    def get(url, **kwargs):
        if "pingzhongdata" in url:
            monkeypatch.setattr(
                market_data,
                "_now",
                lambda: datetime(2026, 10, 13, 6, 5, tzinfo=timezone.utc),
            )
        return original_get(url, **kwargs)

    monkeypatch.setattr(market_data, "_get", get)
    result = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    assert result["estimate"]["fetched_at"] == NOW.isoformat()
    assert result["estimate"]["published_at"] == "2026-10-13T14:00:00+08:00"
    assert result["fetched_at"] == "2026-10-13T06:05:00+00:00"


def test_foreign_code_estimate_is_not_attached_to_matching_formal_history(feed):
    feed["payload"]["FCODE"] = "654321"
    result = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    assert result["price"] == "1"
    assert result["estimate"]["price"] is None


@pytest.mark.parametrize("error", ["identity_mismatch", "unsupported_money_fund"])
def test_history_identity_or_product_rule_failure_is_not_bypassed_by_estimate(
    feed, error
):
    feed.update(history_failed=True, history_error=error)
    result = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    assert result["price"] is None
    assert "estimate" not in result
    assert result["error_code"] == error


def test_money_fund_does_not_fall_back_to_ordinary_nav_or_estimate(feed):
    feed["payload"]["FUNDTYPE"] = "005"
    result = market_data.fetch_quote(PRODUCT, provider_config=CONFIG)
    assert result["error_code"] == "unsupported_money_fund"
    assert result["price"] is None
    assert "estimate" not in result
    assert len(feed["calls"]) == 1


def test_disabled_provider_never_uses_estimate_fallback(feed):
    config = {**CONFIG, "enabled": {"eastmoney_fund": False}}
    result = market_data.fetch_quote(PRODUCT, provider_config=config)
    assert result["error_code"] == "provider_disabled"
    assert not feed["calls"]
