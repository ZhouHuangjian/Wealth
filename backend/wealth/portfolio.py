"""Comparable wealth, exclusive allocation groups and fixed-quantity tag series.

Reference prices are presentation observations: these functions do not create
cashflows or alter immutable accounting facts. All amounts retain Decimal math.
"""

from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Max, Q, Sum

from .common import DomainError, catalog_queryset, day, dec, get_obj, serial
from .investments import DERIVATIVES, holdings_summary, is_derivative_instrument
from .models import (
    Account,
    Event,
    FxRate,
    Instrument,
    JournalLine,
    PositionMovement,
    Price,
    Resource,
)
from .reporting import ASSET_CODES, FORMAL_PRICE_KINDS

ZERO = Decimal(0)
HUNDRED = Decimal(100)


def _unique(values):
    return list(dict.fromkeys(values))


def _fx_observation(space, currency, target, when):
    if currency == target:
        return {
            "rate": Decimal(1),
            "date": when,
            "source": "same_currency",
            "data_state": "identity",
        }
    for base, quote, inverse in [(currency, target, False), (target, currency, True)]:
        row = (
            FxRate.objects.filter(
                tenant=space,
                base=base,
                quote=quote,
                purpose="valuation",
                economic_date__lte=when,
            )
            .order_by("-economic_date", "-created_at")
            .first()
        )
        if row and row.rate > ZERO:
            return {
                "rate": Decimal(1) / row.rate if inverse else row.rate,
                "date": row.economic_date,
                "source": row.source,
                "data_state": "stale"
                if (when - row.economic_date).days > 7
                else "official",
                "pair": f"{currency}/{target}",
            }
    return {
        "rate": None,
        "date": None,
        "source": None,
        "data_state": "missing",
        "pair": f"{currency}/{target}",
    }


def _chosen_holding(row, prefer_reference=True):
    formal, estimate = row.get("market_value"), row.get("estimate_value")
    stale = row.get("estimate_status") == "stale"
    if prefer_reference and estimate is not None and (not stale or formal is None):
        estimate_basis = row.get("estimate_basis")
        return {
            "local_value": Decimal(estimate),
            "date": row.get("estimate_date"),
            "source": row.get("estimate_source"),
            "basis": "manual_unknown"
            if estimate_basis == "unknown"
            else "manual_estimate"
            if estimate_basis == "estimate"
            else "reference",
            "data_state": "stale" if stale else "reference",
            "recorded_as_of": row.get("estimate_recorded_as_of"),
            "observed_at": row.get("estimate_published_at"),
        }
    if formal is not None:
        basis = "manual" if row.get("price_kind") == "manual_holding" else "formal"
        if basis == "manual" and row.get("valuation_basis") == "formal":
            basis = "manual_formal"
        return {
            "local_value": Decimal(formal),
            "date": row.get("price_date"),
            "source": row.get("price_source"),
            "basis": basis,
            "data_state": "stale"
            if row.get("valuation_status", row.get("status")) == "stale"
            else "manual"
            if basis in {"manual", "manual_formal"}
            else "official",
            "recorded_as_of": row.get("valuation_recorded_as_of"),
            "observed_at": row.get("valuation_observed_at"),
        }
    return {
        "local_value": None,
        "date": None,
        "source": None,
        "basis": "unavailable",
        "data_state": "missing",
    }


def _snapshot_account(account):
    return account.valuation_mode == "snapshot" or account.kind in DERIVATIVES


