"""AKShare SDK contracts and isolation, without live upstream calls in CI."""

import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from wealth import akshare_provider as ap
from wealth import market_data as md

INVOKE = ap._invoke
STAMP = "2026-10-08T04:00:00+00:00"


def inst(kind="fund", code="270042", **extra):
    return {"kind": kind, "code": code, "market": "CN", "currency": "CNY", **extra}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 10, 8, 4, tzinfo=timezone.utc)
    )
    ap._CACHE.clear()


def feed(monkeypatch, **responses):
    calls = []

    def invoke(job, **params):
        calls.append((job, params))
        value = responses[job]
        if isinstance(value, Exception):
            raise value
        return {
            "rows": value,
            "fetched_at": STAMP,
            "interface_name": ap._INTERFACES[job],
        }

    monkeypatch.setattr(ap, "_invoke", invoke)
    return calls


def nav(day, value):
    return {"净值日期": day, "单位净值": value, "日增长率": "0.12"}


CATALOG = [
    ["270042", "广发纳斯达克100ETF联接(QDII)A人民币", "QDII"],
    ["510300", "沪深300ETF", "指数型"],
]


@pytest.mark.parametrize(
    "kind,code,operation,expected",
    [
        ("fund", "270042", "quote", True),
        ("stock", "000001", "history", True),
        ("etf", "510300", "quote", True),
        ("future", "M2701", "quote", True),
        ("future", "M2701", "history", False),
        ("future", "M0", "quote", False),
        ("option", "m2701-P-3300", "history", True),
        ("option", "10003720", "quote", False),
        ("stock", "AAPL", "quote", False),
        ("index", "000300", "quote", False),
    ],
)
def test_capabilities(kind, code, operation, expected):
    assert ap.supports(inst(kind, code), operation) is expected


@pytest.mark.parametrize(
    "extra", [{"currency": "USD"}, {"market": "HK"}, {"currency": "HKD"}]
)
def test_currency_and_market_not_inferred(extra):
    assert not ap.supports(inst(**extra))
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst(**extra))
    assert exc.value.code == "unsupported_akshare"


def test_qdii_economic_day_not_fetch_day_and_source_group(monkeypatch):
    feed(
        monkeypatch,
        fund_catalog=CATALOG,
        fund_nav=[nav("2026-09-30", "8.3691"), nav("2026-10-07", "8.3812")],
    )
    quote = ap.quote(inst(name="private family name"))
    assert quote["kind"] == "official_nav"
    assert quote["economic_date"] == "2026-10-07"
    assert quote["published_at"] is None
    assert quote["price"] == "8.3812"
    assert quote["provider_id"] == "akshare"
    assert quote["source_group"] == "eastmoney_fund"
    assert quote["interface_name"] == "fund_etf_fund_info_em"
    assert "private" not in quote["name"]
    assert "estimate" not in quote


def test_history_range_sorted_no_missing_days_filled(monkeypatch):
    feed(
        monkeypatch,
        fund_catalog=CATALOG,
        fund_nav=[
            nav("2026-10-07", "8.3812"),
            nav("2026-09-30", "8.3691"),
            nav("2026-09-29", "8.36"),
        ],
    )
    rows = ap.history(inst(), "2026-09-30", "2026-10-08")
    assert [r["economic_date"] for r in rows] == ["2026-09-30", "2026-10-07"]
    assert all(r["kind"] == "official_nav" for r in rows)


@pytest.mark.parametrize(
    "catalog,code",
    [
        ([], "identity_mismatch"),
        ([["270042", "现金宝货币", "货币型"]], "unsupported_money_fund"),
        ([["270042", "美元份额", "QDII"]], "currency_mismatch"),
        ([["270042", "", "QDII"]], "identity_mismatch"),
    ],
)
def test_identity_and_money_fund_fail_closed(monkeypatch, catalog, code):
    feed(monkeypatch, fund_catalog=catalog)
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst())
    assert exc.value.code == code


@pytest.mark.parametrize("value", ["0", "-1", "nan", "Infinity", None])
def test_invalid_nav_never_becomes_zero(monkeypatch, value):
    feed(monkeypatch, fund_catalog=CATALOG, fund_nav=[nav("2026-10-07", value)])
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst())
    assert exc.value.code == "invalid_price"


def test_same_day_conflicting_rows_not_silently_overwritten(monkeypatch):
    feed(
        monkeypatch,
        fund_catalog=CATALOG,
        fund_nav=[nav("2026-10-07", "1"), nav("2026-10-07", "2")],
    )
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst())
    assert exc.value.code == "conflicting_history"


