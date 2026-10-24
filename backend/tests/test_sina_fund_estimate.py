"""Fixed public-source contracts. No live network, DB, account or book writes."""

import copy
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from wealth import fund_sources as fs
from wealth import market_data as md
from wealth import provider_policy as policy
from wealth import sina_fund_estimate as sina

NOW = datetime(2026, 10, 13, 10, 41, tzinfo=timezone.utc)
PRODUCT = {"code": "017641", "kind": "fund", "market": "CN", "currency": "CNY"}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    fs._DATA_CACHE.clear()
    monkeypatch.setattr(md, "_now", lambda: NOW)
    monkeypatch.setattr(md, "_get", lambda *a, **k: pytest.fail("Unexpected HTTP"))
    yield
    fs._DATA_CACHE.clear()


def sample():
    # Minimal synthetic series with the public endpoint's field names. No user
    # holdings, public-site application code or clock-dependent live fixture.
    return {
        "result": {
            "status": {"code": 0},
            "data": {
                "worth": "1.7251",
                "worth_date": "20261009",
                "networth": [
                    {
                        "symbol": "017641",
                        "pre_nav": "1.7220",
                        "growthrate": "-0.001788",
                        "pre_date": "2026-10-12",
                        "min_time": "21:30:00",
                    },
                    {
                        "symbol": "017641",
                        "pre_nav": "1.7203",
                        "growthrate": "-0.002788",
                        "pre_date": "2026-10-13",
                        "min_time": "05:04:00",
                    },
                ],
            },
        }
    }


def feed(monkeypatch, payload):
    monkeypatch.setattr(md, "_get", lambda *a, **k: json.dumps(payload))


def config(chain, **flags):
    return {"schema_version": 4, "priority": {"fund": chain}, "enabled": flags}


def formal():
    return md._quote(
        PRODUCT,
        price="1.7251",
        kind="official_nav",
        economic_date="2026-10-09",
        source="formal",
    )


def test_overnight_reference_preserves_baseline_and_real_times_without_nav_date(
    monkeypatch,
):
    feed(monkeypatch, sample())
    result = sina.quote(PRODUCT)
    reference = result["reference_estimate"]
    assert result["price"] is None and "estimate" not in result
    assert reference["price"] == "1.7203"
    assert (
        reference["base_nav"] == "1.7251" and reference["base_nav_date"] == "2026-10-09"
    )
    assert reference["source_change_percent"] == "-0.278800"
    assert reference["base_ratio_consistent"] is True
    assert reference["published_at"] == "2026-10-13T05:04:00+08:00"
    assert reference["fetched_at"] == NOW.isoformat()
    assert reference["observation_window_start"] == "2026-10-12T21:30:00+08:00"
    assert reference["economic_date"] is None and reference["data_state"] == "delayed"
    assert (
        reference["usable_for_accounting"]
        is reference["usable_for_daily_return"]
        is False
    )
    from wealth.market_sync import _price_rows
    from wealth.models import Price

    monkeypatch.setattr(
        Price.objects,
        "filter",
        lambda **kwargs: SimpleNamespace(order_by=lambda *a: []),
    )

    assert _price_rows(None, SimpleNamespace(currency="CNY"), [result, reference]) == []


@pytest.mark.parametrize(
    "product",
    [
        {**PRODUCT, "currency": "USD"},
        {**PRODUCT, "market": "US"},
        {**PRODUCT, "code": "017641&symbol=270042"},
        {**PRODUCT, "kind": "etf"},
    ],
)
def test_unsupported_identity_never_fetches(product):
    with pytest.raises(md.MarketDataError, match="人民币"):
        sina.quote(product)


@pytest.mark.parametrize(
    "field,value",
    [
        ("symbol", "019305"),
        ("pre_date", "2026-10-14"),
        ("pre_date", "2026-02-30"),
        ("min_time", "25:00:00"),
        ("min_time", None),
        ("pre_nav", "NaN"),
        ("pre_nav", "0"),
    ],
)
def test_invalid_point_cannot_sneak_past_valid_other_points(monkeypatch, field, value):
    payload = sample()
    payload["result"]["data"]["networth"][0][field] = value
    feed(monkeypatch, payload)
    with pytest.raises(md.MarketDataError):
        sina.quote(PRODUCT)


