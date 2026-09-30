"""Separate a valuation's market date and basis from when a user entered it."""

from datetime import timedelta

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .common import DomainError, day


def observed_timestamp(value):
    if value in (None, ""):
        return None
    try:
        parsed = parse_datetime(value) if isinstance(value, str) else None
    except (ValueError, TypeError):
        parsed = None
    if parsed is None or timezone.is_naive(parsed):
        raise DomainError("查看时刻须为带时区的时间，例如 2026-09-27T20:30:00+08:00")
    if parsed > timezone.now() + timedelta(minutes=1):
        raise DomainError("查看时刻不能晚于当前时间")
    return parsed.isoformat()


def holding_valuation_metadata(data, as_of):
    if not any(
        key in data
        for key in ("valuation_basis", "valuation_date", "valuation_observed_at")
    ):
        return {}  # Preserve historical API semantics, without relabelling them formal.
    basis = data.get("valuation_basis", "unknown")
    if not isinstance(basis, str) or basis not in {"formal", "estimate", "unknown"}:
        raise DomainError("请选择正式净值、盘中估算或暂不清楚的计值方式")
    value_date = day(data["valuation_date"]) if data.get("valuation_date") else None
    if basis != "unknown" and value_date is None:
        raise DomainError(
            "请按平台显示填写净值或估算所属日期，不能用录入日期代替",
            "valuation_date_required",
        )
    if value_date and value_date > as_of:
        raise DomainError("净值或估算所属日期不能晚于持仓核对日期")
    return {
        "valuation_basis": basis,
        "valuation_date": str(value_date) if value_date else None,
        "valuation_observed_at": observed_timestamp(data.get("valuation_observed_at")),
    }


def validate_snapshot_basis(body):
    details = body.get("details") if isinstance(body.get("details"), dict) else {}
    provided = any(
        key in body or key in details
        for key in ("valuation_basis", "valuation_observed_at", "calendar_id")
    )
    if not provided:
        return {}
    basis = body.get("valuation_basis", details.get("valuation_basis", "unknown"))
    if not isinstance(basis, str) or basis not in {"settlement", "intraday", "unknown"}:
        raise DomainError("机构权益请选择结算权益、盘中权益或暂不清楚")
    from .trading_calendar import CALENDARS

    calendar_id = body.get("calendar_id", details.get("calendar_id"))
    if calendar_id not in (None, "") and (
        not isinstance(calendar_id, str) or calendar_id not in CALENDARS
    ):
        raise DomainError("请选择已支持的交易日历；不清楚时请留空")
    return {
        "valuation_basis": basis,
        "calendar_id": calendar_id or None,
        "valuation_observed_at": observed_timestamp(
            body.get("valuation_observed_at", details.get("valuation_observed_at"))
        ),
    }


def settled_market_remained_closed(snapshot, when):
    """Only a verified, explicitly selected calendar can justify holiday carry."""
    from .trading_calendar import is_trading_day

    calendar_id = snapshot.details.get("calendar_id")
    if (
        not calendar_id
        or snapshot.details.get("valuation_basis") != "settlement"
        or is_trading_day(snapshot.economic_date, calendar_id) is not True
    ):
        return False
    current = snapshot.economic_date + timedelta(days=1)
    while current <= when:
        if is_trading_day(current, calendar_id) is not False:
            return False
        current += timedelta(days=1)
    return True
