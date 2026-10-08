"""Pure public-source contracts: no live HTTP, DB, credentials or ledger writes."""

import copy
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.error import URLError

import pytest
from wealth import fund_sources as fs
from wealth import market_data as md
from wealth import provider_policy as policy

_REAL_GET = md._get


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    fs._CACHE.clear()
    fs._DATA_CACHE.clear()
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
    )
    monkeypatch.setattr(md, "_get", lambda *a, **k: pytest.fail("Unexpected network"))
    monkeypatch.setattr(md, "_post", lambda *a, **k: pytest.fail("Unexpected POST"))
    yield
    fs._CACHE.clear()


@pytest.fixture
def samples():
    return json.loads(
        (
            Path(__file__).parent / "fixtures/market_data/official_fund_responses.json"
        ).read_text()
    )


def inst(code="270042", **kwargs):
    return md._instrument(
        {"code": code, "kind": "fund", "market": "CN", "currency": "CNY", **kwargs}
    )


def configuration(providers):
    return {
        "schema_version": 3,
        "priority": {"fund": providers},
        "enabled": {p: True for p in providers},
    }


def nav(product, provider, value="1.2300", day="2026-09-30", **kwargs):
    return md._quote(
        product,
        price=value,
        kind="official_nav",
        source=provider,
        economic_date=day,
        provider_id=provider,
        **kwargs,
    )


@pytest.mark.parametrize(
    "provider,code,count,last",
    [
        ("gffunds_official", "270042", 20, "8.3418"),
        ("efunds_official", "020602", 10, "1.0826"),
        ("cifm_official", "021187", 21, "1.2464"),
    ],
)
def test_recorded_official_history_identity_dates_and_publication(
    monkeypatch, samples, provider, code, count, last
):
    def get(url, **kwargs):
        if "BaseInfo" in url:
            return json.dumps(samples["gf_basic"])
        if "MarketPerformance" in url:
            return json.dumps(samples["gf_history"])
        if "efunds.com.cn" in url:
            return samples["ef_page"]
        if "fund_2697.xml" in url:
            return samples["cifm_catalog"]
        pytest.fail(url)

    monkeypatch.setattr(md, "_get", get)
    monkeypatch.setattr(
        md,
        "_post",
        lambda url, *a, **k: json.dumps(
            samples["ef_history" if "efunds" in url else "cifm_history"]
        ),
    )
    rows = md.fetch_history(
        inst(code),
        "2026-09-01",
        "2026-10-06",
        provider_config=configuration([provider]),
    )
    assert len(rows) == count and rows[-1]["price"] == last
    assert all(
        r["code"] == code
        and r["currency"] == "CNY"
        and r["published_at"] is None
        and r["identity_verified"]
        for r in rows
    )
    assert all(r["data_quality"]["status"] == "single_source" for r in rows)
    assert rows[-1]["economic_date"] < "2026-10-06"


@pytest.mark.parametrize(
    "field,value,error",
    [
        ("FUNDCODE", "270043", "identity_mismatch"),
        ("MONEYTYPE", "USD", "currency_mismatch"),
        ("CATEGORYNAME", "货币型", "unsupported_money_fund"),
    ],
)
def test_gf_identity_rejects_wrong_code_currency_or_money(
    monkeypatch, samples, field, value, error
):
    samples["gf_basic"]["data"][0][field] = value
    monkeypatch.setattr(md, "_get", lambda *a, **k: json.dumps(samples["gf_basic"]))
    result = md.fetch_quote(inst(), provider_config=configuration(["gffunds_official"]))
    assert result["price"] is None and result["error_code"] == error


@pytest.mark.parametrize(
    "before,after,error",
    [
        ('"020602"', '"020603"', "identity_mismatch"),
        ("单位净值(元)", "单位净值(美元)", "currency_mismatch"),
        ('"false"', '"true"', "unsupported_money_fund"),
    ],
)
def test_ef_product_page_binds_exact_share_and_currency(
    monkeypatch, samples, before, after, error
):
    monkeypatch.setattr(
        md, "_get", lambda *a, **k: samples["ef_page"].replace(before, after)
    )
    row = md.fetch_quote(
        inst("020602"), provider_config=configuration(["efunds_official"])
    )
    assert row["error_code"] == error and row["price"] is None


