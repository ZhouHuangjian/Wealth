"""Account-scoped investment onboarding and evidence-based profit observations.

Historical opening metadata supports an explicitly confirmed unchanged holding.
It never creates trades, cash payments or scheduled purchases retrospectively.
"""

import re
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .common import catalog_queryset
from .common import DomainError, audit, day, dec, get_obj, serial
from .ledger import event_detail, post_event
from .models import (
    Account,
    Event,
    Instrument,
    JournalLine,
    PositionMovement,
    Price,
    Resource,
    Snapshot,
    Workspace,
)

D = Decimal
ZERO = D(0)
DERIVATIVES = {"future", "futures", "option", "options"}
REFERENCE_KINDS = {"estimate", "reference", "reference_estimate", "market", "trade"}


def is_derivative_instrument(instrument):
    """Recognize mislabelled margin contracts before creating full-cost assets."""
    specification = (
        instrument.specification if isinstance(instrument.specification, dict) else {}
    )
    if instrument.kind in DERIVATIVES or specification.get("is_derivative") is True:
        return True
    if instrument.kind != "gold":
        return False
    code = str(instrument.code or "").strip().upper()
    market = str(instrument.market or "").strip().upper()
    # Explicit spot identities are distinct from similarly spelled gold futures.
    if market == "SGE" and code in {
        "AU99.99",
        "AU99.95",
        "AU9999",
        "AU9995",
        "AU100G",
        "IAU99.99",
    }:
        return False
    if re.fullmatch(r"(?:NF_|SHFE[.:])?AU(?:0|[0-9]{3,4})", code):
        return True
    futures_markets = {
        "SHFE",
        "DCE",
        "CZCE",
        "CFFEX",
        "INE",
        "GFEX",
        "COMEX",
        "NYMEX",
        "CME",
        "FUTURES",
        "CN_FUTURES",
        "CN_FUTURE",
    }
    return market in futures_markets and code not in {"XAU", "XAUUSD", "XAU/USD"}


def validate_investment_account(account, instrument):
    """The same rule is usable by product registration and holding commands."""
    if instrument.kind == "index":
        raise DomainError(
            "指数用于市场观察，不能直接作为可买入持仓；请选择对应基金或 ETF",
            "index_observation_only",
        )
    if is_derivative_instrument(instrument) and instrument.kind not in DERIVATIVES:
        raise DomainError(
            "该产品属于衍生合约，请改为期货或期权分类并选择对应账户；资产请录入机构权益",
            "derivative_snapshot_required",
        )
    if account.archived:
        raise DomainError("账户已归档")
    if account.currency != instrument.currency:
        raise DomainError("产品与账户计价币种不一致，请选择对应币种账户")
    if instrument.kind in {"future", "futures"} and account.kind not in {
        "future",
        "futures",
    }:
        raise DomainError("期货产品只能关联期货账户", "investment_account_kind")
    if instrument.kind in {"option", "options"} and account.kind not in {
        "future",
        "futures",
        "broker",
        "securities",
    }:
        raise DomainError("期权产品请选择券商或期货账户", "investment_account_kind")
    if instrument.kind in {"stock", "etf"} and account.kind not in {
        "broker",
        "securities",
    }:
        raise DomainError("股票或 ETF 请选择券商账户", "investment_account_kind")
    if instrument.kind not in DERIVATIVES and account.kind in {"future", "futures"}:
        raise DomainError("该产品不能关联期货账户", "investment_account_kind")
    if account.kind in {"loan", "credit", "credit_card", "property", "receivable"}:
        raise DomainError("请选择投资产品对应的资金账户", "investment_account_kind")


def manual_position_valuation(
    space, account, instrument, quantity, when, formal=None, *, reference_only=False
):
    """A user's holding total is never promoted to a shared instrument price.

    A later position movement invalidates it, even if a round trip restores the
    same quantity. A later formal valuation day supersedes the manual snapshot.
    """
    rows = Resource.objects.filter(
        tenant=space,
        kind="holding_valuations",
        data__account_id=str(account.pk),
        data__instrument_id=str(instrument.pk),
    ).order_by("-created_at")
    for row in rows:
        data = row.data
        holding_date = day(data.get("economic_date"))
        basis = data.get("valuation_basis", "legacy")
        if (basis in {"estimate", "unknown"}) != reference_only:
            continue
        value_date = (
            day(data.get("valuation_date"))
            if data.get("valuation_date")
            else holding_date
            if basis == "legacy"
            else None
        )
        if holding_date > when or dec(data.get("quantity"), places=18) != quantity:
            continue
        if (
            formal
            and value_date
            and (
                formal.economic_date > value_date
                or (reference_only and formal.economic_date == value_date)
            )
        ):
            continue
        opening = Event.objects.filter(
            tenant=space,
            pk=data.get("opening_event_id"),
            reversal__isnull=True,
            reverses__isnull=True,
        ).first()
        if not opening:
            continue
        subsequent = PositionMovement.objects.filter(
            tenant=space,
            account=account,
            instrument=instrument,
            event__economic_date__lte=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
            created_at__gt=row.created_at,
        )
        if subsequent.exists():
            continue
        return {
            "value": dec(data["value"], nonnegative=True),
            "date": value_date,
            "recorded_as_of": holding_date,
            "basis": basis,
            "observed_at": data.get("valuation_observed_at"),
            "source": "manual",
            "id": str(row.pk),
        }
    return None


