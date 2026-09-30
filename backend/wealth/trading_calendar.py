"""Published exchange holidays, with bounded coverage and forecast-only dates.

This is not an order router, fund suspension feed or settlement ledger. Unknown
years never silently fall back to Monday-Friday. See docs/research/trade-dates-2.3.md.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .common import DomainError

CALENDAR_VERSION = "2026-09-26"
SSE_2025 = (
    "https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20241223_10767110.shtml"
)
SSE_2026 = (
    "https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml"
)
SHFE_2026 = "https://www.shfe.com.cn/services/calenderandholidays/holiday/"
HKEX_2026 = "https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf"
NYSE_2026 = "https://www.nyse.com/trade/hours-calendars"


def _range(start, end):
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    return {first + timedelta(days=i) for i in range((last - first).days + 1)}


CN_HOLIDAYS = {
    2025: set().union(
        *[
            _range(a, b)
            for a, b in [
                ("2025-01-01", "2025-01-01"),
                ("2025-01-28", "2025-02-04"),
                ("2025-04-04", "2025-04-06"),
                ("2025-05-01", "2025-05-05"),
                ("2025-05-31", "2025-06-02"),
                ("2025-10-01", "2025-10-08"),
            ]
        ]
    ),
    2026: set().union(
        *[
            _range(a, b)
            for a, b in [
                ("2026-01-01", "2026-01-03"),
                ("2026-02-15", "2026-02-23"),
                ("2026-04-04", "2026-04-06"),
                ("2026-05-01", "2026-05-05"),
                ("2026-06-19", "2026-06-21"),
                ("2026-09-25", "2026-09-27"),
                ("2026-10-01", "2026-10-07"),
            ]
        ]
    ),
}
HK_HOLIDAYS = {
    2026: {
        date.fromisoformat(x)
        for x in [
            "2026-01-01",
            "2026-02-17",
            "2026-02-18",
            "2026-02-19",
            "2026-04-03",
            "2026-04-06",
            "2026-04-07",
            "2026-05-01",
            "2026-05-25",
            "2026-06-19",
            "2026-07-01",
            "2026-10-01",
            "2026-10-19",
            "2026-12-25",
        ]
    }
}
US_HOLIDAYS = {
    2026: {
        date.fromisoformat(x)
        for x in [
            "2026-01-01",
            "2026-01-19",
            "2026-02-16",
            "2026-04-03",
            "2026-05-25",
            "2026-06-19",
            "2026-07-03",
            "2026-09-07",
            "2026-11-26",
            "2026-12-25",
        ]
    }
}
CALENDARS = {
    "CN_EXCHANGE": {
        "timezone": "Asia/Shanghai",
        "holidays": CN_HOLIDAYS,
        "sources": [SSE_2025, SSE_2026],
    },
    "CN_FUTURES": {
        "timezone": "Asia/Shanghai",
        "holidays": {2026: CN_HOLIDAYS[2026]},
        "sources": [SHFE_2026],
    },
    "HKEX": {
        "timezone": "Asia/Hong_Kong",
        "holidays": HK_HOLIDAYS,
        "sources": [HKEX_2026],
    },
    "US_EQUITIES": {
        "timezone": "America/New_York",
        "holidays": US_HOLIDAYS,
        "sources": [NYSE_2026],
    },
}


def calendar_info(calendar_id):
    calendar = CALENDARS.get(calendar_id)
    return {
        "id": calendar_id,
        "timezone": calendar["timezone"] if calendar else "Asia/Shanghai",
        "coverage_years": sorted(calendar["holidays"]) if calendar else [],
        "status": "published" if calendar else "unavailable",
        "sources": calendar["sources"] if calendar else [],
        "version": CALENDAR_VERSION,
        "scope": "exchange_trading_days_not_product_suspensions",
    }


def parse_date(value, label="日期"):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except (ValueError, TypeError):
        raise DomainError(f"{label}应为 YYYY-MM-DD") from None


def is_trading_day(value, calendar_id="CN_EXCHANGE"):
    """True/False within published coverage; None means genuinely unknown."""
    when = parse_date(value)
    calendar = CALENDARS.get(calendar_id)
    if not calendar or when.year not in calendar["holidays"]:
        return None
    return when.weekday() < 5 and when not in calendar["holidays"][when.year]


def next_trading_day(value, calendar_id="CN_EXCHANGE", include_current=True):
    when = parse_date(value)
    if is_trading_day(when, calendar_id) is None:
        return None
    when += timedelta(days=0 if include_current else 1)
    for _ in range(370):
        state = is_trading_day(when, calendar_id)
        if state is None:
            return None
        if state:
            return when
        when += timedelta(days=1)
    return None


def add_trading_days(value, count, calendar_id="CN_EXCHANGE"):
    if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 30:
        raise DomainError("确认周期应为 0 至 30 个交易日的整数")
    when = parse_date(value)
    if is_trading_day(when, calendar_id) is not True:
        return None
    for _ in range(count):
        when = next_trading_day(when, calendar_id, include_current=False)
        if when is None:
            return None
    return when


def _application_time(body, timezone):
    value = body.get("application_at")
    if value:
        try:
            result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            raise DomainError("申请时间应为 ISO 日期时间") from None
        if result.tzinfo is None:
            result = result.replace(tzinfo=ZoneInfo(timezone))
        try:
            return result.astimezone(ZoneInfo(timezone)), True
        except (OverflowError, ValueError):
            raise DomainError("申请时间超出可处理范围") from None
    value = body.get("application_date") or body.get("date") or body.get("trade_date")
    if not value:
        raise DomainError("请提供申请日期时间或申请日期")
    return datetime.combine(
        parse_date(value, "申请日期"), time(0), ZoneInfo(timezone)
    ), False


def preview_trade_dates(body):
    from .instrument_metadata import resolve_instrument_metadata

    if not isinstance(body, dict):
        raise DomainError("日期预览参数应为对象")
    instrument = body.get("instrument", body)
    if not isinstance(instrument, dict):
        raise DomainError("产品信息应为对象")
    instrument = dict(instrument)
    if "overrides" in body:
        instrument["overrides"] = body["overrides"]
    metadata = resolve_instrument_metadata(instrument)
    calendar, rule = metadata["calendar"], metadata["settlement_rule"]
    calendar_id = calendar["id"]
    from .subscription_calendar import subscription_day, next_subscription_day

    subscription = metadata["subscription_rule"]
    use_subscription = (
        metadata["kind"] == "fund"
        and metadata["specification"].get("trading_channel") != "exchange"
    )
    application, timed = _application_time(body, calendar["timezone"])
    warnings = list(metadata["warnings"])
    manual_trade = body.get("trade_date")
    manual_confirmation = body.get("confirmation_date") or body.get(
        "expected_confirmation_date"
    )
    trade = None
    if manual_trade:
        trade = parse_date(manual_trade, "归属交易日")
        if is_trading_day(trade, calendar_id) is False:
            warnings.append("人工指定的归属日期为已公布休市日，请核对交易凭据。")
        if is_trading_day(trade, calendar_id) is None:
            warnings.append("人工归属日超出已核实日历范围，未自动验证。")
    elif (
        calendar_id == "CN_FUTURES"
        and timed
        and (application.hour >= 18 or application.hour < 6)
    ):
        warnings.append("夜盘归属日与品种、节前停盘安排有关，请填写结算单上的交易日。")
    elif metadata["status"] in {"unknown", "ambiguous"}:
        warnings.append("请先确认产品类型及市场，再计算交易日。")
    else:
        # Fund order cutoff is not the stock exchange's closing-auction endpoint.
        day_value = application.date()
        if timed and rule.get("cutoff_time"):
            cutoff = time.fromisoformat(rule["cutoff_time"])
            if (
                application.time().replace(tzinfo=None) >= cutoff
                and is_trading_day(day_value, calendar_id) is not None
            ):
                day_value += timedelta(days=1)
                warnings.append("申请时间达到或超过截止时点，按下一开放交易日预估。")
        trade = (
            next_subscription_day(day_value, subscription)
            if use_subscription
            else next_trading_day(day_value, calendar_id)
        )
        if not timed:
            warnings.append("未提供申请时间，暂按当日截止时间前提交估算。")
        if trade is None:
            warnings.append("该日期超出已公布日历覆盖范围，未按普通工作日推算。")
    expected = None
    if manual_confirmation:
        expected = parse_date(manual_confirmation, "预期确认日")
        if trade and expected < trade:
            raise DomainError("预期确认日不能早于归属交易日")
        if is_trading_day(expected, rule.get("calendar_id", calendar_id)) is not True:
            warnings.append("人工预期确认日未通过交易日历核验，请核对产品规则。")
    elif trade and rule["confirmation_days"] is not None:
        expected = add_trading_days(
            trade, rule["confirmation_days"], rule.get("calendar_id", calendar_id)
        )
        if expected is None:
            warnings.append("确认区间没有完整已核实日历，预期确认日暂不可用。")
    if (
        use_subscription
        and subscription_day(application.date(), rule=subscription)["is_open"] is False
    ):
        warnings.append("申请日为申购休市日，预计归属日顺延；每日定投计划会跳过该日。")
    if metadata["specification"].get("is_qdii"):
        warnings.append(
            "QDII 可能因境外市场休市或临时公告暂停申赎；当前日期仅为估计，需核对该基金开放日。"
        )
    status = (
        "manual"
        if manual_trade or manual_confirmation or rule["status"] == "manual"
        else "estimated"
    )
    if trade is None:
        status = "unavailable"
    return {
        "application_at": application.isoformat() if timed else None,
        "application_date": application.date().isoformat(),
        "trade_date": trade.isoformat() if trade else None,
        "expected_confirmation_date": expected.isoformat() if expected else None,
        "calendar": calendar,
        "subscription_rule": subscription,
        "settlement_rule": rule,
        "status": status,
        "warnings": list(dict.fromkeys(warnings)),
        "sources": list(dict.fromkeys(metadata["sources"] + calendar["sources"])),
        "is_forecast": True,
        "creates_ledger_event": False,
        "message": "仅预估归属与确认日期；实际成交、份额及资金以机构确认记录为准。",
    }
