"""Tenant-scoped market observations; fetching never creates a financial event."""

import uuid
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .common import (
    DomainError,
    bump,
    catalog_queryset,
    day,
    dec,
    get_obj,
    serial,
    tenant_context,
)
from .market_quality import updated_quarantine
from .models import Instrument, Membership, Price, Resource, Workspace
from .provider_policy import get_provider_config

INTERVAL = 300
LEASE = 600
LABELS = {
    "fund": "基金",
    "stock": "股票",
    "etf": "ETF",
    "future": "期货",
    "option": "期权",
    "gold": "黄金",
    "index": "指数",
}


def enabled():
    return getattr(settings, "WEALTH_MARKET_DATA_ENABLED", True)


def _state(space, instrument):
    return Resource.objects.filter(
        tenant=space, kind="market_quotes", data__instrument_id=str(instrument.pk)
    ).first()


def _time(value):
    try:
        return parse_datetime(value) if value else None
    except (ValueError, TypeError):
        return None


def queue_refresh(space, user, instrument_ids=None, history=False, start=None):
    """Persist intent first. Broker failure is retried by the periodic scanner."""
    if not enabled():
        raise DomainError("行情更新当前未启用", "market_disabled", 409)
    if instrument_ids is not None:
        if not isinstance(instrument_ids, list) or len(instrument_ids) > 100:
            raise DomainError("每次最多更新 100 个产品")
        instruments = [
            get_obj(Instrument, space, iid) for iid in dict.fromkeys(instrument_ids)
        ]
    else:
        instruments = list(
            catalog_queryset(Instrument, space)
            .filter(tenant=space)
            .order_by("created_at")[:100]
        )
    today = day()
    history_start = day(start) if start else today - timedelta(days=366)
    if history and (history_start > today or (today - history_start).days > 5 * 366):
        raise DomainError("历史行情支持最近五年，开始日期不能晚于今天")
    queued = []
    now = timezone.now()
    for instrument in instruments:
        state = _state(space, instrument)
        if state is None:
            state = Resource(
                tenant=space,
                created_by=user,
                kind="market_quotes",
                data={"instrument_id": str(instrument.pk)},
            )
        data = dict(state.data)
        pending = data.get("refresh_status") in {"pending", "queued", "running"}
        started = _time(data.get("requested_at"))
        if pending and started and (now - started).total_seconds() < LEASE:
            # Extend requested history without replacing the running task's lease.
            if history:
                old_start = data.get("history_start")
                data["history_start"] = (
                    min(old_start, str(history_start))
                    if old_start
                    else str(history_start)
                )
                data["history_requested"] = True
                state.data = data
                state.save(update_fields=["data"])
            queued.append(str(instrument.pk))
            continue
        last = _time(data.get("last_attempt_at"))
        if not history and last and (now - last).total_seconds() < 30:
            continue
        token = str(uuid.uuid4())
        data.update(
            refresh_status="pending", request_token=token, requested_at=now.isoformat()
        )
        if history:
            data.update(history_requested=True, history_start=str(history_start))
        state.data = data
        state.save()
        queued.append(str(instrument.pk))
        if not getattr(settings, "WEALTH_MARKET_INLINE", False):
            transaction.on_commit(
                lambda sid=str(space.pk), iid=str(instrument.pk), tok=token: _publish(
                    sid, iid, tok
                )
            )
    return {
        "status": "queued" if queued else "up_to_date",
        "instrument_ids": queued,
        "refresh_interval_seconds": INTERVAL,
    }


def _publish(space_id, instrument_id, token):
    try:
        from .tasks import refresh_market_instrument

        refresh_market_instrument.apply_async(
            args=[space_id, instrument_id, token], retry=False, expires=LEASE
        )
    except Exception:
        # The DB intent remains pending; no financial action depends on this broker.
        return False
    return True


