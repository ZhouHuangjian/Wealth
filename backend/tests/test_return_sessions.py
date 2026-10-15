"""Fixed clocks and published-calendar fixtures; no DB or live market data."""

from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal

import pytest
from wealth.instrument_metadata import resolve_instrument_metadata
from wealth.return_sessions import closed_return_state, return_session_state

SATURDAY = date(2026, 10, 17)
NOW = datetime.fromisoformat("2026-10-17T12:00:00+08:00")
FUND = {
    "code": "123456",
    "kind": "fund",
    "market": "CN",
    "currency": "CNY",
    "name": "合成境内净值基金",
    "specification": {},
}
MISSING = {
    "status": "unavailable",
    "amount": None,
    "missing_reason_code": "no_current_price",
}


def state(instrument=FUND, when=SATURDAY, **extra):
    return return_session_state(instrument, when, now=extra.pop("now", NOW), **extra)


def closed(instrument=FUND, when=SATURDAY, **extra):
    return closed_return_state(
        instrument,
        when,
        now=extra.pop("now", NOW),
        item=extra.pop("item", MISSING),
        **extra,
    )


@pytest.mark.parametrize("kind", ["fund", "etf", "stock"])
def test_known_domestic_weekend_is_closed_without_inventing_return(kind):
    product = {**FUND, "kind": kind}
    proof = state(product)
    assert proof["status"] == "closed"
    assert proof["calendar_id"] == "CN_EXCHANGE" and proof["sources"]
    patch = closed(product)
    assert patch["status"] == "market_closed" and patch["missing_reason_code"] is None
    assert patch["amount"] is patch["basis"] is patch["return_rate"] is None


@pytest.mark.parametrize(
    ("market", "when", "expected"),
    [
        ("CN", "2026-09-25", "closed"),
        ("HK", "2026-09-25", "open"),
        ("CN", "2026-07-03", "open"),
        ("US", "2026-07-03", "closed"),
        ("CN", "2026-10-10", "closed"),
    ],
)
def test_market_specific_holidays_and_makeup_weekend(market, when, expected):
    assert (
        state({**FUND, "kind": "stock", "market": market}, when)["status"] == expected
    )


@pytest.mark.parametrize("when", ["2027-01-02", "2027-01-04"])
def test_uncovered_year_never_falls_back_to_weekends(when):
    result = state(when=when, now=datetime.fromisoformat("2027-01-05T12:00:00+08:00"))
    assert result["status"] == "unknown" and result["reason"] == "calendar_uncovered"


def test_metadata_generated_cn_default_does_not_close_known_us_qdii_on_cn_holiday():
    product = resolve_instrument_metadata(
        {**FUND, "code": "017641", "name": "摩根标普500指数(QDII)人民币A"}
    )
    assert product["specification"]["calendar_id"] == "CN_EXCHANGE"
    assert "metadata_overrides" not in product["specification"]
    result = state(product, "2026-09-25")
    assert result["status"] == "open" and result["calendar_id"] == "US_EQUITIES"
    assert result["basis"] == "published_product_market"


@pytest.mark.parametrize("name", ["合成全球QDII", "合成纳斯达克基金"])
def test_qdii_or_name_inference_without_product_evidence_keeps_unknown(name):
    product = resolve_instrument_metadata({**FUND, "name": name})
    result = state(product)
    assert result["status"] == "unknown" and result["calendar_id"] is None
    assert closed(product) is None


def test_manual_product_override_is_preserved_and_exchange_etf_uses_listing_market():
    product = {
        **FUND,
        "code": "017641",
        "name": "合成QDII",
        "specification": {"metadata_overrides": {"calendar_id": "HKEX"}},
    }
    assert state(product, "2026-09-25")["calendar_id"] == "HKEX"
    product["specification"] = {"trading_channel": "exchange"}
    assert state(product, "2026-09-25")["status"] == "closed"
    assert state(product, "2026-09-25")["calendar_id"] == "CN_EXCHANGE"


@pytest.mark.parametrize("kind,code", [("stock", "AAPL"), ("fund", "017641")])
def test_shanghai_saturday_during_us_friday_does_not_claim_closed(kind, code):
    product = {
        **FUND,
        "kind": kind,
        "code": code,
        "market": "US" if kind == "stock" else "CN",
    }
    now = datetime.fromisoformat("2026-10-17T01:00:00+08:00")
    result = state(product, now=now)
    assert result["status"] == "unknown"
    assert result["reason"] == "overseas_date_still_open"
    assert result["market_date"] == "2026-10-16"
    assert closed(product, now=now) is None