def test_ef_api_different_share_name_rejected(monkeypatch, samples):
    samples["ef_history"]["data"]["data"][0]["shortName"] = (
        "易方达中证红利低波动ETF联接发起式C"
    )
    monkeypatch.setattr(md, "_get", lambda *a, **k: samples["ef_page"])
    monkeypatch.setattr(md, "_post", lambda *a, **k: json.dumps(samples["ef_history"]))
    with pytest.raises(md.MarketDataError, match="份额名称"):
        md.fetch_history(
            inst("020602"),
            "2026-09-01",
            "2026-10-06",
            provider_config=configuration(["efunds_official"]),
        )


def test_pagination_incomplete_does_not_return_partial_nav(monkeypatch, samples):
    monkeypatch.setattr(md, "_get", lambda *a, **k: samples["ef_page"])
    calls = []

    def post(url, payload, **kwargs):
        calls.append(payload)
        data = copy.deepcopy(samples["ef_history"])
        data["data"]["total"] = 11
        if payload["pageIndex"]:
            data["data"]["data"] = []
        return json.dumps(data)

    monkeypatch.setattr(md, "_post", post)
    with pytest.raises(md.MarketDataError) as error:
        fs.official_history(
            "efunds_official", inst("020602"), date(2026, 9, 1), date(2026, 10, 6)
        )
    assert error.value.code == "incomplete_history" and len(calls) == 2


def test_comparison_queries_every_source_after_first_success_and_selects_latest(
    monkeypatch,
):
    calls = []

    def quote(provider, product):
        calls.append(provider)
        return nav(
            product,
            provider,
            "1.3" if provider == "efunds_official" else "1.2",
            "2026-09-30" if provider == "efunds_official" else "2026-09-29",
        )

    monkeypatch.setattr(md, "_provider_quote", quote)
    result = md.fetch_quote(
        inst(),
        provider_config=configuration(
            ["eastmoney_fund", "gffunds_official", "efunds_official"]
        ),
    )
    assert len(calls) == 3 and result["price"] == "1.3"
    assert result["data_quality"]["status"] == "single_source"
    assert len(result["provider_observations"]) == 3


@pytest.mark.parametrize(
    "second,expected", [("1.23", "consistent"), ("1.2301", "conflict")]
)
def test_same_date_decimal_agreement_and_conflict(monkeypatch, second, expected):
    monkeypatch.setattr(
        md,
        "_provider_quote",
        lambda p, i: nav(i, p, "1.2300" if p == "eastmoney_fund" else second),
    )
    result = md.fetch_quote(
        inst(), provider_config=configuration(["eastmoney_fund", "gffunds_official"])
    )
    assert result["data_quality"]["status"] == expected
    assert result["data_quality"]["usable_for_accounting"] == (expected == "consistent")
    if expected == "conflict":
        assert result["price"] is None and result["status"] == "conflict"
    json.dumps(result)


def test_history_conflict_is_returned_quarantined_not_dropped(monkeypatch):
    monkeypatch.setattr(
        md,
        "_provider_history",
        lambda p, i, *a: [
            nav(i, p, "1.2" if p == "eastmoney_fund" else "1.3"),
            nav(i, p, "1.1", "2026-09-29"),
        ],
    )
    rows = md.fetch_history(
        inst(),
        "2026-09-01",
        "2026-10-06",
        provider_config=configuration(["eastmoney_fund", "gffunds_official"]),
    )
    assert len(rows) == 2 and rows[0]["price"] == "1.1" and rows[1]["price"] is None
    assert rows[1]["data_quality"]["status"] == "conflict"