def quote_list(space):
    states = {
        x.data.get("instrument_id"): x.data
        for x in Resource.objects.filter(tenant=space, kind="market_quotes")
    }
    items = []
    for instrument in (
        catalog_queryset(Instrument, space).filter(tenant=space).order_by("name")
    ):
        state = states.get(str(instrument.pk), {})
        quote = dict(state.get("quote") or {})
        item = {
            **quote,
            "instrument_id": str(instrument.pk),
            "name": instrument.name,
            "code": instrument.code,
            "kind": instrument.kind,
            "price_kind": quote.get("kind"),
            "market": instrument.market,
            "currency": instrument.currency,
            "price": quote.get("price"),
            "status": quote.get("status", "unavailable"),
            "refresh_status": state.get("refresh_status", "not_requested"),
            "last_attempt_at": state.get("last_attempt_at"),
            "fetched_at": state.get("fetched_at"),
            "message": state.get("error_message")
            or quote.get("message", "尚未获取行情"),
            "history_error": state.get("history_error"),
            "corporate_actions": state.get("corporate_actions", []),
            "data_quality": state.get("last_quality") or quote.get("data_quality"),
            "provider_observations": state.get("provider_observations")
            or quote.get("provider_observations", []),
            "provider_attempts": state.get("provider_attempts")
            or quote.get("provider_attempts", []),
            "nav_quarantine": state.get("nav_quarantine", {}),
            "retained_previous_quote": state.get("retained_previous_quote", False),
        }
        if (item.get("data_quality") or {}).get("status") == "conflict":
            item["status"] = "conflict"
        observed = _time(state.get("fetched_at"))
        if (
            state.get("refresh_status") == "failed"
            and quote.get("price") is not None
            or (
                observed
                and (timezone.now() - observed).total_seconds() > 2 * INTERVAL
                and item["status"] == "ok"
            )
        ) and item["status"] != "conflict":
            item["status"] = "stale"
        items.append(item)
    attempts = [x["fetched_at"] for x in items if x.get("fetched_at")]
    return {
        "items": items,
        "refreshed_at": max(attempts) if attempts else None,
        "refresh_interval_seconds": INTERVAL,
        "enabled": enabled(),
    }


def _price_rows(space, instrument, quotes):
    """Only provider-declared daily observations can be formal ledger valuations."""
    rows = []
    for quote in quotes:
        quality = quote.get("data_quality") or {}
        if (
            quality.get("usable_for_accounting") is False
            and quote.get("kind") == "official_nav"
        ):
            continue
        if quote.get("price") is None or quote.get("status") not in {"ok", "stale"}:
            continue
        try:
            date = (
                day(quote.get("economic_date")) if quote.get("economic_date") else None
            )
            value = dec(quote["price"], nonnegative=True, places=18)
        except DomainError:
            continue
        if date is None or date > day() or quote.get("currency") != instrument.currency:
            continue
        if value <= 0:
            continue
        kind = quote.get("kind")
        kind = (
            kind
            if kind in {"official_nav", "close", "official_close", "settlement"}
            else "reference"
        )
        stamp = _time(quote.get("published_at"))
        if stamp is not None and timezone.is_naive(stamp):
            stamp = timezone.make_aware(stamp)
        rows.append(
            Price(
                tenant=space,
                instrument=instrument,
                value=value,
                kind=kind,
                economic_date=date,
                published_at=stamp,
                source=str(quote.get("source") or "public_market")[:120],
            )
        )
    # Compare to the latest observation, not every historic numeric value:
    # 100 -> 101 -> 100 is a real return to 100, not a duplicate of the first tick.
    latest = {}
    for old in Price.objects.filter(tenant=space, instrument=instrument).order_by(
        "created_at"
    ):
        latest[(old.kind, old.economic_date, old.source)] = old
    fresh = []
    for row in rows:
        identity = (row.kind, row.economic_date, row.source)
        old = latest.get(identity)
        if (
            old
            and old.published_at
            and row.published_at
            and row.published_at < old.published_at
        ):
            continue
        changed = old is None or old.value != row.value
        new_tick = (
            row.kind == "reference"
            and row.published_at
            and (old is None or old.published_at != row.published_at)
        )
        if changed or new_tick:
            latest[identity] = row
            fresh.append(row)
    return fresh


