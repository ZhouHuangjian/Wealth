"""Versioned fund intentions and explicitly recorded payment/share facts.

An application is never a journal fact. Unknown funding is an explicit external
capital contribution, not fabricated cash or income. Quotes only create shares
when estimation was selected; all transitions run in the caller's command lock.
"""

from decimal import ROUND_HALF_UP, Decimal, localcontext

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from .common import DomainError, bump, day, dec, get_obj, money_round, serial
from .institution_funding import CASH_ACCOUNT_KINDS
from .investment_trades import record_trade
from .investments import validate_investment_account
from .ledger import post_event, reverse_event
from .models import Account, Event, Instrument, JournalLine, Price, Resource, Workspace
from .planning import _remember, today

KIND = "fund_orders"
DEFAULTS = "fund_trade_defaults"
FIELDS = {
    "instrument_id",
    "account_id",
    "amount",
    "application_date",
    "after_cutoff",
    "funding_source",
    "cash_account_id",
    "status",
    "auto_estimate",
    "fee_mode",
    "fee_value",
    "quantity",
    "price",
    "confirmation_date",
    "description",
    "remember_defaults",
    "version",
}
LABELS = {
    "submitted": "已提交，未确认扣款",
    "paid": "已扣款，待确认份额",
    "confirmed": "已按机构记录确认",
    "estimated": "已自动入账 · 份额推算",
    "cancelled": "已撤销",
}


def _objects(space, data):
    instrument = get_obj(Instrument, space, data.get("instrument_id"))
    if (
        instrument.kind != "fund"
        or instrument.specification.get("trading_channel") == "exchange"
    ):
        raise DomainError("此入口用于场外基金申购")
    account = get_obj(Account, space, data.get("account_id"))
    validate_investment_account(account, instrument)
    if account.valuation_mode != "detailed":
        raise DomainError("余额记录账户请更新余额，记录基金交易需使用交易明细账户")
    return instrument, account


def _preferences(space, data):
    instrument, account = _objects(space, data)
    funding = data.get("funding_source", "account")
    if funding not in {"account", "untracked"}:
        raise DomainError("请选择账户扣款或账外资金")
    cash_id = data.get("cash_account_id") or str(account.pk)
    if funding == "account":
        cash = get_obj(Account, space, cash_id)
        if (
            cash.archived
            or cash.valuation_mode != "detailed"
            or cash.kind not in CASH_ACCOUNT_KINDS
            or cash.currency != instrument.currency
        ):
            raise DomainError("请选择同币种、未归档的明细资金账户")
    mode = data.get("fee_mode", "unknown")
    if mode not in {"unknown", "zero", "fixed", "rate"}:
        raise DomainError("费用请选择未知、无费率、固定费用或申购费率")
    value = dec(data.get("fee_value") or "0", nonnegative=True, places=6)
    if mode in {"unknown", "zero"} and value or mode == "rate" and value > 100:
        raise DomainError("费用设置不正确")
    automatic = data.get("auto_estimate", False)
    if type(automatic) is not bool:
        raise DomainError("份额推算开关须为是或否")
    return {
        "instrument_id": str(instrument.pk),
        "account_id": str(account.pk),
        "funding_source": funding,
        "cash_account_id": cash_id if funding == "account" else None,
        "fee_mode": mode,
        "fee_value": str(value),
        "auto_estimate": automatic,
    }


def preferences(space, instrument_id, account_id):
    _objects(space, {"instrument_id": instrument_id, "account_id": account_id})
    row = Resource.objects.filter(
        tenant=space,
        kind=DEFAULTS,
        data__instrument_id=str(instrument_id),
        data__account_id=str(account_id),
    ).first()
    return {
        **(
            row.data
            if row
            else {
                "funding_source": "account",
                "cash_account_id": str(account_id),
                "fee_mode": "unknown",
                "fee_value": "0",
                "auto_estimate": False,
            }
        ),
        "version": row.version if row else 0,
    }


