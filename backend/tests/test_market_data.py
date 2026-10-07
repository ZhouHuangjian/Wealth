"""Provider contracts from public response samples, with no live network in CI."""

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from wealth import market_data as md

HTTP_GET = md._get


@pytest.fixture
def responses():
    return json.loads(
        (Path(__file__).parent / "fixtures/market_data/responses.json").read_text()
    )


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch):
    from wealth import fund_sources

    fund_sources._DATA_CACHE.clear()
    fund_sources._CACHE.clear()
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 9, 25, 13, tzinfo=timezone.utc)
    )
    monkeypatch.setattr(
        md, "_get", lambda *a, **k: pytest.fail("Unexpected network request")
    )


def inst(kind="fund", code="110022", market="CN", currency="CNY"):
    return {"kind": kind, "code": code, "market": market, "currency": currency}


def feed(monkeypatch, value):
    monkeypatch.setattr(
        md,
        "_get",
        lambda *a, **k: value if isinstance(value, str) else json.dumps(value),
    )


def test_fund_official_nav_and_estimate_are_separate(monkeypatch, responses):
    feed(monkeypatch, responses["fund_new_good"])
    result = md.fetch_quote(inst(code="161725"))
    assert result["price"] == "0.5208"
    assert result["kind"] == "official_nav"
    assert result["economic_date"] == "2026-09-24"
    assert result["published_at"] is None
    assert result["estimate"]["price"] == "0.5204"
    assert result["estimate"]["kind"] == "estimate"
    assert result["estimate"]["published_at"] == "2026-09-24T15:00:00+08:00"
    assert result["fetched_at"] == "2026-09-25T13:00:00+00:00"


def test_fund_without_intraday_estimate_still_has_official_nav(monkeypatch, responses):
    feed(monkeypatch, responses["fund_new_good"])
    result = md.fetch_quote(inst())
    assert result["status"] == "ok"
    assert result["price"] == "2.781"
    assert result["estimate"]["price"] is None
    assert result["estimate"]["status"] == "unavailable"


def test_fund_history_returns_actual_dates_and_does_not_fill_today(
    monkeypatch, responses
):
    feed(monkeypatch, responses["fund_history"])
    rows = md.fetch_history(inst(), "2026-05-06", "2026-09-25")
    assert [r["economic_date"] for r in rows] == [
        "2026-05-06",
        "2026-05-07",
        "2026-09-24",
    ]
    assert all(r["kind"] == "official_nav" and r["published_at"] is None for r in rows)
    assert all(isinstance(r["price"], str) for r in rows)


def test_history_does_not_execute_javascript(monkeypatch):
    feed(
        monkeypatch,
        'var fS_code="110022";var fS_name="Example";var Data_netWorthTrend=(()=>{throw new Error("execute")})();',
    )
    with pytest.raises(md.MarketDataError, match="格式"):
        md.fetch_history(inst(), "2026-05-06", "2026-09-25")
    assert md._js_value("var safe=[1,2];arbitraryExecutableCode();", "safe") == [1, 2]


def test_fund_mismatched_identity_rejected(monkeypatch, responses):
    feed(monkeypatch, responses["fund_history"].replace('"110022"', '"999999"'))
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(inst(), "2026-05-06", "2026-09-25")
    assert error.value.code == "identity_mismatch"


@pytest.mark.parametrize(
    ("kind", "code", "market", "currency", "price", "stamp"),
    [
        ("stock", "600519", "CN", "CNY", "1237.00", "2026-09-24T16:14:44+08:00"),
        ("stock", "00700", "HK", "HKD", "436.600", "2026-09-25T16:08:20+08:00"),
        ("stock", "AAPL", "US", "USD", "335.92", "2026-09-24T16:00:01-04:00"),
        ("etf", "510300", "CN", "CNY", "4.515", "2026-09-24T16:14:56+08:00"),
    ],
)
def test_cn_hk_us_stock_and_etf(
    monkeypatch, responses, kind, code, market, currency, price, stamp
):
    feed(monkeypatch, responses["quotes"])
    result = md.fetch_quote(inst(kind, code, market, currency))
    assert result["status"] == "ok"
    assert result["price"] == price
    assert result["published_at"] == stamp
    assert result["kind"] == "market"
    assert result["currency"] == currency
    assert result["data_state"] in ("delayed", "previous_session")


