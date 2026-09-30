from datetime import date

import pytest
from wealth.common import DomainError
from wealth.trading_calendar import (
    add_trading_days,
    is_trading_day,
    preview_trade_dates,
)


def preview(**kwargs):
    return preview_trade_dates(
        {"instrument": {"code": "123456", "kind": "fund"}, **kwargs}
    )


@pytest.mark.parametrize(
    "value",
    [
        "2026-05-01",
        "2026-05-05",
        "2026-05-09",
        "2026-09-25",
        "2026-09-20",
        "2026-10-10",
    ],
)
def test_exchange_holidays_and_government_makeup_weekends_remain_closed(value):
    assert is_trading_day(value) is False


def test_cutoff_and_published_may_holidays_shift_confirmation():
    before = preview(application_at="2026-04-30T14:59:59+08:00")
    assert before["trade_date"] == "2026-04-30"
    assert before["expected_confirmation_date"] == "2026-05-06"
    after = preview(application_at="2026-04-30T15:00:00+08:00")
    assert after["trade_date"] == "2026-05-06"
    assert after["expected_confirmation_date"] == "2026-05-07"
    assert after["is_forecast"] is True
    assert after["creates_ledger_event"] is False


def test_utc_application_is_converted_before_cutoff_check():
    result = preview(application_at="2026-05-06T07:00:00Z")
    assert result["trade_date"] == "2026-05-07"
    assert result["expected_confirmation_date"] == "2026-05-08"


def test_unpublished_year_has_no_weekday_fallback():
    assert is_trading_day("2027-01-04") is None
    assert add_trading_days("2026-12-31", 1) is None
    result = preview(application_date="2027-01-04")
    assert result["status"] == "unavailable"
    assert result["trade_date"] is None
    assert result["expected_confirmation_date"] is None


def test_qdii_estimate_is_overridable_and_warns_overseas_suspension():
    instrument = {"code": "123456", "kind": "fund", "name": "海外QDII"}
    result = preview(instrument=instrument, application_date="2026-05-06")
    assert result["expected_confirmation_date"] == "2026-05-08"
    assert result["status"] == "estimated"
    assert any("境外" in warning for warning in result["warnings"])
    manual = preview(
        instrument=instrument,
        application_date="2026-05-06",
        overrides={"confirmation_days": 1},
    )
    assert manual["expected_confirmation_date"] == "2026-05-07"
    assert manual["status"] == "manual"


def test_night_futures_requires_explicit_statement_trade_date():
    body = {
        "instrument": {"code": "AU2612", "kind": "future"},
        "application_at": "2026-09-24T21:00:00+08:00",
    }
    result = preview_trade_dates(body)
    assert result["trade_date"] is None
    assert result["status"] == "unavailable"
    manual = preview_trade_dates({**body, "trade_date": "2026-09-28"})
    assert manual["trade_date"] == "2026-09-28"
    assert manual["expected_confirmation_date"] is None
    assert manual["status"] == "manual"


def test_market_specific_holidays_are_not_interchangeable():
    assert is_trading_day("2026-09-25", "HKEX") is True
    assert is_trading_day("2026-09-25", "CN_EXCHANGE") is False
    assert is_trading_day("2026-05-25", "HKEX") is False
    assert is_trading_day("2026-05-25", "CN_EXCHANGE") is True
    assert is_trading_day("2026-07-03", "US_EQUITIES") is False
    assert is_trading_day("2026-07-03", "CN_EXCHANGE") is True


def test_previous_covered_year_spring_festival():
    assert add_trading_days("2025-01-27", 1) == date(2025, 2, 5)


def test_manual_confirmation_cannot_precede_trade_date():
    with pytest.raises(DomainError):
        preview(
            application_date="2026-05-06",
            trade_date="2026-05-06",
            confirmation_date="2026-05-05",
        )


def test_uncovered_maximum_date_is_unavailable_without_overflow():
    result = preview(application_at="9999-12-31T16:00:00+08:00")
    assert result["trade_date"] is None
    assert result["status"] == "unavailable"