def _save_defaults(space, user, data):
    values = _preferences(space, data)
    row = Resource.objects.filter(
        tenant=space,
        kind=DEFAULTS,
        data__instrument_id=values["instrument_id"],
        data__account_id=values["account_id"],
    ).first()
    if row:
        if row.data != values:
            _remember(row, user)
            row.data, row.version = values, row.version + 1
            row.save(update_fields=["data", "version"])
    else:
        Resource.objects.create(
            tenant=space, created_by=user, kind=DEFAULTS, data=values
        )


def detail(row):
    d = row.data
    requires_action = d["status"] == "submitted" or (
        d["status"] == "paid"
        and (
            not d.get("auto_estimate")
            or d.get("fee_mode", "unknown") == "unknown"
            or d.get("needs_review", False)
        )
    )
    return {
        "id": str(row.pk),
        "version": row.version,
        **row.data,
        "status_label": LABELS[row.data["status"]],
        "requires_action": bool(requires_action),
        "processing_state": "attention"
        if requires_action
        else "waiting"
        if d["status"] == "paid"
        else "complete",
    }


def list_orders(space, **filters):
    rows = Resource.objects.filter(tenant=space, kind=KIND).order_by("-created_at")
    for name in ("instrument_id", "account_id"):
        if filters.get(name):
            rows = rows.filter(**{f"data__{name}": filters[name]})
    if filters.get("pending"):
        rows = rows.filter(action_filter())
    try:
        offset = max(0, int(filters.get("offset") or 0))
        limit = min(100, max(1, int(filters.get("limit") or 20)))
    except (ValueError, TypeError):
        raise DomainError("分页参数须为整数")
    count = rows.count()
    return {
        "items": [detail(row) for row in rows[offset : offset + limit]],
        "count": count,
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < count,
    }


def action_filter():
    return Q(data__status="submitted") | Q(data__status="paid") & (
        Q(data__auto_estimate=False)
        | Q(data__auto_estimate__isnull=True)
        | Q(data__fee_mode="unknown")
        | Q(data__fee_mode__isnull=True)
        | Q(data__needs_review=True)
    )


def _update(row, user, **data):
    if all(row.data.get(k) == v for k, v in data.items()):
        return
    _remember(row, user)
    row.data = {**row.data, **serial(data)}
    row.version += 1
    row.save(update_fields=["data", "version"])
    bump(row.tenant, user)


def _debit(space, user, row, payment_date=None):
    d = row.data
    result = record_trade(
        space,
        user,
        {
            "side": "buy",
            "pending": True,
            "instrument_id": d["instrument_id"],
            "account_id": d["account_id"],
            "cash_account_id": d.get("cash_account_id"),
            "funding_source": d["funding_source"],
            "amount": d["amount"],
            "economic_date": payment_date or d["application_date"],
            "description": d.get("description", ""),
        },
    )
    _update(
        row,
        user,
        status="paid",
        debit_event_id=result["items"][0]["id"],
        payment_date=payment_date or d["application_date"],
        note="等待份额确认",
    )