@pytest.mark.parametrize(
    "field,value",
    [
        ("worth", None),
        ("worth", "-1"),
        ("worth_date", "20260230"),
        ("worth_date", "20261014"),
        ("networth", []),
    ],
)
def test_missing_or_future_baseline_rejected(monkeypatch, field, value):
    payload = sample()
    payload["result"]["data"][field] = value
    feed(monkeypatch, payload)
    with pytest.raises(md.MarketDataError):
        sina.quote(PRODUCT)


def test_growth_is_reference_only_never_multiplied_by_an_unrelated_nav(monkeypatch):
    payload = sample()
    payload["result"]["data"]["networth"][-1]["growthrate"] = "0.10"
    feed(monkeypatch, payload)
    reference = sina.quote(PRODUCT)["reference_estimate"]
    assert (
        reference["price"] == "1.7203" and reference["source_change_percent"] == "10.00"
    )
    assert reference["base_nav"] == "1.7251"
    assert reference["base_ratio_consistent"] is False


def test_reference_never_enters_official_comparison_and_keeps_eastmoney_estimate(
    monkeypatch,
):
    feed(monkeypatch, sample())
    reference = sina.quote(PRODUCT)
    nav = formal()
    nav["estimate"] = md._quote(
        PRODUCT, price="1.72", kind="estimate", published_at="2026-10-13T05:00:00+08:00"
    )
    monkeypatch.setattr(
        md,
        "_provider_quote",
        lambda provider, inst: reference if provider == "sina" else nav,
    )
    result = md.fetch_quote(PRODUCT, config(["eastmoney_fund", "sina"]))
    assert result["price"] == "1.7251" and result["estimate"]["price"] == "1.72"
    assert result["reference_estimate"]["price"] == "1.7203"
    assert result["data_quality"]["independent_source_count"] == 1
    assert result["provider_attempts"][-1]["status"] == "reference_only"
    assert result["reference_estimate"]["source_group"] == "sina"


def test_fresh_usable_primary_estimate_does_not_call_backup(monkeypatch):
    nav = formal()
    nav["estimate"] = md._quote(
        PRODUCT, price="1.72", kind="estimate", published_at=NOW - timedelta(seconds=30)
    )

    def quote(provider, inst):
        assert provider == "eastmoney_fund"
        return nav

    monkeypatch.setattr(md, "_provider_quote", quote)
    result = md.fetch_quote(PRODUCT, config(["eastmoney_fund", "sina"]))
    assert "reference_estimate" not in result


def test_cache_does_not_renew_source_quote_or_fetch_time(monkeypatch):
    clock = [100.0]
    calls = []

    def get(*args, **kwargs):
        calls.append(args[0])
        return json.dumps(sample())

    monkeypatch.setattr(md, "_get", get)
    monkeypatch.setattr(fs.time, "monotonic", lambda: clock[0])
    first = md.fetch_quote(PRODUCT, config(["sina"]))["reference_estimate"]
    clock[0] += 59
    monkeypatch.setattr(md, "_now", lambda: NOW + timedelta(seconds=59))
    assert md.fetch_quote(PRODUCT, config(["sina"]))["reference_estimate"] == first
    assert len(calls) == 1
    clock[0] += 2
    second = md.fetch_quote(PRODUCT, config(["sina"]))["reference_estimate"]
    assert len(calls) == 2 and second["published_at"] == first["published_at"]
    assert second["fetched_at"] != first["fetched_at"]


@pytest.mark.parametrize("version", [1, 2, 3])
def test_old_policy_adds_only_enabled_capability_and_is_idempotent(version):
    old = {
        "schema_version": version,
        "priority": {"fund": ["eastmoney_fund"]},
        "enabled": {"sina": True},
    }
    normalized = policy.validate_provider_config(old)
    assert (
        normalized["schema_version"] == 4
        and normalized["priority"]["fund"][-1] == "sina"
    )
    assert policy.validate_provider_config(normalized) == normalized
    assert old["priority"]["fund"] == ["eastmoney_fund"]


@pytest.mark.parametrize(
    "source_policy",
    [
        {"schema_version": 3, "priority": {"fund": []}},
        {
            "schema_version": 3,
            "priority": {"fund": ["eastmoney_fund"]},
            "enabled": {"sina": False},
        },
        {
            "schema_version": 3,
            "priority": {"fund": ["eastmoney_fund"]},
            "enabled": {"eastmoney_fund": False},
        },
        {"schema_version": 4, "priority": {"fund": ["eastmoney_fund"]}},
    ],
)
def test_policy_preserves_disabling_empty_chains_and_current_omissions(source_policy):
    assert "sina" not in policy.provider_chain(source_policy, "fund")