def refresh_one(space_id, instrument_id, token=None):
    """Network work runs outside the space writer lock and tenant transaction."""
    from . import market_data

    if not enabled():
        return {"status": "disabled"}
    with tenant_context(space_id):
        space = Workspace.objects.filter(pk=space_id, deleted_at__isnull=True).first()
        if not space:
            return {"status": "not_found"}
        instrument = (
            catalog_queryset(Instrument, space)
            .filter(tenant_id=space_id, pk=instrument_id)
            .first()
        )
        if not space or not instrument:
            return {"status": "not_found"}
        space = Workspace.objects.select_for_update().get(pk=space.pk)
        from .catalog_lifecycle import is_catalog_deleted

        if space.deleted_at or is_catalog_deleted(space, "instruments", instrument.pk):
            return {"status": "not_found"}
        state = _state(space, instrument)
        if not state or token != state.data.get("request_token"):
            return {"status": "superseded"}
        if state.data.get("refresh_status") == "running":
            last = _time(state.data.get("last_attempt_at"))
            if last and (timezone.now() - last).total_seconds() < LEASE:
                return {"status": "running"}
        if state.data.get("refresh_status") not in {"pending", "queued", "running"}:
            return {"status": "already_completed"}
        request_data = dict(state.data)
        state.data = {
            **state.data,
            "refresh_status": "running",
            "last_attempt_at": timezone.now().isoformat(),
        }
        state.save(update_fields=["data"])
        provider_input = {
            "name": instrument.name,
            "code": instrument.code,
            "kind": instrument.kind,
            "market": instrument.market,
            "currency": instrument.currency,
            "specification": instrument.specification,
        }
        identity_before = (
            instrument.code,
            instrument.market,
            instrument.currency,
            instrument.kind,
            instrument.share_class,
        )
        supports_history = instrument.kind in {"fund", "stock", "etf", "index"} or (
            instrument.kind == "gold"
            and instrument.code.isdigit()
            and len(instrument.code) == 6
        )
        last_history = _time(request_data.get("last_history_at"))
        need_history = request_data.get("history_requested") or (
            supports_history
            and (
                not last_history
                or (timezone.now() - last_history).total_seconds() >= 3600
            )
        )
        latest_formal = (
            Price.objects.filter(
                tenant=space,
                instrument=instrument,
                kind__in=["official_nav", "close", "official_close"],
            )
            .order_by("-economic_date")
            .first()
        )
        history_start = (
            request_data.get("history_start")
            if request_data.get("history_requested")
            else str(
                max(
                    (latest_formal.economic_date if latest_formal else day())
                    - timedelta(days=14),
                    day() - timedelta(days=5 * 366),
                )
            )
        )
    quote, history, history_error, error = None, [], None, None
    provider_config = None
    try:
        provider_config = get_provider_config()
        quote = market_data.fetch_quote(provider_input, provider_config=provider_config)
        if quote.get("currency") != provider_input["currency"]:
            quote = {
                "status": "unavailable",
                "price": None,
                "currency": provider_input["currency"],
                "message": "行情币种与产品不符，请核对市场与产品代码",
            }
    except Exception:
        error = "行情源暂时不可用，将自动重试"
        if need_history and provider_config is None:
            history_error = "数据源配置暂不可用，保留历史补全请求"
    if need_history and provider_config is not None:
        try:
            history = market_data.fetch_history(
                provider_input,
                history_start,
                str(day()),
                provider_config=provider_config,
            )
        except Exception:
            history_error = "历史行情暂不可用，保留已知记录"
    with tenant_context(space_id):
        space = Workspace.objects.select_for_update().get(pk=space_id)
        if space.deleted_at:
            return {"status": "not_found"}
        instrument = (
            catalog_queryset(Instrument, space)
            .filter(tenant=space, pk=instrument_id)
            .first()
        )
        if not instrument:
            return {"status": "not_found"}
        state = _state(space, instrument)
        if not state or token != state.data.get("request_token"):
            return {"status": "superseded"}
        if (
            instrument.code,
            instrument.market,
            instrument.currency,
            instrument.kind,
            instrument.share_class,
        ) != identity_before:
            state.data = {
                "instrument_id": str(instrument.pk),
                "refresh_status": "failed",
                "error_message": "产品身份已改变，已放弃旧产品的行情结果",
                "last_attempt_at": timezone.now().isoformat(),
            }
            state.save(update_fields=["data"])
            return {"status": "superseded"}
        owner = (
            Membership.objects.filter(workspace=space, role="owner")
            .select_related("user")
            .first()
        )
        if not owner:
            return {"status": "no_owner"}
        observations = [*history, *([quote] if quote else [])]
        if quote and quote.get("estimate"):
            observations.append(quote["estimate"])
        quarantine_before = state.data.get("nav_quarantine", {})
        quarantine = updated_quarantine(
            quarantine_before, observations, timezone.now().isoformat()
        )
        accepted = [
            q
            for q in observations
            if not (
                q.get("kind") == "official_nav" and q.get("economic_date") in quarantine
            )
        ]
        fresh = _price_rows(space, instrument, accepted)
        Price.objects.bulk_create(fresh)
        ok = (
            quote
            and quote.get("status") in {"ok", "stale"}
            and quote.get("price") is not None
        )
        # A later single-source reply cannot clear a conflict seen in history
        # or an earlier refresh. Keep the latest safe quote until independent
        # sources agree for this NAV date.
        if (
            quote
            and quote.get("kind") == "official_nav"
            and quote.get("economic_date") in quarantine
        ):
            blocked = quarantine[quote["economic_date"]]
            ok = False
            quote = {
                **quote,
                "status": "conflict",
                "price": None,
                "message": blocked["message"],
                "data_quality": {
                    **(quote.get("data_quality") or {}),
                    "status": "conflict",
                    "usable_for_accounting": False,
                },
                "provider_observations": blocked.get("observations", []),
            }
        previous_quote = state.data.get("quote") or {}
        if (
            ok
            and previous_quote.get("economic_date")
            and quote.get("economic_date")
            and quote["economic_date"] < previous_quote["economic_date"]
        ):
            ok = False
            error = "来源返回了更早日期的数据，已保留此前有效行情"
        state.data = {
            **state.data,
            "refresh_status": "ready" if ok else "failed",
            "history_error": history_error,
            "history_rows": len(history)
            if need_history
            else state.data.get("history_rows", 0),
            "error_message": error or (quote or {}).get("message", ""),
            "nav_quarantine": quarantine,
        }
        if quote:
            state.data["retained_previous_quote"] = bool(
                not ok and previous_quote.get("price") is not None
            )
            state.data["last_quality"] = quote.get("data_quality")
            state.data["provider_observations"] = quote.get("provider_observations", [])
            state.data["provider_attempts"] = quote.get("provider_attempts", [])
            # On a failed refresh retain the last successful observation, visibly stale.
            if ok or not state.data.get("quote"):
                state.data["quote"] = serial(quote)
            if ok:
                state.data["fetched_at"] = (
                    quote.get("fetched_at") or timezone.now().isoformat()
                )
        if request_data.get("history_requested") and not history_error:
            requested_start = state.data.get("history_start")
            state.data["history_requested"] = bool(
                requested_start
                and requested_start < request_data.get("history_start", requested_start)
            )
        if need_history and not history_error:
            state.data["last_history_at"] = timezone.now().isoformat()
            state.data["last_history_date"] = max(
                (x.get("economic_date", "") for x in history), default=None
            )
            actions = {
                (x["date"], x.get("source", "")): x
                for x in state.data.get("corporate_actions", [])
            }
            for observation in history:
                description = str(observation.get("corporate_action") or "").strip()
                if description:
                    date = observation.get("economic_date")
                    source = str(observation.get("source") or "")
                    actions[(date, source)] = {
                        "date": date,
                        "description": description[:500],
                        "source": source,
                    }
            state.data["corporate_actions"] = sorted(
                actions.values(), key=lambda x: x["date"]
            )[-100:]
        state.save(update_fields=["data"])
        if fresh or quarantine != quarantine_before:
            bump(space, owner.user, invalidate_reconciliations=False)
        return {
            "status": state.data["refresh_status"],
            "prices_added": len(fresh),
            "history_rows": len(history),
        }


