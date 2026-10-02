"""Valuation dates differ from a fund's order-acceptance calendar."""

from datetime import timedelta

from .trading_calendar import is_trading_day, parse_date


def valuation_calendar(instrument):
    get = (
        instrument.get
        if isinstance(instrument, dict)
        else lambda k, d=None: getattr(instrument, k, d)
    )
    spec = get("specification", {}) or {}
    explicit = (spec.get("metadata_overrides") or {}).get("calendar_id") or spec.get(
        "calendar_id"
    )
    if explicit:
        return explicit
    if get("kind") == "fund" and spec.get("trading_channel") != "exchange":
        from .subscription_calendar import subscription_rule

        calendars = subscription_rule(instrument)["calendar_ids"]
        if "US_EQUITIES" in calendars:
            return "US_EQUITIES"
        if "HKEX" in calendars:
            return "HKEX"
    return (
        (spec.get("metadata_overrides") or {}).get("calendar_id")
        or spec.get("calendar_id")
        or {"CN": "CN_EXCHANGE", "US": "US_EQUITIES", "HK": "HKEX"}.get(get("market"))
    )


def nav_freshness_calendar(instrument):
    """Do not infer a QDII publication calendar from its subscription calendar.

    Offshore valuation/publication schedules differ between products. Without
    an explicit rule, keep the last published NAV and its date, not a stale claim.
    """
    get = (
        instrument.get
        if isinstance(instrument, dict)
        else lambda k, d=None: getattr(instrument, k, d)
    )
    spec = get("specification", {}) or {}
    explicit = (spec.get("metadata_overrides") or {}).get("calendar_id") or spec.get(
        "calendar_id"
    )
    if explicit:
        return explicit
    if get("kind") == "fund" and spec.get("trading_channel") != "exchange":
        from .subscription_calendar import subscription_rule

        calendars = subscription_rule(instrument)["calendar_ids"]
        if (
            len(calendars) > 1
            or spec.get("is_qdii")
            or "QDII" in get("name", "").upper()
        ):
            return None
    return valuation_calendar(instrument)


def return_calendar(instrument, *, estimated=False):
    """A reference market calendar does not prove a QDII's formal NAV cadence.

    Actual adjacent NAV observations need no guessed closure. Longer gaps need
    an explicit product rule before they can be called a single day's return.
    Overseas intraday references retain their existing market-day checks.
    """
    return (
        valuation_calendar(instrument)
        if estimated
        else nav_freshness_calendar(instrument)
    )


def open_days_between(start, end, calendar_id, *, include_end=True):
    """Count published open dates after start; None never means a guessed weekday."""
    start, end = parse_date(start), parse_date(end)
    if (end - start).days > 740:
        return None
    total = 0
    cursor = start + timedelta(days=1)
    while cursor <= end if include_end else cursor < end:
        opened = is_trading_day(cursor, calendar_id)
        if opened is None:
            return None
        total += int(opened)
        cursor += timedelta(days=1)
    return total
