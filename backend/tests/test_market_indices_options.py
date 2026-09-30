"""Provider regressions using dated public feed samples, never live CI calls."""

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from wealth import market_data as md


@pytest.fixture
def sample():
    return json.loads(
        (
            Path(__file__).parent / "fixtures/market_data/catalog_responses.json"
        ).read_text()
    )


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch):
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 9, 25, 14, tzinfo=timezone.utc)
    )
    monkeypatch.setattr(
        md, "_get", lambda *a, **k: pytest.fail("Unexpected network request")
    )


def feed(monkeypatch, data):
    monkeypatch.setattr(
        md, "_get", lambda *a, **k: data if isinstance(data, str) else json.dumps(data)
    )


def index(code="NDX", market="US", currency="USD"):
    return {"kind": "index", "code": code, "market": market, "currency": currency}


@pytest.mark.parametrize(
    "notation",
    [
        "2701豆粕沽3300",
        "豆粕2701认沽3300",
        "m2701-P-3300",
        "M2701P3300",
        "ｍ２７０１ｐ３３００",
    ],
)
def test_commodity_option_notation_is_one_contract(notation):
    row = md.normalize_commodity_contract(notation)
    assert row["code"] == "m2701-P-3300"
    assert row["specification"]["provider_symbol"] == "m2701P3300"
    assert row["specification"]["option_right"] == "put"
    assert row["specification"]["contract_multiplier"] == "10"


@pytest.mark.parametrize(
    "notation",
    [
        "m2713P3300",
        "m2702P3300",
        "m2701MSP3300",
        "m2701P0",
        "10005711",
        "https://example.com/m2701P3300",
        "a" * 81,
    ],
)
def test_ambiguous_invalid_or_etf_notation_is_not_commodity_option(notation):
    assert md.normalize_commodity_contract(notation) is None


def test_copper_chinese_notation_and_verified_multiplier():
    row = md.normalize_commodity_contract("沪铜2701看涨80000")
    assert row["code"] == "cu2701-C-80000"
    assert row["specification"]["contract_multiplier"] == "5"
    assert row["specification"]["quote_unit"] == "CNY/吨"


def test_natural_future_notation_stays_future():
    assert md.normalize_commodity_future("2701豆粕")["code"] == "M2701"
    assert md.normalize_commodity_future("豆粕2701期货")["kind"] == "future"
    assert md.normalize_commodity_future("m2701P3300") is None


def test_commodity_option_uses_own_feed_and_original_timestamp(monkeypatch, sample):
    urls = []

    def get(url, **kwargs):
        urls.append(url)
        return sample["commodity_option"]

    monkeypatch.setattr(md, "_get", get)
    quote = md.fetch_quote(md.normalize_commodity_contract("2701豆粕沽3300"))
    assert urls == ["https://hq.sinajs.cn/list=P_OP_m2701P3300"]
    assert quote["price"] == "40.000"
    assert quote["economic_date"] == "2026-09-24"
    assert quote["published_at"] == "2026-09-24T15:04:42+08:00"
    assert quote["is_derivative"] is True
    assert quote["quote_unit"] == "CNY/吨"
    assert quote["contract_multiplier"] == "10"
    assert quote["change_percent"] is None


def test_etf_option_does_not_enter_commodity_feed(monkeypatch):
    urls = []

    def get(url, **kwargs):
        urls.append(url)
        return 'var hq_str_CON_OP_10005711="";'

    monkeypatch.setattr(md, "_get", get)
    quote = md.fetch_quote(
        {"code": "10005711", "kind": "option", "market": "CN", "currency": "CNY"}
    )
    assert urls == ["https://hq.sinajs.cn/list=CON_OP_10005711"]
    assert quote["price"] is None


def test_empty_option_source_does_not_verify_listing(monkeypatch):
    feed(monkeypatch, 'var hq_str_P_OP_m2701P3300="";')
    quote = md.fetch_quote(md.normalize_commodity_contract("2701豆粕沽3300"))
    assert quote["status"] == "unavailable" and quote["price"] is None
    assert md.search_products("2701豆粕沽3300", "option", "CN") == []


