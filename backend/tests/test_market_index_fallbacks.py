"""Public source fallbacks reproduced from the Ubuntu server's actual replies."""

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from wealth import market_data as md


@pytest.fixture
def samples():
    return json.loads(
        (
            Path(__file__).parent / "fixtures/market_data/index_fallback_responses.json"
        ).read_text()
    )


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 9, 25, 16, tzinfo=timezone.utc)
    )
    monkeypatch.setattr(
        md, "_get", lambda *a, **k: pytest.fail("Unexpected network request")
    )


def inst(code):
    return {"kind": "index", "code": code, "market": "US", "currency": "USD"}


def unavailable():
    raise md.MarketDataError("provider_unavailable", "源暂不可用")


def route(monkeypatch, *, quote=None, history=None):
    urls = []

    def get(url, **kwargs):
        urls.append(url)
        if "yahoo" in url:
            unavailable()
        payload = (
            history
            if "kline" in url or ".csv" in url or "/historical?" in url
            else quote
        )
        if payload is None:
            unavailable()
        return payload if isinstance(payload, str) else json.dumps(payload)

    monkeypatch.setattr(md, "_get", get)
    return urls


@pytest.mark.parametrize(
    ("code", "sample", "symbol"),
    [("NDX", "ndx_quote", "us.NDX"), ("SPX", "spx_quote", "us.INX")],
)
def test_yahoo_429_can_use_verified_tencent_indices(
    monkeypatch, samples, code, sample, symbol
):
    urls = route(monkeypatch, quote=samples[sample])
    quote = md.fetch_quote(inst(code))
    assert quote["status"] == "ok" and quote["price"] is not None
    assert quote["source"] == "腾讯财经·指数参考点位"
    assert quote["published_at"].startswith("2026-09-25T11:")
    assert quote["published_at"].endswith("-04:00")
    assert quote["quote_unit"] == "指数点"
    assert urls[-1] == "https://qt.gtimg.cn/q=" + symbol


def test_wrong_index_in_fallback_quote_is_rejected(monkeypatch, samples):
    route(monkeypatch, quote=samples["ndx_quote"].replace("~.NDX~", "~.IXIC~"))
    result = md.fetch_quote(inst("NDX"))
    assert result["price"] is None and result["error_code"] == "identity_mismatch"


def test_real_tencent_ndx_history_with_wrong_dx_stock_qt_is_rejected(
    monkeypatch, samples
):
    # Actual provider defect: historical index rows followed by a DX.N stock bar.
    route(monkeypatch, history=samples["ndx_history"])
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(inst("NDX"), "2025-09-25", "2026-09-25")
    assert error.value.code == "identity_mismatch"


def test_spx_history_has_original_closes_and_excludes_live_bar(monkeypatch, samples):
    route(monkeypatch, history=samples["spx_history"])
    rows = md.fetch_history(inst("SPX"), "2025-09-25", "2026-09-25")
    assert [row["economic_date"] for row in rows] == ["2025-09-25", "2026-09-24"]
    assert rows[-1]["price"] == "7704.130"
    assert all(
        row["kind"] == "close" and row["source"] == "腾讯财经·指数收盘点位"
        for row in rows
    )


def test_ndx_history_uses_nasdaq_official_prices_and_not_broken_tencent(
    monkeypatch, samples
):
    urls = route(monkeypatch, history=samples["nasdaq_history"])
    rows = md.fetch_history(inst("NDX"), "2025-09-25", "2026-09-25")
    assert [row["economic_date"] for row in rows] == ["2025-09-25", "2026-09-24"]
    assert rows[-1]["price"] == "30478.86"
    assert rows[-1]["source"] == "Nasdaq·NDX官方收盘点位"
    assert all("gtimg" not in url for url in urls)
    assert urls[-1].startswith("https://api.nasdaq.com/api/quote/NDX/historical?")


def test_nasdaq_cannot_silently_truncate_history(monkeypatch, samples):
    payload = copy.deepcopy(samples["nasdaq_history"])
    payload["data"]["totalRecords"] = 500
    route(monkeypatch, history=payload)
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(inst("NDX"), "2025-09-25", "2026-09-25")
    assert error.value.code == "incomplete_history"


def test_nasdaq_index_identity_and_today_bar_validation(monkeypatch, samples):
    payload = copy.deepcopy(samples["nasdaq_history"])
    payload["data"]["tradesTable"]["rows"].append(
        {"date": "09/25/2026", "close": "30,580.50"}
    )
    payload["data"]["totalRecords"] = 3
    route(monkeypatch, history=payload)
    assert (
        md.fetch_history(inst("NDX"), "2025-09-25", "2026-09-25")[-1]["economic_date"]
        == "2026-09-24"
    )
    payload["data"]["symbol"] = "IXIC"
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(inst("NDX"), "2025-09-25", "2026-09-25")
    assert error.value.code == "identity_mismatch"