def _fee(data):
    mode = data.get("fee_mode", "unknown")
    if mode == "unknown":
        return None
    amount, value = dec(data["amount"]), dec(data.get("fee_value") or "0")
    fee = (
        value
        if mode == "fixed"
        else (amount - amount / (1 + value / 100)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        if mode == "rate"
        else Decimal(0)
    )
    if fee >= amount:
        raise DomainError("费用须小于申购金额")
    return fee


def _confirm(
    space, user, row, quantity, price, when, *, estimated=False, nav_date=None
):
    d = row.data
    fee = _fee(d)
    if fee is None:
        raise DomainError("请补充实际费用或明确选择无申购费")
    when = day(when)
    if when > today(space):
        raise DomainError("确认日尚未到达，暂保留待确认")
    qty, nav = (
        dec(quantity, nonnegative=True, places=18),
        dec(price, nonnegative=True, places=18),
    )
    amount = dec(d["amount"])
    adjustment = amount - money_round(qty * nav + fee)
    confirmation = post_event(
        space,
        user,
        {
            "kind": "fund_confirm",
            "account_id": d["account_id"],
            "instrument_id": d["instrument_id"],
            "related_event_id": d["debit_event_id"],
            "economic_date": str(when),
            "quantity": str(qty),
            "price": str(nav),
            "fee": str(fee),
            "rounding_confirmed": True,
            "entry_basis": "preview_confirmed" if estimated else "institution",
            "automatic_estimate": estimated,
            "nav_date": nav_date or str(when),
            "fund_order_id": str(row.pk),
            "description": "按正式净值推算份额，待机构核实"
            if estimated
            else "手工记录机构确认份额",
        },
        stage_key=f"{space.pk}:fund-order:{row.pk}:confirm:{row.version}",
        _fund_confirmation={
            "confirmed_amount": str(amount),
            "rounding_adjustment": str(adjustment),
        },
    )
    _update(
        row,
        user,
        status="estimated" if estimated else "confirmed",
        confirmation_event_id=str(confirmation.pk),
        quantity=str(qty),
        price=str(nav),
        confirmation_date=str(when),
        nav_date=nav_date or str(when),
        note="按申购日正式净值与费用规则计算；可随时更正"
        if estimated
        else "已按手工填写的机构记录确认",
        needs_review=False,
    )


def estimate(space, user, row):
    from .dca_automation import _fund
    from .trading_calendar import preview_trade_dates

    if row.data["status"] != "paid":
        return
    d = row.data
    debit = get_obj(Event, space, d["debit_event_id"])
    confirmations = list(
        debit.following.filter(
            kind="fund_confirm", reversal__isnull=True, reverses__isnull=True
        )
    )
    if confirmations and len(confirmations) == 1:
        confirmation = confirmations[0]
        remaining = JournalLine.objects.filter(
            tenant=space, event_id__in=[debit.pk, confirmation.pk], code="fund_transit"
        ).aggregate(amount=Sum("amount"))["amount"]
        if remaining == 0 and confirmation.payload.get("account_id") == d["account_id"]:
            _update(
                row,
                user,
                status="estimated"
                if confirmation.payload.get("automatic_estimate")
                else "confirmed",
                confirmation_event_id=str(confirmation.pk),
                quantity=confirmation.payload.get("quantity"),
                price=confirmation.payload.get("price"),
                confirmation_date=str(confirmation.economic_date),
                note="已关联原扣款对应的份额确认记录",
                needs_review=False,
            )
            return
    if hasattr(debit, "reversal") or confirmations:
        _update(
            row, user, note="扣款或确认记录已在其他入口处理，请核对", needs_review=True
        )
        return
    if not d.get("auto_estimate"):
        return
    instrument, _ = _objects(space, d)
    _fund(instrument)
    dates = preview_trade_dates(
        {
            "instrument": {
                "name": instrument.name,
                "code": instrument.code,
                "kind": instrument.kind,
                "market": instrument.market,
                "currency": instrument.currency,
                "specification": instrument.specification,
            },
            "application_at": d["application_date"]
            + ("T15:30:00+08:00" if d.get("after_cutoff") else "T14:00:00+08:00"),
        }
    )
    nav_date, confirmation = (
        dates.get("trade_date"),
        dates.get("expected_confirmation_date"),
    )
    if not nav_date or not confirmation:
        _update(row, user, note="交易日或确认周期待配置", needs_review=True)
        return
    _update(row, user, expected_confirmation_date=confirmation, nav_date=nav_date)
    if day(confirmation) > today(space):
        _update(row, user, note="等待份额入账日，系统将自动继续", needs_review=False)
        return
    with localcontext() as ctx:
        ctx.prec = 160
        fee = _fee(d)
        if fee is None:
            _update(row, user, note="待补充费用规则，不推测费用")
            return
        quote = (
            Price.objects.filter(
                tenant=space,
                instrument=instrument,
                economic_date=day(nav_date),
                kind="official_nav",
            )
            .filter(Q(published_at__isnull=True) | Q(published_at__lte=timezone.now()))
            .order_by("-created_at")
            .first()
        )
        if not quote or quote.value <= 0:
            _update(
                row, user, note="等待申购日净值，公布后自动入账", needs_review=False
            )
            return
        precision = instrument.specification.get("share_precision", 2)
        if type(precision) is not int or not 0 <= precision <= 8:
            raise DomainError("基金份额精度需核对")
        qty = ((dec(d["amount"]) - fee) / quote.value).quantize(
            Decimal(1).scaleb(-precision), rounding=ROUND_HALF_UP
        )
        _confirm(
            space,
            user,
            row,
            str(qty),
            str(quote.value),
            confirmation,
            estimated=True,
            nav_date=nav_date,
        )


@transaction.atomic
def save_order(space, user, data, row=None):
    Workspace.objects.select_for_update().get(pk=space.pk)
    if not isinstance(data, dict) or set(data) - FIELDS:
        raise DomainError("申购记录含不支持的字段")
    if row and row.data["status"] != "submitted":
        raise DomainError("已扣款记录请从阶段处理入口更正，避免重复扣款")
    values = _preferences(space, data)
    instrument, account = _objects(space, values)
    when = day(data.get("application_date"))
    if when > today(space):
        raise DomainError("未来买入请建立定投计划")
    amount = dec(data.get("amount"), nonnegative=True, places=2)
    if amount <= 0:
        raise DomainError("申购金额须大于零")
    status = data.get("status", "submitted")
    if status not in {"submitted", "paid", "confirmed"}:
        raise DomainError("请选择已提交、已扣款或已确认")
    if (
        type(data.get("after_cutoff", False)) is not bool
        or type(data.get("remember_defaults", False)) is not bool
    ):
        raise DomainError("选项格式不正确")
    values.update(
        amount=str(amount),
        currency=account.currency,
        instrument_name=instrument.name,
        account_name=account.name,
        application_date=str(when),
        after_cutoff=data.get("after_cutoff", False),
        status="submitted",
        description=str(data.get("description") or "")[:1000],
        note="仅记录申请，不计入资产",
    )
    if row:
        _update(row, user, **values)
    else:
        row = Resource.objects.create(
            tenant=space, created_by=user, kind=KIND, data=values
        )
        bump(space, user)
    if status in {"paid", "confirmed"}:
        _debit(space, user, row)
    if status == "confirmed":
        with localcontext() as ctx:
            ctx.prec = 160
            _confirm(
                space,
                user,
                row,
                data.get("quantity"),
                data.get("price"),
                data.get("confirmation_date") or when,
            )
    elif status == "paid" and values["auto_estimate"]:
        # A quote/calendar problem must never discard a known payment.
        try:
            with transaction.atomic():
                estimate(space, user, row)
        except DomainError as exc:
            row.refresh_from_db()
            _update(row, user, note=exc.message, needs_review=True)
    if data.get("remember_defaults"):
        _save_defaults(space, user, values)
    return detail(row)


@transaction.atomic
def transition(space, user, row, body):
    Workspace.objects.select_for_update().get(pk=space.pk)
    action = body.get("action")
    if set(body) - {
        "action",
        "version",
        "payment_date",
        "quantity",
        "price",
        "confirmation_date",
        "fee_mode",
        "fee_value",
        "auto_estimate",
        "cash_account_id",
    }:
        raise DomainError("阶段处理含不支持的字段")
    if action == "cancel":
        if row.data["status"] == "cancelled":
            return detail(row)
        for key in (
            "confirmation_event_id",
            "funding_event_id",
            "debit_event_id",
            "conversion_settlement_id",
            "conversion_redeem_id",
        ):
            if row.data.get(key):
                event = get_obj(Event, space, row.data[key])
                if not hasattr(event, "reversal"):
                    reverse_event(space, user, event, "撤销基金申购记录")
        _update(row, user, status="cancelled", note="已撤销账簿记录；未向机构发出撤单")
    elif action == "associate" and row.data["status"] in {
        "paid",
        "confirmed",
        "estimated",
    }:
        if row.data["funding_source"] != "untracked":
            raise DomainError("此记录已有关联扣款账户")
        event = post_event(
            space,
            user,
            {
                "kind": "fund_funding",
                "account_id": body.get("cash_account_id"),
                "related_event_id": row.data["debit_event_id"],
                "economic_date": row.data["payment_date"],
                "description": "补充基金申购的实际资金来源",
            },
        )
        _update(
            row,
            user,
            funding_source="account",
            cash_account_id=body["cash_account_id"],
            funding_event_id=str(event.pk),
        )
    elif action == "paid" and row.data["status"] == "submitted":
        when = day(body.get("payment_date"))
        if when < day(row.data["application_date"]) or when > today(space):
            raise DomainError("扣款日须在申请日至今天之间")
        _debit(space, user, row, str(when))
    elif action in {"confirm", "estimate", "configure", "verify"} and row.data[
        "status"
    ] in {"paid", "estimated"}:
        if row.data["status"] == "estimated":
            if action != "verify":
                raise DomainError("已有推算份额，请核对实际确认记录")
            previous = get_obj(Event, space, row.data["confirmation_event_id"])
            reverse_event(space, user, previous, "以机构确认信息更正推算份额")
            _update(row, user, status="paid")
        values = _preferences(
            space,
            {
                **row.data,
                **{
                    k: body[k]
                    for k in ("fee_mode", "fee_value", "auto_estimate")
                    if k in body
                },
            },
        )
        _update(row, user, **values)
        with localcontext() as ctx:
            ctx.prec = 160
            if action in {"confirm", "verify"}:
                _confirm(
                    space,
                    user,
                    row,
                    body.get("quantity"),
                    body.get("price"),
                    body.get("confirmation_date"),
                )
            elif action == "estimate" or values["auto_estimate"]:
                estimate(space, user, row)
    else:
        raise DomainError("当前阶段不支持此操作，请刷新记录")
    return detail(row)


def scan_orders(space, user):
    rows = Resource.objects.filter(
        tenant=space, kind=KIND, data__status="paid"
    ).order_by("created_at")
    for row in rows:
        try:
            with transaction.atomic():
                estimate(space, user, row)
        except DomainError as exc:
            row.refresh_from_db()
            _update(row, user, note=exc.message, needs_review=True)


def entry_defaults(space, user, values=None):
    row = Resource.objects.filter(
        tenant=space, created_by=user, kind="entry_defaults"
    ).first()
    if values is None:
        return row.data if row else {}
    data = {key: values.get(key) for key in ("account_id", "currency", "category")}
    if row:
        _remember(row, user)
        row.data = {**row.data, values["kind"]: data}
        row.version += 1
        row.save(update_fields=["data", "version"])
    else:
        Resource.objects.create(
            tenant=space,
            created_by=user,
            kind="entry_defaults",
            data={values["kind"]: data},
        )


@transaction.atomic
def convert_fund(space, user, body):
    """Record an executed conversion: redeemed cash clears straight into transit."""
    Workspace.objects.select_for_update().get(pk=space.pk)
    if set(body) - {
        "instrument_id",
        "account_id",
        "target_instrument_id",
        "quantity",
        "price",
        "fee",
        "economic_date",
        "target_fee_mode",
        "target_fee_value",
        "auto_estimate",
    }:
        raise DomainError("基金转换含不支持的字段")
    source, account = _objects(space, body)
    target, _ = _objects(
        space,
        {
            "instrument_id": body.get("target_instrument_id"),
            "account_id": str(account.pk),
        },
    )
    if source.pk == target.pk:
        raise DomainError("请选择另一只目标基金")
    sale = record_trade(
        space,
        user,
        {
            "instrument_id": str(source.pk),
            "account_id": str(account.pk),
            "side": "sell",
            "quantity": body.get("quantity"),
            "price": body.get("price"),
            "fee": body.get("fee") or "0",
            "economic_date": body.get("economic_date"),
            "settled": True,
            "description": "基金转换：赎回款在机构内转申购",
        },
    )
    redeemed = sale["items"][0]
    amount = dec(redeemed["amount"]).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    result = save_order(
        space,
        user,
        {
            "instrument_id": str(target.pk),
            "account_id": str(account.pk),
            "amount": str(amount),
            "application_date": body.get("economic_date"),
            "status": "paid",
            "funding_source": "account",
            "fee_mode": body.get("target_fee_mode", "unknown"),
            "fee_value": body.get("target_fee_value") or "0",
            "auto_estimate": body.get("auto_estimate", False),
            "description": f"由 {source.name} 转入",
        },
    )
    order = get_obj(Resource, space, result["id"], kind=KIND)
    _update(
        order,
        user,
        conversion_redeem_id=redeemed["id"],
        conversion_settlement_id=sale["items"][1]["id"],
        conversion_source_name=source.name,
    )
    return detail(order)
