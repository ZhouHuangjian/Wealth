"""Currency conversion preserves native return evidence and dated gaps."""

from datetime import date, timedelta
from decimal import Decimal as D
from types import SimpleNamespace

import pytest

from wealth.daily_returns import convert_return_currency


DAY = date(2026, 10, 12)


def observation(**changes):
    return {
        "instrument_id": "synthetic",
        "name": "原币收益样本",
        "date": str(DAY),
        "currency": "USD",
        "amount": D("10"),
        "basis": D("100"),
        "return_rate": D("0.1"),
        "status": "confirmed",
        "message": "正式净值",
        **changes,
    }


def rate(age, value="7", base="USD", quote="CNY"):
    return SimpleNamespace(
        economic_date=DAY - timedelta(days=age),
        base=base,
        quote=quote,
        rate=D(value),
        source="synthetic",
    )


@pytest.mark.parametrize("age,expected", [(7, D("70")), (8, None)])
def test_fx_age_boundary_keeps_native_amount_and_original_input(age, expected):
    original = observation()
    converted = convert_return_currency(original, "CNY", [rate(age)])
    assert converted["amount"] == D("10")
    assert converted["native_status"] == "confirmed"
    assert converted["native_message"] == "正式净值"
    assert converted["base_amount"] == expected
    assert original == observation()
    if expected is None:
        assert converted["status"] == "unavailable"
        assert converted["missing_reason_code"] == "fx_missing"
        assert converted["base_basis"] is None
    else:
        assert converted["status"] == "confirmed"
        assert converted["base_basis"] == D("700")


def test_missing_fx_is_not_zero_and_same_currency_needs_no_fx():
    missing = convert_return_currency(observation(), "CNY", [])
    assert missing["base_amount"] is None
    assert missing["amount"] == D("10")
    assert missing["status"] == "unavailable"
    native = convert_return_currency(observation(), "USD", [])
    assert native["base_amount"] == D("10")
    assert native["status"] == "confirmed"
    assert native["fx_source"] == "same_currency"


def test_inverse_fx_uses_return_date_not_future_rate():
    rows = [rate(-1, "0.1", "CNY", "USD"), rate(0, "0.2", "CNY", "USD")]
    converted = convert_return_currency(observation(), "CNY", rows)
    assert converted["base_amount"] == D("50")
    assert converted["fx_date"] == DAY


def test_unavailable_return_keeps_unknown_basis_and_original_reason():
    original = observation(
        amount=None,
        basis=None,
        return_rate=None,
        status="unavailable",
        message="缺少交易日记录",
        missing_reason_code="baseline_missing",
    )
    converted = convert_return_currency(original, "CNY", [rate(0)])
    assert converted["amount"] is converted["base_amount"] is None
    assert converted["basis"] is converted["base_basis"] is None
    assert converted["status"] == converted["native_status"] == "unavailable"
    assert converted["missing_reason_code"] == "baseline_missing"
    assert converted["message"] == "缺少交易日记录"


@pytest.mark.parametrize("basis", [None, D("0")])
def test_known_cash_distribution_does_not_invent_missing_denominator(basis):
    converted = convert_return_currency(
        observation(basis=basis, return_rate=None), "CNY", [rate(0)]
    )
    assert converted["base_amount"] == D("70")
    assert converted["base_basis"] == (None if basis is None else D("0"))
    assert converted["return_rate"] is None