def test_wrong_historical_envelope_cannot_fall_back_to_any_first_item(
    monkeypatch, samples
):
    payload = copy.deepcopy(samples["spx_history"])
    payload["data"]["us.INX_WRONG"] = payload["data"].pop("us.INX")
    route(monkeypatch, history=payload)
    with pytest.raises(md.MarketDataError):
        md.fetch_history(inst("SPX"), "2025-09-25", "2026-09-25")


def test_cboe_delayed_quote_keeps_trade_time_and_delay_label(monkeypatch, samples):
    urls = route(monkeypatch, quote=samples["vix_quote"])
    result = md.fetch_quote(inst("VIX"))
    assert result["source"] == "Cboe·VIX官方延迟点位"
    assert result["price"] == "15.66"
    assert result["published_at"] == "2026-09-25T10:49:16-04:00"
    assert result["economic_date"] == "2026-09-25"
    assert result["delay_minutes"] == 15 and "延迟" in result["feed_delay"]
    assert result["data_state"] == "delayed"
    assert urls[-1].endswith("/_VIX.json")


@pytest.mark.parametrize("field", ["symbol", "security_type"])
def test_cboe_wrong_identity_is_rejected(monkeypatch, samples, field):
    payload = copy.deepcopy(samples["vix_quote"])
    payload["data"][field] = "VIXY_ETF"
    route(monkeypatch, quote=payload)
    result = md.fetch_quote(inst("VIX"))
    assert result["price"] is None and result["error_code"] == "identity_mismatch"


def test_cboe_missing_trade_time_does_not_invent_today(monkeypatch, samples):
    payload = copy.deepcopy(samples["vix_quote"])
    payload["data"].pop("last_trade_time")
    route(monkeypatch, quote=payload)
    result = md.fetch_quote(inst("VIX"))
    assert result["price"] is None and result["error_code"] == "missing_timestamp"


def test_cboe_history_uses_official_new_host_and_original_closes(monkeypatch, samples):
    urls = route(monkeypatch, history=samples["vix_history"])
    rows = md.fetch_history(inst("VIX"), "2026-09-20", "2026-09-25")
    assert [row["economic_date"] for row in rows] == [
        "2026-09-22",
        "2026-09-23",
        "2026-09-24",
    ]
    assert rows[-1]["price"] == "15.670000"
    assert all(row["published_at"] is None for row in rows)
    assert (
        urls[-1]
        == "https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"
    )


def test_cboe_live_unavailable_can_return_explicit_last_close(monkeypatch, samples):
    route(monkeypatch, history=samples["vix_history"])
    result = md.fetch_quote(inst("VIX"))
    assert result["kind"] == "close" and result["price"] == "15.670000"
    assert result["economic_date"] == "2026-09-24" and result["published_at"] is None
    assert result["live_status"] == "unavailable" and "收盘" in result["message"]


def test_cboe_invalid_schema_never_imports_another_series(monkeypatch):
    route(monkeypatch, history="observation_date,SP500\n2026-09-24,7704.13\n")
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(inst("VIX"), "2026-09-20", "2026-09-25")
    assert error.value.code == "invalid_response"


def test_cboe_intraday_bar_is_not_admitted_as_formal_close(monkeypatch, samples):
    csv = samples["vix_history"] + "09/25/2026,15,16,14,15.5\n"
    route(monkeypatch, history=csv)
    rows = md.fetch_history(inst("VIX"), "2026-09-20", "2026-09-25")
    assert rows[-1]["economic_date"] == "2026-09-24"


def test_failed_fallback_is_not_zero_or_an_etf_proxy(monkeypatch):
    route(monkeypatch)
    result = md.fetch_quote(inst("VIX"))
    assert result["status"] == "unavailable" and result["price"] is None


def test_cboe_future_or_wrong_timezone_stamp_is_rejected(monkeypatch, samples):
    payload = copy.deepcopy(samples["vix_quote"])
    payload["data"]["last_trade_time"] = "2026-09-25T15:49:16"
    route(monkeypatch, quote=payload)
    result = md.fetch_quote(inst("VIX"))
    assert result["price"] is None and result["error_code"] == "invalid_timestamp"


def test_cached_intraday_spx_bar_does_not_become_close_after_wall_clock_close(
    monkeypatch, samples
):
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 9, 25, 21, tzinfo=timezone.utc)
    )
    route(monkeypatch, history=samples["spx_history"])
    rows = md.fetch_history(inst("SPX"), "2025-09-25", "2026-09-25")
    assert rows[-1]["economic_date"] == "2026-09-24"