def test_historical_market_date_is_not_shifted_into_previous_day():
    product = {**FUND, "kind": "stock", "market": "US"}
    result = state(product, "2026-10-10")
    assert result["status"] == "closed" and result["calendar_date"] == "2026-10-10"


@pytest.mark.parametrize("clock", ["00:30", "05:59", "18:00", "23:00"])
def test_futures_possible_night_hours_need_session_evidence(clock):
    now = datetime.fromisoformat(f"2026-10-17T{clock}:00+08:00")
    result = state(None, now=now, calendar_id="CN_FUTURES")
    assert (
        result["status"] == "unknown" and result["reason"] == "night_session_unverified"
    )
    assert (
        closed(None, now=now, calendar_id="CN_FUTURES", item={"amount": None}) is None
    )


def test_explicit_institution_calendar_supports_daytime_closure_but_no_default():
    result = closed(None, calendar_id="CN_FUTURES", item={"amount": None})
    assert result["status"] == "market_closed"
    assert result["market_calendar"]["calendar_id"] == "CN_FUTURES"
    assert closed(None, item={"amount": None}) is None
    assert state(None)["status"] == "unknown"


@pytest.mark.parametrize(
    "reason",
    [
        "nav_conflict",
        "holding_reconciliation",
        "trade_date_unverified",
        "corporate_action",
        "missing_baseline",
        "missing_trade_cost",
        "fx_missing",
    ],
)
def test_actionable_missing_facts_cannot_be_hidden_by_closure(reason):
    assert closed(item={**MISSING, "missing_reason_code": reason}) is None


@pytest.mark.parametrize("flag", ["has_activity", "has_conflict"])
def test_caller_activity_and_conflict_guards_take_precedence(flag):
    assert closed(**{flag: True}) is None


@pytest.mark.parametrize("amount", [Decimal(0), Decimal("1.20")])
def test_formal_return_including_zero_is_never_replaced(amount):
    item = {
        "status": "estimated",
        "amount": amount,
        "observation_kind": "formal",
        "quantity_source": "automatic_estimate",
    }
    assert closed(item=item) is None


def test_closed_day_reference_can_be_suppressed_but_original_data_unchanged():
    item = {"status": "estimated", "amount": Decimal("1.2"), "price_basis": "estimate"}
    before = deepcopy(item)
    patch = closed(item=item)
    assert patch["amount"] is patch["base_amount"] is None
    assert item == before
    assert closed(item={**item, "observation_kind": "formal"}) is None


@pytest.mark.parametrize("calendar_id", ["UNKNOWN", "missing", ["CN_EXCHANGE"]])
def test_unknown_calendar_never_uses_placeholder_timezone(calendar_id):
    result = state(None, calendar_id=calendar_id)
    assert result["status"] == "unknown" and result["timezone"] is None


def test_future_date_invalid_timezone_and_naive_clock_stay_unknown():
    assert state(when="2026-10-18")["reason"] == "future_date"
    assert state(workspace_timezone="not/a/timezone")["reason"] == "timezone_unverified"
    assert state(now=NOW.replace(tzinfo=None))["reason"] == "clock_unverified"


@pytest.mark.parametrize(
    "product",
    [
        {**FUND, "name": "合成货币基金"},
        {**FUND, "specification": {"fund_type": "货币型"}},
    ],
)
def test_money_fund_income_does_not_follow_exchange_closure(product):
    result = state(product, calendar_id="CN_EXCHANGE")
    assert result["status"] == "unknown"
    assert result["basis"] == "income_calendar_unverified"
    assert closed(product, calendar_id="CN_EXCHANGE") is None


def test_empty_account_is_not_relabelled_as_closed_market():
    assert (
        closed(
            None,
            calendar_id="CN_FUTURES",
            item={"status": "no_position", "amount": None},
        )
        is None
    )
    assert (
        closed(
            None,
            calendar_id="CN_FUTURES",
            item={
                "status": "estimated",
                "amount": Decimal(0),
                "source": "cash_only_carry_forward",
            },
        )
        is None
    )