def test_same_provider_duplicate_prices_conflict_but_never_independent_agreement(
    monkeypatch,
):
    monkeypatch.setattr(
        md, "_provider_history", lambda p, i, *a: [nav(i, p, "1.2"), nav(i, p, "1.3")]
    )
    rows = md.fetch_history(
        inst(),
        "2026-09-01",
        "2026-10-06",
        provider_config=configuration(["eastmoney_fund"]),
    )
    assert rows[0]["price"] is None and rows[0]["data_quality"][
        "conflicting_providers"
    ] == ["eastmoney_fund"]


def test_estimate_remains_separate_and_does_not_resolve_formal_conflict(monkeypatch):
    def quote(p, i):
        result = nav(i, p, "1.2" if p == "eastmoney_fund" else "1.3")
        if p == "eastmoney_fund":
            result["estimate"] = md._quote(
                i,
                price="1.4",
                kind="estimate",
                source="estimate",
                economic_date="2026-09-30",
            )
        return result

    monkeypatch.setattr(md, "_provider_quote", quote)
    result = md.fetch_quote(
        inst(), provider_config=configuration(["eastmoney_fund", "gffunds_official"])
    )
    assert result["price"] is None and result["estimate"]["kind"] == "estimate"
    assert result["estimate"]["economic_date"] == "2026-09-30"


@pytest.mark.parametrize(
    "overrides",
    [
        {"code": "../../bad"},
        {"code": "１２３４５６"},
        {"currency": "USD"},
        {"market": "HK"},
    ],
)
def test_invalid_identity_never_requests_network(overrides):
    result = md.fetch_quote(
        inst(**overrides), provider_config=configuration(["gffunds_official"])
    )
    assert (
        result["price"] is None and not result["data_quality"]["usable_for_accounting"]
    )


def test_future_date_is_not_accepted(monkeypatch):
    monkeypatch.setattr(md, "_provider_quote", lambda p, i: nav(i, p, day="2026-10-07"))
    row = md.fetch_quote(inst(), provider_config=configuration(["eastmoney_fund"]))
    assert row["price"] is None and row["error_code"] == "invalid_date"


def test_history_rejects_entire_mismatched_batch(monkeypatch):
    def history(p, i, *a):
        return [nav(i, p), nav(inst("999999"), p, day="2026-09-29")]

    monkeypatch.setattr(md, "_provider_history", history)
    with pytest.raises(md.MarketDataError):
        md.fetch_history(
            inst(),
            "2026-09-01",
            "2026-10-06",
            provider_config=configuration(["eastmoney_fund"]),
        )


def test_xml_entities_are_rejected():
    with pytest.raises(md.MarketDataError):
        fs._xml('<!DOCTYPE a [<!ENTITY x "x">]><Root>&x;</Root>')


def test_policy_upgrade_preserves_explicit_disables_and_new_version_exact_priority():
    old = {
        "schema_version": 1,
        "enabled": {"eastmoney_fund": False, "gffunds_official": False},
        "priority": {"fund": ["eastmoney_fund"]},
    }
    upgraded = policy.validate_provider_config(old)
    assert upgraded["schema_version"] == 3 and policy.provider_chain(
        upgraded, "fund"
    ) == ["efunds_official", "cifm_official"]
    assert (
        not upgraded["enabled"]["gffunds_official"]
        and not upgraded["enabled"]["tushare_fund"]
    )
    exact = configuration(["eastmoney_fund"])
    assert policy.provider_chain(exact, "fund") == ["eastmoney_fund"]
    assert (
        policy.provider_chain({"schema_version": 2, "priority": {"fund": []}}, "fund")
        == []
    )


@pytest.mark.parametrize("provider", ["tushare_fund", "lixinger_fund"])
def test_enabled_token_provider_without_credentials_is_unconfigured(
    monkeypatch, provider
):
    monkeypatch.setitem(
        sys.modules,
        "wealth.provider_credentials",
        SimpleNamespace(get_provider_credentials=lambda p: None),
    )
    row = md.fetch_quote(inst(), provider_config=configuration([provider]))
    assert row["error_code"] == "provider_unconfigured"
    assert row["provider_attempts"][0]["status"] == "unconfigured"