def _check_holding_input(space, instrument, data, quantity, cost, value, as_of):
    """Cross-check reported scopes; never infer cost or pending units."""
    mode = data.get("reconciliation_mode", "strict")
    if mode not in {"strict", "pending"}:
        raise DomainError("请选择严格核对或明确保存为待核对")
    profit = (
        dec(data["institution_profit"])
        if data.get("institution_profit") not in (None, "")
        else None
    )
    nav = (
        dec(data["reference_nav"], nonnegative=True, places=18)
        if data.get("reference_nav") not in (None, "")
        else None
    )
    if nav is not None and nav <= 0:
        raise DomainError("参考净值须大于零")
    reference_date = day(
        data.get("reference_date") or data.get("valuation_date") or as_of
    )
    if reference_date > as_of:
        raise DomainError("参考数据日期不能晚于持仓核对日期")
    if mode == "pending":
        if data.get("confirm_unreconciled") is not True or profit is None:
            raise DomainError(
                "保存待核对须填写机构显示收益，并明确确认金额范围尚未核实",
                "holding_reconciliation_confirmation",
            )
        return {
            "version": 0,
            "institution_profit": str(profit),
            "reference_nav": str(nav) if nav is not None else None,
            "reference_date": str(reference_date),
            "as_of": str(as_of),
            "note": "录入时明确保存为待核对；份额、成本和资金均按原始输入保留",
            "scope_unconfirmed": True,
        }
    if profit is None and nav is None:
        return None
    value_date = day(data.get("valuation_date") or as_of)
    if value is not None and reference_date != value_date:
        raise DomainError(
            "参考净值和机构收益须与录入市值属于同一数据日期，请核对日期或明确保存为待核对",
            "holding_check_date_mismatch",
        )
    baseline = value
    if baseline is None:
        from .reporting import formal_price

        price = formal_price(space, instrument, reference_date)
        if price and price.economic_date == reference_date:
            baseline = quantity * price.value
        elif nav is not None and profit is not None:
            baseline = quantity * nav
        else:
            raise DomainError(
                "缺少同日可核对市值，请填写机构总市值及其数据日期，或明确保存为待核对",
                "holding_check_baseline_missing",
            )
    mismatch = []
    if profit is not None and abs(baseline - cost - profit) > D("0.02"):
        mismatch.append("机构收益与市值减成本不一致")
    if nav is not None and abs(quantity * nav - baseline) > D("0.02"):
        mismatch.append("总份额乘参考净值与市值不一致")
    if mismatch:
        raise DomainError(
            "；".join(mismatch)
            + "。请核对资产、成本、收益和在途款是否属于同一范围；不会自动修改成本或拆分未确认份额。也可明确保存为待核对。",
            "holding_reconciliation_mismatch",
            fields=serial(
                {
                    "computed_profit": baseline - cost,
                    "institution_profit": profit,
                    "computed_value": quantity * nav if nav is not None else None,
                    "current_value": baseline,
                }
            ),
        )
    return None