def test_stock_identity_verified_and_partial_today_not_close(monkeypatch):
    feed(
        monkeypatch,
        stock_identity=[
            {"item": "股票代码", "value": "000001"},
            {"item": "股票简称", "value": "平安银行"},
        ],
        stock_history=[
            {"日期": "2026-10-07", "收盘": "11.25", "股票代码": "000001"},
            {"日期": "2026-10-08", "收盘": "11.30", "股票代码": "000001"},
        ],
    )
    q = ap.quote(inst("stock", "000001"))
    assert q["kind"] == "close"
    assert q["economic_date"] == "2026-10-07"
    assert q["price"] == "11.25"
    assert q["source_group"] == "eastmoney"
    assert q["published_at"] is None


def test_stock_today_close_after_finished_session(monkeypatch):
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 10, 8, 9, tzinfo=timezone.utc)
    )
    feed(
        monkeypatch,
        stock_identity=[
            {"item": "股票代码", "value": "000001"},
            {"item": "股票简称", "value": "平安银行"},
        ],
        stock_history=[{"日期": "2026-10-08", "收盘": "11.3", "股票代码": "000001"}],
    )
    assert ap.quote(inst("stock", "000001"))["economic_date"] == "2026-10-08"


def test_stock_mismatched_upstream_code_rejected(monkeypatch):
    feed(
        monkeypatch,
        stock_identity=[
            {"item": "股票代码", "value": "000002"},
            {"item": "股票简称", "value": "万科"},
        ],
    )
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst("stock", "000001"))
    assert exc.value.code == "identity_mismatch"


def test_etf_exact_catalog_identity_and_unadjusted_close(monkeypatch):
    feed(
        monkeypatch,
        fund_catalog=CATALOG,
        etf_history=[{"日期": "2026-10-07", "收盘": "3.81"}],
    )
    q = ap.quote(inst("etf", "510300"))
    assert q["interface_name"] == "fund_etf_hist_em"
    assert q["kind"] == "close"
    assert q["price"] == "3.81"


def test_future_exact_contract_exchange_and_dynamic_settlement_distinct(monkeypatch):
    feed(
        monkeypatch,
        future_quotes=[
            {
                "symbol": "M2701",
                "exchange": "dce",
                "name": "豆粕2701",
                "trade": "3100",
                "tradedate": "2026-10-08",
                "ticktime": "11:00:00",
                "settlement": "3098",
                "presettlement": "3090",
            },
            {"symbol": "M2705", "exchange": "dce", "trade": "3101"},
        ],
    )
    q = ap.quote(inst("future", "M2701"))
    assert q["price"] == "3100"
    assert q["kind"] == "market"
    assert q["economic_date"] == "2026-10-08"
    assert q["published_at"] == "2026-10-08T11:00:00+08:00"
    assert q["dynamic_settlement"] == "3098"
    assert q["previous_settlement"] == "3090"
    assert "settlement" not in q
    assert q["source_group"] == "sina"


@pytest.mark.parametrize(
    "row",
    [{"symbol": "M2705", "exchange": "dce"}, {"symbol": "M2701", "exchange": "shfe"}],
)
def test_future_wrong_identity_rejected(monkeypatch, row):
    feed(monkeypatch, future_quotes=[row])
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst("future", "M2701"))
    assert exc.value.code == "identity_mismatch"


@pytest.mark.parametrize("clock", [None, "", "unknown", "25:12:00", "12:99:00"])
def test_future_requires_valid_source_clock(monkeypatch, clock):
    feed(
        monkeypatch,
        future_quotes=[
            {
                "symbol": "M2701",
                "exchange": "dce",
                "trade": "3100",
                "tradedate": "2026-10-08",
                "ticktime": clock,
            }
        ],
    )
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst("future", "M2701"))
    assert exc.value.code == "invalid_time"


def test_night_session_date_not_invented_as_publication_timestamp(monkeypatch):
    feed(
        monkeypatch,
        future_quotes=[
            {
                "symbol": "M2701",
                "exchange": "dce",
                "trade": "3100",
                "tradedate": "2026-10-09",
                "ticktime": "21:23:45",
            }
        ],
    )
    q = ap.quote(inst("future", "M2701"))
    assert q["economic_date"] == "2026-10-09"
    assert q["published_at"] is None
    assert q["source_clock"] == "21:23:45"
    assert q["timestamp_quality"] == "source_clock_only"