def test_tushare_ann_date_not_forged_as_publication_timestamp(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "wealth.provider_credentials",
        SimpleNamespace(get_provider_credentials=lambda p: {"token": "secret"}),
    )
    monkeypatch.setattr(fs, "_verified_token_identity", lambda i: {})

    def post(url, payload, **kwargs):
        assert (
            url == "https://api.tushare.pro"
            and payload["params"]["ts_code"] == "270042.OF"
        )
        return json.dumps(
            {
                "code": 0,
                "data": {
                    "fields": ["ts_code", "ann_date", "nav_date", "unit_nav"],
                    "items": [["270042.OF", "20261005", "20260930", 1.234]],
                },
            }
        )

    monkeypatch.setattr(md, "_post", post)
    row = md.fetch_quote(inst(), provider_config=configuration(["tushare_fund"]))
    assert (
        row["publication_date"] == "2026-10-05"
        and row["published_at"] is None
        and row["economic_date"] == "2026-09-30"
    )
    assert "secret" not in json.dumps(row)


def test_vendor_error_body_is_not_exposed(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "wealth.provider_credentials",
        SimpleNamespace(get_provider_credentials=lambda p: {"token": "secret"}),
    )
    monkeypatch.setattr(fs, "_verified_token_identity", lambda i: {})
    monkeypatch.setattr(
        md,
        "_post",
        lambda *a, **k: json.dumps({"code": 2002, "msg": "secret token denied"}),
    )
    row = md.fetch_quote(inst(), provider_config=configuration(["tushare_fund"]))
    assert row["price"] is None and "secret" not in json.dumps(row)


def test_secure_transport_rejects_urls_and_does_not_echo_network_secrets(monkeypatch):
    with pytest.raises(md.MarketDataError, match="允许列表"):
        _REAL_GET("https://attacker.test/private", _body=b"secret")

    class BadOpener:
        def open(self, *a, **k):
            raise URLError("private secret")

    monkeypatch.setattr(md, "build_opener", lambda *a: BadOpener())
    with pytest.raises(md.MarketDataError) as error:
        _REAL_GET("https://api.tushare.pro", _body=b"secret")
    assert "secret" not in str(error.value)


def test_public_cache_ttl_does_not_cache_user_labels_or_rewrite_fetch_time(monkeypatch):
    calls = []
    tick = [1000]
    monkeypatch.setattr(fs.time, "monotonic", lambda: tick[0])

    def quote(p, i):
        calls.append(i)
        return nav(i, p)

    monkeypatch.setattr(md, "_provider_quote", quote)
    config = configuration(["eastmoney_fund"])
    first = md.fetch_quote(inst(name="private name A"), provider_config=config)
    first["price"] = "bad client mutation"
    second = md.fetch_quote(inst(name="private name B"), provider_config=config)
    assert len(calls) == 1 and calls[0]["name"] == ""
    assert second["price"] == "1.2300" and "private name" not in json.dumps(second)
    assert second["fetched_at"] == first["fetched_at"]
    tick[0] += 601
    md.fetch_quote(inst(), provider_config=config)
    assert len(calls) == 2


def test_error_is_retried_never_cached_as_zero(monkeypatch):
    calls = []

    def quote(p, i):
        calls.append(p)
        if len(calls) == 1:
            raise md.MarketDataError("provider_unavailable", "Unavailable")
        return nav(i, p)

    monkeypatch.setattr(md, "_provider_quote", quote)
    config = configuration(["eastmoney_fund"])
    assert md.fetch_quote(inst(), provider_config=config)["price"] is None
    assert md.fetch_quote(inst(), provider_config=config)["price"] == "1.2300"
    assert len(calls) == 2


def test_cached_data_does_not_bypass_disabled_policy(monkeypatch):
    monkeypatch.setattr(md, "_provider_quote", lambda p, i: nav(i, p))
    md.fetch_quote(inst(), provider_config=configuration(["eastmoney_fund"]))
    config = configuration(["eastmoney_fund"])
    config["enabled"]["eastmoney_fund"] = False
    assert (
        md.fetch_quote(inst(), provider_config=config)["error_code"]
        == "provider_disabled"
    )


