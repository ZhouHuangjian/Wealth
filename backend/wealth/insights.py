"""User-configured allocation, market watches and observation-only condition alerts."""

import re
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .common import (
    DomainError,
    audit,
    bump,
    catalog_queryset,
    day,
    dec,
    get_obj,
    record,
    serial,
)
from .models import Event, Instrument, Price, Resource, ResourceRevision

D = Decimal
RESOURCE_PATHS = {
    "investment-tags": "investment_tags",
    "signal-rules": "signal_rules",
    "market-watchlist": "market_watchlist",
    "dashboard-preferences": "dashboard_preferences",
}
DEFAULT_PREFERENCES = {
    "show_market_environment": True,
    "show_valuation": True,
    "show_signals": True,
}
FORMAL = {"official_nav", "close", "official_close", "settlement"}


def configuration_record(obj):
    result = record(obj)
    if obj.kind == "investment_tags":
        result["primary_instrument_ids"] = [
            str(p.pk)
            for p in catalog_queryset(Instrument, obj.tenant).filter(
                tenant=obj.tenant, specification__allocation_tag_id=str(obj.pk)
            )
        ]
    return result


def _text(value, label, maximum=120):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise DomainError(f"{label}须为 1—{maximum} 个字符")
    return value.strip()


def _boolean(value, label):
    if not isinstance(value, bool):
        raise DomainError(f"{label}须为开关值")
    return value


def _integer(value, label, low, high):
    if isinstance(value, bool):
        raise DomainError(f"{label}须为整数")
    try:
        number = int(str(value))
    except (ValueError, TypeError):
        raise DomainError(f"{label}须为整数")
    if str(number) != str(value) or not low <= number <= high:
        raise DomainError(f"{label}须在 {low}—{high} 之间")
    return number


def _ids(space, values, model=Instrument, kind=None):
    if not isinstance(values, list) or len(values) > 500:
        raise DomainError("关联项目须为列表，最多 500 项")
    output = []
    for ident in values:
        obj = get_obj(model, space, ident, **({"kind": kind} if kind else {}))
        key = str(obj.pk)
        if key not in output:
            output.append(key)
    return output


def validate_tag_specification(space, specification):
    if not isinstance(specification, dict):
        raise DomainError("产品说明须为对象")
    tag_id = specification.get("allocation_tag_id")
    if tag_id:
        tag = get_obj(Resource, space, tag_id, kind="investment_tags")
        if tag.data.get("archived"):
            raise DomainError("此标签已停用，请选择有效主配置标签")
        specification["allocation_tag_id"] = str(tag.pk)
    if "tag_ids" in specification:
        specification["tag_ids"] = _ids(
            space, specification["tag_ids"], Resource, "investment_tags"
        )
    return specification


def _save(space, user, kind, values, obj=None):
    if obj:
        ResourceRevision.objects.get_or_create(
            tenant=space,
            resource=obj,
            version=obj.version,
            defaults={"created_by": user, "data": deepcopy(obj.data)},
        )
        obj.version += 1
        obj.data = serial(values)
        obj.save(update_fields=["data", "version"])
    else:
        obj = Resource.objects.create(
            tenant=space, created_by=user, kind=kind, data=serial(values)
        )
    ResourceRevision.objects.get_or_create(
        tenant=space,
        resource=obj,
        version=obj.version,
        defaults={"created_by": user, "data": deepcopy(obj.data)},
    )
    audit(space, user, f"{kind}.save", obj)
    bump(space, user, invalidate_reconciliations=False)
    return obj


