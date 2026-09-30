"""Identity/timezone regressions based on public Tencent samples from 2026-09-26."""

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from wealth import market_data as md


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(
        md, "_now", lambda: datetime(2026, 9, 25, 17, tzinfo=timezone.utc)
    )
    monkeypatch.setattr(md, "_get", lambda *a, **k: pytest.fail("Unexpected network"))


def sample(symbol):
    return json.loads(
        (
            Path(__file__).parent / "fixtures/market_data/expanded_indices.json"
        ).read_text()
    )[symbol]


def product(code):
    spec = md.INDEX_SPECS[code]
    return {
        "kind": "index",
        "code": code,
        "market": spec["market"],
        "currency": spec["currency"],
    }


@pytest.mark.parametrize(
    "code,symbol,offset,last",
    [
        ("000300", "sh000300", "+08:00", "2026-09-24"),
        ("HSI", "hkHSI", "+08:00", "2026-09-25"),
        ("DJI", "us.DJI", "-04:00", "2026-09-24"),
        ("IXIC", "us.IXIC", "-04:00", "2026-09-24"),
    ],
)
def test_verified_indices_preserve_identity_timezone_and_completed_sessions(
    monkeypatch, code, symbol, offset, last
):
    samples = sample(symbol)
    monkeypatch.setattr(
        md,
        "_get",
        lambda url, **k: (
            json.dumps(samples["history"]) if "kline" in url else samples["quote"]
        ),
    )
    config = {"priority": {"index": ["tencent"]}}
    quote = md.fetch_quote(product(code), provider_config=config)
    assert quote["price"] is not None and quote["quote_unit"] == "指数点"
    assert quote["published_at"].endswith(offset) and quote["provider_id"] == "tencent"
    rows = md.fetch_history(
        product(code), "2026-09-01", "2026-09-25", provider_config=config
    )
    assert rows[-1]["economic_date"] == last
    assert all(row["kind"] == "close" for row in rows)


@pytest.mark.parametrize(
    "code,symbol,field,value",
    [
        ("000300", "sh000300", 2, "000001"),
        ("HSI", "hkHSI", 75, "USD"),
        ("DJI", "us.DJI", 56, "STOCK"),
        ("IXIC", "us.IXIC", 2, ".NDX"),
    ],
)
def test_other_symbol_currency_or_security_type_cannot_be_accepted(
    monkeypatch, code, symbol, field, value
):
    samples = copy.deepcopy(sample(symbol))
    raw = md._assignment(samples["quote"], "v_", symbol).split("~")
    raw[field] = value
    samples["quote"] = "v_" + symbol + '="' + "~".join(raw) + '";'
    samples["history"]["data"][symbol]["qt"][symbol][field] = value
    monkeypatch.setattr(
        md,
        "_get",
        lambda url, **k: (
            json.dumps(samples["history"]) if "kline" in url else samples["quote"]
        ),
    )
    config = {"priority": {"index": ["tencent"]}}
    quote = md.fetch_quote(product(code), provider_config=config)
    assert quote["price"] is None and quote["error_code"] == "identity_mismatch"
    with pytest.raises(md.MarketDataError) as error:
        md.fetch_history(
            product(code), "2026-09-01", "2026-09-25", provider_config=config
        )
    assert error.value.code == "identity_mismatch"
