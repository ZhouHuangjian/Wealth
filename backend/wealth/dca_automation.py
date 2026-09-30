"""Opt-in, estimated DCA bookkeeping. No bank or broker orders are transmitted.

The same immutable plan/date/stage keys as history imports protect both paths.
Only a published NAV for the exact application day may supply estimated units.
"""

from collections import Counter
from decimal import ROUND_HALF_UP, Decimal, localcontext

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from .common import DomainError, bump, day, dec, get_obj, money_round, serial
from .institution_funding import available_funding_cash
from .models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Occurrence,
    Price,
    Resource,
    Workspace,
)

FIELDS = {
    "enabled",
    "start_date",
    "holding_account_id",
    "fee_mode",
    "fee_amount",
    "excluded_dates",
    "pause_ranges",
    "funding_source",
}
ZERO = Decimal(0)
STATES = {
    "scheduled": "已到期，等待自动检查",
    "disabled": "未开启自动推算",
    "paused": "计划已暂停",
    "excluded": "已排除该期",
    "waiting_calendar": "交易日历或确认周期待核实",
    "waiting_cash": "可用资金不足，等待核对余额",
    "waiting_nav": "等待该申购日正式净值",
    "waiting_confirmation": "等待预计份额确认日",
    "waiting_fee": "费用未知，等待配置",
    "recorded_estimate": "已按净值自动推算入账",
    "already_recorded": "已有记录，未重复入账",
    "needs_review": "存在记录差异，请核对",
}


def validate_configuration(space, data):
    """Called by the existing versioned plan write command, not a new write path."""
    raw = data.get("automation")
    if raw is None:
        return
    if not isinstance(raw, dict) or set(raw) - FIELDS:
        raise DomainError("定投自动配置含不支持的字段")
    enabled = raw.get("enabled", False)
    if type(enabled) is not bool:
        raise DomainError("自动补录开关须为是或否")
    if not enabled:
        data["automation"] = {**raw, "enabled": False}
        return
    if data.get("kind") != "dca":
        raise DomainError("只有基金定投计划支持自动推算")
    instrument = get_obj(Instrument, space, data.get("instrument_id"))
    _fund(instrument)
    start = day(raw.get("start_date")) if raw.get("start_date") else None
    if start is None:
        raise DomainError("请选择自动补录生效起始日；不会默认补录全部历史")
    if start < day(data["start_date"]):
        raise DomainError("自动补录起始日不能早于计划首期日期")
    source = get_obj(Account, space, data.get("account_id"))
    holding = get_obj(Account, space, raw.get("holding_account_id") or source.pk)
    funding_source = raw.get("funding_source", "account")
    if funding_source not in {"account", "untracked"}:
        raise DomainError("请选择账户扣款或账外资金")
    if funding_source == "untracked" and source.pk != holding.pk:
        raise DomainError(
            "使用账外资金时，计划资金账户请选择持仓账户，不会扣减该账户现金"
        )
    from .institution_funding import CASH_ACCOUNT_KINDS
    from .investments import validate_investment_account

    validate_investment_account(holding, instrument)
    if holding.valuation_mode != "detailed" or holding.kind not in {
        "fund",
        "broker",
        "securities",
    }:
        raise DomainError("请选择基金或券商持仓账户；银行卡可作为付款账户")
    if (
        source.kind not in CASH_ACCOUNT_KINDS
        or source.valuation_mode != "detailed"
        or source.archived
    ):
        raise DomainError("自动定投付款账户须为未归档的现金余额账户")
    if (
        source.currency != instrument.currency
        or holding.currency != instrument.currency
    ):
        raise DomainError("付款账户、持仓账户和基金须使用相同币种")
    fee_mode = raw.get("fee_mode", "unknown")
    if fee_mode not in {"unknown", "zero", "fixed", "rate"}:
        raise DomainError("费用请选择未知、零费用、每期固定费用或申购费率")
    fee = dec(
        raw.get("fee_amount", "0"),
        nonnegative=True,
        places=6 if fee_mode == "rate" else 2,
    )
    if fee_mode not in {"fixed", "rate"} and fee:
        raise DomainError("只有固定费用模式可以填写费用")
    if (fee_mode == "fixed" and fee >= dec(data["amount"])) or (
        fee_mode == "rate" and fee > 100
    ):
        raise DomainError("费用须小于每期投入金额")
    excluded = raw.get("excluded_dates", [])
    pauses = raw.get("pause_ranges", [])
    if (
        not isinstance(excluded, list)
        or len(excluded) > 1097
        or not isinstance(pauses, list)
        or len(pauses) > 100
    ):
        raise DomainError("排除日期最多1097天，暂停区间最多100段")
    excluded = sorted({str(day(value)) for value in excluded if value})
    ranges = []
    for item in pauses:
        if (
            not isinstance(item, dict)
            or set(item) != {"start", "end"}
            or not item["start"]
            or not item["end"]
        ):
            raise DomainError("暂停区间须填写开始和结束日期")
        first, last = day(item["start"]), day(item["end"])
        if first > last:
            raise DomainError("暂停开始日不能晚于结束日")
        ranges.append({"start": str(first), "end": str(last)})
    data["automation"] = {
        "enabled": True,
        "start_date": str(start),
        "holding_account_id": str(holding.pk),
        "fee_mode": fee_mode,
        "fee_amount": str(fee),
        "excluded_dates": excluded,
        "pause_ranges": ranges,
        "funding_source": funding_source,
    }