@pytest.mark.parametrize(
    ("code", "fixture", "price", "name"),
    [
        ("RB2701", "sina_derivative", "3118.000", "螺纹钢2701"),
        ("IF2610", "option_good", "4428.000", "沪深300指数期货2610"),
        ("AU2612", "sina_derivative", "927.660", "黄金2612"),
    ],
)
def test_commodity_financial_and_gold_futures(
    monkeypatch, responses, code, fixture, price, name
):
    feed(monkeypatch, responses[fixture])
    result = md.fetch_quote(inst("future", code))
    assert result["price"] == price and result["name"] == name
    assert result["economic_date"] == "2026-09-24"
    assert result["kind"] == "market"  # Never settlement equity or contract notional.


def test_etf_option_quote_uses_premium_and_provider_time(monkeypatch, responses):
    feed(monkeypatch, responses["option_good"])
    result = md.fetch_quote(inst("option", "10012427"))
    assert result["price"] == "0.2148"
    assert result["name"] == "50ETF购10月2750"
    assert result["published_at"] == "2026-09-24T14:54:44+08:00"
    assert result["quote_unit"] == "每份权利金"


def test_spot_gold_currency_and_ounce_unit_explicit(monkeypatch, responses):
    feed(monkeypatch, responses["gold"])
    result = md.fetch_quote(inst("gold", "XAU", currency="USD"))
    assert result["price"] == "4298.96"
    assert result["quote_unit"] == "USD/金衡盎司"
    assert md.fetch_quote(inst("gold", "XAU"))["status"] == "unsupported"


@pytest.mark.parametrize("market", ["CN", "US"])
@pytest.mark.parametrize(
    ("fetched_hour", "fetched_minute", "state"),
    [(16, 41, "latest_available"), (17, 11, "delayed")],
)
def test_sina_spot_gold_clock_stays_beijing_across_midnight(
    monkeypatch, responses, market, fetched_hour, fetched_minute, state
):
    # The feed crosses midnight in Beijing while New York is still Sep 25.
    feed(
        monkeypatch,
        responses["gold"]
        .replace("20:57:00", "00:41:00")
        .replace("2026-09-25,伦敦金", "2026-09-26,伦敦金"),
    )
    now = datetime(
        2026,
        9,
        25,
        fetched_hour,
        fetched_minute,
        tzinfo=timezone.utc,
    )
    monkeypatch.setattr(md, "_now", lambda: now)
    result = md.fetch_quote(inst("gold", "XAU", market=market, currency="USD"))
    assert result["status"] == "ok"
    assert result["published_at"] == "2026-09-26T00:41:00+08:00"
    assert datetime.fromisoformat(result["published_at"]) <= now
    assert result["data_state"] == state
    assert result["currency"] == "USD"


def test_expired_or_unknown_option_is_missing_not_zero(monkeypatch, responses):
    feed(monkeypatch, responses["sina_derivative"])
    result = md.fetch_quote(inst("option", "10008273"))
    assert result["status"] == "unavailable"
    assert result["price"] is None


@pytest.mark.parametrize(
    "bad", ["NaN", "Infinity", "-Infinity", "--", None, True, "0", "-1", "1e9999"]
)
def test_invalid_prices_never_become_zero_or_a_quote(bad):
    result = md._quote(inst(), price=bad, economic_date="2026-09-24")
    assert result["price"] is None
    assert result["status"] == "unavailable"


def test_stale_price_preserves_original_date():
    result = md._quote(
        inst(), price="1.23", kind="official_nav", economic_date="2026-08-01"
    )
    assert result["status"] == "stale"
    assert result["economic_date"] == "2026-08-01"
    assert result["published_at"] is None


def test_missing_date_cannot_be_relabelled_today():
    result = md._quote(inst(), price="1.23")
    assert result["status"] == "unavailable"
    assert result["economic_date"] is None


def test_historical_weekends_and_missing_days_are_not_filled(monkeypatch, responses):
    feed(monkeypatch, responses["cn_history"])
    rows = md.fetch_history(inst("stock", "600519"), "2026-05-06", "2026-05-10")
    assert [r["economic_date"] for r in rows] == [
        "2026-05-06",
        "2026-05-07",
        "2026-05-08",
    ]
    assert rows[0]["price"] == "1375.000"
    assert all(r["kind"] == "close" for r in rows)