def _ensure_product(space, user, body):
    if body.get("instrument_id"):
        return get_obj(Instrument, space, body["instrument_id"])
    product = body.get("product")
    if not isinstance(product, dict):
        raise DomainError("请选择要观察的产品或指数")
    kind = product.get("kind", "index")
    if kind not in {"index", "fund", "stock", "etf", "future", "option", "gold"}:
        raise DomainError("不支持的观察品类")
    code = _text(product.get("code"), "产品代码", 60)
    if not re.fullmatch(r"[A-Za-z0-9.^:_/-]+", code):
        raise DomainError("请使用搜索结果中的标准代码")
    market = _text(product.get("market", "CN"), "市场", 30).upper()
    currency = product.get("currency", "CNY")
    if currency not in {"CNY", "HKD", "USD"}:
        raise DomainError("仅支持 CNY、HKD、USD 计价产品；指数点位单独显示")
    name = _text(product.get("name", code), "产品名称", 150)
    specification = product.get("specification", {})
    if not isinstance(specification, dict):
        raise DomainError("产品规格须为对象")
    # Watch creation only copies public provider metadata, never account links.
    specification = {
        key: value
        for key, value in specification.items()
        if key
        in {
            "provider_symbol",
            "quote_unit",
            "is_derivative",
            "reference_only",
            "exchange",
            "underlying",
            "expiry",
            "option_type",
            "strike",
            "multiplier",
            "asset_class",
            "contract_multiplier",
            "option_right",
            "contract_month",
            "is_index",
            "quote_provider",
            "product_code",
        }
        and isinstance(value, (str, int, bool))
    }
    inst = (
        catalog_queryset(Instrument, space)
        .filter(
            tenant=space, code=code, market=market, currency=currency, share_class=""
        )
        .first()
    )
    if inst:
        if inst.kind != kind:
            raise DomainError("此代码已按另一品类登记，请选择已有的正确产品")
        return inst
    inst = Instrument(
        tenant=space,
        created_by=user,
        name=name,
        code=code,
        market=market,
        currency=currency,
        kind=kind,
        specification=specification,
    )
    inst.full_clean()
    inst.save()
    return inst


def _condition(space, raw):
    if not isinstance(raw, dict):
        raise DomainError("每个提醒条件须为对象")
    metric = raw.get("metric", "drawdown")
    scope = raw.get("scope", "instrument")
    operator = raw.get("operator", "gte")
    if metric not in {"drawdown", "change_percent", "price"}:
        raise DomainError("条件类型只能为回撤、单日涨跌幅或价格/点位")
    if scope not in {"instrument", "tag"} or operator not in {"gte", "lte"}:
        raise DomainError("请选择有效观察对象及比较方式")
    output = {"metric": metric, "scope": scope, "operator": operator}
    if scope == "instrument":
        obj = get_obj(Instrument, space, raw.get("instrument_id"))
        output["instrument_id"] = str(obj.pk)
    else:
        obj = get_obj(Resource, space, raw.get("tag_id"), kind="investment_tags")
        if obj.data.get("archived"):
            raise DomainError("已停用标签不能用于提醒")
        output["tag_id"] = str(obj.pk)
    threshold = dec(raw.get("threshold"), places=8)
    if metric == "drawdown" and not 0 < threshold <= 100:
        raise DomainError("回撤阈值须大于 0 且不超过 100%，例如 10 表示下跌 10%")
    if metric == "price" and threshold < 0:
        raise DomainError("价格或点位阈值不能为负")
    if metric == "change_percent" and not -100 <= threshold <= 1000:
        raise DomainError("涨跌幅阈值须在 -100%—1000% 之间")
    output["threshold"] = str(threshold)
    if metric == "drawdown":
        baseline = raw.get("baseline", "rolling_high")
        if baseline not in {"rolling_high", "cost", "manual"}:
            raise DomainError("请选择阶段高点、持仓成本或自定基准")
        output["baseline"] = baseline
        output["lookback_days"] = _integer(
            raw.get("lookback_days", 365), "回看天数", 7, 1825
        )
        if baseline == "manual":
            reference = dec(raw.get("reference_price"), nonnegative=True, places=12)
            if reference <= 0:
                raise DomainError("自定基准须大于零")
            output["reference_price"] = str(reference)
        if baseline == "cost" and scope == "instrument" and obj.kind == "index":
            raise DomainError("指数没有持仓成本，请使用阶段高点或自定基准")
    return output


