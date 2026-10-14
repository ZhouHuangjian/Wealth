"""Read-only closure evidence, not a NAV publication or trading-session router.

Callers must still prove that every date since the last usable observation is
closed and that no intervening movement/distribution or unresolved fact exists.
This module neither invents zero returns nor changes market refresh scheduling.
"""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.utils import timezone

from .common import DomainError
from .subscription_calendar import KNOWN_US_FUNDS, subscription_rule
from .trading_calendar import CALENDARS, calendar_info, is_trading_day, parse_date


def _get(instrument, key, default=None):
    return (
        instrument.get(key, default)
        if isinstance(instrument, dict)
        else getattr(instrument, key, default)
    )


def _calendar(instrument, explicit):
    """Do not mistake the metadata wizard's CN default for a QDII NAV rule."""
    if instrument is None:
        return (
            (explicit, "explicit_account_or_product_calendar")
            if explicit is not None
            else (
                None,
                "unknown",
            )
        )
    spec = _get(instrument, "specification", {}) or {}
    if not isinstance(spec, dict):
        return None, "unknown"
    # Money funds can accrue across exchange holidays. Their income disclosure
    # schedule is not established by an exchange calendar, even an explicit one.
    if _get(instrument, "kind") == "fund" and (
        "货币" in str(spec.get("fund_type", ""))
        or "货币" in str(_get(instrument, "name", ""))
    ):
        return None, "income_calendar_unverified"
    if explicit is not None:
        return explicit, "explicit_account_or_product_calendar"
    overrides = spec.get("metadata_overrides") or {}
    if not isinstance(overrides, dict):
        return None, "unknown"
    if overrides.get("calendar_id"):
        return overrides["calendar_id"], "explicit_product_override"
    kind, market = _get(instrument, "kind"), _get(instrument, "market")
    stored = spec.get("calendar_id")
    if kind == "fund" and spec.get("trading_channel") != "exchange":
        # This is a market-closure label only. A known investment market still
        # cannot establish when a QDII is obliged to publish its next NAV.
        rule = subscription_rule(instrument)
        offshore = (
            spec.get("is_qdii") is True
            or "QDII" in str(_get(instrument, "name", "")).upper()
            or len(rule["calendar_ids"]) > 1
        )
        if offshore:
            if stored and stored != "CN_EXCHANGE":
                return stored, "product_calendar"
            if str(_get(instrument, "code", "")) in KNOWN_US_FUNDS:
                return "US_EQUITIES", "published_product_market"
            return None, "qdii_market_unverified"
    if stored:
        return stored, "product_calendar"
    if kind in {"future", "futures", "option"}:
        return (
            ("CN_FUTURES", "domestic_derivative_market")
            if market == "CN"
            else (
                None,
                "derivative_market_unverified",
            )
        )
    if kind in {"fund", "etf", "stock", "index"}:
        return {
            "CN": "CN_EXCHANGE",
            "US": "US_EQUITIES",
            "HK": "HKEX",
        }.get(market), "listing_or_domestic_market"
    return None, "market_unverified"