def _fund(instrument):
    spec = instrument.specification or {}
    fund_type = str(spec.get("fund_type", "")).lower()
    if (
        instrument.kind != "fund"
        or spec.get("is_derivative")
        or spec.get("trading_channel") == "exchange"
        or "货币" in instrument.name
        or "货币" in fund_type
        or fund_type in {"005", "money", "money_market", "money-market"}
        or spec.get("is_money_fund")
        or spec.get("is_money_market")
    ):
        raise DomainError(
            "自动推算仅支持按正式单位净值申购的场外基金，其他产品请记录实际成交"
        )


def _excluded(config, when):
    return str(when) in config.get("excluded_dates", []) or any(
        day(item["start"]) <= when <= day(item["end"])
        for item in config.get("pause_ranges", [])
    )


def _state(space, user, occurrence, status, message=None, **fields):
    values = serial({"status": status, "message": message or STATES[status], **fields})
    if occurrence.details.get("automation") != values:
        occurrence.details = {**occurrence.details, "automation": values}
        occurrence.version += 1
        occurrence.save(update_fields=["details", "version"])
        bump(space, user, invalidate_reconciliations=False)
    return values


def automation_status(space, plan_id):
    plan = get_obj(Resource, space, plan_id, kind="plans")
    config = plan.data.get("automation") or {}
    from .planning import today

    now = today(space)
    items = []
    start = day(config["start_date"]) if config.get("start_date") else now
    occurrences = Occurrence.objects.filter(
        tenant=space, plan=plan, due_date__gte=start, due_date__lte=now
    ).order_by("due_date", "sequence")
    total_count = occurrences.count()
    for row in reversed(list(occurrences.order_by("-due_date", "-sequence")[:500])):
        state = row.details.get("automation") or {}
        default = (
            "already_recorded"
            if row.event_id
            else "disabled"
            if not config.get("enabled")
            else "paused"
            if plan.data.get("status") != "active"
            else "excluded"
            if _excluded(config, row.due_date) or row.status in {"skipped", "cancelled"}
            else "scheduled"
        )
        values = {"status": default, "message": STATES[default], **state}
        if not row.event_id and (
            not config.get("enabled") or plan.data.get("status") != "active"
        ):
            values.update(status=default, message=STATES[default])
        items.append(
            {
                "occurrence_id": str(row.pk),
                "date": str(row.due_date),
                "amount": str(row.amount),
                "debit_event_id": str(row.event_id) if row.event_id else None,
                "confirmation_event_id": None,
                **values,
            }
        )
    return {
        "enabled": bool(config.get("enabled")),
        "start_date": config.get("start_date"),
        "plan_version": plan.version,
        "total_count": total_count,
        "has_more": total_count > len(items),
        "items": items,
        "summary": dict(Counter(item["status"] for item in items)),
        "data_revision": Workspace.objects.get(pk=space.pk).revision,
        "message": "按计划假定扣款并用正式净值推算份额，仅更新本账簿，不向银行或基金平台发起交易。",
    }