def test_option_exact_contract_preflight_and_dated_close(monkeypatch):
    calls = feed(
        monkeypatch,
        option_identity=[{"看跌合约-看跌期权合约": "m2701P3300"}],
        option_history=[{"date": "2026-10-07", "close": "110.5"}],
    )
    q = ap.quote(inst("option", "m2701-P-3300"))
    assert q["price"] == "110.5"
    assert q["kind"] == "close"
    assert q["source_group"] == "sina"
    assert calls[-1] == ("option_history", {"symbol": "m2701P3300"})


@pytest.mark.parametrize("kind,code", [("future", "M2701"), ("option", "m2701-P-3300")])
def test_supplied_derivative_exchange_must_match_contract(kind, code):
    with pytest.raises(md.MarketDataError) as exc:
        ap.quote(inst(kind, code, specification={"exchange": "SHFE"}))
    assert exc.value.code == "identity_mismatch"


def test_cache_preserves_real_fetch_time_and_no_private_labels(monkeypatch):
    calls = feed(monkeypatch, fund_catalog=CATALOG, fund_nav=[nav("2026-10-07", "8.3")])
    a = ap.quote(inst(name="family A"))
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 10, 8, 5, tzinfo=timezone.utc)
    )
    b = ap.quote(inst(name="family B"))
    assert len(calls) == 2
    assert a["fetched_at"] == b["fetched_at"] == STAMP
    assert "family" not in repr(ap._CACHE)
    b["price"] = "99"
    assert ap.quote(inst())["price"] == "8.3"


def test_concurrent_public_calls_coalesced(monkeypatch):
    import threading

    arrived, release = threading.Event(), threading.Event()
    calls = []

    def invoke(job, **params):
        calls.append(job)
        arrived.set()
        assert release.wait(3)
        return {"rows": CATALOG, "fetched_at": STAMP, "interface_name": "fund_name_em"}

    monkeypatch.setattr(ap, "_invoke", invoke)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(ap._cached_call, "fund_catalog")
        assert arrived.wait(2)
        b = pool.submit(ap._cached_call, "fund_catalog")
        release.set()
        assert a.result() == b.result()
    assert calls == ["fund_catalog"]


def test_error_not_cached(monkeypatch):
    calls = feed(
        monkeypatch, fund_catalog=md.MarketDataError("provider_unavailable", "down")
    )
    for _ in range(2):
        with pytest.raises(md.MarketDataError):
            ap.quote(inst())
    assert len(calls) == 2


@pytest.mark.parametrize(
    "job,params",
    [
        ("os.system", {}),
        (
            "fund_nav",
            {"code": "../../etc/passwd", "start": "2026-01-01", "end": "2026-02-01"},
        ),
        ("fund_catalog", {"url": "https://private"}),
        ("stock_identity", {"code": "000001", "token": "secret"}),
        ("option_history", {"symbol": "m2701P3300; rm"}),
    ],
)
def test_worker_allowlist_before_process(monkeypatch, job, params):
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **k: pytest.fail("No child should run")
    )
    with pytest.raises(md.MarketDataError):
        INVOKE(job, **params)


def test_child_environment_does_not_receive_credentials(monkeypatch):
    for key in (
        "DJANGO_SECRET_KEY",
        "DATABASE_URL",
        "REDIS_URL",
        "TUSHARE_TOKEN",
        "HOME",
        "HTTPS_PROXY",
    ):
        monkeypatch.setenv(key, "sensitive")
    monkeypatch.setenv("PATH", "/usr/bin")
    seen = {}

    def run(command, **kwargs):
        seen.update(kwargs)
        assert command[1] == "-I"
        kwargs["stdout"].write(b'{"ok":true,"rows":[]}')
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", run)
    assert INVOKE("fund_catalog")["rows"] == []
    assert all(
        key not in seen["env"]
        for key in (
            "DJANGO_SECRET_KEY",
            "DATABASE_URL",
            "REDIS_URL",
            "TUSHARE_TOKEN",
            "HOME",
            "HTTPS_PROXY",
        )
    )
    assert seen["timeout"] <= 20
    assert seen["close_fds"] is True


