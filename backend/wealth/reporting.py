from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Q, Sum

from .common import catalog_queryset
from .common import day, dec, record, serial
from .ledger import LIABILITIES, cash_code, position
from .models import (
    Account,
    Event,
    FxRate,
    Instrument,
    JournalLine,
    Occurrence,
    PositionMovement,
    Price,
    Resource,
)

ASSET_CODES = {
    "cash",
    "investment",
    "property",
    "fund_transit",
    "receivable",
    "payable",
    "liability",
}
FORMAL_PRICE_KINDS = {
    "official_nav",
    "close",
    "official_close",
    "settlement",
    "institution_settlement",
}


def formal_price(space, instrument, when):
    """Trade observations and reference estimates are not closing valuations."""
    return (
        Price.objects.filter(
            tenant=space,
            instrument=instrument,
            economic_date__lte=when,
            kind__in=FORMAL_PRICE_KINDS,
        )
        .order_by("-economic_date", "-created_at")
        .first()
    )


def fx(space, currency, target, when):
    if currency == target:
        return Decimal(1)
    direct = (
        FxRate.objects.filter(
            tenant=space,
            base=currency,
            quote=target,
            economic_date__lte=when,
            purpose="valuation",
        )
        .order_by("-economic_date", "-created_at")
        .first()
    )
    if direct:
        return direct.rate
    inverse = (
        FxRate.objects.filter(
            tenant=space,
            base=target,
            quote=currency,
            economic_date__lte=when,
            purpose="valuation",
        )
        .order_by("-economic_date", "-created_at")
        .first()
    )
    return Decimal(1) / inverse.rate if inverse else None


def _position_entry_basis(space, account, instrument, when):
    """Describe recorded source evidence without changing value or price basis.

    This is provenance of active position records, not a claim to trace units
    remaining in an average-cost position back to a particular purchase lot.
    """
    sources = set()
    automatic = False
    movements = PositionMovement.objects.filter(
        tenant=space,
        account=account,
        instrument=instrument,
        event__economic_date__lte=when,
        event__reversal__isnull=True,
        event__reverses__isnull=True,
    ).select_related("event")
    for movement in movements:
        payload = movement.event.payload
        expected_stage = (
            f"{space.pk}:dca:{payload.get('dca_import_plan_id')}:"
            f"{payload.get('dca_import_date')}:confirm"
        )
        if movement.event.kind == "fund_confirm" and (
            movement.event.stage_key == expected_stage
            or movement.event.stage_key.startswith(
                f"{space.pk}:fund-order:{payload.get('fund_order_id')}:confirm:"
            )
        ):
            automatic = automatic or payload.get("automatic_estimate") is True
            for field in ("entry_basis", "debit_entry_basis"):
                sources.add(
                    "preview_confirmed"
                    if payload.get(field) == "preview_confirmed"
                    else "institution"
                )
        else:
            sources.add("institution")
    if "preview_confirmed" not in sources:
        return {"contains_preview_entries": False}
    return {
        "contains_preview_entries": True,
        "entry_basis": "mixed" if "institution" in sources else "preview_confirmed",
        "contains_automatic_estimates": automatic,
        "entry_basis_label": "含自动推算" if automatic else "含按预览补录",
        "entry_basis_description": "持仓含按计划自动推算的扣款或份额，尚未按机构成交资料核实；不会向银行或基金平台发起交易。"
        if automatic
        else "持仓记录包含按预览补录的扣款或份额，未全部按机构成交资料核实；行情来源与此标记分开显示",
    }


