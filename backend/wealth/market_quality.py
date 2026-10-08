"""Quarantine disputed public NAVs without deleting the original observations."""

from copy import deepcopy

from django.db.models import Q

from .common import DomainError, day
from .models import Resource
from .provider_policy import provider_origin


def nav_quarantine(space, instrument_id=None):
    query = Resource.objects.filter(tenant=space, kind="market_quotes")
    if instrument_id is not None:
        query = query.filter(data__instrument_id=str(instrument_id))
    return {
        data["instrument_id"]: data["nav_quarantine"]
        for data in query.values_list("data", flat=True)
        if data.get("instrument_id")
        and isinstance(data.get("nav_quarantine"), dict)
        and data["nav_quarantine"]
    }


def nav_is_blocked(space, instrument_id, when):
    return str(day(when)) in nav_quarantine(space, instrument_id).get(
        str(instrument_id), {}
    )


def approved_prices(query, space, *, quarantines=None):
    """Used by both current values and historical returns; raw rows are retained."""
    blocked = nav_quarantine(space) if quarantines is None else quarantines
    for instrument_id, dates in blocked.items():
        if dates:
            query = query.exclude(
                Q(
                    instrument_id=instrument_id,
                    kind="official_nav",
                    economic_date__in=list(dates),
                )
            )
    return query


def updated_quarantine(previous, observations, observed_at):
    result = deepcopy(previous) if isinstance(previous, dict) else {}
    grouped = {}
    for item in observations:
        if item.get("kind") != "official_nav" or not item.get("economic_date"):
            continue
        try:
            date = str(day(item["economic_date"]))
            if day(date) > day():
                continue
        except (DomainError, ValueError, TypeError):
            continue
        grouped.setdefault(date, []).append(item)
    for date, items in grouped.items():
        conflicts = [
            q
            for q in items
            if q.get("status") == "conflict"
            or (q.get("data_quality") or {}).get("status") == "conflict"
        ]
        if conflicts:
            item = conflicts[-1]
            result[date] = {
                "date": date,
                "status": "conflict",
                "message": "同日正式净值存在来源差异，已暂停用于自动份额和收益计算",
                "observed_at": observed_at,
                "observations": item.get("provider_observations", []),
                "quality": item.get("data_quality", {}),
            }
        elif any(
            (q.get("data_quality") or {}).get("status") == "consistent"
            and len(
                {
                    provider_origin(p)
                    for p in (q.get("data_quality") or {}).get("agreeing_providers", [])
                }
            )
            >= 2
            and (q.get("data_quality") or {}).get("usable_for_accounting") is True
            for q in items
        ):
            result.pop(date, None)
    return result