@transaction.atomic
def record_holding(space, user, data, *, _funding_context=None):
    # Funding checks and the optional top-up must share post_event's writer lock.
    Workspace.objects.select_for_update().get(pk=space.pk)
    account = get_obj(Account, space, data.get("account_id"))
    instrument = get_obj(Instrument, space, data.get("instrument_id"))
    validate_investment_account(account, instrument)
    if is_derivative_instrument(instrument) or account.valuation_mode == "snapshot":
        raise DomainError(
            "期货、期权及快照账户请录入机构权益，合约名义价值不能计入资产",
            "derivative_snapshot_required",
        )
    as_of = day(data.get("as_of"))
    purchase_date = day(data.get("purchase_date") or as_of)
    if purchase_date > as_of or as_of > timezone.localdate():
        raise DomainError("买入日期不能晚于持仓日期，持仓日期不能晚于今天")
    quantity = dec(data.get("quantity"), nonnegative=True, places=18)
    cost = dec(data.get("cost"), nonnegative=True)
    if quantity <= 0:
        raise DomainError("持有份额必须大于零")
    history_mode = data.get("history_mode", "snapshot_only")
    if history_mode not in {"unchanged_holding", "snapshot_only"}:
        raise DomainError("请选择历史持仓确认方式")
    supplied_value = data.get("current_value") not in (None, "")
    supplied_profit = data.get("current_profit") not in (None, "")
    if supplied_value and supplied_profit:
        raise DomainError("当前市值和当前收益请选择一项填写")
    manual_value = None
    if supplied_value:
        manual_value = dec(data["current_value"], nonnegative=True)
    elif supplied_profit:
        manual_value = cost + dec(data["current_profit"])
        if manual_value < 0:
            raise DomainError("当前收益与成本相加后的市值不能小于零")
        dec(manual_value, nonnegative=True)
    from .institution_funding import prepare_holding_funding, transfer_holding_shortfall
    from .valuation_basis import holding_valuation_metadata

    valuation_metadata = (
        holding_valuation_metadata(data, as_of) if manual_value is not None else {}
    )
    pending_check = _check_holding_input(
        space, instrument, data, quantity, cost, manual_value, as_of
    )
    funding_data = (
        {**data, "funding_account_id": None} if _funding_context is not None else data
    )
    funding = prepare_holding_funding(space, account, funding_data, as_of, manual_value)
    if _funding_context is None:
        transfer = transfer_holding_shortfall(space, user, account, as_of, funding)
    else:
        if funding["shortfall"]:
            raise DomainError(
                "无法在资金不变的前提下更正，请核对原记录", "holding_correction_funding"
            )
        transfer = _funding_context["parent"]
        funding["source_account_id"] = _funding_context["source_account_id"]
        funding["transfer_event_id"] = str(transfer.pk) if transfer else None
    opening_metadata = {}
    if manual_value is not None:
        opening_metadata["opening_market_value"] = str(manual_value)
        opening_metadata.update(valuation_metadata)
    if funding["mode"] == "allocate":
        opening_metadata.update(
            funding_mode="allocate",
            funding_amount=str(funding["required"]),
            funding_account_id=funding["source_account_id"],
        )
    if transfer:
        opening_metadata["related_event_id"] = str(transfer.pk)
    event = post_event(
        space,
        user,
        {
            "kind": "opening",
            "account_id": str(account.pk),
            "instrument_id": str(instrument.pk),
            "economic_date": str(as_of),
            "amount": "0",
            "quantity": str(quantity),
            "cost": str(cost),
            "purchase_date": str(purchase_date),
            "history_mode": history_mode,
            "opening_source": "existing_holding",
            "description": data.get("description")
            or (
                "从机构总额分配已有持仓"
                if funding["mode"] == "allocate"
                else "录入已有持仓"
            ),
            **opening_metadata,
        },
        _holding_funding=funding if funding["mode"] == "allocate" else None,
    )
    if manual_value is not None:
        valuation = Resource.objects.create(
            tenant=space,
            created_by=user,
            kind="holding_valuations",
            data={
                "account_id": str(account.pk),
                "instrument_id": str(instrument.pk),
                "quantity": str(quantity),
                "value": str(manual_value),
                "economic_date": str(as_of),
                "opening_event_id": str(event.pk),
                "source": "manual",
                "input_kind": "profit" if supplied_profit else "value",
                **valuation_metadata,
            },
        )
        audit(
            space,
            user,
            "holding.manual_valuation",
            valuation,
            {"event_id": str(event.pk)},
        )
    if pending_check:
        from .holding_checks import save_holding_check

        save_holding_check(space, user, event.pk, pending_check)
    return {
        "event": event_detail(event),
        "funding": serial(funding),
        "holding": holdings_summary(
            space,
            as_of,
            account_id=account.pk,
            instrument_id=instrument.pk,
        )["items"][0],
    }


def _selected_rows(space, account_id=None, instrument_id=None, kind=None):
    accounts = catalog_queryset(Account, space).filter(tenant=space)
    instruments = catalog_queryset(Instrument, space).filter(tenant=space)
    if account_id:
        account = get_obj(Account, space, account_id)
        accounts = accounts.filter(pk=account.pk)
    if instrument_id:
        instrument = get_obj(Instrument, space, instrument_id)
        instruments = instruments.filter(pk=instrument.pk)
    if kind:
        instruments = instruments.filter(kind=kind)
    return (
        {str(row.pk): row for row in accounts},
        {str(row.pk): row for row in instruments},
    )


def _corporate_actions(state):
    actions = []
    for item in (state or {}).get("corporate_actions", []):
        if not isinstance(item, dict) or not item.get("date"):
            continue
        try:
            when = day(item["date"])
        except DomainError:
            continue
        actions.append(
            {
                "date": when,
                "description": str(item.get("description", "")),
                "source": str(item.get("source", "")),
            }
        )
    return actions