def positions(space, when=None):
    from .portfolio import _snapshot_account

    when = day(when)
    result = []
    pairs = (
        PositionMovement.objects.filter(
            tenant=space,
            event__economic_date__lte=when,
            account_id__in=catalog_queryset(Account, space).values("pk"),
            instrument_id__in=catalog_queryset(Instrument, space).values("pk"),
        )
        .values_list("account_id", "instrument_id")
        .distinct()
    )
    for aid, iid in pairs:
        account = Account.objects.get(tenant=space, pk=aid)
        instrument = Instrument.objects.get(tenant=space, pk=iid)
        q, c = position(space, account, instrument, when)
        if q == 0:
            continue
        price = formal_price(space, instrument, when)
        from .investments import manual_position_valuation

        manual = manual_position_valuation(space, account, instrument, q, when, price)
        value = manual["value"] if manual else q * price.value if price else None
        result.append(
            {
                "id": f"{aid}:{iid}",
                "account_id": str(aid),
                "account_name": account.name,
                "instrument_id": str(iid),
                "name": instrument.name,
                "code": instrument.code,
                "market": instrument.market,
                "currency": instrument.currency,
                "quantity": q,
                "cost": c,
                "total_cost": c,
                "average_cost": c / q if c is not None else None,
                "kind": instrument.kind,
                "specification": instrument.specification,
                "price": manual["value"] / q
                if manual
                else price.value
                if price
                else None,
                "price_date": manual["date"]
                if manual
                else price.economic_date
                if price
                else None,
                "market_value": value,
                "unrealized_profit": value - c
                if value is not None and c is not None
                else None,
                "status": ("stale" if (when - manual["date"]).days > 7 else "manual")
                if manual
                else "unknown"
                if not price
                else ("stale" if (when - price.economic_date).days > 7 else "official"),
                "cost_status": "unknown" if c is None else "known",
                "contributes": not _snapshot_account(account),
                "price_kind": "manual_holding"
                if manual
                else price.kind
                if price
                else None,
                "price_source": "manual" if manual else price.source if price else None,
                "valuation_basis": manual["basis"]
                if manual
                else "formal"
                if price
                else None,
                "valuation_recorded_as_of": manual["recorded_as_of"]
                if manual
                else None,
                "valuation_observed_at": manual["observed_at"] if manual else None,
                **_position_entry_basis(space, account, instrument, when),
            }
        )
        from .holding_checks import apply_holding_check, read_holding_check

        result[-1] = apply_holding_check(
            result[-1], read_holding_check(space, account, instrument, q, when)
        )
    return result