def _active(event):
    return event and not event.reverses_id and not hasattr(event, "reversal")


def _same_debit(event, occurrence, instrument, source):
    return (
        _active(event)
        and event.kind == "fund_debit"
        and event.payload.get("account_id") == str(source.pk)
        and event.payload.get("instrument_id") == str(instrument.pk)
        and event.payload.get("currency") == instrument.currency
        and dec(event.payload.get("amount")) == occurrence.amount
        and event.economic_date == occurrence.due_date
    )


def _period(space, plan, occurrence):
    records = list(
        Resource.objects.filter(
            tenant=space,
            kind="dca_import_periods",
            data__plan_id=str(plan.pk),
            data__scheduled_date=str(occurrence.due_date),
        )
    )
    if len(records) > 1:
        raise DomainError("该日期存在重复定投登记，请核对", "dca_registry_conflict")
    return records[0] if records else None


def _write_period(
    space,
    user,
    plan,
    instrument,
    holding,
    occurrence,
    debit,
    confirmation=None,
    resource=None,
    **extra,
):
    from .dca_import import _save_period

    debit_basis = debit.payload.get("entry_basis", "institution")
    data = {
        **(resource.data if resource else {}),
        "scheduled_date": str(occurrence.due_date),
        "debit_date": str(debit.economic_date),
        "amount": str(occurrence.amount),
        "funding_account_id": debit.payload["account_id"],
        "status": "confirmed" if confirmation else "debited",
        "entry_basis": "preview_confirmed",
        "debit_entry_basis": debit_basis,
        "confirmation_entry_basis": "preview_confirmed" if confirmation else None,
        "automatic_estimate": True,
        "automation_plan_version": plan.version,
        **extra,
    }
    return _save_period(
        space, user, plan, holding, instrument, data, debit, confirmation, resource
    )