def test_credential_rotation_changes_cache_key_without_retaining_token(monkeypatch):
    credential = ["private-token-one"]
    calls = []
    monkeypatch.setitem(
        sys.modules,
        "wealth.provider_credentials",
        SimpleNamespace(get_provider_credentials=lambda p: {"token": credential[0]}),
    )

    def quote(p, i):
        calls.append(p)
        return nav(i, p)

    monkeypatch.setattr(md, "_provider_quote", quote)
    config = configuration(["tushare_fund"])
    md.fetch_quote(inst(), provider_config=config)
    credential[0] = "private-token-two"
    md.fetch_quote(inst(), provider_config=config)
    assert len(calls) == 2
    assert "private-token" not in repr(fs._DATA_CACHE)


def test_concurrent_identical_requests_share_one_provider_call(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    entered, release = Event(), Event()
    calls = []

    def quote(p, i):
        calls.append(p)
        entered.set()
        assert release.wait(2)
        return nav(i, p)

    monkeypatch.setattr(md, "_provider_quote", quote)
    config = configuration(["eastmoney_fund"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(md.fetch_quote, inst(), config)
        assert entered.wait(2)
        second = pool.submit(md.fetch_quote, inst(), config)
        release.set()
        assert first.result()["price"] == second.result()["price"] == "1.2300"
    assert len(calls) == 1


def test_data_cache_has_bounded_entry_count(monkeypatch):
    monkeypatch.setattr(md, "_provider_quote", lambda p, i: nav(i, p))
    config = configuration(["eastmoney_fund"])
    for i in range(66):
        md.fetch_quote(inst(code=f"{i:06d}"), provider_config=config)
    assert len(fs._DATA_CACHE) == 64
    assert sum(value[2] for value in fs._DATA_CACHE.values()) <= fs._DATA_CACHE_BYTES


def test_morgan_qdii_exact_code_currency_identity_allows_official_shortname_alias(
    monkeypatch, samples
):
    monkeypatch.setattr(md, "_get", lambda *a, **k: samples["cifm_qdii_catalog"])
    monkeypatch.setattr(
        md, "_post", lambda *a, **k: json.dumps(samples["cifm_qdii_history"])
    )
    rows = md.fetch_history(
        inst("019172"),
        "2026-09-01",
        "2026-10-06",
        provider_config=configuration(["cifm_official"]),
    )
    assert rows[-1]["price"] == "1.7899" and rows[-1]["economic_date"] == "2026-09-29"
    assert rows[-1]["currency"] == "CNY" and rows[-1]["code"] == "019172"


@pytest.mark.parametrize(
    "field,value",
    [
        ("FUNDCODE", "019173"),
        ("FUNDNAME", "摩根纳斯达克100美元A"),
        ("FUNDTYPE", "货币型"),
    ],
)
def test_morgan_qdii_other_share_or_unit_is_rejected(
    monkeypatch, samples, field, value
):
    monkeypatch.setattr(md, "_get", lambda *a, **k: samples["cifm_qdii_catalog"])
    samples["cifm_qdii_history"]["rows"][0][field] = value
    monkeypatch.setattr(
        md, "_post", lambda *a, **k: json.dumps(samples["cifm_qdii_history"])
    )
    row = md.fetch_quote(
        inst("019172"), provider_config=configuration(["cifm_official"])
    )
    assert row["price"] is None and row["error_code"] == "identity_mismatch"


def test_available_estimate_is_retained_when_formal_nav_missing(monkeypatch):
    def quote(p, i):
        result = nav(i, p, value=None)
        result["estimate"] = md._quote(
            i,
            price="1.25",
            kind="estimate",
            source="public estimate",
            economic_date="2026-10-06",
        )
        return result

    monkeypatch.setattr(md, "_provider_quote", quote)
    row = md.fetch_quote(inst(), provider_config=configuration(["eastmoney_fund"]))
    assert row["price"] is None and not row["data_quality"]["usable_for_accounting"]
    assert row["estimate"]["price"] == "1.25" and row["estimate"]["kind"] == "estimate"