def test_worker_deadline_and_timeout_releases_slot(monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", timeout)
    for _ in range(3):
        with pytest.raises(md.MarketDataError) as exc:
            INVOKE("fund_catalog")
        assert exc.value.code == "provider_timeout"


@pytest.mark.parametrize(
    "raw,code",
    [
        (b"not json", "invalid_response"),
        (b'{"ok":false,"code":"provider_unconfigured"}', "provider_unconfigured"),
        (b'{"ok":true,"rows":"invalid"}', "invalid_response"),
    ],
)
def test_worker_failure_is_clean(monkeypatch, raw, code):
    def run(*args, **kwargs):
        kwargs["stdout"].write(raw)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(md.MarketDataError) as exc:
        INVOKE("fund_catalog")
    assert exc.value.code == code


def test_worker_large_output_rejected(monkeypatch):
    def run(*args, **kwargs):
        kwargs["stdout"].write(b"x" * (ap.MAX_BYTES + 1))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(md.MarketDataError) as exc:
        INVOKE("fund_catalog")
    assert exc.value.code == "response_too_large"


def test_sdk_fixed_unadjusted_methods_no_js_execution():
    calls = []

    class Frame:
        def __len__(self):
            return 1

        def to_dict(self, orient):
            assert orient == "records"
            return [{"close": 1.2345, "date": datetime(2026, 10, 7)}]

    def read(**params):
        calls.append(params)
        return Frame()

    sdk = SimpleNamespace(stock_zh_a_hist=read)
    result = ap._sdk_rows(
        sdk,
        "stock_history",
        {"code": "000001", "start": "2026-09-01", "end": "2026-10-07"},
    )
    assert calls == [
        {
            "symbol": "000001",
            "period": "daily",
            "start_date": "20260901",
            "end_date": "20261007",
            "adjust": "",
            "timeout": 8,
        }
    ]
    assert result == [{"close": "1.2345", "date": "2026-10-07T00:00:00"}]


def test_nonfinite_sdk_values_preserved_as_missing():
    assert ap._plain([float("nan"), float("inf"), 1.7987]) == [None, None, "1.7987"]


def http_response(monkeypatch, *, status=200, chunks=(b'{"value":1}',), headers=None):
    seen = {}

    class Response:
        status_code = status

        def __init__(self):
            self.headers = headers or {}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            seen["status_checked"] = True

        def iter_content(self, chunk_size):
            assert chunk_size == 65_536
            return iter(chunks)

    response = Response()

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url, **params):
            seen.update(params)
            seen["trust_env"] = self.trust_env
            return response

    monkeypatch.setitem(sys.modules, "requests", SimpleNamespace(Session=Session))
    return response, seen


def test_contained_http_transport_is_bounded_and_no_redirects(monkeypatch):
    response, seen = http_response(monkeypatch)
    result = ap._bounded_http_get(
        "https://api.fund.eastmoney.com/f10/lsjz",
        params={"fundCode": "270042"},
        timeout=None,
    )
    assert result is response
    assert result._content == b'{"value":1}'
    assert result._content_consumed is True
    assert seen["timeout"] == 8
    assert seen["allow_redirects"] is False
    assert seen["trust_env"] is False
    assert seen["status_checked"] is True


@pytest.mark.parametrize(
    "url",
    [
        "http://fund.eastmoney.com/",
        "https://127.0.0.1/",
        "https://user:password@fund.eastmoney.com/",
        "https://fund.eastmoney.com:8080/",
    ],
)
def test_contained_http_transport_rejects_nonpublic_hosts(monkeypatch, url):
    _, seen = http_response(monkeypatch)
    with pytest.raises(md.MarketDataError) as exc:
        ap._bounded_http_get(url)
    assert exc.value.code == "unsafe_url"
    assert not seen


def test_contained_http_transport_rejects_redirect(monkeypatch):
    http_response(monkeypatch, status=302)
    with pytest.raises(md.MarketDataError) as exc:
        ap._bounded_http_get("https://fund.eastmoney.com/")
    assert exc.value.code == "provider_redirect"


@pytest.mark.parametrize("declared", [True, False])
def test_contained_http_transport_bounds_wire_body(monkeypatch, declared):
    http_response(
        monkeypatch,
        chunks=(b"x" * (8 * 1024 * 1024 + 1),),
        headers={"Content-Length": str(8 * 1024 * 1024 + 1)} if declared else {},
    )
    with pytest.raises(md.MarketDataError) as exc:
        ap._bounded_http_get("https://fund.eastmoney.com/")
    assert exc.value.code == "response_too_large"


def test_sdk_module_local_transport_does_not_patch_global_requests(monkeypatch):
    original = SimpleNamespace(get=lambda *a, **k: None)
    modules = {name: SimpleNamespace(requests=original) for name in ap._SDK_MODULES}
    monkeypatch.setattr(ap, "import_module", lambda name: modules[name])
    ap._guard_sdk_transport()
    assert all(
        module.requests.get is ap._bounded_http_get for module in modules.values()
    )
    assert original.get is not ap._bounded_http_get