def _process(space, user, plan, occurrence, now):
    from .dca_import import _baseline
    from .ledger import post_event
    from .planning import confirm_occurrence
    from .subscription_calendar import subscription_day
    from .trading_calendar import preview_trade_dates

    config = plan.data["automation"]
    if (
        occurrence.details.get("permanently_removed")
        or occurrence.status == "cancelled"
    ):
        return _state(space, user, occurrence, "excluded")
    if _excluded(config, occurrence.due_date) or (
        occurrence.status == "skipped" and not occurrence.details.get("auto_skip")
    ):
        return _state(
            space,
            user,
            occurrence,
            "needs_review" if occurrence.event_id else "excluded",
            "该期已有推算扣款；如实际失败，请冲正扣款及关联份额，系统不会静默撤销"
            if occurrence.event_id
            else None,
        )
    instrument = get_obj(Instrument, space, plan.data["instrument_id"])
    _fund(instrument)
    source = get_obj(Account, space, plan.data["account_id"])
    holding = get_obj(Account, space, config["holding_account_id"])
    if occurrence.details.get("instrument_id") not in (
        None,
        str(instrument.pk),
    ) or occurrence.details.get("account_id") not in (None, str(source.pk)):
        return _state(
            space,
            user,
            occurrence,
            "needs_review",
            "历史期次的产品或付款账户与当前计划不同，请核对",
        )
    period = _period(space, plan, occurrence)
    prefix = f"{space.pk}:dca:{plan.pk}:{occurrence.due_date}"
    debit = occurrence.event if occurrence.event_id else None
    stage_debit = Event.objects.filter(
        tenant=space, stage_key=prefix + ":debit"
    ).first()
    stage_confirmation = Event.objects.filter(
        tenant=space, stage_key=prefix + ":confirm"
    ).first()
    if any(
        event and not _active(event)
        for event in (debit, stage_debit, stage_confirmation)
    ):
        return _state(
            space,
            user,
            occurrence,
            "needs_review",
            "该期记录已冲正，不会自动重新扣款或确认",
        )
    if period:
        prior = period.data
        if (
            prior.get("instrument_id") != str(instrument.pk)
            or prior.get("holding_account_id") != str(holding.pk)
            or prior.get("funding_account_id") != str(source.pk)
            or dec(prior.get("amount")) != occurrence.amount
            or not debit
            or prior.get("debit_event_id") != str(debit.pk)
        ):
            return _state(
                space,
                user,
                occurrence,
                "needs_review",
                "已记录期次与当前计划配置不一致，请核对原记录",
            )
    if debit and not _same_debit(debit, occurrence, instrument, source):
        return _state(
            space,
            user,
            occurrence,
            "needs_review",
            "该期待办已关联其他实际记录，未再次扣款",
        )
    if debit and bool(debit.payload.get("untracked_funding")) != (
        config.get("funding_source") == "untracked"
    ):
        return _state(
            space,
            user,
            occurrence,
            "needs_review",
            "已记录扣款的资金来源与当前计划不同，请核对原记录",
        )
    if stage_debit and (not debit or debit.pk != stage_debit.pk):
        return _state(
            space,
            user,
            occurrence,
            "needs_review",
            "原扣款与待办关联不一致，未再次扣款",
        )
    if debit:
        confirmations = list(
            Event.objects.filter(
                tenant=space,
                related=debit,
                kind="fund_confirm",
                reversal__isnull=True,
                reverses__isnull=True,
            )
        )
        if confirmations:
            confirmation = confirmations[0]
            if len(confirmations) != 1 or (
                period
                and period.data.get("confirmation_event_id")
                not in (None, str(confirmation.pk))
            ):
                return _state(
                    space,
                    user,
                    occurrence,
                    "needs_review",
                    "已有分笔或不同份额确认，请核对",
                )
            remaining = (
                JournalLine.objects.filter(
                    tenant=space,
                    event_id__in=[debit.pk, confirmation.pk],
                    code="fund_transit",
                ).aggregate(value=Sum("amount"))["value"]
                or ZERO
            )
            if (
                remaining != ZERO
                or confirmation.payload.get("account_id") != str(holding.pk)
                or confirmation.payload.get("instrument_id") != str(instrument.pk)
                or confirmation.payload.get("currency") != instrument.currency
            ):
                return _state(
                    space,
                    user,
                    occurrence,
                    "needs_review",
                    "已有份额确认未完整覆盖扣款，或关联账户、产品不一致，请核对",
                )
            return _state(
                space,
                user,
                occurrence,
                "recorded_estimate"
                if confirmation.payload.get("automatic_estimate")
                else "already_recorded",
                debit_event_id=str(debit.pk),
                confirmation_event_id=str(confirmation.pk),
                quantity=confirmation.payload.get("quantity"),
                nav=confirmation.payload.get("price"),
                nav_date=confirmation.payload.get("nav_date"),
                confirmation_date=str(confirmation.economic_date),
            )
    availability = subscription_day(occurrence.due_date, instrument)
    if availability["is_open"] is not True:
        return _state(
            space,
            user,
            occurrence,
            "needs_review"
            if debit
            else "excluded"
            if availability["is_open"] is False
            else "waiting_calendar",
            "已有扣款但该申购日并非已核实开放日，请核对"
            if debit
            else availability["reason"],
        )
    if not debit:
        if plan.data.get("status") != "active":
            return _state(space, user, occurrence, "paused")
        candidates = Event.objects.filter(
            tenant=space,
            kind="fund_debit",
            economic_date=occurrence.due_date,
            payload__account_id=str(source.pk),
            payload__instrument_id=str(instrument.pk),
            reversal__isnull=True,
            reverses__isnull=True,
        )
        if any(
            dec(event.payload["amount"]) == occurrence.amount for event in candidates
        ):
            return _state(
                space,
                user,
                occurrence,
                "needs_review",
                "同日已有相同基金金额的扣款，请先关联待办，避免重复",
            )
        if period or stage_confirmation:
            return _state(
                space,
                user,
                occurrence,
                "needs_review",
                "已登记的阶段记录不完整，请核对",
            )
        _baseline(space, source, occurrence.due_date)
        if config.get("funding_source") != "untracked" and (
            available_funding_cash(space, source, occurrence.due_date)
            < occurrence.amount
        ):
            return _state(space, user, occurrence, "waiting_cash")
        debit = post_event(
            space,
            user,
            {
                "kind": "fund_debit",
                "account_id": str(source.pk),
                "holding_account_id": str(holding.pk),
                "instrument_id": str(instrument.pk),
                "economic_date": str(occurrence.due_date),
                "amount": str(occurrence.amount),
                "dca_import_plan_id": str(plan.pk),
                "dca_import_date": str(occurrence.due_date),
                "entry_basis": "preview_confirmed",
                "automatic_estimate": True,
                "automation_plan_version": plan.version,
                "description": "按定投计划自动推算扣款（未核实机构成交）",
            },
            stage_key=prefix + ":debit",
            _untracked_funding=config.get("funding_source") == "untracked",
        )
        confirm_occurrence(space, user, occurrence, debit.pk)
        occurrence.refresh_from_db()
    if period is None:
        period = _write_period(
            space, user, plan, instrument, holding, occurrence, debit
        )
    details = {"debit_event_id": str(debit.pk)}
    metadata = preview_trade_dates(
        {
            "instrument": {
                "name": instrument.name,
                "code": instrument.code,
                "kind": instrument.kind,
                "market": instrument.market,
                "currency": instrument.currency,
                "specification": instrument.specification,
            },
            "application_date": str(occurrence.due_date),
        }
    )
    trade_date, confirmation_date = (
        metadata.get("trade_date"),
        metadata.get("expected_confirmation_date"),
    )
    if not trade_date or not confirmation_date:
        return _state(space, user, occurrence, "waiting_calendar", **details)
    details.update(nav_date=trade_date, confirmation_date=confirmation_date)
    if day(confirmation_date) > now:
        return _state(space, user, occurrence, "waiting_confirmation", **details)
    if config.get("fee_mode", "unknown") == "unknown":
        return _state(space, user, occurrence, "waiting_fee", **details)
    quote = (
        Price.objects.filter(
            tenant=space,
            instrument=instrument,
            kind="official_nav",
            economic_date=day(trade_date),
        )
        .filter(Q(published_at__isnull=True) | Q(published_at__lte=timezone.now()))
        .order_by("-created_at")
        .first()
    )
    if not quote or quote.value <= 0 or not quote.value.is_finite():
        return _state(space, user, occurrence, "waiting_nav", **details)
    fee = dec(config.get("fee_amount", "0")) if config["fee_mode"] == "fixed" else ZERO
    if config["fee_mode"] == "rate":
        with localcontext() as context:
            context.prec = 160
            fee = (
                occurrence.amount
                - occurrence.amount / (1 + dec(config.get("fee_amount", "0")) / 100)
            ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if fee >= occurrence.amount:
        return _state(
            space,
            user,
            occurrence,
            "needs_review",
            "该期金额不足以覆盖当前费用配置",
            **details,
        )
    with localcontext() as context:
        context.prec = 160
        precision = instrument.specification.get("share_precision", 2)
        if type(precision) is not int or not 0 <= precision <= 8:
            return _state(
                space,
                user,
                occurrence,
                "needs_review",
                "基金份额精度配置无效，请核对",
                **details,
            )
        quantity = ((occurrence.amount - fee) / quote.value).quantize(
            Decimal(1).scaleb(-precision), rounding=ROUND_HALF_UP
        )
        if quantity <= 0:
            return _state(
                space,
                user,
                occurrence,
                "needs_review",
                "金额无法得到有效份额，需核对机构确认规则",
                **details,
            )
        adjustment = occurrence.amount - money_round(quantity * quote.value + fee)
        limit = min(
            Decimal(1),
            quote.value * Decimal("0.01") + Decimal("0.01"),
            occurrence.amount * Decimal("0.01"),
        )
        if abs(adjustment) > limit:
            return _state(
                space,
                user,
                occurrence,
                "needs_review",
                "份额舍入差异超出可自动处理范围",
                **details,
            )
        _baseline(space, holding, day(confirmation_date))
        allowed = [
            row.data["confirmation_event_id"]
            for row in Resource.objects.filter(
                tenant=space, kind="dca_import_periods", data__plan_id=str(plan.pk)
            )
            if row.data.get("confirmation_event_id")
        ]
        confirmation = post_event(
            space,
            user,
            {
                "kind": "fund_confirm",
                "account_id": str(holding.pk),
                "instrument_id": str(instrument.pk),
                "related_event_id": str(debit.pk),
                "economic_date": confirmation_date,
                "amount": str(occurrence.amount),
                "quantity": str(quantity),
                "price": str(quote.value),
                "fee": str(fee),
                "rounding_adjustment": str(adjustment),
                "rounding_confirmed": True,
                "dca_import_plan_id": str(plan.pk),
                "dca_import_date": str(occurrence.due_date),
                "entry_basis": "preview_confirmed",
                "debit_entry_basis": debit.payload.get("entry_basis", "institution"),
                "automatic_estimate": True,
                "automation_plan_version": plan.version,
                "nav_date": trade_date,
                "nav_price_id": str(quote.pk),
                "nav_source": quote.source,
                "share_precision": precision,
                "share_rounding": "half_up",
                "description": "按正式净值自动推算份额（未核实机构成交）",
            },
            stage_key=prefix + ":confirm",
            _fund_confirmation={
                "confirmed_amount": str(occurrence.amount),
                "rounding_adjustment": str(adjustment),
                "plan_id": str(plan.pk),
                "allow_later_event_ids": allowed,
            },
        )
    _write_period(
        space,
        user,
        plan,
        instrument,
        holding,
        occurrence,
        debit,
        confirmation,
        period,
        confirmation_date=confirmation_date,
        quantity=str(quantity),
        nav=str(quote.value),
        fee=str(fee),
        rounding_adjustment=str(adjustment),
        rounding_confirmed=True,
        nav_date=trade_date,
        nav_price_id=str(quote.pk),
        nav_source=quote.source,
    )
    return _state(
        space,
        user,
        occurrence,
        "recorded_estimate",
        **details,
        confirmation_event_id=str(confirmation.pk),
        quantity=str(quantity),
        nav=str(quote.value),
    )


@transaction.atomic
def run_plan(space, user, plan_id, *, expected_plan_version=None):
    from .planning import generate_schedule, today

    locked = Workspace.objects.select_for_update().get(pk=space.pk)
    if locked.deleted_at:
        raise DomainError("空间已移入回收站", "not_found", 404)
    plan = get_obj(Resource, space, plan_id, kind="plans")
    if expected_plan_version is not None and str(expected_plan_version) != str(
        plan.version
    ):
        raise DomainError("计划已修改，请刷新后再检查", "version_conflict", 412)
    config = plan.data.get("automation") or {}
    if not config.get("enabled") or plan.data.get("status") not in {"active", "paused"}:
        return {**automation_status(space, plan.pk), "processed": 0}
    validate_configuration(space, plan.data)
    now = today(space)
    if plan.data.get("status") == "active":
        generate_schedule(space, user, plan, now)
    occurrences = list(
        Occurrence.objects.filter(
            tenant=space,
            plan=plan,
            due_date__gte=day(config["start_date"]),
            due_date__lte=now,
        ).order_by("due_date", "sequence")
    )
    runtime = Resource.objects.filter(
        tenant=space, kind="dca_automation_runtime", data__plan_id=str(plan.pk)
    ).first()
    cursor = runtime.data.get("cursor", "") if runtime else ""

    def cursor_key(row):
        return f"{row.due_date}:{row.sequence:08d}"

    queue = [row for row in occurrences if cursor_key(row) > cursor] + [
        row for row in occurrences if cursor_key(row) <= cursor
    ]
    selected = queue[:500]
    processed = 0
    for occurrence in selected:
        try:
            with transaction.atomic():
                _process(space, user, plan, occurrence, now)
        except DomainError as error:
            occurrence.refresh_from_db()
            _state(
                space,
                user,
                occurrence,
                "waiting_cash"
                if error.code
                in {"negative_funding_balance", "insufficient_source_cash"}
                else "needs_review",
                error.message,
            )
        processed += 1
    if selected:
        runtime_data = {
            "plan_id": str(plan.pk),
            "cursor": cursor_key(selected[-1]),
            "checked_at": timezone.now().isoformat(),
        }
        if runtime:
            runtime.data = runtime_data
            runtime.version += 1
            runtime.save(update_fields=["data", "version"])
        else:
            Resource.objects.create(
                tenant=space,
                created_by=user,
                kind="dca_automation_runtime",
                data=runtime_data,
            )
    return {
        **automation_status(space, plan.pk),
        "processed": processed,
        "has_more": len(occurrences) > 500,
    }