def save_configuration(space, user, kind, body, obj=None):
    values = {**(obj.data if obj else {}), **body}
    queued = []
    if kind == "dashboard_preferences":
        values = {
            key: _boolean(values.get(key, default), key)
            for key, default in DEFAULT_PREFERENCES.items()
        }
    elif kind == "investment_tags":
        name = _text(values.get("name"), "标签名称", 60)
        archived = _boolean(values.get("archived", False), "停用标签")
        weight = dec(values.get("target_weight", "0"), nonnegative=True, places=4)
        if weight > 100:
            raise DomainError("目标占比不能超过 100%")
        others = Resource.objects.filter(tenant=space, kind=kind).exclude(
            pk=obj.pk if obj else None
        )
        if any(t.data.get("name", "").casefold() == name.casefold() for t in others):
            raise DomainError("该标签名称已存在")
        total = sum(
            (
                D(t.data.get("target_weight", "0"))
                for t in others
                if not t.data.get("archived")
            ),
            D(0),
        )
        if not archived and total + weight > 100:
            raise DomainError("各标签目标占比合计不能超过 100%，请先调整其他标签")
        color = values.get("color", "#527765")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise DomainError("标签颜色须为 #RRGGBB")
        members = _ids(space, values.get("instrument_ids", []))
        primary = (
            _ids(space, body["primary_instrument_ids"])
            if "primary_instrument_ids" in body
            else None
        )
        if primary is not None:
            members = list(dict.fromkeys([*members, *primary]))
        values = {
            "name": name,
            "color": color,
            "target_weight": str(weight),
            "instrument_ids": members,
            "archived": archived,
        }
        obj = _save(space, user, kind, values, obj)
        # One allocation tag per product; other thematic labels may overlap.
        for inst in catalog_queryset(Instrument, space).filter(tenant=space):
            spec = dict(inst.specification or {})
            prior = spec.get("allocation_tag_id")
            if archived and prior == str(obj.pk):
                spec.pop("allocation_tag_id", None)
            elif primary is not None:
                if str(inst.pk) in primary:
                    spec["allocation_tag_id"] = str(obj.pk)
                elif prior == str(obj.pk):
                    spec.pop("allocation_tag_id", None)
            if spec != inst.specification:
                inst.specification = spec
                inst.version += 1
                inst.save(update_fields=["specification", "version"])
        return configuration_record(obj)
    elif kind == "market_watchlist":
        inst = _ensure_product(space, user, values)
        existing = Resource.objects.filter(
            tenant=space, kind=kind, data__instrument_id=str(inst.pk)
        ).exclude(pk=obj.pk if obj else None)
        if existing.exists():
            raise DomainError("此产品已在市场观察列表中，请编辑已有项目")
        if not obj and Resource.objects.filter(tenant=space, kind=kind).count() >= 100:
            raise DomainError("每个空间最多观察 100 个产品，请编辑或停用已有项目")
        values = {
            "instrument_id": str(inst.pk),
            "show_on_home": _boolean(values.get("show_on_home", True), "显示在首页"),
            "enabled": _boolean(values.get("enabled", True), "启用观察"),
            "lookback_days": _integer(
                values.get("lookback_days", 365), "回看天数", 7, 1825
            ),
        }
        if values["enabled"]:
            queued.append((str(inst.pk), values["lookback_days"]))
    elif kind == "signal_rules":
        name = _text(values.get("name"), "提醒名称")
        conditions = values.get("conditions")
        if not isinstance(conditions, list) or not 1 <= len(conditions) <= 8:
            raise DomainError("每条提醒需配置 1—8 个条件")
        match = values.get("match", "all")
        if match not in {"all", "any"}:
            raise DomainError("条件关系须为全部满足或任一满足")
        values = {
            "name": name,
            "enabled": _boolean(values.get("enabled", False), "启用提醒"),
            "match": match,
            "conditions": [_condition(space, c) for c in conditions],
            "cooldown_hours": _integer(
                values.get("cooldown_hours", 24), "冷却小时数", 0, 720
            ),
        }
        if not obj and Resource.objects.filter(tenant=space, kind=kind).count() >= 200:
            raise DomainError("每个空间最多配置 200 条提醒")
        for condition in values["conditions"]:
            ids = (
                [condition["instrument_id"]]
                if condition["scope"] == "instrument"
                else _tag_ids(space, condition["tag_id"])
            )
            queued.extend((iid, condition.get("lookback_days", 30)) for iid in ids)
    else:
        raise DomainError("不支持的配置类型")
    obj = _save(space, user, kind, values, obj)
    if queued:
        from .market_sync import enabled, queue_refresh

        if enabled():
            starts = {}
            for iid, days in queued:
                starts[iid] = max(starts.get(iid, 0), days)
            for iid, days in starts.items():
                queue_refresh(
                    space, user, [iid], history=True, start=day() - timedelta(days=days)
                )
    return record(obj)


