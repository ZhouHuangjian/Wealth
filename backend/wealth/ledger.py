"""Business commands create balanced, immutable facts in one transaction."""

import uuid
from collections import defaultdict
from decimal import Decimal

from django.db import transaction
from django.db.models import Q, Sum

from .common import (
    DomainError,
    audit,
    bump,
    day,
    dec,
    get_obj,
    money_round,
    record,
    serial,
)
from .models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    Occurrence,
    PositionMovement,
)

LIABILITIES = {"loan", "credit", "credit_card"}


def cash_code(account):
    return "liability" if account.kind in LIABILITIES else "cash"


def balance(space, account, code=None, as_of=None):
    rows = JournalLine.objects.filter(tenant=space, account=account)
    if code:
        rows = rows.filter(code=code)
    if as_of:
        rows = rows.filter(event__economic_date__lte=as_of)
    return rows.aggregate(v=Sum("amount"))["v"] or Decimal(0)


def position(space, account, instrument, as_of=None):
    rows = PositionMovement.objects.filter(
        tenant=space,
        account=account,
        instrument=instrument,
        event__reversal__isnull=True,
        event__reverses__isnull=True,
    )
    if as_of:
        rows = rows.filter(event__economic_date__lte=as_of)
    quantity = Decimal(0)
    cost = Decimal(0)
    for row in rows.order_by("event__economic_date", "event__created_at"):
        quantity += row.quantity
        cost = cost + row.cost if cost is not None and row.cost is not None else None
        if quantity == 0:
            cost = Decimal(0)
    return quantity, cost


def event_detail(event):
    result = record(event)
    result["amount"] = event.payload.get("amount")
    result["currency"] = event.payload.get("currency")
    result["account_id"] = event.payload.get("account_id")
    result["lines"] = [record(x) for x in event.lines.all()]
    result["movements"] = [record(x) for x in event.movements.all()]
    evidence = (
        event.active_evidence
        if hasattr(event, "active_evidence")
        else event.evidence_links.filter(active=True).select_related("record")
    )
    result["evidence"] = [
        {
            "record_id": str(x.record_id),
            "batch_id": str(x.record.batch_id),
            "row_number": x.record.row_number,
        }
        for x in evidence
    ]
    result["reversed"] = hasattr(event, "reversal")
    if (
        not result["reversed"]
        and not event.reverses_id
        and event.kind in {"fund_debit", "buy", "sell", "fund_redeem"}
    ):
        code = (
            "fund_transit"
            if event.kind == "fund_debit"
            else "payable"
            if event.kind == "buy"
            else "receivable"
        )
        remaining = JournalLine.objects.filter(
            Q(event=event) | Q(event__related=event),
            tenant_id=event.tenant_id,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
            code=code,
        ).aggregate(total=Sum("amount"))["total"] or Decimal(0)
        remaining = -remaining if code == "payable" else remaining
        if remaining > 0:
            result["next_stage"] = {
                "kind": "fund_confirm" if code == "fund_transit" else "settlement",
                "amount": str(remaining),
                "account_id": event.payload.get("holding_account_id")
                or event.payload.get("account_id"),
                "instrument_id": event.payload.get("instrument_id"),
            }
    return result