def holdings_summary(
    space,
    when=None,
    account_id=None,
    instrument_id=None,
    kind=None,
    *,
    include_daily=True,
    include_pending=True,
):
    from .reporting import formal_price, positions

    when = day(when)
    accounts, instruments = _selected_rows(space, account_id, instrument_id, kind)
    market_states = {
        row.data.get("instrument_id"): row.data
        for row in Resource.objects.filter(tenant=space, kind="market_quotes")
    }
    now = timezone.now()

    def source_is_stale(instrument_id):
        state = market_states.get(instrument_id)
        if not state:
            return False
        if (
            state.get("refresh_status") == "failed"
            or (state.get("quote") or {}).get("status") == "stale"
        ):
            return True
        try:
            observed = (
                parse_datetime(state["fetched_at"]) if state.get("fetched_at") else None
            )
        except (ValueError, TypeError):
            observed = None
        if observed and timezone.is_naive(observed):
            observed = timezone.make_aware(observed)
        return observed is not None and (now - observed).total_seconds() > 600

    rows = []
    for row in positions(space, when):
        if row["account_id"] not in accounts or row["instrument_id"] not in instruments:
            continue
        instrument = instruments[row["instrument_id"]]
        opening = (
            Event.objects.filter(
                tenant=space,
                kind="opening",
                movements__account_id=row["account_id"],
                movements__instrument_id=row["instrument_id"],
                reversal__isnull=True,
                reverses__isnull=True,
            )
            .order_by("economic_date")
            .first()
        )
        reference = (
            Price.objects.filter(
                tenant=space,
                instrument=instrument,
                economic_date__lte=when,
                kind__in=REFERENCE_KINDS,
            )
            .order_by("-economic_date", "-published_at", "-created_at")
            .first()
        )
        # An older indicative quote is not fresher information than today's NAV.
        if (
            reference
            and row["price_date"]
            and reference.economic_date < row["price_date"]
        ):
            reference = None
        purchase_date = (
            day(opening.payload.get("purchase_date") or opening.economic_date)
            if opening
            else None
        )
        if purchase_date is None:
            first_movement = (
                PositionMovement.objects.filter(
                    tenant=space,
                    account_id=row["account_id"],
                    instrument=instrument,
                    quantity__gt=0,
                    event__economic_date__lte=when,
                    event__reversal__isnull=True,
                    event__reverses__isnull=True,
                )
                .select_related("event")
                .order_by("event__economic_date", "event__created_at")
                .first()
            )
            purchase_date = (
                first_movement.event.economic_date if first_movement else None
            )
        actions = [
            item
            for item in _corporate_actions(market_states.get(row["instrument_id"]))
            if purchase_date is not None and purchase_date < item["date"] <= when
        ]
        history_mode = (
            opening.payload.get("history_mode", "ledger") if opening else "ledger"
        )
        history_warning = (
            "历史区间存在分红或折算提示，请核对份额未变的确认，并补录实际分红、红利再投或拆分。"
            if actions and history_mode == "unchanged_holding"
            else "存在分红或折算提示，请核对并补录实际分红、红利再投或拆分。"
            if actions
            else ""
        )
        manual_reference = manual_position_valuation(
            space,
            accounts[row["account_id"]],
            instrument,
            row["quantity"],
            when,
            formal_price(space, instrument, when),
            reference_only=True,
        )
        use_manual_reference = manual_reference is not None and (
            reference is None
            or (
                manual_reference["date"] is not None
                and manual_reference["date"] > reference.economic_date
            )
        )
        estimated_value = (
            manual_reference["value"]
            if use_manual_reference
            else reference.value * row["quantity"]
            if reference
            else None
        )
        estimate_date = (
            manual_reference["date"]
            if use_manual_reference
            else reference.economic_date
            if reference
            else None
        )
        cost = row["cost"]
        profit = row["unrealized_profit"]
        rows.append(
            {
                **row,
                "kind": instrument.kind,
                "purchase_date": purchase_date,
                "history_mode": history_mode,
                "corporate_actions": actions,
                "history_warning": history_warning,
                "profit": profit,
                "profit_type": "unrealized",
                "profit_rate": profit / cost if profit is not None and cost else None,
                "manual_value": row["market_value"]
                if row["price_kind"] == "manual_holding"
                else None,
                "manual_value_date": row["price_date"]
                if row["price_kind"] == "manual_holding"
                else None,
                "estimate_price": estimated_value / row["quantity"]
                if estimated_value is not None
                else None,
                "estimate_date": estimate_date,
                "estimate_published_at": manual_reference["observed_at"]
                if use_manual_reference
                else reference.published_at
                if reference
                else None,
                "estimate_value": estimated_value,
                "estimate_profit": estimated_value - cost
                if estimated_value is not None and cost is not None
                else None,
                "estimate_source": "manual"
                if use_manual_reference
                else reference.source
                if reference
                else None,
                "estimate_basis": manual_reference["basis"]
                if use_manual_reference
                else "reference"
                if reference
                else None,
                "estimate_recorded_as_of": manual_reference["recorded_as_of"]
                if use_manual_reference
                else None,
                "estimate_status": (
                    "stale"
                    if (estimate_date is not None and (when - estimate_date).days > 1)
                    or (
                        not use_manual_reference
                        and source_is_stale(row["instrument_id"])
                    )
                    else "reference"
                )
                if estimated_value is not None
                else "unavailable",
            }
        )
        from .holding_checks import apply_holding_check, holding_check_eligibility
        from .holding_corrections import correction_metadata

        rows[-1] = apply_holding_check(rows[-1], row.get("reconciliation"))
        rows[-1]["correction"] = correction_metadata(space, opening)
        from .dca_history import placeholder_void_metadata

        rows[-1]["placeholder_void"] = placeholder_void_metadata(space, opening)
        rows[-1]["reconciliation_eligibility"] = (
            holding_check_eligibility(space, opening, when)
            if opening
            else {
                "eligible": False,
                "reason": "仅支持核对存量持仓录入",
                "opening_event_id": None,
            }
        )
    from .option_positions import option_items

    references = (
        option_items(space, when, account_id, instrument_id)
        if kind in (None, "option", "options")
        else []
    )
    pending = None
    if include_pending:
        from .pending_purchases import PendingPurchases

        projection = PendingPurchases(space, when)
        pending = projection.summary(
            holding_account_id=account_id, instrument_id=instrument_id, kind=kind
        )
        existing = {(row["account_id"], row["instrument_id"]): row for row in rows}
        groups = defaultdict(list)
        for item in pending["items"]:
            key = (item["holding_account_id"], item["instrument_id"])
            if key[0] in accounts and key[1] in instruments:
                groups[key].append(item)
        for (aid, iid), items in groups.items():
            if (aid, iid) not in existing:
                instrument, account = instruments[iid], accounts[aid]
                row = {
                    "id": f"{aid}:{iid}",
                    "account_id": aid,
                    "account_name": account.name,
                    "instrument_id": iid,
                    "name": instrument.name,
                    "code": instrument.code,
                    "market": instrument.market,
                    "kind": instrument.kind,
                    "currency": instrument.currency,
                    "pending_only": True,
                    "specification": instrument.specification,
                    "contributes": False,
                    "quantity": None,
                    "cost": None,
                    "total_cost": None,
                    "average_cost": None,
                    "market_value": None,
                    "price": None,
                    "price_date": None,
                    "price_kind": None,
                    "price_source": None,
                    "profit": None,
                    "unrealized_profit": None,
                    "profit_rate": None,
                    "estimate_value": None,
                    "estimate_profit": None,
                    "estimate_status": "pending_confirmation",
                    "status": "pending_confirmation",
                    "cost_status": "pending_confirmation",
                    "purchase_date": None,
                    "contains_preview_entries": any(
                        item["entry_basis"] == "preview_confirmed" for item in items
                    ),
                    "contains_automatic_estimates": any(
                        item["automatic_estimate"] for item in items
                    ),
                }
                existing[(aid, iid)] = row
                rows.append(row)
        for row in rows:
            row["pending_purchases"] = projection.summary(
                currency=row["currency"],
                items=groups.get((row["account_id"], row["instrument_id"]), []),
            )
    summary = None
    observations = {}
    if include_daily:
        from .daily_returns import daily_return_overview

        summary, observations = daily_return_overview(
            space,
            when,
            account_id=account_id,
            instrument_id=instrument_id,
            kind=kind,
        )
    tags = [
        tag
        for tag in Resource.objects.filter(tenant=space, kind="investment_tags")
        if not tag.data.get("archived") and tag.data.get("status") != "archived"
    ]
    for row in [*rows, *references]:
        iid = row["instrument_id"]
        spec = instruments[iid].specification if iid in instruments else {}
        row["labels"] = [
            {"id": str(tag.pk), "name": tag.data.get("name", "")}
            for tag in tags
            if iid in tag.data.get("instrument_ids", [])
            or str(tag.pk) in spec.get("tag_ids", [])
            or str(tag.pk) == str(spec.get("allocation_tag_id") or "")
        ]
        if include_daily:
            row.update(
                observations.get(
                    (row["account_id"], iid),
                    {"daily_return": None, "latest_confirmed_return": None},
                )
            )
    return serial(
        {
            "as_of": when,
            "items": rows,
            "currency": space.base_currency,
            "reference_items": references,
            **({"pending_purchases": pending} if include_pending else {}),
            **({"daily_return": summary} if include_daily else {}),
        }
    )