def preferences(space):
    obj = Resource.objects.filter(tenant=space, kind="dashboard_preferences").first()
    return {**DEFAULT_PREFERENCES, **(record(obj) if obj else {})}


def _tag_ids(space, tag_id):
    tag = get_obj(Resource, space, tag_id, kind="investment_tags")
    explicit = tag.data.get("instrument_ids", [])
    return [
        str(inst.pk)
        for inst in catalog_queryset(Instrument, space).filter(tenant=space)
        if str(inst.pk) in explicit
        or (inst.specification or {}).get("allocation_tag_id") == str(tag.pk)
        or str(tag.pk) in (inst.specification or {}).get("tag_ids", [])
    ]


def _point(value, as_of, source, **extra):
    return {
        "value": value,
        "as_of": str(as_of) if as_of else None,
        "source": source,
        "status": "ok" if value is not None else "unavailable",
        **extra,
    }


def _quote(space, inst):
    from .market_sync import quote_list

    row = next(
        (r for r in quote_list(space)["items"] if r["instrument_id"] == str(inst.pk)),
        {},
    )
    estimate = row.get("estimate") or {}
    chosen = (
        estimate
        if estimate.get("price") is not None
        and estimate.get("status") in {"ok", "stale"}
        else row
    )
    value = (
        dec(chosen["price"], nonnegative=True, places=18)
        if chosen.get("price") is not None
        else None
    )
    as_of = chosen.get("economic_date") or row.get("economic_date")
    good = (
        row.get("status") == "ok"
        and chosen.get("status") == "ok"
        and as_of
        and day() - timedelta(days=7) <= day(as_of) <= day()
    )
    return _point(
        value,
        as_of,
        chosen.get("source") or row.get("source", ""),
        status="ok" if good and value is not None else "unavailable",
        quote=chosen,
        message="" if good else "行情未更新、已陈旧或暂不可用",
    )


def _history(space, inst, start, end):
    from .market_quality import approved_prices

    rows = approved_prices(
        Price.objects.filter(
            tenant=space,
            instrument=inst,
            kind__in=FORMAL,
            economic_date__gte=start,
            economic_date__lte=end,
        ),
        space,
    ).order_by("economic_date", "created_at")
    days = {}
    for row in rows:
        days[row.economic_date] = {
            "date": row.economic_date,
            "value": row.value,
            "source": row.source,
        }
    return list(days.values())


def _has_corporate_action(space, inst, start, end):
    state = Resource.objects.filter(
        tenant=space, kind="market_quotes", data__instrument_id=str(inst.pk)
    ).first()
    actions = state.data.get("corporate_actions", []) if state else []
    return Event.objects.filter(
        tenant=space,
        kind__in=["dividend", "reinvest", "split"],
        economic_date__range=(start, end),
        payload__instrument_id=str(inst.pk),
        reversal__isnull=True,
        reverses__isnull=True,
    ).exists() or any(
        start <= day(action["date"]) <= end for action in actions if action.get("date")
    )


def _instrument_cost(space, inst):
    from .investments import holdings_summary

    holdings = [
        h
        for h in holdings_summary(space, include_pending=False)["items"]
        if h["instrument_id"] == str(inst.pk) and h.get("contributes", True)
    ]
    if not holdings or any(h.get("cost") is None for h in holdings):
        return None
    quantity = sum((D(h["quantity"]) for h in holdings), D(0))
    return (
        sum((D(h["cost"]) for h in holdings), D(0)) / quantity if quantity > 0 else None
    )