@transaction.atomic
def post_event(
    space,
    user,
    data,
    stage_key=None,
    *,
    _holding_funding=None,
    _fund_confirmation=None,
    _spot_confirmation=None,
    _untracked_funding=False,
):
    # Serialize writers in one space; source uniqueness also protects concurrent imports.
    from .models import Workspace

    Workspace.objects.select_for_update().get(pk=space.pk)
    data = dict(data)
    kind = data.get("kind")
    if (
        data.get("untracked_funding") or data.get("funding_source") == "untracked"
    ) and not _untracked_funding:
        raise DomainError("账外资金请通过基金买入入口记录")
    if _untracked_funding and kind != "fund_debit":
        raise DomainError("账外申购资金仅用于基金扣款")
    if (
        any(
            key in data
            for key in ("rounding_adjustment", "rounding_confirmed", "confirmed_amount")
        )
        and _fund_confirmation is None
    ):
        raise DomainError(
            "基金确认尾差须使用已核实定投补录入口", "fund_rounding_command_required"
        )
    if _fund_confirmation is not None and kind != "fund_confirm":
        raise DomainError("确认尾差仅用于基金份额确认")
    if any(
        key in data for key in ("trade_calculated_amount", "trade_rounding_adjustment")
    ):
        raise DomainError("交易尾差由买卖录入入口计算，不能直接填写")
    if _spot_confirmation is not None and kind not in {"buy", "sell", "fund_redeem"}:
        raise DomainError("交易金额确认仅适用于现货买卖")
    if (data.get("funding_mode") or data.get("funding_amount") not in (None, "")) and (
        kind != "opening" or _holding_funding is None
    ):
        raise DomainError(
            "机构资金拆分请使用已有持仓录入入口", "holding_funding_command_required"
        )
    a = get_obj(Account, space, data.get("account_id"))
    if a.archived:
        raise DomainError("账户已归档")
    b = (
        get_obj(Account, space, data["target_account_id"])
        if data.get("target_account_id")
        else None
    )
    inst = (
        get_obj(Instrument, space, data["instrument_id"])
        if data.get("instrument_id")
        else None
    )
    related = (
        get_obj(Event, space, data["related_event_id"])
        if data.get("related_event_id")
        else None
    )
    when = day(data.get("economic_date"))
    for involved in [a, b] if b else [a]:
        baseline = (
            Event.objects.filter(tenant=space, kind="opening", reversal__isnull=True)
            .filter(Q(lines__account=involved) | Q(movements__account=involved))
            .order_by("economic_date")
            .first()
        )
        if baseline and when < baseline.economic_date:
            raise DomainError(
                "早于账户期初的历史记录须先重建期初，不能叠加到已包含历史的余额",
                "before_opening",
                409,
            )
    currency = data.get("currency") or a.currency
    if currency != a.currency:
        raise DomainError("事件币种与账户币种不符，请使用对应币种子账户")
    if related and related.payload.get("currency") != currency:
        raise DomainError("原阶段与本阶段币种不一致")
    if related and hasattr(related, "reversal"):
        raise DomainError("原阶段已冲正，不能追加业务阶段")
    if related and when < related.economic_date:
        raise DomainError(
            "后续业务阶段日期不能早于原阶段；净值所属日请在行情记录中单独保存",
            "stage_date",
        )
    if b and b.currency != currency and kind != "fx":
        raise DomainError("跨币种操作请使用换汇事件")
    if b and b.archived:
        raise DomainError("目标账户已归档")
    if b and b.pk == a.pk:
        raise DomainError("来源与目标账户必须不同")
    if inst and inst.currency != currency:
        raise DomainError("产品与账户计价币种不一致")
    from .investments import is_derivative_instrument

    if inst and inst.kind == "index":
        raise DomainError(
            "指数仅用于市场观察，请选择可交易的基金或 ETF 记账",
            "index_observation_only",
        )

    if (
        inst
        and is_derivative_instrument(inst)
        and kind
        in {
            "opening",
            "buy",
            "sell",
            "fund_confirm",
            "fund_redeem",
            "reinvest",
            "position_transfer",
            "split",
        }
    ):
        raise DomainError(
            "期货期权请录入机构权益快照、覆盖范围与入出金；不能套用股票或基金的全额成本分录",
            "derivative_snapshot_required",
        )
    amount = dec(data.get("amount", "0"), nonnegative=True)
    supplied_amount = amount
    fee = dec(data.get("fee", "0"), nonnegative=True)
    tax = dec(data.get("tax", "0"), nonnegative=True)
    if tax and kind not in {"buy", "sell", "fund_redeem", "dividend"}:
        raise DomainError("该业务不接受税额字段，请按实际业务拆分记录")
    if fee and kind not in {
        "transfer",
        "fx",
        "fund_confirm",
        "buy",
        "sell",
        "fund_redeem",
        "reinvest",
        "dividend",
        "repayment",
        "repayment_allocate",
        "property_purchase",
    }:
        raise DomainError("该业务不接受费用字段，请单独记录实际费用")
    qty = dec(data.get("quantity", "0"), nonnegative=True, places=18)
    price = dec(data.get("price", "0"), nonnegative=True, places=18)
    lines = []
    moves = []

    def line(account, code, value, cc=None, instrument=None):
        value = money_round(value)
        dec(value)
        if value:
            lines.append((account, code, value, cc or currency, instrument))

    def need_target():
        if b is None:
            raise DomainError("请选择目标账户")

    def need_inst():
        if not inst or qty <= 0:
            raise DomainError("请选择产品并提供大于零的份额")
        later = PositionMovement.objects.filter(
            tenant=space,
            account=a,
            instrument=inst,
            event__economic_date__gt=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        if _fund_confirmation is not None:
            # The dedicated importer certifies these IDs are independent,
            # additive purchases from this same immutable plan-period registry.
            allowed = _fund_confirmation.get("allow_later_event_ids", [])
            later = later.exclude(
                event_id__in=allowed,
                event__kind="fund_confirm",
                event__payload__dca_import_plan_id=_fund_confirmation.get("plan_id"),
            )
        if later.exists():
            raise DomainError(
                "存在更晚的持仓事实；历史补录须先按时间顺序冲正受影响事项后重放，不能直接改写成本",
                "historical_dependency",
                409,
            )

    def pool():
        q, c = position(space, a, inst)
        if qty > q:
            raise DomainError("卖出或转出份额超过已确认持仓")
        return q, c

    def stage_remaining(code):
        if not related:
            raise DomainError("请关联已确认的原始阶段事件")
        if hasattr(related, "reversal"):
            raise DomainError("原始事项已冲正")
        stages = Event.objects.filter(
            Q(pk=related.pk) | Q(related=related),
            tenant=space,
            reversal__isnull=True,
            reverses__isnull=True,
        )
        return JournalLine.objects.filter(
            tenant=space, event__in=stages, code=code
        ).aggregate(v=Sum("amount"))["v"] or Decimal(0)

    def confirmed_spot_amount(calculated):
        if _spot_confirmation is None:
            return calculated
        confirmed = dec(_spot_confirmation, nonnegative=True, places=2)
        if confirmed <= 0 or abs(confirmed - calculated) > Decimal("0.01"):
            raise DomainError(
                "实收实付金额与成交计算结果的差异超过一分钱，请核对费用和价格"
            )
        data.update(
            trade_calculated_amount=str(calculated),
            trade_rounding_adjustment=str(confirmed - calculated),
        )
        return confirmed

    if kind == "opening":
        if data.get("opening_market_value") not in (None, ""):
            dec(data["opening_market_value"], nonnegative=True)
            if not inst or qty <= 0:
                raise DomainError("持仓期初市值须对应具体产品及已确认份额")
        exists = (
            JournalLine.objects.filter(tenant=space, account=a).exists()
            or PositionMovement.objects.filter(tenant=space, account=a).exists()
        )
        if exists and (amount or not (inst and qty)):
            raise DomainError("账户已建账，不能重复录现金期初；请使用有依据的更正流程")
        if (
            inst
            and PositionMovement.objects.filter(
                tenant=space,
                account=a,
                instrument=inst,
                event__reversal__isnull=True,
                event__reverses__isnull=True,
            ).exists()
        ):
            raise DomainError("该产品已有持仓记录，不能重复录期初")
        value = -amount if a.kind in LIABILITIES else amount
        line(a, cash_code(a), value)
        line(None, "equity", -value)
        if amount == 0 and not inst:
            # A user-confirmed zero opening is a balance observation. Retain
            # its account/date without creating income or changing any amount.
            lines.extend(
                [
                    (a, cash_code(a), Decimal(0), currency, None),
                    (None, "equity", Decimal(0), currency, None),
                ]
            )
        if inst and qty:
            cost = (
                dec(data["cost"], nonnegative=True)
                if data.get("cost") not in (None, "")
                else None
            )
            moves.append((a, inst, qty, cost))
            if cost is not None:
                line(a, "investment", cost, instrument=inst)
                line(None, "equity", -cost)
            if _holding_funding is not None:
                from .institution_funding import available_funding_cash

                funded = dec(_holding_funding["required"], nonnegative=True)
                if (
                    amount != 0
                    or cost is None
                    or _holding_funding.get("mode") != "allocate"
                    or dec(data.get("funding_amount"), nonnegative=True) != funded
                    or dec(data.get("opening_market_value"), nonnegative=True) != funded
                ):
                    raise DomainError("机构持仓拆分金额与已核对市值不一致")
                if available_funding_cash(space, a, when) < funded:
                    raise DomainError(
                        "机构现金不足，持仓拆分未扣款", "insufficient_institution_cash"
                    )
                # Cost remains the original acquisition cost. Allocating market
                # value out of the institution total cannot become spending or
                # erase the holding's pre-existing unrealized gain.
                line(a, "cash", -funded)
                line(None, "equity", funded)
    elif kind in {"expense", "income", "refund"}:
        if amount <= 0:
            raise DomainError("金额必须大于零")
        if kind == "refund":
            if not related or related.kind != "expense":
                raise DomainError("退款须关联原消费")
            refunded = sum(
                (
                    dec(e.payload.get("amount", "0"))
                    for e in Event.objects.filter(
                        tenant=space,
                        related=related,
                        kind="refund",
                        reversal__isnull=True,
                    )
                ),
                Decimal(0),
            )
            if refunded + amount > dec(related.payload["amount"]):
                raise DomainError("累计退款超过原消费金额")
        sign = -1 if kind == "expense" else 1
        line(a, cash_code(a), sign * amount)
        line(None, "income" if kind == "income" else "expense", -sign * amount)
    elif kind == "transfer":
        need_target()
        if amount <= 0 or fee > amount:
            raise DomainError("转账金额或费用不正确")
        line(a, cash_code(a), -amount)
        line(b, cash_code(b), amount - fee)
        line(None, "expense", fee)
    elif kind == "fx":
        need_target()
        received = dec(data.get("received_amount"), nonnegative=True)
        if a.currency == b.currency or amount <= 0 or received <= 0:
            raise DomainError("换汇须为两种不同币种且金额大于零")
        line(a, "cash", -amount - fee)
        line(None, "fx_bridge", amount)
        line(None, "expense", fee)
        line(b, "cash", received, b.currency)
        line(None, "fx_bridge", -received, b.currency)
    elif kind == "fund_debit":
        if amount <= 0:
            raise DomainError("扣款金额必须大于零")
        if _untracked_funding:
            data.update(untracked_funding=True, funding_source="untracked")
            line(None, "equity", -amount)
        else:
            line(a, "cash", -amount)
        line(a, "fund_transit", amount)
    elif kind == "fund_funding":
        if (
            not related
            or related.kind != "fund_debit"
            or not related.payload.get("untracked_funding")
        ):
            raise DomainError("只能为账外资金申购补充实际扣款账户")
        if related.following.filter(
            kind="fund_funding", reversal__isnull=True, reverses__isnull=True
        ).exists():
            raise DomainError("该申购已关联扣款账户")
        from .institution_funding import available_funding_cash

        amount = dec(related.payload["amount"])
        if available_funding_cash(space, a, when) < amount:
            raise DomainError("实际扣款账户余额不足，请核对账户或期初")
        line(a, "cash", -amount)
        line(None, "equity", amount)
    elif kind == "fund_confirm":
        need_inst()
        amount = money_round(qty * price + fee)
        if _fund_confirmation is not None:
            confirmed = dec(
                _fund_confirmation.get("confirmed_amount"), nonnegative=True
            )
            adjustment = dec(_fund_confirmation.get("rounding_adjustment", "0"))
            limit = min(
                Decimal(1),
                price * Decimal("0.01") + Decimal("0.01"),
                confirmed * Decimal("0.01"),
            )
            if (
                price <= 0
                or confirmed <= 0
                or fee >= confirmed
                or amount + adjustment != confirmed
                or abs(adjustment) > limit
                or adjustment
                and data.get("rounding_confirmed") is not True
                or not related
                or confirmed != dec(related.payload["amount"])
                or stage_remaining("fund_transit") != confirmed
            ):
                raise DomainError(
                    "实际确认金额、尾差或剩余在途不符合已核实补录条件",
                    "fund_confirmation_difference",
                )
            data.update(
                confirmed_amount=str(confirmed),
                rounding_adjustment=str(adjustment),
                confirmation_calculated_amount=str(amount),
            )
            amount = confirmed
        if (
            not related
            or related.kind != "fund_debit"
            or amount > stage_remaining("fund_transit")
        ):
            raise DomainError("确认金额超过该申购剩余在途或缺原扣款")
        if related.payload.get("instrument_id") and related.payload[
            "instrument_id"
        ] != str(inst.pk):
            raise DomainError("份额确认产品与原申购基金不一致")
        source = get_obj(Account, space, related.payload["account_id"])
        target = b or a
        line(source, "fund_transit", -amount)
        line(target, "investment", amount, instrument=inst)
        moves.append((target, inst, qty, amount))
    elif kind == "fund_refund":
        if (
            not related
            or related.kind != "fund_debit"
            or amount <= 0
            or amount > stage_remaining("fund_transit")
        ):
            raise DomainError("退款须在该申购未确认金额内")
        source = get_obj(Account, space, related.payload["account_id"])
        line(source, "fund_transit", -amount)
        line(a, "cash", amount)
    elif kind in {"buy", "sell", "fund_redeem", "reinvest"}:
        need_inst()
        if price <= 0:
            raise DomainError("成交价格必须大于零")
        gross = money_round(qty * price)
        if kind in {"buy", "reinvest"}:
            amount = confirmed_spot_amount(gross + fee + tax)
            line(a, "investment", amount, instrument=inst)
            if kind == "reinvest":
                line(None, "investment_income", -gross)
                line(a, "cash", -fee)
            else:
                line(a, "payable", -amount)
            moves.append((a, inst, qty, amount))
        else:
            q, c = pool()
            released = money_round(c * qty / q) if c is not None else None
            amount = confirmed_spot_amount(gross - fee - tax)
            if amount < 0:
                raise DomainError("费用超过成交总额")
            line(a, "receivable", amount)
            if released is None:
                line(None, "unresolved_cost", -amount)
                data["cost_unknown"] = True
            else:
                line(a, "investment", -released, instrument=inst)
                line(None, "realized", released - amount)
            moves.append((a, inst, -qty, -released if released is not None else None))
    elif kind == "settlement":
        if not related or related.kind not in {"buy", "sell", "fund_redeem"}:
            raise DomainError("交收须关联实际成交或赎回确认")
        source = get_obj(Account, space, related.payload["account_id"])
        if related.kind == "buy":
            remaining = -stage_remaining("payable")
            amount = amount or remaining
            if amount <= 0 or amount > remaining:
                raise DomainError("交收金额超过未交收应付款")
            line(source, "payable", amount)
            line(a, "cash", -amount)
        else:
            remaining = stage_remaining("receivable")
            amount = amount or remaining
            if amount <= 0 or amount > remaining:
                raise DomainError("到账金额超过未交收应收款")
            line(source, "receivable", -amount)
            line(b or a, "cash", amount)
    elif kind == "dividend":
        if amount <= 0 or tax + fee > amount:
            raise DomainError("股息金额、费用或预扣税不正确")
        line(a, "cash", amount - tax - fee)
        line(None, "investment_income", -amount)
        line(None, "tax", tax)
        line(None, "expense", fee)
    elif kind == "split":
        if not inst:
            raise DomainError("请选择产品")
        if PositionMovement.objects.filter(
            tenant=space,
            account=a,
            instrument=inst,
            event__economic_date__gt=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        ).exists():
            raise DomainError(
                "存在更晚的持仓事实，请先处理历史依赖", "historical_dependency", 409
            )
        ratio = dec(data.get("ratio"), nonnegative=True, places=18)
        q, c = position(space, a, inst)
        if ratio <= 0 or q <= 0:
            raise DomainError("拆分比例或现有持仓不正确")
        moves.append((a, inst, q * (ratio - 1), Decimal(0)))
    elif kind == "position_transfer":
        need_target()
        need_inst()
        q, c = pool()
        cost = money_round(c * qty / q) if c is not None else None
        if cost is not None:
            line(a, "investment", -cost, instrument=inst)
            line(b, "investment", cost, instrument=inst)
        else:
            data["cost_unknown"] = True
        moves.extend(
            [(a, inst, -qty, -cost if cost is not None else None), (b, inst, qty, cost)]
        )
    elif kind in {"repayment", "repayment_allocate"}:
        need_target()
        if b.kind not in LIABILITIES:
            raise DomainError("目标必须是贷款或信用卡账户")
        if kind == "repayment" and data.get("principal") in (None, ""):
            if amount <= 0:
                raise DomainError("实际扣款金额必须大于零")
            line(a, "cash", -amount)
            line(a, "loan_clearing", amount)
        else:
            principal = dec(data.get("principal"), nonnegative=True)
            interest = dec(data.get("interest", "0"), nonnegative=True)
            total = principal + interest + fee
            if amount and total != amount:
                raise DomainError("本金、利息、费用合计必须等于实际扣款")
            amount = total
            if principal > -balance(space, b, "liability"):
                raise DomainError("还款本金超过未还负债")
            if kind == "repayment_allocate":
                if (
                    not related
                    or related.kind != "repayment"
                    or total > stage_remaining("loan_clearing")
                ):
                    raise DomainError("拆分金额超过原扣款待分配余额")
                if related.payload.get("target_account_id") != str(b.pk):
                    raise DomainError("拆分目标与原扣款贷款不一致")
                source = get_obj(Account, space, related.payload["account_id"])
                line(source, "loan_clearing", -total)
            else:
                line(a, "cash", -total)
            line(b, "liability", principal)
            line(None, "expense", interest + fee)
    elif kind in {"lend", "borrow", "receivable_collect"}:
        need_target()
        if amount <= 0:
            raise DomainError("本金必须大于零")
        if kind == "borrow":
            line(a, "cash", amount)
            line(b, "liability", -amount)
        elif kind == "lend":
            line(a, "cash", -amount)
            line(b, "receivable", amount)
        else:
            line(a, "cash", amount)
            line(b, "receivable", -amount)
    elif kind == "property_purchase":
        need_target()
        if b.kind != "property":
            raise DomainError("请选择房产资产账户")
        loan = get_obj(Account, space, data.get("liability_account_id"))
        if loan.currency != currency:
            raise DomainError("贷款与房产购入币种不一致，请记录真实换汇及对应币种贷款")
        mortgage = dec(data.get("loan_amount"), nonnegative=True)
        if amount <= 0 or mortgage > amount or loan.kind != "loan":
            raise DomainError("房价或贷款不正确")
        line(b, "property", amount)
        line(loan, "liability", -mortgage)
        line(a, "cash", -(amount - mortgage + fee))
        line(None, "expense", fee)
    elif kind == "unclassified":
        if amount <= 0:
            raise DomainError("金额必须大于零")
        sign = 1 if data.get("direction") == "in" else -1
        line(a, "cash", sign * amount)
        line(a, "unclassified", -sign * amount)
    else:
        raise DomainError("不支持的业务类型")
    if (
        kind in {"buy", "sell", "fund_confirm", "fund_redeem", "reinvest"}
        and supplied_amount
        and supplied_amount != amount
    ):
        raise DomainError(
            f"核对金额与份额、价格、税费计算的合计 {format(amount, 'f')} 不一致",
            "amount_mismatch",
        )
    sums = defaultdict(Decimal)
    for _, _, v, cc, _ in lines:
        sums[cc] += v
    if any(v != 0 for v in sums.values()):
        raise DomainError("按币种分录不平衡")
    if not lines and not moves:
        raise DomainError("本事件没有有效金额或持仓变化")
    moves = [
        (
            account,
            instrument,
            dec(quantity.quantize(Decimal("0.000000000000000001")), places=18),
            cost,
        )
        for account, instrument, quantity, cost in moves
    ]
    data.update(
        amount=str(amount),
        currency=currency,
        account_id=str(a.pk),
        fee=str(fee),
        tax=str(tax),
    )
    rev = bump(space, user)
    event = Event.objects.create(
        tenant=space,
        created_by=user,
        kind=kind,
        economic_date=when,
        description=data.get("description", ""),
        category=data.get("category", ""),
        payload=serial(data),
        operation_id=related.operation_id if related else uuid.uuid4(),
        related=related,
        stage_key=stage_key or f"{space.pk}:{uuid.uuid4()}",
        revision=rev,
    )
    JournalLine.objects.bulk_create(
        [
            JournalLine(
                tenant=space,
                created_by=user,
                event=event,
                account=x,
                code=c,
                amount=v,
                currency=cc,
                instrument=i,
            )
            for x, c, v, cc, i in lines
        ]
    )
    PositionMovement.objects.bulk_create(
        [
            PositionMovement(
                tenant=space,
                created_by=user,
                event=event,
                account=x,
                instrument=i,
                quantity=q,
                cost=c,
            )
            for x, i, q, c in moves
        ]
    )
    occurrence_id = data.get("occurrence_id")
    if occurrence_id:
        occ = get_obj(Occurrence, space, occurrence_id)
        from .planning import confirm_occurrence

        confirm_occurrence(space, user, occ, event.pk)
    if data.get("reservation_id"):
        from .reservations import sync_reservation_payments

        sync_reservation_payments(space, user)
    audit(space, user, "event.posted", event, {"kind": kind, "revision": rev})
    return event


@transaction.atomic
def reverse_event(space, user, event, reason):
    from .models import Workspace

    Workspace.objects.select_for_update().get(pk=space.pk)
    if not str(reason).strip():
        raise DomainError("冲正必须填写原因")
    if hasattr(event, "reversal"):
        raise DomainError("该事件已冲正", "conflict", 409)
    if event.reverses_id:
        raise DomainError("请新建替代事项，不对冲正再次冲正")
    if event.following.filter(reversal__isnull=True, reverses__isnull=True).exists():
        raise DomainError("存在后续阶段，请先处理依赖", "dependency", 409)
    for m in event.movements.all():
        if PositionMovement.objects.filter(
            tenant=space,
            account=m.account,
            instrument=m.instrument,
            event__created_at__gt=event.created_at,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        ).exists():
            raise DomainError("已有后续持仓变动，请按逆序处理依赖", "dependency", 409)
    if event.kind == "transfer" and event.payload.get("holding_funding_transfer"):
        from .institution_funding import available_funding_cash

        target = get_obj(Account, space, event.payload.get("target_account_id"))
        amount = dec(event.payload["amount"], nonnegative=True)
        if available_funding_cash(space, target, event.economic_date) < amount:
            raise DomainError(
                "机构补入资金已有后续使用或冻结，请先处理后续记录后再撤销补资",
                "funding_reversal_dependency",
                409,
            )
    rev = bump(space, user)
    reversal = Event.objects.create(
        tenant=space,
        created_by=user,
        kind="reversal",
        economic_date=event.economic_date,
        description=reason,
        category=event.category,
        payload={"original_event_id": str(event.pk), "reason": reason},
        operation_id=event.operation_id,
        stage_key=f"{space.pk}:reverse:{event.pk}",
        reverses=event,
        revision=rev,
    )
    JournalLine.objects.bulk_create(
        [
            JournalLine(
                tenant=space,
                created_by=user,
                event=reversal,
                account=l.account,
                code=l.code,
                currency=l.currency,
                amount=-l.amount,
                instrument=l.instrument,
            )
            for l in event.lines.all()
        ]
    )
    PositionMovement.objects.bulk_create(
        [
            PositionMovement(
                tenant=space,
                created_by=user,
                event=reversal,
                account=m.account,
                instrument=m.instrument,
                quantity=-m.quantity,
                cost=-m.cost if m.cost is not None else None,
            )
            for m in event.movements.all()
        ]
    )
    Occurrence.objects.filter(tenant=space, event=event).update(
        event=None, status="pending"
    )
    from .reservations import sync_reservation_payments, unlink_reversed_goal_payment

    unlink_reversed_goal_payment(space, user, event)
    sync_reservation_payments(space, user)
    audit(
        space,
        user,
        "event.reversed",
        event,
        {"reason": reason, "reversal": str(reversal.pk)},
    )
    return reversal