@pytest.mark.parametrize("version", [None, 1, 2, 3])
@pytest.mark.parametrize("explicit_priority", [False, True])
def test_legacy_all_disabled_fund_sources_do_not_enable_sina_capability(
    version, explicit_priority
):
    old_chain = [p for p in policy.DEFAULT_PRIORITY["fund"] if p != "sina"]
    previous = {"enabled": {p: False for p in old_chain}}
    if version is not None:
        previous["schema_version"] = version
    if explicit_priority:
        previous["priority"] = {"fund": old_chain}
    before = copy.deepcopy(previous)
    upgraded = policy.validate_provider_config(previous)
    # The existing Sina switch remains on for its other supported products;
    # gaining a fund capability must not turn an entirely disabled fund chain on.
    assert upgraded["enabled"]["sina"] is True
    assert policy.provider_chain(upgraded, "fund") == []
    assert policy.provider_chain(upgraded, "future") == ["sina"]
    assert "sina" not in upgraded["priority"]["fund"]
    assert previous == before
    assert policy.validate_provider_config(upgraded) == upgraded


@pytest.mark.parametrize("version", [None, 1, 2, 3])
def test_legacy_omitted_priority_upgrades_only_when_fund_source_was_enabled(version):
    previous = {"enabled": {"sina": True}}
    if version is not None:
        previous["schema_version"] = version
    assert policy.provider_chain(previous, "fund")[-1] == "sina"
    previous["enabled"]["sina"] = False
    assert "sina" not in policy.provider_chain(previous, "fund")


def test_current_version_defaults_include_new_capability_and_invalid_zero_rejected():
    assert policy.provider_chain({"schema_version": 4}, "fund")[-1] == "sina"
    with pytest.raises(ValueError, match="不支持"):
        policy.validate_provider_config({"schema_version": 0})


def test_disabled_sina_does_not_fetch_or_reuse_cached_data(monkeypatch):
    feed(monkeypatch, sample())
    assert md.fetch_quote(PRODUCT, config(["sina"]))["reference_estimate"]
    monkeypatch.setattr(
        md, "_get", lambda *a, **k: pytest.fail("Disabled source fetched")
    )
    result = md.fetch_quote(PRODUCT, config(["sina"], sina=False))
    assert (
        result["error_code"] == "provider_disabled"
        and "reference_estimate" not in result
    )
    assert not md._supports_provider("sina", md._instrument(PRODUCT), "history")


def test_sina_failure_does_not_block_valid_official_nav(monkeypatch):
    def quote(provider, inst):
        if provider == "sina":
            raise md.MarketDataError("provider_unavailable", "Unavailable")
        return copy.deepcopy(formal())

    monkeypatch.setattr(md, "_provider_quote", quote)
    result = md.fetch_quote(PRODUCT, config(["eastmoney_fund", "sina"]))
    assert (
        result["price"] == "1.7251" and result["data_quality"]["usable_for_accounting"]
    )


def test_public_quote_row_exposes_latest_reference_with_original_times(monkeypatch):
    from wealth import market_sync

    feed(monkeypatch, sample())
    reference = sina.quote(PRODUCT)["reference_estimate"]
    product = SimpleNamespace(pk="fund-id", name="fund", **PRODUCT)
    state = SimpleNamespace(
        data={
            "instrument_id": "fund-id",
            "quote": formal(),
            "reference_estimate": reference,
            "refresh_status": "failed",
            "fetched_at": "2026-10-13T10:30:00+00:00",
            "nav_quarantine": {"2026-10-09": {"status": "conflict"}},
        }
    )
    monkeypatch.setattr(market_sync.Resource.objects, "filter", lambda **kw: [state])
    monkeypatch.setattr(
        market_sync,
        "catalog_queryset",
        lambda *a: SimpleNamespace(
            filter=lambda **kw: SimpleNamespace(order_by=lambda *args: [product])
        ),
    )
    row = market_sync.quote_list(None)["items"][0]
    assert row["reference_estimate"] == reference
    assert row["reference_estimate"]["fetched_at"] != row["fetched_at"]
    assert row["reference_estimate"]["economic_date"] is None
    assert row["nav_quarantine"] == state.data["nav_quarantine"]