def test_us_history_uses_unadjusted_not_adjusted_close(monkeypatch, responses):
    feed(monkeypatch, responses["us_history"])
    rows = md.fetch_history(
        inst("stock", "AAPL", "US", "USD"), "2026-03-01", "2026-09-25"
    )
    assert len(rows) == 2
    assert all(r["currency"] == "USD" and r["kind"] == "close" for r in rows)
    assert all(Decimal(r["price"]) > 0 for r in rows)


def test_history_limits_and_unsupported_markets_do_not_call_network():
    for start, end in [
        ("2020-01-01", "2026-09-25"),
        ("2026-05-20", "2026-05-01"),
        ("abc", "2026-09-25"),
    ]:
        with pytest.raises(md.MarketDataError) as error:
            md.fetch_history(inst(), start, end)
        assert error.value.code == "invalid_range"
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(inst("future", "RB2701"), "2026-05-06", "2026-09-25")
    assert error.value.code == "unsupported_history"


def test_search_fund_code_and_institution(monkeypatch, responses):
    feed(monkeypatch, responses["fund_search"])
    rows = md.search_products("110022")
    assert rows[0]["name"] == "易方达消费行业股票"
    assert rows[0]["specification"]["institution"] == "易方达基金"
    assert rows[0]["currency"] == "CNY"


def test_search_filters_requested_market(monkeypatch, responses):
    feed(monkeypatch, responses["search_hk"])
    rows = md.search_products("00700", "stock", "HK")
    assert rows and all(r["market"] == "HK" and r["currency"] == "HKD" for r in rows)
    assert rows[0]["code"] == "00700"


def test_code_injection_and_currency_mismatch_never_reach_network():
    for product in [
        inst(code="../../etc/passwd"),
        inst("stock", "AAPL?other=x", "US", "USD"),
        inst("stock", "600519", currency="USD"),
        inst(currency="USD"),
        inst("option", "https://localhost"),
    ]:
        assert md.fetch_quote(product)["status"] == "unsupported"


def test_public_network_failure_is_reported_without_leaking_error(monkeypatch):
    def fail(*args, **kwargs):
        raise md.MarketDataError("provider_unavailable", "行情源暂时不可用，请稍后刷新")

    monkeypatch.setattr(md, "_get", fail)
    result = md.fetch_quote(inst("stock", "600519"))
    assert result["price"] is None and result["status"] == "unavailable"
    assert result["error_code"] == "provider_unavailable"


def test_no_cross_host_redirects():
    with pytest.raises(md.MarketDataError) as error:
        md._NoRedirect().redirect_request(None, None, 302, "", {}, "http://127.0.0.1/")
    assert error.value.code == "provider_redirect"


def test_quote_accepts_instrument_model_like_object(monkeypatch, responses):
    feed(monkeypatch, responses["fund_new_good"])

    class Instrument:
        code, kind, market, currency, name = "110022", "fund", "CN", "CNY", ""

    assert md.fetch_quote(Instrument())["price"] == "2.781"


@pytest.mark.parametrize(
    "url",
    [
        "http://qt.gtimg.cn/q=x",
        "https://localhost/private",
        "https://qt.gtimg.cn.evil.test/x",
        "https://user:pass@qt.gtimg.cn/x",
        "https://qt.gtimg.cn:444/x",
    ],
)
def test_url_allowlist_is_enforced_before_network(url):
    with pytest.raises(md.MarketDataError) as error:
        HTTP_GET(url)
    assert error.value.code == "unsafe_url"


def test_response_read_is_bounded(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, size):
            assert size == md.MAX_BYTES + 1
            return b"x" * size

    class Opener:
        def open(self, request, timeout):
            assert timeout == 8
            return Response()

    monkeypatch.setattr(md, "build_opener", lambda *args: Opener())
    with pytest.raises(md.MarketDataError) as error:
        HTTP_GET("https://qt.gtimg.cn/q=sh600519")
    assert error.value.code == "response_too_large"


def test_malformed_search_schema_returns_domain_error(monkeypatch):
    feed(monkeypatch, [])
    with pytest.raises(md.MarketDataError) as error:
        md.search_products("110022")
    assert error.value.code == "invalid_response"