def return_session_state(
    instrument,
    when,
    *,
    now=None,
    workspace_timezone="Asia/Shanghai",
    calendar_id=None,
):
    """Return a three-state *date* assessment with its evidence.

    ``calendar_id`` is for an explicitly selected institution snapshot calendar
    (instrument may be None), not a fallback default. Date-only historical input
    keeps its original economic date. For today's workspace date, a different
    current overseas market date must also be verified closed. There is no
    intraday session timetable, so domestic futures' possible night hours stay
    unknown instead of converting a Saturday clock into a closed session.
    """
    result = {
        "status": "unknown",
        "calendar_id": None,
        "calendar_date": None,
        "market_date": None,
        "timezone": None,
        "sources": [],
        "basis": "unknown",
        "reason": "calendar_unverified",
        "message": "产品交易日历尚未核实，不能按周末推定休市",
    }
    try:
        when = parse_date(when)
        selected, basis = _calendar(instrument, calendar_id)
    except (DomainError, TypeError, ValueError):
        return result
    result.update(calendar_date=when.isoformat(), basis=basis)
    if not isinstance(selected, str) or selected not in CALENDARS:
        return result
    info = calendar_info(selected)
    result.update(
        calendar_id=selected,
        timezone=info["timezone"],
        sources=info["sources"],
        calendar_version=info["version"],
    )
    now = now if now is not None else timezone.now()
    if not isinstance(now, datetime) or timezone.is_naive(now):
        return {**result, "reason": "clock_unverified", "message": "查看时刻未核实"}
    try:
        workspace_today = now.astimezone(ZoneInfo(workspace_timezone)).date()
        market_now = now.astimezone(ZoneInfo(info["timezone"]))
    except (TypeError, ValueError, ZoneInfoNotFoundError):
        return {**result, "reason": "timezone_unverified", "message": "适用时区未核实"}
    result["market_date"] = market_now.date().isoformat()
    if when > workspace_today:
        return {**result, "reason": "future_date", "message": "未来日期不生成收益状态"}
    opened = is_trading_day(when, selected)
    if opened is None:
        return {
            **result,
            "reason": "calendar_uncovered",
            "message": "日期超出已核实日历范围，不能按周末推定休市",
        }
    if when == workspace_today:
        # This window matches the existing conservative trade-date preview.
        # It does not claim that every contract trades at night or closes at 06.
        if selected == "CN_FUTURES" and (market_now.hour >= 18 or market_now.hour < 6):
            return {
                **result,
                "reason": "night_session_unverified",
                "message": "夜盘归属日与节前安排待核实，不能仅按自然日判定休市",
            }
        current_opened = is_trading_day(market_now.date(), selected)
        if current_opened is None:
            return {
                **result,
                "reason": "calendar_uncovered",
                "message": "市场当前日期超出已核实日历范围",
            }
        if opened is False and current_opened is True:
            return {
                **result,
                "reason": "overseas_date_still_open",
                "message": "相关市场仍处于另一交易日，不能按本地周末判定休市",
            }
    return {
        **result,
        "status": "open" if opened else "closed",
        "reason": None if opened else "market_closed",
        "message": "该日期为交易日；具体开盘时段以产品规则为准"
        if opened
        else "相关市场休市；保留最近有效数据及原日期，不把缺少报价记为零收益",
    }


def closed_return_state(
    instrument,
    when,
    *,
    item,
    has_activity=False,
    has_conflict=False,
    now=None,
    workspace_timezone="Asia/Shanghai",
    calendar_id=None,
):
    """A safe closure display patch, or None; never an accounting observation.

    Call only after checking the last observation's continuous closed-day gap and
    actual movements/payouts. Snapshot callers must also verify statement scope
    and flows. Those guards require tenant data and intentionally stay outside
    this pure calendar helper. An explicit current reference may be discarded on
    a verified closed date; a known formal return is never overwritten.
    """
    if (
        not isinstance(item, dict)
        or item.get("status") in {"no_position", "future"}
        or has_activity
        or has_conflict
    ):
        return None
    reference = (
        item.get("observation_kind") == "reference"
        or item.get("price_basis") == "estimate"
    )
    formal = (
        item.get("observation_kind") == "formal" or item.get("price_basis") == "formal"
    )
    if item.get("amount") is not None and (formal or not reference):
        return None
    reason = item.get("missing_reason_code")
    allowed = reason in {"no_current_price", "no_estimate", "calendar_unverified"}
    if reason is None and reference and not formal:
        allowed = True
    if (
        instrument is None
        and calendar_id is not None
        and reason in {None, "account_snapshot_needed"}
        and item.get("amount") is None
    ):
        allowed = True
    if not allowed:
        return None
    session = return_session_state(
        instrument,
        when,
        now=now,
        workspace_timezone=workspace_timezone,
        calendar_id=calendar_id,
    )
    if session["status"] != "closed":
        return None
    return {
        "status": "market_closed",
        "market_state": "closed",
        "amount": None,
        "basis": None,
        "return_rate": None,
        "base_amount": None,
        "base_basis": None,
        "missing_reason_code": None,
        "message": session["message"],
        "market_calendar": session,
    }