@pytest.mark.parametrize(
    ("code", "key", "expected"),
    [("NDX", "ndx", "30464.553"), ("SPX", "spx", "7704.43"), ("VIX", "vix", "15.75")],
)
def test_us_indices_are_distinct_points_not_etfs(
    monkeypatch, sample, code, key, expected
):
    feed(monkeypatch, sample[key])
    quote = md.fetch_quote(index(code))
    assert quote["price"] == expected
    assert quote["quote_unit"] == "指数点" and quote["is_index"] is True
    assert quote["currency"] == "USD"
    assert quote["kind"] == "market"
    assert quote["published_at"].startswith("2026-09-25T")


@pytest.mark.parametrize("field", ["symbol", "instrumentType", "currency"])
def test_wrong_index_identity_or_currency_fails_closed(monkeypatch, sample, field):
    payload = copy.deepcopy(sample["ndx"])
    payload["chart"]["result"][0]["meta"][field] = "OTHER"
    feed(monkeypatch, payload)
    quote = md.fetch_quote(index())
    assert quote["status"] == "unavailable" and quote["price"] is None
    assert quote["error_code"] == "identity_mismatch"


def test_index_same_day_bar_waits_for_completed_session(monkeypatch, sample):
    feed(monkeypatch, sample["ndx"])
    rows = md.fetch_history(index(), "2025-09-25", "2026-09-25")
    assert [row["economic_date"] for row in rows] == ["2025-09-25", "2025-09-26"]
    assert all(row["kind"] == "close" for row in rows)
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 9, 25, 21, tzinfo=timezone.utc)
    )
    rows = md.fetch_history(index(), "2025-09-25", "2026-09-25")
    assert rows[-1]["economic_date"] == "2026-09-25"
    assert len(rows) == 3  # No missing sessions or cash events are invented.


def test_distinct_csi_red_lowvol_codes_and_missing_source(monkeypatch, sample):
    feed(monkeypatch, sample["cn_index_quote"])
    quote = md.fetch_quote(index("H30269", "CN", "CNY"))
    assert quote["price"] == "10848.95"
    assert quote["name"] == "中证红利低波动指数"
    wrong = md.fetch_quote(index("930955", "CN", "CNY"))
    assert wrong["price"] is None
    assert wrong["error_code"] == "history_unavailable"
    assert md.INDEX_SPECS["930955"]["name"] != md.INDEX_SPECS["H30269"]["name"]
    assert md.INDEX_SPECS["931446"]["provider_symbol"] == "2.931446"


def test_csi_history_uses_closes_and_original_dates_without_gap_fill(
    monkeypatch, sample
):
    feed(monkeypatch, sample["cn_index_history"])
    rows = md.fetch_history(index("H30269", "CN", "CNY"), "2025-03-01", "2026-09-25")
    assert [(r["economic_date"], r["price"]) for r in rows] == [
        ("2025-03-03", "10749.19"),
        ("2026-09-24", "10848.95"),
    ]
    assert all(r["kind"] == "close" for r in rows)


def test_csi_live_failure_returns_explicit_formal_close_not_fake_live_tick(
    monkeypatch, sample
):
    def get(url, **kwargs):
        if "push2his" in url:
            return json.dumps(sample["cn_index_history"])
        raise md.MarketDataError("provider_unavailable", "源暂不可用")

    monkeypatch.setattr(md, "_get", get)
    quote = md.fetch_quote(index("H30269", "CN", "CNY"))
    assert quote["price"] == "10848.95" and quote["kind"] == "close"
    assert quote["economic_date"] == "2026-09-24" and quote["published_at"] is None
    assert quote["live_status"] == "unavailable"
    assert "最近已收盘" in quote["message"]


def test_index_unknown_market_cannot_redirect_to_stock_or_arbitrary_url():
    quote = md.fetch_quote(index("http://127.0.0.1", "HK", "HKD"))
    assert quote["status"] == "unsupported" and quote["price"] is None
