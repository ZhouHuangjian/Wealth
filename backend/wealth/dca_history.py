"""Read-only daily fund subscription scenarios and narrowly scoped placeholder voids.

Calendar days are a scheduling proxy, not proof of an order or fund opening.
No preview creates occurrences, market prices, holdings, or cash movements.
"""

from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal, localcontext

from django.db import transaction
from django.db.models import Q

from .common import DomainError, audit, day, dec, get_obj, serial
from .models import (
    Account,
    Event,
    Instrument,
    PositionMovement,
    Price,
    Resource,
    Workspace,
)
from .trading_calendar import CALENDARS, add_trading_days, calendar_info, is_trading_day

ZERO = Decimal(0)
FIELDS = {
    "start",
    "end",
    "as_of",
    "excluded_dates",
    "pause_ranges",
    "fee_mode",
    "fee_amount",
}


def _quantity(amount, nav):
    with localcontext() as context:
        context.prec = 80
        return (amount / nav).quantize(
            Decimal("0.000000000000000001"), rounding=ROUND_HALF_UP
        )


def _exclusions(body, start, end):
    values = body.get("excluded_dates", [])
    ranges = body.get("pause_ranges", [])
    if not isinstance(values, list) or len(values) > 1097:
        raise DomainError("排除日期须为不超过 1097 项的日期列表")
    if not isinstance(ranges, list) or len(ranges) > 100:
        raise DomainError("暂停区间须为不超过 100 项的列表")
    excluded = set()
    for value in values:
        if not value:
            raise DomainError("排除日期不能为空")
        when = day(value)
        if not start <= when <= end:
            raise DomainError("排除日期须位于本次预览区间")
        excluded.add(when)
    paused = set()
    for item in ranges:
        if (
            not isinstance(item, dict)
            or set(item) != {"start", "end"}
            or not item["start"]
            or not item["end"]
        ):
            raise DomainError("每个暂停区间须包含 start 和 end 日期")
        first, last = day(item["start"]), day(item["end"])
        if not start <= first <= last <= end:
            raise DomainError("暂停区间须为预览范围内的有效起止日期")
        paused.update(first + timedelta(days=i) for i in range((last - first).days + 1))
    return excluded, paused


def history_preview(space, plan_id, body):
    with localcontext() as context:
        context.prec = 80
        return _history_preview(space, plan_id, body)