def instrument_metric(
    space,
    instrument_id,
    metric="drawdown",
    baseline="rolling_high",
    lookback_days=365,
    reference_price=None,
):
    inst = get_obj(Instrument, space, instrument_id)
    current = _quote(space, inst)
    if current["status"] != "ok":
        return _point(
            None,
            current.get("as_of"),
            current.get("source", ""),
            current_price=current.get("value"),
            message=current.get("message") or "行情暂不可用",
        )
    price = current["value"]
    when = day(current["as_of"])
    output = {k: v for k, v in current.items() if k != "quote"}
    if metric == "price":
        return output
    if metric == "change_percent" or baseline == "rolling_high":
        from .market_quality import nav_quarantine

        # Omitting a disputed peak/previous NAV would silently change the
        # meaning of a drawdown or daily-change rule. Keep it unresolved.
        cutoff = when - timedelta(
            days=4 if metric == "change_percent" else lookback_days
        )
        if any(
            str(cutoff) <= date <= str(when)
            for date in nav_quarantine(space, inst.pk).get(str(inst.pk), {})
        ):
            return _point(
                None,
                when,
                current["source"],
                message="比较区间内的正式净值存在来源差异，暂停此条件提醒",
            )
    history = _history(space, inst, when - timedelta(days=lookback_days), when)
    if metric == "change_percent":
        change = current["quote"].get("change_percent")
        if change is None:
            previous = [r for r in history if r["date"] < when]
            if previous and (when - previous[-1]["date"]).days > 4:
                return _point(
                    None,
                    when,
                    current["source"],
                    message="上一正式价格相隔超过 4 天，不能将跨期变化当作单日涨跌幅",
                )
            if previous and _has_corporate_action(
                space, inst, previous[-1]["date"], when
            ):
                return _point(
                    None,
                    when,
                    current["source"],
                    message="比较期间有分红、再投或折算，未复权价格不能推算单日涨跌幅",
                )
            change = (
                (price / previous[-1]["value"] - 1) * 100
                if previous and previous[-1]["value"] > 0
                else None
            )
        output["value"] = D(str(change)) if change is not None else None
        output["status"] = "ok" if change is not None else "unavailable"
        output["message"] = (
            "" if change is not None else "缺少上一正式价格，无法计算涨跌幅"
        )
        return output
    if baseline == "manual":
        peak = D(str(reference_price))
        peak_day = None
    elif baseline == "cost":
        peak = _instrument_cost(space, inst)
        peak_day = None
    else:
        if len(history) < 2 or history[0]["date"] > when - timedelta(
            days=lookback_days
        ) + timedelta(days=10):
            return _point(
                None,
                when,
                current["source"],
                message="历史覆盖不足，暂不能确定所选区间高点",
                history_count=len(history),
            )
        # Unadjusted prices across a corporate action are not a comparable drawdown.
        if _has_corporate_action(
            space, inst, when - timedelta(days=lookback_days), when
        ):
            return _point(
                None,
                when,
                current["source"],
                message="区间含分红或折算，未使用除权价格触发补仓提醒",
            )
        high = max(history, key=lambda r: r["value"])
        peak = max(high["value"], price)
        peak_day = when if price > high["value"] else high["date"]
    if peak is None or peak <= 0:
        return _point(
            None, when, current["source"], message="缺少可核对的成本或有效基准"
        )
    output.update(
        value=max(D(0), (peak - price) / peak * 100),
        baseline_price=peak,
        baseline_date=str(peak_day) if peak_day else None,
        current_price=price,
        lookback_days=lookback_days,
        series=history,
    )
    return output