def refresh_due(inline=False, limit=100):
    if not enabled():
        return {"scheduled": 0}
    scheduled, candidates = [], []
    now = timezone.now()
    for space in Workspace.objects.filter(deleted_at__isnull=True).order_by(
        "created_at"
    ):
        with tenant_context(space.pk):
            owner = (
                Membership.objects.filter(workspace=space, role="owner")
                .select_related("user")
                .first()
            )
            if not owner:
                continue
            for instrument in (
                catalog_queryset(Instrument, space)
                .filter(tenant=space)
                .order_by("created_at")
            ):
                state = _state(space, instrument)
                data = state.data if state else {}
                last = _time(data.get("last_attempt_at"))
                pending = data.get("refresh_status") == "pending"
                if not pending and last and (now - last).total_seconds() < INTERVAL:
                    continue
                if (
                    data.get("refresh_status") == "running"
                    and last
                    and (now - last).total_seconds() < LEASE
                ):
                    continue
                # Across households, oldest observations are serviced first.
                candidates.append(
                    (last.timestamp() if last else 0, str(space.pk), str(instrument.pk))
                )
    for _, sid, iid in sorted(candidates)[:limit]:
        with tenant_context(sid):
            space = Workspace.objects.select_for_update().get(pk=sid)
            if space.deleted_at:
                continue
            owner = (
                Membership.objects.filter(workspace=space, role="owner")
                .select_related("user")
                .first()
            )
            instrument = (
                catalog_queryset(Instrument, space).filter(tenant=space, pk=iid).first()
            )
            if not owner or not instrument:
                continue
            state = _state(space, instrument)
            data = state.data if state else {}
            requested = _time(data.get("requested_at"))
            last = _time(data.get("last_attempt_at"))
            if (
                data.get("refresh_status") == "running"
                and last
                and (now - last).total_seconds() < LEASE
            ):
                continue
            preserve = (
                data.get("refresh_status") in {"pending", "queued"}
                and requested
                and (now - requested).total_seconds() < LEASE
            )
            token = data.get("request_token") if preserve else str(uuid.uuid4())
            data = {
                **data,
                "instrument_id": iid,
                "request_token": token,
                "refresh_status": "pending",
                "requested_at": data.get("requested_at")
                if preserve
                else now.isoformat(),
            }
            if not state:
                state = Resource(
                    tenant=space, created_by=owner.user, kind="market_quotes"
                )
            state.data = data
            state.save()
            scheduled.append((sid, iid, token))
    for sid, iid, token in scheduled:
        if inline:
            refresh_one(sid, iid, token)
        else:
            _publish(sid, iid, token)
    return {"scheduled": len(scheduled)}