def _institution_value(space, account, when, prefer_reference=False):
    from .account_opening import effective_snapshots
    from .availability import (
        CASH_INSTITUTION_ACCOUNTS,
        cash_only_interval,
        institution_availability,
    )

    snapshots = (
        effective_snapshots(space, account)
        .filter(economic_date__lte=when)
        .order_by("economic_date", "created_at")
    )
    first = snapshots.first()
    eligible = (
        snapshots
        if prefer_reference
        else snapshots.exclude(
            Q(details__has_key="valuation_basis")
            & Q(details__valuation_basis__in=["intraday", "unknown"])
        )
    )
    latest = eligible.last()
    gaps = []
    if latest is None:
        # Legacy onboarding saved cash even for institution-valued accounts.
        # This is a known cash portion, not proof of total customer equity.
        # A later equity snapshot replaces it rather than adding it again.
        recorded = JournalLine.objects.filter(
            tenant=space,
            account=account,
            code="cash",
            event__economic_date__lte=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        ).aggregate(value=Sum("amount"), latest=Max("event__economic_date"))
        known_cash = recorded["value"]
        result = {
            "local_value": known_cash,
            "date": recorded["latest"],
            "source": "recorded_ledger"
            if known_cash is not None
            else "institution_snapshot",
            "basis": "recorded_cash" if known_cash is not None else "institution",
            "data_state": "partial" if known_cash is not None else "missing",
            "gaps": [
                f"{account.name} 缺机构总权益；仅显示已记录资金余额，尚未包含持仓价值或结算盈亏"
                if known_cash is not None
                else f"{account.name} 缺机构结算权益；盘中或口径未知的权益仅用于今日估算"
                if first is not None and not prefer_reference
                else f"{account.name} 缺机构权益"
            ],
            "roll_forward": ZERO,
            "reported_available": None,
        }
        if account.kind in CASH_INSTITUTION_ACCOUNTS:
            result.update(institution_availability(space, account, when, result))
        return result
    value = latest.equity
    valuation_basis = latest.details.get("valuation_basis", "legacy")
    from .valuation_basis import settled_market_remained_closed

    holiday_carry = latest.economic_date < when and settled_market_remained_closed(
        latest, when
    )
    empty_interval = cash_only_interval(space, account, when, latest)
    cash_carry = latest.economic_date < when and empty_interval
    if not latest.complete or latest.includes_options is None:
        gaps.append(f"{account.name} 机构权益包含范围未核实")
    if (
        latest.includes_options is False
        and latest.details.get("no_option_positions") is not True
    ):
        gaps.append(f"{account.name} 快照不包含期权价值，账户整体权益覆盖不完整")
    from .option_positions import has_option_reference

    if latest.includes_options is not True and has_option_reference(
        space, account_id=account.pk, when=when, active_only=True
    ):
        gaps.append(
            f"{account.name} 已记录期权持仓，机构总权益尚未确认包含期权；参考市值不会另行加总"
        )
    for line in (
        JournalLine.objects.filter(
            tenant=space,
            account=account,
            code="cash",
            event__economic_date__gte=first.economic_date,
            event__economic_date__lte=when,
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .exclude(event__kind="opening")
        .select_related("event")
    ):
        if str(line.event_id) in latest.included_event_ids:
            continue
        if line.event.economic_date <= latest.economic_date:
            description = (
                "出入金" if line.event.kind in {"transfer", "fx"} else "实际资金收支"
            )
            gaps.append(f"{account.name} 机构权益未声明是否包含{description}")
        elif line.event.kind in {
            "transfer",
            "fx",
            "income",
            "expense",
            "refund",
            "dividend",
        }:
            # Only independently recorded cashflows may extend institution equity.
            # A trade settlement can exchange cash for another included asset and
            # must not be treated as an equity change without a new statement.
            value += line.amount
        else:
            gaps.append(
                f"{account.name} 机构权益尚未核对后续 {line.event.kind} 资金流水"
            )
    if latest.economic_date < when and not holiday_carry and not cash_carry:
        gaps.append(f"{account.name} 权益截至 {latest.economic_date}，尚缺后续结算盈亏")
    result = {
        "local_value": value,
        "date": latest.economic_date,
        "source": latest.details.get("source") or "institution_snapshot",
        "basis": "institution_estimate"
        if valuation_basis == "intraday"
        else "institution_unknown"
        if valuation_basis == "unknown"
        else "institution_settlement"
        if valuation_basis == "settlement"
        else "institution",
        "data_state": "stale"
        if latest.economic_date < when and not holiday_carry and not cash_carry
        else "reference"
        if valuation_basis in {"intraday", "unknown"}
        else "institution",
        "gaps": _unique(gaps),
        "roll_forward": value - latest.equity,
        "reported_available": latest.details.get("available"),
        "observed_at": latest.details.get("valuation_observed_at"),
        "calendar_id": latest.details.get("calendar_id"),
        "holiday_carry_forward": holiday_carry,
        "cash_only_carry_forward": cash_carry,
        "settlement_pnl": ZERO if empty_interval else None,
        "settlement_pnl_basis": "no_recorded_positions" if empty_interval else None,
    }
    if account.kind in CASH_INSTITUTION_ACCOUNTS:
        result.update(
            institution_availability(space, account, when, result, latest.details)
        )
    return result


def _observation_detail(account, instrument_id, chosen):
    return {
        "account_id": str(account.pk),
        "account_name": account.name,
        "instrument_id": instrument_id,
        "instrument_name": chosen.get("instrument_name"),
        "name": chosen.get("instrument_name") or account.name,
        "date": chosen.get("date"),
        "source": chosen.get("source"),
        "basis": chosen["basis"],
        "data_state": chosen["data_state"],
        "recorded_as_of": chosen.get("recorded_as_of"),
        "observed_at": chosen.get("observed_at"),
        "calendar_id": chosen.get("calendar_id"),
        "holiday_carry_forward": chosen.get("holiday_carry_forward", False),
        "cash_only_carry_forward": chosen.get("cash_only_carry_forward", False),
        "settlement_pnl": chosen.get("settlement_pnl"),
        "settlement_pnl_basis": chosen.get("settlement_pnl_basis"),
    }


def _wealth_state(space, when, currency, prefer_reference=False):
    accounts = list(catalog_queryset(Account, space).filter(tenant=space))
    instruments = {
        str(row.pk): row
        for row in catalog_queryset(Instrument, space).filter(tenant=space)
    }
    holdings = holdings_summary(
        space, when, include_daily=False, include_pending=False
    )["items"]
    by_account = defaultdict(list)
    for row in holdings:
        by_account[row["account_id"]].append(row)
    prior_holding_gaps = defaultdict(list)
    for opening in Event.objects.filter(
        tenant=space,
        kind="opening",
        economic_date__gt=when,
        payload__opening_source="existing_holding",
        reversal__isnull=True,
        reverses__isnull=True,
    ):
        purchase_date = day(
            opening.payload.get("purchase_date") or opening.economic_date
        )
        instrument = instruments.get(str(opening.payload.get("instrument_id")))
        if purchase_date <= when and instrument is not None:
            prior_holding_gaps[str(opening.payload.get("account_id"))].append(
                f"{instrument.name} 于 {opening.economic_date} 补录存量持仓，"
                f"尚无 {when} 的已记录持仓价值"
            )
    parts = defaultdict(dict)
    ledger_dates = {}
    for row in (
        JournalLine.objects.filter(tenant=space, event__economic_date__lte=when)
        .values("account_id", "code")
        .annotate(value=Sum("amount"), latest=Max("event__economic_date"))
    ):
        aid = str(row["account_id"])
        parts[aid][row["code"]] = row["value"]
        if row["latest"]:
            ledger_dates[aid] = max(ledger_dates.get(aid, row["latest"]), row["latest"])
    total = ZERO
    gaps, sources, details = [], [], []
    has_facts = bool(ledger_dates) or bool(holdings)
    known_account_count = 0
    for account in accounts:
        aid = str(account.pk)
        known_value = False
        availability = {}
        if _snapshot_account(account):
            chosen = _institution_value(space, account, when, prefer_reference)
            availability = {
                key: value
                for key, value in chosen.items()
                if key == "available" or key.startswith("available_")
            }
            value = chosen["local_value"]
            gaps.extend(chosen["gaps"])
            sources.append(_observation_detail(account, None, chosen))
            has_facts = has_facts or value is not None
            known_value = value is not None
        else:
            gaps.extend(prior_holding_gaps[aid])
            from .option_positions import has_option_reference

            if has_option_reference(
                space, account_id=account.pk, when=when, active_only=True
            ):
                gaps.append(
                    f"{account.name} 有期权持仓参考，尚缺包含期权的机构总权益；当前只展示已记录资金与普通持仓"
                )
            value = sum(
                (
                    amount
                    for code, amount in parts[aid].items()
                    if code in ASSET_CODES and code != "investment"
                ),
                ZERO,
            )
            known_value = any(
                code in ASSET_CODES and code != "investment" for code in parts[aid]
            )
            if aid in ledger_dates:
                sources.append(
                    _observation_detail(
                        account,
                        None,
                        {
                            "date": ledger_dates[aid],
                            "source": "recorded_ledger",
                            "basis": "ledger",
                            "data_state": "ledger",
                        },
                    )
                )
            if parts[aid].get("unclassified", ZERO) or parts[aid].get(
                "loan_clearing", ZERO
            ):
                gaps.append(f"{account.name} 存在待分类或待分配款项")
            for row in by_account[aid]:
                if row.get("cost_status") == "unreconciled":
                    gaps.append(
                        f"{account.name} / {row['name']} 份额、成本或收益范围待核对；资产金额保留原记录"
                    )
                instrument = instruments.get(row["instrument_id"])
                chosen = _chosen_holding(row, prefer_reference)
                if (
                    instrument is None
                    or is_derivative_instrument(instrument)
                    or instrument.kind == "index"
                ):
                    chosen = {
                        "local_value": None,
                        "date": None,
                        "source": None,
                        "basis": "unavailable",
                        "data_state": "missing",
                    }
                    gaps.append(
                        f"{account.name} / {row['name']} 不能用合约或指数名义价格计资产"
                    )
                elif chosen["local_value"] is None:
                    gaps.append(f"{account.name} / {row['name']} 缺可用价格")
                else:
                    value += chosen["local_value"]
                    known_value = True
                if chosen["data_state"] == "stale":
                    gaps.append(f"{account.name} / {row['name']} 价格陈旧")
                sources.append(
                    _observation_detail(
                        account,
                        row["instrument_id"],
                        {
                            **chosen,
                            "instrument_name": row["name"],
                        },
                    )
                )
            # A current opening is not evidence of a zero balance before opening.
            past = aid in ledger_dates or bool(by_account[aid])
            if not past and (
                JournalLine.objects.filter(
                    tenant=space, account=account, event__economic_date__gt=when
                ).exists()
                or PositionMovement.objects.filter(
                    tenant=space,
                    account=account,
                    event__economic_date__gt=when,
                    event__reversal__isnull=True,
                    event__reverses__isnull=True,
                ).exists()
            ):
                gaps.append(f"{account.name} 尚无 {when} 的期初或余额记录")
        converted = None
        if value is not None:
            exchange = _fx_observation(space, account.currency, currency, when)
            if exchange["rate"] is None and value != ZERO:
                gaps.append(f"{account.currency}/{currency} 缺估值汇率")
            elif exchange["rate"] is not None:
                converted = value * exchange["rate"]
                if exchange["data_state"] == "stale" and value != ZERO:
                    gaps.append(f"{account.currency}/{currency} 估值汇率陈旧")
            else:
                converted = ZERO
            if account.currency != currency and value != ZERO:
                sources.append(
                    {
                        "account_id": aid,
                        "instrument_id": None,
                        "basis": "fx",
                        **exchange,
                    }
                )
            if converted is not None:
                total += converted
                if known_value:
                    known_account_count += 1
        details.append(
            {
                "account_id": aid,
                "name": account.name,
                "currency": account.currency,
                "local_value": value,
                "value": converted,
                **availability,
            }
        )
    if not has_facts:
        gaps.append("尚无该日可核对的余额、持仓或机构权益")
    return {
        "date": when,
        "net_assets": None if gaps else total,
        "known_net_assets": total,
        "known_account_count": known_account_count,
        "completeness": "partial" if gaps else "complete",
        "gaps": _unique(gaps),
        "source_dates": sources,
        "accounts": details,
    }


def net_worth_comparison(space, when=None, currency=None):
    when = day(when)
    currency = currency or space.base_currency
    if when > day():
        raise DomainError("净资产对比不能使用未来日期")
    if currency not in {"CNY", "USD", "HKD"}:
        raise DomainError("当前支持 CNY、USD、HKD 作为展示币种")
    from .daily_returns import daily_return_overview

    daily_return, _ = daily_return_overview(space, when, currency)
    previous = _wealth_state(space, when - timedelta(days=1), currency)
    formal = _wealth_state(space, when, currency)
    estimated = _wealth_state(space, when, currency, prefer_reference=True)
    from .pending_purchases import PendingPurchases

    current_pending = PendingPurchases(space, when)
    for state, projection in (
        (previous, PendingPurchases(space, when - timedelta(days=1))),
        (estimated, current_pending),
    ):
        state["pending_purchases"] = projection.summary(currency=currency)
        for account in state["accounts"]:
            account["pending_purchases"] = projection.summary(
                currency=account["currency"], source_account_id=account["account_id"]
            )
    estimated["reference_delta"] = (
        estimated["net_assets"] - formal["net_assets"]
        if estimated["net_assets"] is not None and formal["net_assets"] is not None
        else None
    )
    estimated["formal_net_assets"] = formal["net_assets"]
    amount = (
        estimated["net_assets"] - previous["net_assets"]
        if estimated["net_assets"] is not None and previous["net_assets"] is not None
        else None
    )
    return serial(
        {
            "as_of": when,
            "currency": currency,
            "previous": previous,
            "estimated": estimated,
            "daily_return": daily_return,
            "change": {
                "amount": amount,
                # Known subtotals may cover different assets or FX observations;
                # their difference is not a known component of a wealth change.
                "known_amount": amount,
                "completeness": "complete" if amount is not None else "partial",
                "message": None
                if amount is not None
                else "两侧可用数据未完全核对，暂不能确定净资产变化。",
                "kind": "net_worth_change",
                "includes_cashflows": True,
                "is_investment_return": False,
            },
            "message": "净资产变化包含已记收支、资金变动和估值变化，不等同于投资收益。",
            "data_revision": space.revision,
        }
    )


def _investment_items(space, when):
    accounts = {
        str(row.pk): row
        for row in catalog_queryset(Account, space).filter(tenant=space)
    }
    instruments = {
        str(row.pk): row
        for row in catalog_queryset(Instrument, space).filter(tenant=space)
    }
    items = []
    for holding in holdings_summary(
        space, when, include_daily=False, include_pending=False
    )["items"]:
        account = accounts[holding["account_id"]]
        if _snapshot_account(account):
            continue
        instrument = instruments[holding["instrument_id"]]
        chosen = _chosen_holding(holding)
        gaps = []
        if holding.get("cost_status") == "unreconciled":
            gaps.append("份额、成本或收益范围待核对；资产金额保留原记录")
        if is_derivative_instrument(instrument) or instrument.kind == "index":
            chosen = {
                "local_value": None,
                "date": None,
                "source": None,
                "basis": "unavailable",
                "data_state": "missing",
            }
            gaps.append("衍生合约或指数不能按名义价格计入组合资产")
        elif chosen["local_value"] is None:
            gaps.append("缺可用价格")
        if chosen["data_state"] == "stale":
            gaps.append("价格陈旧")
        items.append(
            {
                "account_id": str(account.pk),
                "account_name": account.name,
                "instrument_id": str(instrument.pk),
                "name": instrument.name,
                "kind": instrument.kind,
                "quantity": holding["quantity"],
                "currency": instrument.currency,
                **chosen,
                "price_date": chosen["date"],
                "gaps": gaps,
            }
        )
    for account in accounts.values():
        if not _snapshot_account(account):
            continue
        chosen = _institution_value(space, account, when, prefer_reference=True)
        items.append(
            {
                "account_id": str(account.pk),
                "account_name": account.name,
                "instrument_id": None,
                "name": account.name,
                "kind": "future"
                if account.kind in DERIVATIVES
                else "institution_account",
                "quantity": None,
                "currency": account.currency,
                **chosen,
                "price_date": chosen["date"],
            }
        )
    for item in items:
        exchange = _fx_observation(space, item["currency"], space.base_currency, when)
        item["fx"] = exchange
        item["value"] = (
            item["local_value"] * exchange["rate"]
            if item["local_value"] is not None and exchange["rate"] is not None
            else None
        )
        if item["local_value"] == ZERO and exchange["rate"] is None:
            item["value"] = ZERO
        elif exchange["rate"] is None:
            item["gaps"].append("缺估值汇率")
        elif exchange["data_state"] == "stale" and item["local_value"] != ZERO:
            item["gaps"].append("估值汇率陈旧")
        item["status"] = "partial" if item["gaps"] else "complete"
    return items, instruments


def _tags(space):
    return {
        str(tag.pk): tag
        for tag in Resource.objects.filter(tenant=space, kind="investment_tags")
        if not tag.data.get("archived") and tag.data.get("status") != "archived"
    }


def _primary_tag(instrument, tags):
    ident = str(instrument.specification.get("allocation_tag_id") or "")
    if ident:
        return ident if ident in tags else None
    # A late-added, unambiguous label should immediately classify existing
    # holdings. Derive this on read so legacy records benefit without rewriting
    # their history. Multiple labels still require an explicit primary choice.
    candidates = [
        tid
        for tid, tag in tags.items()
        if str(instrument.pk) in tag.data.get("instrument_ids", [])
        or tid in instrument.specification.get("tag_ids", [])
    ]
    return candidates[0] if len(candidates) == 1 else None


def _tag_members(tag, instruments):
    explicit = {str(ident) for ident in tag.data.get("instrument_ids", [])}
    return {
        iid
        for iid, instrument in instruments.items()
        if iid in explicit
        or str(instrument.specification.get("allocation_tag_id") or "") == str(tag.pk)
        or str(tag.pk) in instrument.specification.get("tag_ids", [])
    }


def _aggregate_group(items, total, complete):
    known = sum((item["value"] for item in items if item["value"] is not None), ZERO)
    own_complete = all(
        item["status"] == "complete" and item["value"] is not None for item in items
    )
    bases = {item["basis"] for item in items}
    dates = [
        {
            "account_id": item["account_id"],
            "instrument_id": item["instrument_id"],
            "date": item["price_date"],
            "source": item["source"],
            "basis": item["basis"],
            "data_state": item["data_state"],
        }
        for item in items
    ]
    return {
        "value": known if own_complete else None,
        "known_value": known,
        "current_weight": HUNDRED * known / total
        if complete and own_complete and total > ZERO
        else None,
        "product_count": len(
            {item["instrument_id"] for item in items if item["instrument_id"]}
        ),
        "holding_count": len(items),
        "basis": next(iter(bases))
        if len(bases) == 1
        else "mixed"
        if bases
        else "empty",
        "sources": sorted({item["source"] for item in items if item["source"]}),
        "source_dates": dates,
        "status": "complete" if own_complete else "partial",
        "gaps": _unique([gap for item in items for gap in item["gaps"]]),
    }


def portfolio_analysis(space, when=None):
    when = day(when)
    if when > day():
        raise DomainError("投资配置不能使用未来日期")
    items, instruments = _investment_items(space, when)
    tags = _tags(space)
    members = {tid: _tag_members(tag, instruments) for tid, tag in tags.items()}
    grouped = {tid: [] for tid in tags}
    grouped[None] = []
    kinds = defaultdict(list)
    for item in items:
        instrument = instruments.get(item["instrument_id"])
        primary = _primary_tag(instrument, tags) if instrument else None
        item["primary_tag_id"] = primary
        item["labels"] = [
            {
                "id": tid,
                "name": tag.data.get("name", "标签"),
                "color": tag.data.get("color", "#4f46e5"),
            }
            for tid, tag in tags.items()
            if item["instrument_id"] in members[tid]
        ]
        grouped[primary].append(item)
        kinds[item["kind"]].append(item)
    total = sum((item["value"] for item in items if item["value"] is not None), ZERO)
    complete = all(
        item["status"] == "complete" and item["value"] is not None for item in items
    )
    groups = []
    targets = ZERO
    for tid, values in grouped.items():
        tag = tags.get(tid)
        raw_weight = tag.data.get("target_weight") if tag else None
        target = (
            dec(raw_weight, nonnegative=True) if raw_weight not in (None, "") else None
        )
        if target is not None:
            targets += target
        summary = _aggregate_group(values, total, complete)
        groups.append(
            {
                "tag_id": tid,
                "name": tag.data.get("name", "标签") if tag else "未分配",
                "color": tag.data.get("color", "#4f46e5") if tag else "#94a3b8",
                "target_weight": target,
                **summary,
                "deviation_pp": summary["current_weight"] - target
                if summary["current_weight"] is not None and target is not None
                else None,
            }
        )
    return serial(
        {
            "as_of": when,
            "currency": space.base_currency,
            "total_value": total if complete else None,
            "known_total_value": total,
            "status": "complete"
            if complete and items
            else "empty"
            if not items
            else "partial",
            "groups": groups,
            "holdings": items,
            "items": items,
            "kind_distribution": [
                {"kind": kind, **_aggregate_group(values, total, complete)}
                for kind, values in kinds.items()
            ],
            "target_weight_total": targets,
            "target_status": "complete"
            if targets == HUNDRED
            else "unconfigured"
            if targets == ZERO
            else "partial",
            "gaps": _unique([gap for item in items for gap in item["gaps"]]),
            "basis": "investment_holdings_and_institution_equity",
            "message": "配置占比按主标签唯一分组；重叠标签不重复计入组合。普通账户闲置现金不计入投资配置。",
            "data_revision": space.revision,
        }
    )


def tag_series(space, tag_id, start, end):
    """Price a frozen basket with batched observations, independent of day count."""
    start, end = day(start), day(end)
    if start > end or end > day() or (end - start).days > 1825:
        raise DomainError("请选择不超过 1825 天的有效区间")
    tag = get_obj(Resource, space, tag_id, kind="investment_tags")
    instruments = {
        str(row.pk): row
        for row in catalog_queryset(Instrument, space).filter(tenant=space)
    }
    accounts = {
        str(row.pk): row
        for row in catalog_queryset(Account, space).filter(tenant=space)
    }
    selected = _tag_members(tag, instruments)
    quantities = defaultdict(Decimal)
    # Current quantities need neither current prices nor current FX. This is also
    # equivalent to ledger.position's active-movement quantity projection.
    for item in (
        PositionMovement.objects.filter(
            tenant=space,
            instrument_id__in=selected,
            event__economic_date__lte=day(),
            event__reversal__isnull=True,
            event__reverses__isnull=True,
        )
        .values("account_id", "instrument_id")
        .annotate(quantity=Sum("quantity"))
    ):
        iid = str(item["instrument_id"])
        account = accounts.get(str(item["account_id"]))
        if (
            account
            and not _snapshot_account(account)
            and not is_derivative_instrument(instruments[iid])
            and instruments[iid].kind != "index"
        ):
            quantities[iid] += item["quantity"]
    quantities = {
        iid: quantity for iid, quantity in quantities.items() if quantity != ZERO
    }
    actions = []
    for state in Resource.objects.filter(tenant=space, kind="market_quotes"):
        iid = state.data.get("instrument_id")
        if iid not in quantities:
            continue
        for action in state.data.get("corporate_actions", []):
            if action.get("date") and start <= day(action["date"]) <= end:
                actions.append({"instrument_id": iid, **action, "origin": "provider"})
    for event in Event.objects.filter(
        tenant=space,
        kind__in=["dividend", "reinvest", "split"],
        economic_date__range=(start, end),
        reversal__isnull=True,
        reverses__isnull=True,
        payload__instrument_id__in=list(quantities),
    ):
        actions.append(
            {
                "instrument_id": event.payload["instrument_id"],
                "date": str(event.economic_date),
                "event_id": str(event.pk),
                "description": {
                    "dividend": "已录入分红",
                    "reinvest": "已录入红利再投",
                    "split": "已录入份额折算",
                }[event.kind],
                "source": "recorded_ledger",
                "origin": "ledger",
            }
        )
    actions_by_day = defaultdict(list)
    for action in actions:
        actions_by_day[day(action["date"])].append(action)
    quantity_basis = [
        {
            "instrument_id": iid,
            "name": instruments[iid].name,
            "quantity": quantity,
            "currency": instruments[iid].currency,
        }
        for iid, quantity in quantities.items()
    ]
    price_query = Price.objects.filter(
        tenant=space, instrument_id__in=quantities, kind__in=FORMAL_PRICE_KINDS
    )
    current_prices = {
        str(row.instrument_id): row
        for row in price_query.filter(economic_date__lt=start)
        .order_by("instrument_id", "-economic_date", "-created_at")
        .distinct("instrument_id")
    }
    price_updates = list(
        price_query.filter(economic_date__range=(start, end)).order_by(
            "economic_date", "created_at"
        )
    )
    currencies = {instruments[iid].currency for iid in quantities} - {
        space.base_currency
    }
    current_fx, fx_updates = {}, []
    if currencies:
        fx_query = FxRate.objects.filter(
            Q(base__in=currencies, quote=space.base_currency)
            | Q(base=space.base_currency, quote__in=currencies),
            tenant=space,
            purpose="valuation",
        )
        current_fx = {
            (row.base, row.quote): row
            for row in fx_query.filter(economic_date__lt=start)
            .order_by("base", "quote", "-economic_date", "-created_at")
            .distinct("base", "quote")
        }
        fx_updates = list(
            fx_query.filter(economic_date__range=(start, end)).order_by(
                "economic_date", "created_at"
            )
        )

    def exchange_at(currency, when):
        if currency == space.base_currency:
            return {
                "rate": Decimal(1),
                "date": when,
                "source": "same_currency",
                "data_state": "identity",
            }
        for pair, inverse in [
            ((currency, space.base_currency), False),
            ((space.base_currency, currency), True),
        ]:
            row = current_fx.get(pair)
            if row and row.rate > ZERO:
                return {
                    "rate": Decimal(1) / row.rate if inverse else row.rate,
                    "date": row.economic_date,
                    "source": row.source,
                    "data_state": "stale"
                    if (when - row.economic_date).days > 7
                    else "official",
                    "pair": f"{currency}/{space.base_currency}",
                }
        return {
            "rate": None,
            "date": None,
            "source": None,
            "data_state": "missing",
            "pair": f"{currency}/{space.base_currency}",
        }

    days, all_gaps, effective_points = [], [], []
    observation_keys = set()
    previous_key = None
    when = start
    previous, peak, max_drawdown = None, None, ZERO
    sources = set()
    price_index = fx_index = 0
    while when <= end:
        while (
            price_index < len(price_updates)
            and price_updates[price_index].economic_date <= when
        ):
            update = price_updates[price_index]
            current_prices[str(update.instrument_id)] = update
            price_index += 1
        while fx_index < len(fx_updates) and fx_updates[fx_index].economic_date <= when:
            update = fx_updates[fx_index]
            current_fx[(update.base, update.quote)] = update
            fx_index += 1
        exchanges = {
            currency: exchange_at(currency, when)
            for currency in currencies | {space.base_currency}
        }
        known, gaps, observations = ZERO, [], []
        if not quantities:
            gaps.append(
                "标签暂无可用于比较的普通产品持仓，机构权益与合约报价不参与固定数量序列"
            )
        for iid, quantity in quantities.items():
            instrument = instruments[iid]
            price = current_prices.get(iid)
            exchange = exchanges[instrument.currency]
            if not price:
                gaps.append(f"{instrument.name} 缺正式历史价格")
            elif exchange["rate"] is None:
                gaps.append(f"{instrument.currency}/{space.base_currency} 缺历史汇率")
            else:
                known += quantity * price.value * exchange["rate"]
                if (when - price.economic_date).days > 7:
                    gaps.append(f"{instrument.name} 历史价格陈旧")
                if exchange["data_state"] == "stale":
                    gaps.append(
                        f"{instrument.currency}/{space.base_currency} 历史汇率陈旧"
                    )
                sources.add(price.source)
            observations.append(
                {
                    "instrument_id": iid,
                    "date": price.economic_date if price else None,
                    "source": price.source if price else None,
                    "basis": "formal",
                    "data_state": "missing"
                    if not price
                    else "stale"
                    if (when - price.economic_date).days > 7
                    else "official",
                    "fx": exchange,
                }
            )
        if actions_by_day[when]:
            gaps.append(
                "区间有分红、再投或折算记录，固定数量的未复权价格不能用于连续回撤告警"
            )
        value = known if not gaps else None
        observation_dates = [
            observation["date"] for observation in observations if observation["date"]
        ]
        observation_date = min(observation_dates) if observation_dates else None
        observation_key = tuple(
            (
                observation["instrument_id"],
                observation["date"],
                observation["fx"]["date"]
                if observation["fx"]["data_state"] != "identity"
                else None,
            )
            for observation in observations
        )
        new_observation = value is not None and observation_key != previous_key
        change_percent = None
        if value is not None:
            observation_keys.add(observation_key)
            if new_observation:
                change_percent = (
                    (value / previous - Decimal(1)) * HUNDRED
                    if previous is not None and previous > ZERO
                    else None
                )
                previous, previous_key = value, observation_key
            peak = max(peak, value) if peak is not None else value
            drawdown = (peak - value) / peak * HUNDRED if peak > ZERO else None
            if drawdown is not None:
                max_drawdown = max(max_drawdown, drawdown)
            if new_observation:
                effective_points.append(
                    {
                        "date": observation_date,
                        "calendar_date": when,
                        "value": value,
                        "change_percent": change_percent,
                        "drawdown_percent": drawdown,
                        "source_dates": observations,
                    }
                )
        else:
            drawdown = None
            previous, peak, previous_key = None, None, None
        days.append(
            {
                "date": when,
                "value": value,
                "known_value": known,
                "currency": space.base_currency,
                "status": "complete" if not gaps else "partial",
                "gaps": _unique(gaps),
                "source_dates": observations,
                "observation_date": observation_date,
                "is_new_observation": new_observation,
                "change_percent": change_percent,
                "drawdown_percent": drawdown,
            }
        )
        all_gaps.extend(gaps)
        when += timedelta(days=1)
    if quantities and len(observation_keys) < 2:
        all_gaps.append("比较区间需要至少两个不同的正式观察时点")
    complete = bool(quantities) and not all_gaps
    first, last = days[0]["value"], days[-1]["value"]
    return_percent = (
        (last / first - Decimal(1)) * HUNDRED
        if complete and first is not None and first > ZERO and last is not None
        else None
    )
    effective_change = (
        effective_points[-1]["change_percent"]
        if complete and len(effective_points) >= 2
        else None
    )
    return serial(
        {
            "tag_id": str(tag.pk),
            "name": tag.data.get("name", "标签"),
            "start": start,
            "end": end,
            "as_of": days[-1]["observation_date"],
            "current_value": last,
            "currency": space.base_currency,
            "status": "complete"
            if complete
            else "empty"
            if not quantities
            else "partial",
            "source": "、".join(sorted(sources)),
            "days": days,
            "effective_points": effective_points,
            "change_percent": effective_change,
            "quantity_basis": quantity_basis,
            "quantity_as_of": day(),
            "corporate_actions": actions,
            "gaps": _unique(all_gaps),
            "summary": {
                "return_percent": return_percent,
                "change_percent": effective_change,
                "current_drawdown_percent": days[-1]["drawdown_percent"]
                if complete
                else None,
                "max_drawdown_percent": max_drawdown if complete else None,
            },
            "method": "frozen_current_quantity_formal_price",
            "message": "固定当前份额对历史正式价格进行比较，排除实际申赎资金流；不是实际历史组合收益。分红折算或数据缺口期间不生成连续回撤结论。",
        }
    )