def _tag_metric(
    space,
    tag_id,
    metric,
    baseline="rolling_high",
    lookback_days=365,
    reference_price=None,
):
    from .portfolio import tag_series

    window = (
        lookback_days if metric == "drawdown" and baseline == "rolling_high" else 14
    )
    result = tag_series(space, tag_id, day() - timedelta(days=window), day())
    points = [
        p for p in result.get("effective_points", []) if p.get("value") is not None
    ]
    as_of = result.get("as_of")
    source = result.get("source", "标签固定份额组合")
    if result.get("status") != "complete" or not points:
        return _point(
            None,
            as_of,
            source,
            message=result.get("message") or "标签组合历史或行情不完整",
        )
    if not as_of or day(as_of) < day() - timedelta(days=7):
        return _point(None, as_of, source, message="标签组合价格已陈旧，等待更新")
    # Preserve every contributing observation date. The basket's minimum date
    # alone must not make mixed market/FX dates look simultaneous in an AND rule.
    effective_dates = sorted(
        {
            str(value)
            for observation in points[-1].get("source_dates", [])
            for value in (
                observation.get("date"),
                observation.get("fx", {}).get("date")
                if observation.get("fx", {}).get("data_state") != "identity"
                else None,
            )
            if value is not None
        }
    )
    price = D(str(result.get("current_value", points[-1]["value"])))
    if metric == "price":
        return _point(
            price,
            as_of,
            source,
            quantity_basis=result.get("quantity_basis"),
            effective_dates=effective_dates,
        )
    if metric == "change_percent":
        if result.get("change_percent") is None:
            return _point(None, as_of, source, message="缺少标签组合的上一有效观察")
        return _point(
            D(str(result["change_percent"])),
            as_of,
            source,
            effective_dates=effective_dates,
        )
    if baseline == "manual":
        peak = D(str(reference_price))
    elif baseline == "cost":
        from .investments import holdings_summary
        from .reporting import fx

        selected = set(_tag_ids(space, tag_id))
        holdings = [
            h
            for h in holdings_summary(space, include_pending=False)["items"]
            if h["instrument_id"] in selected and h.get("contributes", True)
        ]
        peak = D(0)
        for holding in holdings:
            rate = fx(space, holding["currency"], space.base_currency, day())
            if rate is None or holding.get("cost") is None:
                return _point(None, as_of, source, message="标签组合缺持仓成本或汇率")
            peak += D(holding["cost"]) * rate
    else:
        dates = [day(p["date"]) for p in points]
        if len(points) < 2 or min(dates) > day(as_of) - timedelta(
            days=lookback_days
        ) + timedelta(days=10):
            return _point(
                None, as_of, source, message="标签历史覆盖不足，不能确定所选区间高点"
            )
        peak = max([price, *[D(p["value"]) for p in points]])
    if peak <= 0:
        return _point(None, as_of, source, message="标签组合的基准无效")
    return _point(
        max(D(0), (peak - price) / peak * 100),
        as_of,
        source,
        baseline_price=peak,
        current_price=price,
        quantity_basis=result.get("quantity_basis"),
        effective_dates=effective_dates,
    )


def evaluate_condition(space, condition):
    arguments = {
        key: condition[key]
        for key in ("metric", "baseline", "lookback_days", "reference_price")
        if key in condition
    }
    if condition["scope"] == "tag":
        observation = _tag_metric(space, condition["tag_id"], **arguments)
    else:
        observation = instrument_metric(space, condition["instrument_id"], **arguments)
    value = observation.get("value")
    matched = None
    if observation["status"] == "ok" and value is not None:
        threshold = D(condition["threshold"])
        matched = (
            value >= threshold if condition["operator"] == "gte" else value <= threshold
        )
    return serial({**condition, **observation, "matched": matched})