def overview(space, when=None, currency=None, account_ids=None):
    from .portfolio import _institution_value, _snapshot_account
    from .pending_purchases import PendingPurchases

    when = day(when)
    currency = currency or space.base_currency
    pending = PendingPurchases(space, when)
    gaps = []
    items = []
    total_assets = Decimal(0)
    total_liabilities = Decimal(0)
    cash = Decimal(0)
    reserved = Decimal(0)
    holdings = positions(space, when)
    by_account = defaultdict(list)
    for p in holdings:
        by_account[p["account_id"]].append(p)
    accounts = catalog_queryset(Account, space).filter(tenant=space)
    if account_ids is not None:
        accounts = accounts.filter(pk__in=account_ids)
    selected = {str(a.pk) for a in accounts}
    holdings = [p for p in holdings if p["account_id"] in selected]
    for a in accounts:
        parts = {
            r["code"]: r["value"]
            for r in JournalLine.objects.filter(
                tenant=space, account=a, event__economic_date__lte=when
            )
            .values("code")
            .annotate(value=Sum("amount"))
        }
        value = sum(
            (v for k, v in parts.items() if k in ASSET_CODES and k != "investment"),
            Decimal(0),
        )
        available = (
            max(Decimal(0), parts.get("cash", Decimal(0)) - a.frozen)
            if a.kind not in LIABILITIES
            else Decimal(0)
        )
        status = "complete"
        as_of = when
        adjustment = Decimal(0)
        value_basis = "ledger_and_holdings"
        availability = {}
        from .option_positions import has_option_reference

        if not _snapshot_account(a) and has_option_reference(
            space, account_id=a.pk, when=when, active_only=True
        ):
            gaps.append(
                f"{a.name} 有期权持仓参考，尚缺包含期权的机构总权益；参考市值不重复计入资产"
            )
            status = "partial"
        for p in by_account[str(a.pk)]:
            if not _snapshot_account(a):
                if p["market_value"] is None:
                    gaps.append(f"{a.name} / {p['name']} 缺正式价格")
                    status = "partial"
                else:
                    value += p["market_value"]
                if p.get("valuation_status", p["status"]) == "stale":
                    gaps.append(f"{p['name']} 价格陈旧（{p['price_date']}）")
                    status = "partial"
                if p["cost_status"] == "unreconciled":
                    gaps.append(
                        f"{a.name} / {p['name']} 份额、成本或收益范围待核对；资产金额保留原记录"
                    )
                    status = "partial"
        if parts.get("loan_clearing", 0) or parts.get("unclassified", 0):
            gaps.append(f"{a.name} 有待分配清算，净资产不完整")
            status = "partial"
        if _snapshot_account(a):
            institution = _institution_value(space, a, when)
            availability = {
                key: value
                for key, value in institution.items()
                if key.startswith("available_")
            }
            value_basis = institution["basis"]
            gaps.extend(institution["gaps"])
            if institution["local_value"] is None:
                value = None
                available = Decimal(0)
                status = "unknown"
            else:
                value = institution["local_value"]
                as_of = institution["date"]
                adjustment = institution["roll_forward"]
                if institution["gaps"]:
                    status = "partial"
                raw_available = institution["reported_available"]
                if "available" in institution:
                    available = institution["available"] or Decimal(0)
                    missing_available = institution["available"] is None
                else:
                    available = (
                        dec(raw_available)
                        if raw_available not in (None, "")
                        and not institution["gaps"]
                        and as_of == when
                        else Decimal(0)
                    )
                    missing_available = (
                        raw_available in (None, "")
                        or institution["gaps"]
                        or as_of < when
                    )
                if missing_available:
                    gaps.append(f"{a.name} 缺最新可提取金额")
        rate = fx(space, a.currency, currency, when)
        # An empty foreign-currency account has no amount requiring conversion.
        needs_rate = (value is not None and value != 0) or available != 0
        converted = (
            None
            if value is None
            else value * rate
            if rate is not None
            else (Decimal(0) if not needs_rate else None)
        )
        if rate is None and needs_rate:
            gaps.append(f"{a.currency}/{currency} 缺汇率")
            status = "partial"
        elif converted is not None:
            if converted >= 0:
                total_assets += converted
            else:
                total_liabilities -= converted
            if available and availability.get("available_eligible", True):
                cash += available * rate
        item = record(a)
        item.update(
            balance=parts.get(cash_code(a), Decimal(0)),
            value=value,
            base_value=converted,
            available=available,
            as_of=as_of,
            status=status,
            roll_forward=adjustment,
            value_basis=value_basis,
            pending_purchases=pending.summary(
                currency=a.currency, source_account_id=a.pk
            ),
            **availability,
        )
        items.append(item)
    from .planning import _active_reservation

    for r in Resource.objects.filter(tenant=space, kind="reservations"):
        if (
            not _active_reservation(space, r.data)
            or r.data.get("account_id") not in selected
        ):
            continue
        rate = fx(space, r.data.get("currency", space.base_currency), currency, when)
        amount = max(
            Decimal(0),
            dec(r.data.get("amount", "0"))
            - dec(r.data.get("linked_freeze_amount", "0")),
        )
        if rate is not None:
            reserved += amount * rate
        else:
            gaps.append("预留资金缺折算汇率")
    todos = []
    for o in Occurrence.objects.filter(
        tenant=space, due_date__lte=when, status__in=["scheduled", "pending"]
    ).select_related("plan")[:30]:
        todos.append(
            {
                "id": str(o.pk),
                "title": o.plan.data.get("name", "到期事项"),
                "due_date": str(o.due_date),
                "amount": str(o.amount),
                "currency": o.currency,
                "status": o.status,
                "kind": "occurrence",
            }
        )
    for r in Resource.objects.filter(tenant=space, kind="todos")[:30]:
        if r.data.get("status") not in {"done", "ignored"}:
            todos.append(record(r))
    for order in Resource.objects.filter(
        tenant=space,
        kind="fund_orders",
        data__status__in=["submitted", "paid", "estimated"],
    )[:30]:
        todos.append(
            {
                "id": str(order.pk),
                "title": order.data.get("instrument_name", "基金申购")
                + " · "
                + order.data.get("note", "待核实"),
                "due_date": order.data.get("application_date"),
                "amount": order.data.get("amount"),
                "currency": order.data.get("currency"),
                "status": order.data["status"],
                "kind": "fund_order",
            }
        )
    return serial(
        {
            "net_assets": total_assets - total_liabilities,
            "total_assets": total_assets,
            "total_liabilities": total_liabilities,
            "available_cash": cash,
            "reserved": reserved,
            "allocatable": cash - reserved,
            "currency": currency,
            "completeness": "partial" if gaps else "complete",
            "gaps": list(dict.fromkeys(gaps)),
            "accounts": items,
            "pending_purchases": pending.summary(
                currency=currency,
                items=[
                    row for row in pending.items if row["source_account_id"] in selected
                ],
            ),
            "positions": holdings,
            "todos": todos,
            "data_revision": space.revision,
            "as_of": when,
            "method_version": "v2-weighted-cost-including-buy-fees",
            "calculation_version": "account-equity-v24",
            "is_demo": False,
        }
    )