def test_gold_futures_search_cannot_be_classified_as_physical_gold(
    monkeypatch, responses
):
    feed(monkeypatch, responses["sina_derivative"])
    rows = md.search_products("AU2612", "gold", "CN")
    assert rows[0]["kind"] == "future"
    assert rows[0]["specification"]["asset_class"] == "gold"
    assert rows[0]["specification"]["is_derivative"] is True
    assert md.fetch_quote(inst("gold", "AU2612"))["is_derivative"] is True


def test_continuous_gold_contract_is_only_a_reference(monkeypatch, responses):
    feed(monkeypatch, responses["gold"])
    rows = md.search_products("AU0", "gold", "CN")
    assert rows[0]["kind"] == "future"
    assert rows[0]["specification"]["reference_only"] is True


def test_money_fund_ten_thousand_unit_income_is_not_nav(monkeypatch):
    feed(
        monkeypatch,
        {
            "data": [
                {
                    "FCODE": "000198",
                    "SHORTNAME": "天弘余额宝货币",
                    "FUNDTYPE": "005",
                    "NAV": 0.225,
                    "PDATE": "2026-09-25",
                }
            ]
        },
    )
    result = md.fetch_quote(inst(code="000198"))
    assert result["status"] == "unsupported"
    assert result["price"] is None
    assert result["error_code"] == "unsupported_money_fund"


def test_money_fund_history_is_rejected_before_treating_income_as_nav(monkeypatch):
    feed(
        monkeypatch,
        'var fS_code="000198";var fS_name="Example";var ishb=true;var Data_netWorthTrend=[{"x":1789920000000,"y":0.225}];',
    )
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(inst(code="000198"), "2026-05-06", "2026-09-25")
    assert error.value.code == "unsupported_money_fund"


@pytest.mark.parametrize(
    ("market", "ready_hour", "minute", "include_today"),
    [
        ("CN", 15, 59, False),
        ("CN", 16, 0, True),
        ("HK", 16, 59, False),
        ("HK", 17, 0, True),
        ("US", 16, 59, False),
        ("US", 17, 0, True),
    ],
)
def test_intraday_daily_bar_is_not_promoted_to_formal_close(
    monkeypatch, market, ready_hour, minute, include_today
):
    market_zone = md.NEW_YORK if market == "US" else md.SHANGHAI
    now = datetime(2026, 9, 25, ready_hour, minute, tzinfo=market_zone)
    monkeypatch.setattr(md, "_now", lambda: now.astimezone(timezone.utc))
    product = inst(
        "stock",
        {"CN": "600519", "HK": "00700", "US": "AAPL"}[market],
        market,
        {"CN": "CNY", "HK": "HKD", "US": "USD"}[market],
    )
    if market == "US":
        feed(
            monkeypatch,
            {
                "chart": {
                    "result": [
                        {
                            "meta": {
                                "currency": "USD",
                                "symbol": "AAPL",
                                "instrumentType": "EQUITY",
                            },
                            "timestamp": [
                                int(
                                    datetime(
                                        2026, 9, d, 9, 30, tzinfo=md.NEW_YORK
                                    ).timestamp()
                                )
                                for d in (24, 25)
                            ],
                            "indicators": {"quote": [{"close": ["100", "101"]}]},
                        }
                    ]
                }
            },
        )
    else:
        symbol = "sh600519" if market == "CN" else "hk00700"
        feed(
            monkeypatch,
            {
                "data": {
                    symbol: {
                        "day": [
                            ["2026-09-24", "99", "100"],
                            ["2026-09-25", "100", "101"],
                        ]
                    }
                }
            },
        )
    rows = md.fetch_history(product, "2026-09-24", "2026-09-25")
    assert [row["economic_date"] for row in rows] == (
        ["2026-09-24", "2026-09-25"] if include_today else ["2026-09-24"]
    )
    assert all(row["kind"] == "close" for row in rows)


def test_us_closing_gate_uses_new_york_winter_offset(monkeypatch):
    # 21:30 UTC is 16:30 EST, still inside the one-hour publication buffer.
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 1, 8, 21, 30, tzinfo=timezone.utc)
    )
    assert (
        md._completed_stock_session(inst("stock", "AAPL", "US", "USD"), "2026-01-08")
        is False
    )
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 1, 8, 22, tzinfo=timezone.utc)
    )
    assert (
        md._completed_stock_session(inst("stock", "AAPL", "US", "USD"), "2026-01-08")
        is True
    )