def evaluate_rules(space, user=None):
    now = timezone.now()
    states = {
        s.data.get("rule_id"): s
        for s in Resource.objects.filter(tenant=space, kind="signal_state")
    }
    for rule in Resource.objects.filter(tenant=space, kind="signal_rules").order_by(
        "created_at"
    ):
        state = states.get(str(rule.pk))
        old = state.data if state else {}
        reset = old.get("rule_version") != rule.version
        latched = False if reset else old.get("latched", False)
        results = []
        if rule.data.get("enabled"):
            for condition in rule.data["conditions"]:
                try:
                    results.append(evaluate_condition(space, condition))
                except (DomainError, ValueError, KeyError, ArithmeticError):
                    results.append(
                        {
                            **condition,
                            "value": None,
                            "matched": None,
                            "status": "unavailable",
                            "message": "观察对象或计算依据暂不可用",
                        }
                    )
            known = [r["matched"] for r in results]
            if rule.data["match"] == "all":
                matched = False if False in known else None if None in known else True
            else:
                matched = True if True in known else None if None in known else False
            # A conjunction is not simultaneous when its sources concern different days.
            dates = {
                value
                for result in results
                for value in (result.get("effective_dates") or [result.get("as_of")])
                if value
            }
            if matched and rule.data["match"] == "all" and len(dates) > 1:
                matched = None
                message = "条件来自不同有效日期，等待相同时点的数据"
            else:
                message = (
                    "符合你设置的观察条件，请自行核对仓位和资金安排"
                    if matched
                    else "部分数据暂不可用，未触发提醒"
                    if matched is None
                    else "尚未满足你设置的条件"
                )
            status = (
                "triggered"
                if matched
                else "unavailable"
                if matched is None
                else "not_triggered"
            )
        else:
            matched, status, message = False, "disabled", "提醒未启用"
        triggered_at = old.get("last_triggered_at")
        previous_time = parse_datetime(triggered_at) if triggered_at else None
        cooled = previous_time is None or now - previous_time >= timedelta(
            hours=rule.data.get("cooldown_hours", 24)
        )
        fired = matched is True and not latched and cooled
        if matched is False:
            latched = False
        elif fired:
            latched = True
        data = {
            "rule_id": str(rule.pk),
            "rule_version": rule.version,
            "name": rule.data["name"],
            "status": status,
            "triggered": matched is True,
            "conditions": results,
            "evaluated_at": now.isoformat(),
            "message": message,
            "latched": latched,
            "last_triggered_at": now.isoformat() if fired else triggered_at,
            "trigger_count": old.get("trigger_count", 0) + int(fired),
            "unread": True if fired else old.get("unread", False),
        }
        if not state:
            state = Resource(tenant=space, created_by=user, kind="signal_state")
        state.data = serial(data)
        state.save()
    return signals(space)


def signals(space):
    states = {
        s.data.get("rule_id"): s
        for s in Resource.objects.filter(tenant=space, kind="signal_state")
    }
    items = []
    for rule in Resource.objects.filter(tenant=space, kind="signal_rules").order_by(
        "-created_at"
    ):
        state = states.get(str(rule.pk))
        if state and state.data.get("rule_version") == rule.version:
            item = record(state)
        else:
            item = {
                "id": str(rule.pk),
                "rule_id": str(rule.pk),
                "name": rule.data["name"],
                "status": "unavailable" if rule.data.get("enabled") else "disabled",
                "conditions": [],
                "triggered": False,
                "message": "等待行情更新及条件检查",
                "unread": False,
                "last_triggered_at": None,
                "trigger_count": 0,
            }
        items.append(item)
    return {"items": items, "unread_count": sum(bool(x.get("unread")) for x in items)}


def acknowledge(space, rule_id):
    rule = get_obj(Resource, space, rule_id, kind="signal_rules")
    state = Resource.objects.filter(
        tenant=space, kind="signal_state", data__rule_id=str(rule.pk)
    ).first()
    if state:
        state.data = {**state.data, "unread": False}
        state.save(update_fields=["data"])
    return {"ok": True}


def watchlist(space):
    from .market_sync import quote_list

    quotes = {r["instrument_id"]: r for r in quote_list(space)["items"]}
    products = {
        str(p.pk): p for p in catalog_queryset(Instrument, space).filter(tenant=space)
    }
    items = []
    for obj in Resource.objects.filter(tenant=space, kind="market_watchlist").order_by(
        "created_at"
    ):
        row = record(obj)
        inst = products.get(obj.data["instrument_id"])
        if not inst:
            continue
        observation = instrument_metric(
            space, str(inst.pk), lookback_days=obj.data["lookback_days"]
        )
        items.append(
            {
                **row,
                "instrument_name": inst.name,
                "name": inst.name,
                "code": inst.code,
                "kind": inst.kind,
                "currency": inst.currency,
                "quote": quotes.get(str(inst.pk), {}),
                "drawdown_percent": observation.get("value"),
                "baseline_price": observation.get("baseline_price"),
                "baseline_date": observation.get("baseline_date"),
                "metric_status": observation["status"],
                "message": observation.get("message", ""),
                "series": observation.get("series", []),
            }
        )
    return serial({"items": items, "data_revision": space.revision})