def _boundary_flow(space, event, selected, gaps):
    """Value only capital crossing this portfolio, excluding internal fees.

    A security transferred between portfolios crosses at formal market value;
    management acquisition cost continues unchanged in the ledger.
    """
    source = str(event.payload.get("account_id", ""))
    target = str(event.payload.get("target_account_id", ""))
    if event.kind == "opening" and event.payload.get("funding_mode") == "allocate":
        # Existing institution wealth is itemized at its checked market value;
        # any top-up is a separate, linked transfer across account boundaries.
        return Decimal(0)
    if (
        event.kind in {"transfer", "fx", "position_transfer"}
        and source in selected
        and target in selected
    ):
        return Decimal(0)
    delta = Decimal(0)
    for line in event.lines.filter(account_id__in=selected, code__in=ASSET_CODES):
        if event.kind in {"position_transfer", "opening"} and line.code == "investment":
            continue
        if not line.amount:
            continue
        rate = fx(space, line.currency, space.base_currency, event.economic_date)
        if rate is None:
            gaps.append("现金流发生日缺汇率")
        else:
            delta += line.amount * rate
    if event.kind in {"position_transfer", "opening"}:
        movements = event.movements.filter(account_id__in=selected).select_related(
            "instrument"
        )
        for movement in movements:
            if not movement.quantity:
                continue
            opening_value = event.payload.get("opening_market_value")
            if event.kind == "opening" and opening_value not in (None, ""):
                rate = fx(
                    space,
                    movement.instrument.currency,
                    space.base_currency,
                    event.economic_date,
                )
                if rate is None:
                    gaps.append("持仓资金流发生日缺汇率")
                else:
                    delta += dec(opening_value, nonnegative=True) * rate
                continue
            price = formal_price(space, movement.instrument, event.economic_date)
            rate = fx(
                space,
                movement.instrument.currency,
                space.base_currency,
                event.economic_date,
            )
            if not price:
                gaps.append(f"{movement.instrument.name} 转入或期初日缺正式价格")
                continue
            if (event.economic_date - price.economic_date).days > 7:
                gaps.append(f"{movement.instrument.name} 资金流估值价格陈旧")
            if rate is None:
                gaps.append("持仓资金流发生日缺汇率")
                continue
            delta += movement.quantity * price.value * rate
    if event.kind in {"transfer", "fx"} and source in selected:
        fee = Decimal(event.payload.get("fee", "0"))
        if fee:
            rate = fx(
                space,
                event.payload["currency"],
                space.base_currency,
                event.economic_date,
            )
            if rate is None:
                gaps.append("资金流费用发生日缺汇率")
            else:
                delta += fee * rate
    return delta