def _latest_quote(prices, when):
    return next(
        (quote for quote in reversed(prices) if quote.economic_date <= when), None
    )


def _calendar_item(
    space,
    account,
    instrument,
    movements,
    prices,
    dividends,
    when,
    corporate_actions=(),
    *,
    check_reader=None,
):
    """Profit for a price observation, with actual trade cashflows separated.

    Missing dates are missing observations, never synthetic zeroes. An explicitly
    confirmed original holding is analytically placed on its purchase date, but
    its real opening event and the balance sheet remain at the onboarding date.
    """
    prior = when - timedelta(days=1)
    q_before = sum((row["quantity"] for row in movements if row["date"] <= prior), ZERO)
    q_after = sum((row["quantity"] for row in movements if row["date"] <= when), ZERO)
    changes = [row for row in movements if row["date"] == when]
    payouts = [event for event in dividends if event.economic_date == when]
    if not q_before and not q_after and not changes and not payouts:
        return None
    base = {
        "account_id": str(account.pk),
        "account_name": account.name,
        "instrument_id": str(instrument.pk),
        "name": instrument.name,
        "code": instrument.code,
        "kind": instrument.kind,
        "currency": instrument.currency,
        "date": str(when),
        "amount": None,
        "return_rate": None,
        "source": None,
        "status": "unavailable",
        "message": "缺少正式价格",
    }
    from .holding_checks import read_holding_check

    read_check = check_reader or read_holding_check
    check = read_check(space, account, instrument, q_after, when)
    if not check:
        for movement in movements:
            event = movement["event"]
            if (
                movement["reconstructed"]
                and movement["date"] <= when < event.economic_date
            ):
                check = read_check(
                    space,
                    account,
                    instrument,
                    movement["quantity"],
                    event.economic_date,
                    event,
                )
                if check and check.get("status") == "unresolved":
                    break
    if check and check.get("status") == "unresolved":
        return {
            **base,
            "message": "原持仓金额、成本或收益范围待核对，暂不确认该日收益",
            "reconciliation": check,
        }
    actions_today = [item for item in corporate_actions if item["date"] == when]
    recorded_action = bool(payouts) or any(
        row["event"].kind in {"reinvest", "split"} for row in changes
    )
    if actions_today and not recorded_action:
        return {
            **base,
            "corporate_actions": actions_today,
            "message": "该日有分红或折算提示，请核对并补录实际记录",
        }
    if is_derivative_instrument(instrument) or account.valuation_mode == "snapshot":
        return {**base, "message": "期货期权收益须按机构权益与真实入出金计算"}
    closing = _latest_quote(prices, when)
    opening = _latest_quote(prices, prior)
    if q_after and (not closing or closing.economic_date != when):
        return base
    from .valuation_calendar import open_days_between, valuation_calendar

    opening_lag = (
        open_days_between(
            opening.economic_date,
            when,
            valuation_calendar(instrument),
            include_end=False,
        )
        if opening
        else None
    )
    if q_before and (not opening or opening_lag is None or opening_lag != 0):
        return {**base, "message": "缺少交易日行情、上一有效价格或日历覆盖"}
    # Multi-day gaps are disclosed. Intervening actual trades require a daily
    # quote on their date, otherwise a later observation cannot move that P&L.
    if q_before and opening.economic_date < prior:
        between = [
            row for row in movements if opening.economic_date < row["date"] < when
        ]
        if between:
            return {**base, "message": "报价缺口内有持仓变动，无法分配每日收益"}
    opening_value = q_before * opening.value if q_before else ZERO
    closing_value = q_after * closing.value if q_after else ZERO
    capital = ZERO
    distributions = ZERO
    added_capital = ZERO
    for row in changes:
        event = row["event"]
        kind = event.kind
        if kind in {"buy", "fund_confirm"}:
            if row["cost"] is None:
                return {**base, "message": "交易成本缺失"}
            contribution = row["cost"]
        elif kind in {"sell", "fund_redeem"}:
            contribution = -dec(event.payload["amount"])
        elif kind == "reinvest":
            # Gross reinvested dividend is earned; only its real fee is capital.
            contribution = dec(event.payload.get("fee", "0"))
        elif kind == "opening":
            if row["reconstructed"]:
                contribution = row["cost"]
            elif closing:
                contribution = row["quantity"] * closing.value
            else:
                return base
        elif kind == "position_transfer":
            if not closing:
                return base
            contribution = row["quantity"] * closing.value
        elif kind == "split":
            contribution = ZERO
        else:
            return {**base, "message": "该持仓变动尚不能计算每日收益"}
        if contribution is None:
            return {**base, "message": "原始取得成本缺失"}
        capital += contribution
        added_capital += max(ZERO, contribution)
    for event in payouts:
        distributions += (
            dec(event.payload["amount"])
            - dec(event.payload.get("fee", "0"))
            - dec(event.payload.get("tax", "0"))
        )
    amount = closing_value - opening_value - capital + distributions
    basis = opening_value + added_capital
    return {
        **base,
        "amount": amount,
        "return_rate": amount / basis if basis else None,
        "basis": basis,
        "status": "confirmed",
        "message": "",
        "source": closing.source
        if closing
        else (opening.source if opening else "ledger"),
        "price_date": closing.economic_date if closing else None,
        "interval_start": opening.economic_date if opening and q_before else when,
        "history_reconstructed": any(row["reconstructed"] for row in movements),
        "capital_flow": capital,
        "dividends": distributions,
    }