def _history_preview(space, plan_id, body):
    if not isinstance(body, dict) or set(body) - FIELDS:
        raise DomainError("历史定投预览含不支持的参数")
    plan = get_obj(Resource, space, plan_id, kind="plans")
    config = plan.data
    if config.get("kind") != "dca":
        raise DomainError("仅定投计划支持历史估算")
    if (
        config.get("frequency", "monthly") != "daily"
        or str(config.get("interval", 1)) != "1"
        or config.get("holiday_policy", "skip") == "next_open"
    ):
        raise DomainError(
            "此预览适用于每日、休市跳过的计划；顺延或其他周期请在定投设置中指定自动记账开始日，系统逐期处理",
            "dca_frequency_unsupported",
        )
    if config.get("count") not in (None, ""):
        raise DomainError(
            "限期数计划请先明确起止日期并取消期数上限后再预览，不能把自然日期数当作基金交易日期数",
            "dca_count_unsupported",
        )
    account = get_obj(Account, space, config.get("account_id"))
    instrument = get_obj(Instrument, space, config.get("instrument_id"))
    specification = instrument.specification or {}
    fund_type = str(specification.get("fund_type", "")).lower()
    if (
        "货币" in instrument.name
        or "货币" in fund_type
        or fund_type in {"005", "money", "money_market", "money-market"}
        or specification.get("is_money_fund") is True
        or specification.get("is_money_market") is True
    ):
        raise DomainError(
            "货币基金使用万份收益等专门计息规则，不能按普通单位净值预览定投；请记录实际确认份额和收益",
            "unsupported_money_fund",
        )
    if (
        instrument.kind != "fund"
        or specification.get("is_derivative")
        or specification.get("trading_channel") == "exchange"
    ):
        raise DomainError(
            "当前历史预览只支持按单位净值申购的基金，不支持股票、ETF 或衍生品",
            "dca_instrument_unsupported",
        )
    currency = config.get("currency") or account.currency
    if currency != account.currency or currency != instrument.currency:
        raise DomainError(
            "计划金额、资金账户与基金净值币种须相同；预览不会推测历史换汇",
            "dca_currency",
        )
    amount = dec(config.get("amount"), nonnegative=True)
    if amount <= ZERO:
        raise DomainError("每期定投金额须大于零")
    if not body.get("start") and not config.get("start_date"):
        raise DomainError("请先设置定投开始日期")
    as_of = day(body.get("as_of"))
    start = day(body.get("start") or config.get("start_date"))
    end = (
        day(body["end"])
        if body.get("end")
        else min(day(config["end_date"]), as_of)
        if config.get("end_date")
        else as_of
    )
    if not start <= end <= as_of <= day() or (end - start).days > 1096:
        raise DomainError(
            "须满足开始日不晚于结束日、结束日不晚于估值日、估值日不晚于今天；单次最多三年"
        )
    excluded, paused = _exclusions(body, start, end)
    fee_mode = body.get("fee_mode", "unknown")
    if fee_mode not in {"unknown", "zero", "fixed"}:
        raise DomainError("费用请选择未知、明确零费用或每期固定金额")
    fee = (
        dec(body.get("fee_amount"), nonnegative=True)
        if fee_mode == "fixed"
        else ZERO
        if fee_mode == "zero"
        else None
    )
    if fee is not None and fee >= amount:
        raise DomainError("每期费用须小于定投金额")
    if fee_mode != "fixed" and body.get("fee_amount") not in (None, "", "0", 0):
        raise DomainError("只有固定费用模式可以填写费用金额")
    overrides = specification.get("metadata_overrides", {})
    if not isinstance(overrides, dict):
        raise DomainError("基金交易规则格式有误，请先核对产品配置")
    calendar_id = (
        overrides.get("calendar_id")
        or specification.get("calendar_id")
        or {
            "CN": "CN_EXCHANGE",
            "HK": "HKEX",
            "US": "US_EQUITIES",
        }.get(instrument.market, "UNKNOWN")
    )
    if not isinstance(calendar_id, str) or calendar_id not in {*CALENDARS, "UNKNOWN"}:
        raise DomainError("基金交易日历尚未正确配置，请先核对产品信息")
    calendar = calendar_info(calendar_id)
    from .instrument_metadata import _settlement_rule

    rule_warnings = []
    rule = _settlement_rule(
        "fund",
        {
            **specification,
            "is_qdii": specification.get("is_qdii") is True
            or "QDII" in instrument.name.upper(),
            "is_fof": specification.get("is_fof") is True
            or "FOF" in instrument.name.upper(),
        },
        overrides,
        calendar_id,
        rule_warnings,
    )
    from .market_quality import approved_prices

    prices = list(
        approved_prices(
            Price.objects.filter(
                tenant=space,
                instrument=instrument,
                kind="official_nav",
                economic_date__lte=as_of,
            ),
            space,
        ).order_by("economic_date", "created_at")
    )
    # A Price belongs to one immutable product/currency identity. Never fetch a
    # similarly named share class, exchange close, estimate, or foreign quote.
    by_date = {quote.economic_date: quote for quote in prices}
    current = prices[-1] if prices else None
    if current and (not current.value.is_finite() or current.value <= ZERO):
        current = None
    current_nav = (
        {
            "value": current.value,
            "date": current.economic_date,
            "source": current.source,
            "published_at": current.published_at,
            "currency": instrument.currency,
            "is_stale": (as_of - current.economic_date).days > 7,
        }
        if current
        else None
    )
    warnings = [
        "按所选参考交易日均成功扣款、在截止时间前提交估算；请排除失败、暂停和实际未扣款日期。",
        "基金开放日可能不同于交易所日历，当前未核实该基金临时暂停、限购和实际订单。",
        "估算份额未应用机构实际份额舍入规则；分红、红利再投、拆分、赎回和历史费率变化均未自动加入。",
        "预览结果不与已有持仓叠加，不影响首页资产、现金或收益日历。",
        "所有份额均为理论估算，可能包含预计尚未确认的申购，不能作为实际已确认或可卖份额。",
        *rule_warnings,
    ]
    if specification.get("is_qdii") is True or "QDII" in instrument.name.upper():
        warnings.append(
            "QDII 已按识别出的申购日历排除已知休市日；临时暂停、限购与实际确认仍须核对。"
        )
    if config.get("status") != "active":
        warnings.append(
            "计划当前不是启用状态；当前状态不能证明历史暂停区间，请填写实际暂停日期。"
        )
    if account.archived:
        warnings.append("该资金账户已归档，本次仍只预览历史假设。")
    from .subscription_calendar import subscription_day, subscription_rule

    subscription = subscription_rule(instrument)
    items, gaps, closed_dates = [], [], []
    known_expected = known_selected = known_quantity = known_cost = ZERO
    theoretical_quantity = theoretical_cost = ZERO
    scheduled_count = selected_count = excluded_count = unknown_count = 0
    pending_count = confirmation_unknown_count = 0
    estimated_count = theoretical_count = 0
    pending_amount = ZERO
    selection_unknown = quantity_unknown = False
    theoretical_unknown = False
    for offset in range((end - start).days + 1):
        when = start + timedelta(days=offset)
        trading = subscription_day(when, rule=subscription)["is_open"]
        if trading is False:
            closed_dates.append(when)
            continue
        excluded_reason = (
            "paused" if when in paused else "excluded" if when in excluded else None
        )
        selected = excluded_reason is None
        quote = by_date.get(when)
        if quote and (not quote.value.is_finite() or quote.value <= ZERO):
            quote = None
        row = {
            "date": when,
            "sequence": len(items) + 1,
            "is_scheduled": trading,
            "selected": selected,
            "excluded_reason": excluded_reason,
            "amount": amount if trading is True else None,
            "fee": fee if selected else None,
            "nav": quote.value if quote else None,
            "nav_date": when if quote else None,
            "nav_source": quote.source if quote else None,
            "estimated_quantity": None,
            "current_value": None,
            "estimated_profit": None,
            "status": "excluded",
            "message": "已按用户选择排除",
            "theoretical_quantity": None,
            "theoretical_value": None,
            "theoretical_profit": None,
            "expected_confirmation_date": None,
            "pending_forecast": None,
        }
        if trading is True:
            scheduled_count += 1
            known_expected += amount
            if selected:
                selected_count += 1
                known_selected += amount
            else:
                excluded_count += 1
        else:
            unknown_count += 1
            if selected:
                selection_unknown = quantity_unknown = True
                gaps.append("部分日期超出已核实交易日历，未按普通工作日补造期次")
        if selected:
            if trading is True:
                expected_confirmation = (
                    add_trading_days(
                        when, rule["confirmation_days"], rule["calendar_id"]
                    )
                    if rule["confirmation_days"] is not None
                    else None
                )
                row["expected_confirmation_date"] = expected_confirmation
                row["pending_forecast"] = (
                    expected_confirmation > as_of if expected_confirmation else None
                )
                if expected_confirmation is None:
                    confirmation_unknown_count += 1
                elif expected_confirmation > as_of:
                    pending_count += 1
                    pending_amount += amount
            if trading is True and quote:
                theoretical_count += 1
                theoretical = _quantity(amount, quote.value)
                theoretical_quantity += theoretical
                theoretical_cost += amount
                row.update(
                    theoretical_quantity=theoretical,
                    theoretical_value=theoretical * current.value if current else None,
                    theoretical_profit=theoretical * current.value - amount
                    if current
                    else None,
                )
            else:
                theoretical_unknown = True
            if trading is None:
                row.update(
                    status="calendar_unknown",
                    message="未知是否为基金参考交易日，未计为确定扣款期次",
                )
            elif fee is None:
                quantity_unknown = True
                row.update(
                    status="fee_unknown",
                    message="费用未知，仅展示未扣费理论值；扣费后份额与收益暂不可知",
                )
                gaps.append("部分申购费用未知，未按零费用计算份额")
                if not quote:
                    gaps.append("部分申购日缺同产品、同币种正式单位净值")
            elif not quote:
                quantity_unknown = True
                row.update(
                    status="missing_nav",
                    message="缺该申购日正式单位净值，不使用前一日或估算行情代替",
                )
                gaps.append("部分申购日缺同产品、同币种正式单位净值")
            else:
                quantity = _quantity(amount - fee, quote.value)
                estimated_count += 1
                known_quantity += quantity
                known_cost += amount
                row.update(
                    status="estimated",
                    message="假设扣款成功的份额估算",
                    estimated_quantity=quantity,
                    current_value=quantity * current.value if current else None,
                    estimated_profit=quantity * current.value - amount
                    if current
                    else None,
                )
        row["cumulative_amount"] = None if selection_unknown else known_selected
        row["cumulative_expected_amount"] = None if unknown_count else known_expected
        row["known_cumulative_expected_amount"] = known_expected
        row["known_cumulative_amount"] = known_selected
        row["cumulative_quantity"] = None if quantity_unknown else known_quantity
        row["known_cumulative_quantity"] = (
            known_quantity
            if estimated_count or not (selected_count or selection_unknown)
            else None
        )
        row["cumulative_theoretical_quantity"] = (
            None if theoretical_unknown else theoretical_quantity
        )
        row["known_cumulative_theoretical_quantity"] = (
            theoretical_quantity
            if theoretical_count or not (selected_count or selection_unknown)
            else None
        )
        items.append(row)
    if unknown_count and not any("日历" in gap for gap in gaps):
        gaps.append("原计划包含日历未核实区间；已排除的未知日仍不计为确定应投期次")
    has_selected = bool(selected_count or selection_unknown)
    if has_selected and not current:
        gaps.append("缺估值日及之前可用的正式单位净值")
    elif has_selected and current_nav["is_stale"]:
        gaps.append("末期计值净值超过七天，估值已陈旧")
    actions = []
    for resource in Resource.objects.filter(
        tenant=space, kind="market_quotes", data__instrument_id=str(instrument.pk)
    ):
        for action in resource.data.get("corporate_actions", []):
            if not isinstance(action, dict) or not action.get("date"):
                continue
            try:
                action_day = day(action["date"])
            except DomainError:
                continue
            if start <= action_day <= as_of:
                actions.append(action)
    if actions and has_selected:
        gaps.append("区间有分红或折算提示，本预览未推测实际份额调整和分红处理")
    if pending_count:
        warnings.append(
            "估算含预计确认日晚于估值日的申购；所列份额是理论份额，不能视作已确认持仓。"
        )
    if confirmation_unknown_count:
        warnings.append("部分申购的预计确认日未知；未推断为已确认份额。")
    known_value = (
        known_quantity * current.value
        if current
        else ZERO
        if not has_selected
        else None
    )
    if not estimated_count and has_selected:
        known_value = None
    known_profit = known_value - known_cost if known_value is not None else None
    quantitative_complete = not quantity_unknown and not actions
    value_complete = quantitative_complete and (not has_selected or current is not None)
    theoretical_value = (
        theoretical_quantity * current.value
        if current
        else ZERO
        if not has_selected
        else None
    )
    if not theoretical_count and has_selected:
        theoretical_value = None
    theoretical_profit = (
        theoretical_value - theoretical_cost if theoretical_value is not None else None
    )
    theoretical_complete = not theoretical_unknown and not actions
    overlap_ids = set(
        PositionMovement.objects.filter(
            tenant=space,
            account=account,
            instrument=instrument,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        ).values_list("event_id", flat=True)
    )
    overlap_ids.update(
        Event.objects.filter(
            tenant=space,
            payload__instrument_id=str(instrument.pk),
            reversal__isnull=True,
            reverses__isnull=True,
        )
        .filter(
            Q(payload__account_id=str(account.pk))
            | Q(payload__target_account_id=str(account.pk))
        )
        .values_list("pk", flat=True)
    )
    overlap = {
        "exists": bool(overlap_ids),
        "event_count": len(overlap_ids),
        "message": "该账户与产品已有存量或真实交易，本估算独立展示，不能直接叠加为新增持仓"
        if overlap_ids
        else "尚未发现同账户产品已记交易；这仍不能证明机构实际扣款成功",
    }
    status = "partial" if gaps else "estimated"
    return serial(
        {
            "is_estimate": True,
            "creates_ledger_event": False,
            "plan_id": plan.pk,
            "plan_version": plan.version,
            "account_id": account.pk,
            "instrument_id": instrument.pk,
            "instrument_name": instrument.name,
            "currency": currency,
            "start": start,
            "end": end,
            "as_of": as_of,
            "calendar": calendar,
            "subscription_rule": subscription,
            "fee_mode": fee_mode,
            "fee_amount": fee,
            "fee_policy": "deducted_from_each_installment_amount",
            "settlement_rule": rule,
            "includes_theoretical_unconfirmed_units": True,
            "theoretical_basis": "before_fees_not_actual_holdings",
            "items": items,
            "closed_dates": closed_dates,
            "current_nav": current_nav,
            "overlap": overlap,
            "corporate_actions": actions,
            "warnings": warnings,
            "gaps": list(dict.fromkeys(gaps)),
            "status": status,
            "summary": {
                "scheduled_count": scheduled_count,
                "selected_count": selected_count,
                "excluded_count": excluded_count,
                "unknown_calendar_count": unknown_count,
                "estimated_pending_count": pending_count,
                "estimated_pending_amount": pending_amount,
                "confirmation_unknown_count": confirmation_unknown_count,
                "expected_amount": None if unknown_count else known_expected,
                "known_expected_amount": known_expected,
                "selected_amount": None if selection_unknown else known_selected,
                "known_selected_amount": known_selected,
                "estimated_quantity": known_quantity if quantitative_complete else None,
                "known_quantity": known_quantity
                if estimated_count or not has_selected
                else None,
                "estimated_value": known_value if value_complete else None,
                "known_value": known_value,
                "estimated_profit": known_profit if value_complete else None,
                "known_profit": known_profit,
                "known_cost": known_cost
                if estimated_count or not has_selected
                else None,
                "theoretical_quantity": theoretical_quantity
                if theoretical_complete
                else None,
                "theoretical_value": theoretical_value
                if theoretical_complete
                else None,
                "theoretical_profit": theoretical_profit
                if theoretical_complete
                else None,
                "known_theoretical_quantity": theoretical_quantity
                if theoretical_count or not has_selected
                else None,
                "known_theoretical_value": theoretical_value,
                "known_theoretical_profit": theoretical_profit,
                "known_count": estimated_count,
                "known_theoretical_count": theoretical_count,
                "status": status,
                "gaps": list(dict.fromkeys(gaps)),
            },
            "data_revision": space.revision,
        }
    )