def performance(space, start=None, end=None, account_ids=None):
    from finance_math import xirr

    from .common import DomainError

    end = day(end)
    investment_accounts = list(
        catalog_queryset(Account, space)
        .filter(tenant=space, kind__in=["fund", "broker", "securities", "futures"])
        .values_list("pk", flat=True)
    )
    ids = (
        list(
            catalog_queryset(Account, space)
            .filter(pk__in=account_ids)
            .values_list("pk", flat=True)
        )
        if account_ids is not None
        else investment_accounts
    )
    selected = {str(value) for value in ids}
    earliest = (
        Event.objects.filter(tenant=space)
        .filter(Q(lines__account_id__in=ids) | Q(movements__account_id__in=ids))
        .order_by("economic_date")
        .first()
    )
    start = day(start) if start else (earliest.economic_date if earliest else end)
    if start > end:
        raise DomainError("收益区间的开始日期不能晚于结束日期")
    opening = overview(space, start - timedelta(days=1), account_ids=ids)
    closing = overview(space, end, account_ids=ids)
    flows = []
    inflow = Decimal(0)
    outflow = Decimal(0)
    gaps = closing["gaps"] + opening["gaps"]
    for scope in Resource.objects.filter(
        tenant=space, kind="account_recording", data__account_id__in=list(selected)
    ):
        if (
            scope.data.get("recording_mode") == "balance"
            or scope.data.get("history_status") != "complete_since_start"
        ):
            gaps.append(
                "部分账户只记录余额或交易历史未核实完整，区间收益与年化暂不可用"
            )
    from .catalog_lifecycle import deleted_catalog_ids

    if PositionMovement.objects.filter(
        tenant=space,
        account_id__in=ids,
        instrument_id__in=deleted_catalog_ids(space, "instruments"),
        event__economic_date__lte=end,
    ).exists():
        gaps.append("部分投资产品已移出统计，区间收益需恢复产品后重新核对")
    external_kinds = {
        "opening",
        "transfer",
        "fx",
        "fund_debit",
        "fund_funding",
        "fund_confirm",
        "fund_refund",
        "settlement",
        "position_transfer",
    }
    events = list(
        Event.objects.filter(
            tenant=space,
            economic_date__gte=start,
            economic_date__lte=end,
            reversal__isnull=True,
            reverses__isnull=True,
        ).order_by("economic_date", "created_at")
    )
    for event in events:
        if event.kind not in external_kinds:
            continue
        delta = _boundary_flow(space, event, selected, gaps)
        if delta > 0:
            inflow += delta
        else:
            outflow -= delta
        if delta:
            flows.append({"date": event.economic_date, "amount": -delta})
    # These are computed Decimal values, not raw user amounts limited to 12dp.
    start_value = Decimal(opening["net_assets"])
    end_value = Decimal(closing["net_assets"])
    if start_value:
        flows.insert(0, {"date": start, "amount": -start_value})
    if end_value:
        flows.append({"date": end, "amount": end_value})
    if any(
        p["cost_status"] in {"unknown", "unreconciled"} and p["contributes"]
        for p in closing["positions"]
    ):
        gaps.append("部分持仓成本或期初历史未知")
    unknown_disposal = any(
        event.payload.get("cost_unknown")
        and (
            event.lines.filter(account_id__in=ids).exists()
            or event.movements.filter(account_id__in=ids).exists()
        )
        for event in events
    )
    if unknown_disposal:
        gaps.append(
            "本期存在取得成本未知的真实处置或转移；已记录现金与份额，相关收益不可完整计算"
        )
    sums = defaultdict(Decimal)
    fees = Decimal(0)
    taxes = Decimal(0)
    for event in events:
        if not event.lines.filter(account_id__in=ids).exists():
            continue
        for line in event.lines.filter(code__in=["realized", "investment_income"]):
            rate = fx(space, line.currency, space.base_currency, event.economic_date)
            if rate is None:
                if line.amount:
                    gaps.append("收益发生日缺汇率")
            else:
                sums[line.code] += line.amount * rate
        # Buy fees are capitalized and sell taxes reduce proceeds. Disclose the
        # recorded amounts without deducting them a second time from net profit.
        fee_account = (
            (event.payload.get("target_account_id") or event.payload.get("account_id"))
            if event.kind == "fund_confirm"
            else event.payload.get("account_id")
        )
        if str(fee_account) not in selected:
            continue
        event_fee = Decimal(event.payload.get("fee", "0"))
        event_tax = Decimal(event.payload.get("tax", "0"))
        if not event_fee and not event_tax:
            continue
        rate = fx(
            space,
            event.payload.get("currency", space.base_currency),
            space.base_currency,
            event.economic_date,
        )
        if rate is None:
            gaps.append("费用或税费发生日缺汇率")
        else:
            fees += event_fee * rate
            taxes += event_tax * rate
    result = (
        xirr(flows)
        if flows and not gaps
        else {"status": "insufficient_data", "rate": None}
    )
    known_profit = end_value - start_value - inflow + outflow
    return serial(
        {
            "start": start,
            "end": end,
            "opening_value": start_value,
            "closing_value": end_value,
            "external_inflows": inflow,
            "external_outflows": outflow,
            "net_profit": None if gaps else known_profit,
            "known_profit": known_profit,
            "realized_profit": None if unknown_disposal else -sums["realized"],
            "known_realized_profit": -sums["realized"],
            "dividends": -sums["investment_income"],
            "fees": fees,
            "taxes": taxes,
            "xirr": result,
            "xirr_cashflows": flows,
            "currency": space.base_currency,
            "completeness": "partial" if gaps else "complete",
            "gaps": list(dict.fromkeys(gaps)),
            "scope_account_ids": [str(x) for x in ids],
            "data_revision": space.revision,
            "cost_policy": "weighted_average_buy_fees_capitalized",
            "fees_already_in_net_profit": True,
        }
    )