def _snapshot_calendar_item(account, snapshots, flows, when):
    # Intraday equity is a reference observation, never a settled daily return.
    has_observation = any(row.economic_date <= when for row in snapshots)
    snapshots = [
        row
        for row in snapshots
        if row.details.get("valuation_basis") not in {"intraday", "unknown"}
    ]
    current = next(
        (row for row in reversed(snapshots) if row.economic_date <= when), None
    )
    if not current and not has_observation:
        return None
    previous = next(
        (row for row in reversed(snapshots) if row.economic_date < when), None
    )
    base = {
        "account_id": str(account.pk),
        "account_name": account.name,
        "instrument_id": None,
        "name": account.name,
        "code": "",
        "kind": "future" if account.kind in {"future", "futures"} else "account",
        "currency": account.currency,
        "date": str(when),
        "amount": None,
        "return_rate": None,
        "source": "institution_snapshot",
        "status": "unavailable",
        "message": "缺少该日或上次机构权益",
        "scope": "account",
    }
    if not current:
        return {**base, "message": "已有盘中或口径未知权益，尚缺正式结算权益"}
    if (
        current.economic_date != when
        or not previous
        or (when - previous.economic_date).days > 7
    ):
        return base
    for snapshot in [previous, current]:
        from .option_positions import has_option_reference

        if snapshot.includes_options is not True and has_option_reference(
            account.tenant,
            account_id=account.pk,
            when=snapshot.economic_date,
            active_only=True,
        ):
            return {**base, "message": "已记录期权持仓，机构结算权益尚未确认包含期权"}
        if (
            not snapshot.complete
            or snapshot.includes_options is None
            or (
                snapshot.includes_options is False
                and snapshot.details.get("no_option_positions") is not True
            )
        ):
            return {**base, "message": "机构权益包含范围尚未核实"}
        relevant = [
            line
            for line in flows
            if snapshots[0].economic_date
            <= line.event.economic_date
            <= snapshot.economic_date
        ]
        if any(
            str(line.event_id) not in snapshot.included_event_ids for line in relevant
        ):
            return {**base, "message": "机构权益未声明是否包含实际入出金"}
    period_flows = [
        line.amount
        for line in flows
        if previous.economic_date < line.event.economic_date <= when
    ]
    capital = sum(period_flows, ZERO)
    amount = current.equity - previous.equity - capital
    basis = previous.equity + sum((max(value, ZERO) for value in period_flows), ZERO)
    return {
        **base,
        "amount": amount,
        "basis": basis,
        "return_rate": amount / basis if basis > ZERO else None,
        "status": "confirmed",
        "message": "",
        "price_date": current.economic_date,
        "interval_start": previous.economic_date,
        "capital_flow": capital,
    }