def placeholder_void_metadata(space, opening):
    result = {
        "eligible": False,
        "reason": "仅可撤销极小份额、零成本零市值的疑似占位录入",
        "opening_event_id": str(opening.pk) if opening else None,
        "data_revision": space.revision,
    }
    if (
        not opening
        or opening.kind != "opening"
        or opening.payload.get("opening_source") != "existing_holding"
        or opening.reverses_id
    ):
        return result
    if (
        Event.objects.filter(tenant=space, reverses=opening).exists()
        or opening.related_id
        or opening.following.filter(
            reversal__isnull=True, reverses__isnull=True
        ).exists()
    ):
        return {**result, "reason": "原录入已冲正或存在关联依赖，不能按占位记录撤销"}
    movements = list(PositionMovement.objects.filter(tenant=space, event=opening))
    if len(movements) != 1:
        return result
    movement = movements[0]
    if not ZERO < movement.quantity <= Decimal("0.00000001") or movement.cost != ZERO:
        return result
    value = opening.payload.get("opening_market_value")
    if (
        value in (None, "")
        or dec(value) != ZERO
        or opening.lines.exclude(amount=ZERO).exists()
    ):
        return result
    observations = Resource.objects.filter(
        tenant=space, kind="holding_valuations", data__opening_event_id=str(opening.pk)
    )
    if not observations.exists() or any(
        dec(row.data.get("value")) != ZERO for row in observations
    ):
        return result
    if (
        PositionMovement.objects.filter(
            tenant=space,
            account_id=movement.account_id,
            instrument_id=movement.instrument_id,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .exclude(event=opening)
        .exists()
    ):
        return {
            **result,
            "reason": "同一账户产品已有其他实际持仓记录，不能按占位记录撤销",
        }
    return {
        **result,
        "eligible": True,
        "reason": "仅冲正零金额占位记录，保留审计历史；不会撤销定投计划或真实资金",
    }


@transaction.atomic
def void_placeholder(space, user, opening_event_id, body):
    from .ledger import event_detail, reverse_event

    if not isinstance(body, dict) or set(body) - {"expected_revision", "reason"}:
        raise DomainError("撤销占位录入仅接受账簿修订和原因")
    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    if isinstance(body.get("expected_revision"), bool) or str(
        body.get("expected_revision")
    ) != str(locked.revision):
        raise DomainError(
            "账簿已变化或缺少版本，请刷新后再撤销", "version_conflict", 412
        )
    reason = body.get("reason")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
        raise DomainError("请填写撤销原因（不超过 2000 字）")
    opening = get_obj(Event, space, opening_event_id)
    eligibility = placeholder_void_metadata(space, opening)
    if not eligibility["eligible"]:
        raise DomainError(eligibility["reason"], "placeholder_ineligible")
    reversal = reverse_event(space, user, opening, reason.strip())
    audit(
        space,
        user,
        "holding.placeholder_voided",
        opening,
        {"reversal_event_id": str(reversal.pk), "reason": reason.strip()},
    )
    return {
        "event": event_detail(reversal),
        "voided_opening_event_id": str(opening.pk),
        "affects_cash": False,
        "data_revision": space.revision,
    }