def valuation_summary(space):
    """Complete category totals use one disclosed valuation per real holding."""
    from .investments import holdings_summary
    from .reporting import fx

    holdings = holdings_summary(space, include_pending=False)["items"]
    quotes = quote_list(space)
    grouped = defaultdict(
        lambda: {
            "market_value": Decimal(0),
            "estimated_value": Decimal(0),
            "estimated_profit": Decimal(0),
            "display_value": Decimal(0),
            "display_profit": Decimal(0),
            "holdings_count": 0,
            "priced_count": 0,
            "formal_count": 0,
            "estimate_count": 0,
            "estimate_profit_count": 0,
            "profit_count": 0,
            "unreconciled_count": 0,
            "sources": set(),
            "dates": [],
            "bases": set(),
            "quotes": [],
            "stale": False,
        }
    )
    for holding in holdings:
        if not holding.get("contributes", True):
            continue
        group = grouped[holding["kind"]]
        group["holdings_count"] += 1
        if holding.get("cost_status") == "unreconciled":
            group["unreconciled_count"] += 1
        rate = fx(space, holding["currency"], space.base_currency, day())
        if rate is None:
            continue
        formal = holding.get("market_value")
        estimate = holding.get("estimate_value")
        estimate_stale = holding.get("estimate_status") == "stale"
        if formal is not None:
            group["market_value"] += Decimal(str(formal)) * rate
            group["formal_count"] += 1
        if estimate is not None:
            group["estimated_value"] += Decimal(str(estimate)) * rate
            group["estimate_count"] += 1
            if holding.get("estimate_profit") is not None:
                group["estimated_profit"] += (
                    Decimal(str(holding["estimate_profit"])) * rate
                )
                group["estimate_profit_count"] += 1
        if estimate is not None and (not estimate_stale or formal is None):
            value, profit, basis = estimate, holding.get("estimate_profit"), "estimate"
            source, observed = (
                holding.get("estimate_source"),
                holding.get("estimate_date"),
            )
            stale = estimate_stale
        elif formal is not None:
            value, profit = (
                formal,
                holding.get("profit", holding.get("unrealized_profit")),
            )
            basis = (
                "manual" if holding.get("price_kind") == "manual_holding" else "formal"
            )
            source, observed = holding.get("price_source"), holding.get("price_date")
            stale = holding.get("valuation_status", holding.get("status")) == "stale"
        else:
            continue
        group["priced_count"] += 1
        group["display_value"] += Decimal(str(value)) * rate
        group["bases"].add(basis)
        group["stale"] = group["stale"] or stale
        if profit is not None:
            group["display_profit"] += Decimal(str(profit)) * rate
            group["profit_count"] += 1
        if source:
            group["sources"].add(source)
        if observed:
            group["dates"].append(str(observed))
    for quote in quotes["items"]:
        grouped[quote["kind"]]["quotes"].append(quote)
    items = []
    for kind, group in grouped.items():
        count = group["holdings_count"]
        priced = group["priced_count"]
        complete = count > 0 and priced == count
        if not count and group["quotes"]:
            status, basis = "quotes_only", "quotes_only"
            sources = {
                quote.get("source") for quote in group["quotes"] if quote.get("source")
            }
            dates = [
                str(quote["economic_date"])
                for quote in group["quotes"]
                if quote.get("economic_date")
            ]
        else:
            status = (
                "needs_reconciliation"
                if group["unreconciled_count"]
                else "partial"
                if priced and not complete
                else "stale"
                if complete and group["stale"]
                else "complete"
                if complete
                else "unavailable"
            )
            basis = (
                next(iter(group["bases"]))
                if len(group["bases"]) == 1
                else "mixed"
                if group["bases"]
                else "unavailable"
            )
            sources, dates = group["sources"], group["dates"]
        items.append(
            {
                "kind": kind,
                "label": LABELS.get(kind, kind),
                "currency": space.base_currency,
                # Do not expose a subset's estimate as the complete category value.
                "market_value": group["market_value"]
                if count and group["formal_count"] == count
                else None,
                "estimated_value": group["estimated_value"]
                if count and group["estimate_count"] == count
                else None,
                "estimated_profit": group["estimated_profit"]
                if count and group["estimate_profit_count"] == count
                else None,
                "display_value": group["display_value"] if complete else None,
                "display_profit": group["display_profit"]
                if complete and group["profit_count"] == count
                else None,
                "display_basis": basis,
                "known_market_value": group["market_value"]
                if group["formal_count"]
                else None,
                "known_estimated_value": group["estimated_value"]
                if group["estimate_count"]
                else None,
                "known_display_value": group["display_value"] if priced else None,
                "known_display_profit": group["display_profit"]
                if group["profit_count"]
                else None,
                "holdings_count": count,
                "priced_count": priced,
                "formal_count": group["formal_count"],
                "estimate_count": group["estimate_count"],
                "profit_count": group["profit_count"],
                "unreconciled_count": group["unreconciled_count"],
                "message": "部分持仓金额、成本或收益范围待核对；已保留录入资产金额"
                if group["unreconciled_count"]
                else None,
                "status": status,
                "is_stale": group["stale"],
                "as_of": min(dates) if dates else None,
                "source": "、".join(sorted(sources)),
                "quotes": group["quotes"],
            }
        )
    return serial(
        {
            "items": items,
            "currency": space.base_currency,
            "data_revision": space.revision,
            "refreshed_at": quotes["refreshed_at"],
            "refresh_interval_seconds": INTERVAL,
        }
    )
