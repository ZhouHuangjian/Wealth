"""The home category card must never mistake a partial estimate for total assets."""

from decimal import Decimal
from types import SimpleNamespace

from wealth import investments, market_sync, reporting

D = Decimal


def summary(monkeypatch, holdings, quotes=(), rates=None):
    def confirmed_holdings(_, *, include_pending):
        assert include_pending is False
        return {"items": holdings}

    monkeypatch.setattr(investments, "holdings_summary", confirmed_holdings)
    monkeypatch.setattr(
        market_sync,
        "quote_list",
        lambda _: {"items": quotes, "refreshed_at": "2026-09-25T14:00:00+08:00"},
    )
    monkeypatch.setattr(
        reporting,
        "fx",
        lambda _, currency, target, when: (rates or {"CNY": D(1)}).get(currency),
    )
    return market_sync.valuation_summary(
        SimpleNamespace(base_currency="CNY", revision=1)
    )["items"]


def holding(**changes):
    return {
        "kind": "fund",
        "currency": "CNY",
        "contributes": True,
        "market_value": "278.10",
        "profit": "78.10",
        "price_kind": "official_nav",
        "price_source": "eastmoney_nav",
        "price_date": "2026-09-25",
        "status": "official",
        "estimate_value": None,
        "estimate_profit": None,
        "estimate_status": "unavailable",
        **changes,
    }


def test_formal_nav_without_intraday_estimate_has_complete_value_profit_and_source(
    monkeypatch,
):
    row = summary(monkeypatch, [holding()])[0]
    assert row["status"] == "complete"
    assert row["display_basis"] == "formal"
    assert D(row["display_value"]) == D("278.10")
    assert D(row["display_profit"]) == D("78.10")
    assert row["estimated_value"] is None
    assert row["estimated_profit"] is None
    assert row["priced_count"] == row["holdings_count"] == 1
    assert row["source"] == "eastmoney_nav"
    assert row["as_of"] == "2026-09-25"


def test_mixed_formal_and_reference_values_are_combined_once_with_explicit_basis(
    monkeypatch,
):
    rows = [
        holding(market_value="100", profit="10"),
        holding(
            market_value="200",
            profit="20",
            estimate_value="220",
            estimate_profit="40",
            estimate_status="reference",
            estimate_source="fund_estimate",
            estimate_date="2026-09-25",
        ),
    ]
    row = summary(monkeypatch, rows)[0]
    assert row["display_basis"] == "mixed"
    assert D(row["display_value"]) == D("320")
    assert D(row["display_profit"]) == D("50")
    assert D(row["market_value"]) == D("300")
    assert row["estimated_value"] is None
    assert row["estimated_profit"] is None
    assert D(row["known_estimated_value"]) == D("220")
    assert row["priced_count"] == row["holdings_count"] == 2
    assert row["source"] == "eastmoney_nav、fund_estimate"


def test_future_quote_does_not_create_asset_value_or_profit(monkeypatch):
    row = summary(
        monkeypatch,
        [],
        [
            {
                "kind": "future",
                "price": "500",
                "source": "quote_provider",
                "economic_date": "2026-09-25",
                "status": "stale",
            }
        ],
    )[0]
    assert row["status"] == row["display_basis"] == "quotes_only"
    assert row["market_value"] is row["estimated_value"] is row["display_value"] is None
    assert row["display_profit"] is None
    assert row["priced_count"] == row["holdings_count"] == 0
    assert row["quotes"][0]["price"] == "500"
    assert row["source"] == "quote_provider"


def test_unknown_second_holding_cannot_be_hidden_by_first_known_value(monkeypatch):
    row = summary(
        monkeypatch,
        [
            holding(market_value="100", profit="10"),
            holding(market_value=None, profit=None),
        ],
    )[0]
    assert row["status"] == "partial"
    assert row["display_value"] is row["market_value"] is None
    assert D(row["known_display_value"]) == D("100")
    assert row["display_profit"] is None
    assert row["priced_count"] == 1
    assert row["holdings_count"] == 2


def test_manual_value_and_missing_fx_keep_their_actual_basis_and_coverage(monkeypatch):
    manual = summary(
        monkeypatch,
        [holding(price_kind="manual_holding", price_source="manual", status="manual")],
    )[0]
    assert manual["display_basis"] == "manual"
    row = summary(monkeypatch, [holding(), holding(currency="USD")])[0]
    assert row["status"] == "partial"
    assert row["display_value"] is None
    assert row["priced_count"] == 1


def test_stale_estimate_falls_back_to_formal_and_stale_only_estimate_is_disclosed(
    monkeypatch,
):
    ref = {
        "estimate_value": "300",
        "estimate_profit": "100",
        "estimate_status": "stale",
        "estimate_source": "provider",
        "estimate_date": "2026-09-25",
    }
    formal = summary(monkeypatch, [holding(**ref)])[0]
    assert formal["display_basis"] == "formal"
    assert D(formal["display_value"]) == D("278.10")
    stale = summary(monkeypatch, [holding(market_value=None, profit=None, **ref)])[0]
    assert stale["status"] == "stale"
    assert stale["display_basis"] == "estimate"
    assert D(stale["display_value"]) == D("300")