def calendar(space, start, end):
    start = day(start)
    end = day(end)
    result = []
    for o in Occurrence.objects.filter(
        tenant=space, due_date__range=(start, end)
    ).select_related("plan"):
        result.append(
            {
                "id": str(o.pk),
                "date": str(o.due_date),
                "kind": "plan",
                "title": o.plan.data.get("name", "计划"),
                "status": o.status,
                "amount": str(o.amount),
                "currency": o.currency,
            }
        )
    for e in Event.objects.filter(
        tenant=space,
        economic_date__range=(start, end),
        reversal__isnull=True,
        reverses__isnull=True,
    ):
        result.append(
            {
                "id": str(e.pk),
                "date": str(e.economic_date),
                "kind": "event",
                "title": e.description or e.kind,
                "status": "confirmed",
            }
        )
    # No invented daily zeroes. Formal daily performance is computed only with complete endpoints.
    dates = set(
        Price.objects.filter(
            tenant=space, economic_date__range=(start, end)
        ).values_list("economic_date", flat=True)
    )
    daily = []
    for d in sorted(dates):
        p = performance(space, d, d)
        daily.append(
            {
                "date": str(d),
                "value": p["net_profit"],
                "status": "complete_official"
                if p["completeness"] == "complete"
                else "partial_official",
                "gaps": p["gaps"],
            }
        )
    return {
        "items": result,
        "daily_returns": daily,
        "data_revision": space.revision,
        "missing_days": "not_updated",
    }