def _aggregate_days(rows):
    values = [row for row in rows if row["amount"] is not None]
    missing = [row for row in rows if row["status"] in {"unavailable", "partial"}]
    known_values = [
        row for row in rows if row.get("known_amount", row["amount"]) is not None
    ]
    known = sum((row.get("known_amount", row["amount"]) for row in known_values), ZERO)
    # A period percentage cannot be obtained by adding daily percentages.
    # Chain the available day returns only for a complete observed period.
    rate = D(1)
    rate_valid = bool(values) and not missing
    for row in values:
        if row["return_rate"] is None:
            rate_valid = False
        else:
            rate *= D(1) + row["return_rate"]
    status = (
        "partial"
        if missing and known_values
        else "unavailable"
        if missing
        else "confirmed"
        if values
        else "no_position"
    )
    return {
        "amount": known if values and not missing else None,
        "known_amount": known if known_values else None,
        "return_rate": rate - D(1) if rate_valid else None,
        "status": status,
        "observed_days": len(values),
        "missing_days": len(missing),
    }


def profit_calendar(
    space,
    start=None,
    end=None,
    period="day",
    selected_day=None,
    account_id=None,
    instrument_id=None,
    kind=None,
):
    from .reporting import FORMAL_PRICE_KINDS, fx

    end = day(end)
    start = day(start) if start else end.replace(day=1)
    if start > end or (end - start).days > 1096:
        raise DomainError("请选择不超过三年的有效收益区间")
    if period not in {"day", "week", "month", "year"}:
        raise DomainError("收益视图须为日、周、月或年")
    selected = day(selected_day) if selected_day else min(end, timezone.localdate())
    accounts, instruments = _selected_rows(space, account_id, instrument_id, kind)
    movement_groups = defaultdict(list)
    for row in (
        PositionMovement.objects.filter(
            tenant=space,
            account_id__in=accounts,
            instrument_id__in=instruments,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .select_related("event")
        .order_by("event__economic_date", "event__created_at")
    ):
        event = row.event
        reconstructed = (
            event.kind == "opening"
            and event.payload.get("history_mode") == "unchanged_holding"
        )
        effective = (
            day(event.payload["purchase_date"])
            if reconstructed
            else event.economic_date
        )
        movement_groups[(str(row.account_id), str(row.instrument_id))].append(
            {
                "date": effective,
                "quantity": row.quantity,
                "cost": row.cost,
                "event": event,
                "reconstructed": reconstructed,
            }
        )
    prices = defaultdict(list)
    for quote in Price.objects.filter(
        tenant=space,
        instrument_id__in=instruments,
        kind__in=FORMAL_PRICE_KINDS,
        economic_date__lte=end,
    ).order_by("economic_date", "created_at"):
        prices[str(quote.instrument_id)].append(quote)
    dividends = defaultdict(list)
    # Imported cash dividends may lack a product. A later explicit, unique
    # confirmation supplies attribution without rewriting the immutable event.
    dividend_links = defaultdict(set)
    for link in Resource.objects.filter(
        tenant=space,
        kind="dividend_candidates",
        data__status="confirmed",
        data__event_id__isnull=False,
    ):
        dividend_links[link.data["event_id"]].add(
            (link.data.get("account_id"), link.data.get("instrument_id"))
        )
    for event in Event.objects.filter(
        tenant=space,
        kind="dividend",
        economic_date__range=(start, end),
        reversal__isnull=True,
        reverses__isnull=True,
    ):
        account_id = event.payload.get("account_id")
        instrument_id = event.payload.get("instrument_id")
        if not instrument_id:
            links = dividend_links.get(str(event.pk), set())
            if len(links) == 1:
                linked_account, linked_instrument = next(iter(links))
                if linked_account == account_id:
                    instrument_id = linked_instrument
        key = (account_id, instrument_id)
        if key[0] in accounts and key[1] in instruments:
            dividends[key].append(event)
            movement_groups.setdefault(key, [])
    corporate_actions = {
        row.data.get("instrument_id"): _corporate_actions(row.data)
        for row in Resource.objects.filter(tenant=space, kind="market_quotes")
    }
    snapshot_groups = defaultdict(list)
    flow_groups = defaultdict(list)
    snapshot_accounts = {
        aid: account
        for aid, account in accounts.items()
        if account.valuation_mode == "snapshot"
    }
    # A broker statement covers the whole account. It cannot be attributed to a
    # selected individual option or future without contract-level settlement.
    if not instrument_id and (not kind or kind in DERIVATIVES):
        from .account_opening import effective_snapshots

        for snapshot in (
            effective_snapshots(space)
            .filter(account_id__in=snapshot_accounts, economic_date__lte=end)
            .order_by("economic_date", "created_at")
        ):
            snapshot_groups[str(snapshot.account_id)].append(snapshot)
        for line in JournalLine.objects.filter(
            tenant=space,
            account_id__in=snapshot_accounts,
            code="cash",
            event__kind__in=["transfer", "fx"],
            event__economic_date__lte=end,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        ).select_related("event"):
            flow_groups[str(line.account_id)].append(line)
    fx_cache = {}

    def converted_item(item, when):
        key = (item["currency"], when)
        if key not in fx_cache:
            fx_cache[key] = fx(space, item["currency"], space.base_currency, when)
        rate = fx_cache[key]
        item["base_amount"] = (
            item["amount"] * rate
            if item["amount"] is not None and rate is not None
            else None
        )
        item["base_basis"] = (
            item.get("basis", ZERO) * rate if rate is not None else None
        )
        if item["amount"] is not None and rate is None:
            item["status"] = "unavailable"
            item["message"] = "缺少该日汇率"
        return item

    days = []
    when = start
    today = timezone.localdate()
    while when <= end:
        items = []
        if when <= today:
            for (aid, iid), moves in movement_groups.items():
                if aid in snapshot_accounts:
                    continue
                item = _calendar_item(
                    space,
                    accounts[aid],
                    instruments[iid],
                    moves,
                    prices[iid],
                    dividends[(aid, iid)],
                    when,
                    corporate_actions.get(iid, []),
                )
                if item is not None:
                    items.append(converted_item(item, when))
            for aid, snapshots in snapshot_groups.items():
                item = _snapshot_calendar_item(
                    accounts[aid], snapshots, flow_groups[aid], when
                )
                if item is not None:
                    items.append(converted_item(item, when))
        known_items = [row for row in items if row["base_amount"] is not None]
        known = sum((row["base_amount"] for row in known_items), ZERO)
        complete = bool(items) and len(known_items) == len(items)
        basis = sum((row["base_basis"] or ZERO for row in known_items), ZERO)
        status = (
            "future"
            if when > today
            else "confirmed"
            if complete
            else "partial"
            if known_items
            else "unavailable"
            if items
            else "no_position"
        )
        days.append(
            {
                "date": when,
                "amount": known if complete else None,
                "known_amount": known if known_items else None,
                "return_rate": known / basis if complete and basis else None,
                "status": status,
                "items": items,
            }
        )
        when += timedelta(days=1)
    groups = defaultdict(list)
    for row in days:
        when = row["date"]
        key = (
            when - timedelta(days=when.weekday())
            if period == "week"
            else when.replace(day=1)
            if period == "month"
            else date(when.year, 1, 1)
            if period == "year"
            else when
        )
        groups[key].append(row)
    buckets = [
        {"date": key, "end": group[-1]["date"], **_aggregate_days(group)}
        for key, group in groups.items()
    ]
    return serial(
        {
            "start": start,
            "end": end,
            "period": period,
            "currency": space.base_currency,
            "days": days,
            "buckets": buckets,
            "selected_day": selected,
            "details": next(
                (row["items"] for row in days if row["date"] == selected), []
            ),
            "summary": _aggregate_days(days),
            "data_revision": space.revision,
            "return_basis": "daily_opening_value_plus_positive_capital",
            "currency_policy": "local_profit_converted_daily_excludes_fx",
            "history_warnings": [
                "持有收益为当前持仓市值减剩余取得成本，不等同于累计总投资收益。",
                "历史回算仅适用于已确认份额不变的持仓；现金分红、红利再投、拆分及买卖须另行录入。",
                "收益日历只计入已记录且关联产品的股息分红；未记录的分配不会自动计为收入。",
                "跨币种汇总按当日汇率折算产品收益，不包含独立的汇兑损益。",
            ],
        }
    )
