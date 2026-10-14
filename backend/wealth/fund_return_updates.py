"""Latest fund observations with explicit intervals, separate from daily P&L.

These read-side results never become Price, ledger, calendar or net-worth facts.
A closed overseas session may remain a reference during the local day, but a
new formal NAV invalidates its old baseline rather than rebasing its old rate.
"""

from decimal import Decimal
from zoneinfo import ZoneInfo

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .common import DomainError, day, dec, serial
from .return_dates import has_automatic_shares

ZERO = Decimal(0)


def _stamp(value):
    try:
        result = parse_datetime(value) if isinstance(value, str) else None
    except (TypeError, ValueError):
        return None
    return result if result and timezone.is_aware(result) else None


def latest_fund_updates(evidence, when, currency, holding_items):
    items = []
    for key, movements in evidence.movements.items():
        aid, iid = key
        account, instrument = evidence.accounts[aid], evidence.instruments[iid]
        state = evidence.states.get(iid, {})
        reference = state.get("reference_estimate") or (state.get("quote") or {}).get(
            "reference_estimate"
        )
        if (
            not isinstance(reference, dict)
            or instrument.kind != "fund"
            or aid in evidence.snapshot_accounts
            or account.valuation_mode == "snapshot"
            or sum((m["quantity"] for m in movements if m["date"] <= when), ZERO) <= 0
        ):
            continue
        item = _holding_update(evidence, key, reference, when, holding_items)
        items.append(evidence.convert(item, currency))
    known = [item for item in items if item.get("base_amount") is not None]
    return serial(
        {
            "currency": currency,
            "known_count": len(known),
            "total_count": len(items),
            "known_amount": sum((item["base_amount"] for item in known), ZERO)
            if known
            else None,
            "items": items,
            "message": "各基金的净值日期与参考区间不同；此处不计入今日收益、收益日历或净资产。",
        }
    )


def _holding_update(evidence, key, reference, when, holding_items):
    aid, iid = key
    account, instrument = evidence.accounts[aid], evidence.instruments[iid]
    state = evidence.states.get(iid, {})
    movements = evidence.movements[key]
    item = {
        "account_id": aid,
        "account_name": account.name,
        "instrument_id": iid,
        "name": instrument.name,
        "code": instrument.code,
        "currency": instrument.currency,
        "date": when,
        "status": "unavailable",
        "amount": None,
        "basis": None,
        "return_rate": None,
        "return_date": None,
        "nav_date": None,
        "quantity_source": None,
        "quantity": None,
        "base_nav": reference.get("base_nav"),
        "base_nav_date": reference.get("base_nav_date"),
        "quote_price": reference.get("price"),
        "quoted_at": reference.get("published_at"),
        "fetched_at": reference.get("fetched_at"),
        "source": reference.get("source"),
        "window_label": "参考区间待核实",
        "message": "参考数据不完整",
        "missing_reason_code": None,
    }
    formal = evidence.formal[iid]
    latest = formal[-1] if formal else None
    recent = (holding_items.get(key) or {}).get("latest_confirmed_return") or {}

    def formal_item(message):
        previous = next(
            (
                q
                for q in reversed(formal)
                if str(q.economic_date) == str(recent.get("interval_start"))
                and q.economic_date < latest.economic_date
            ),
            None,
        )
        result = {
            **item,
            "source": latest.source,
            "nav_date": latest.economic_date,
            "return_date": latest.economic_date,
            "date": latest.economic_date,
            "quote_price": latest.value,
            "quoted_at": latest.published_at,
            "formal_updated_at": latest.created_at,
            "old_reference_base_nav": reference.get("base_nav"),
            "old_reference_base_nav_date": reference.get("base_nav_date"),
            "base_nav": previous.value if previous else None,
            "base_nav_date": previous.economic_date if previous else None,
            "window_label": f"正式净值收益 · 归属 {latest.economic_date}",
            "message": message,
        }
        if recent.get("amount") is not None and str(recent.get("nav_date")) == str(
            latest.economic_date
        ):
            return {
                **result,
                "status": "formal",
                # Internal Decimal results may legitimately retain 36 places.
                "amount": recent["amount"],
                "basis": recent.get("basis"),
                "return_rate": recent.get("return_rate"),
                "quantity_source": recent.get("quantity_source"),
                "contains_automatic_estimates": recent.get(
                    "contains_automatic_estimates", False
                ),
                "interval_start": recent.get("interval_start"),
            }
        return {
            **result,
            "message": message
            + " "
            + (recent.get("message") or "尚缺可计算的正式收益基准。"),
            "missing_reason_code": "formal_return_unavailable",
        }

    def unavailable(message, reason):
        result = {**item, "message": message, "missing_reason_code": reason}
        if (
            reason
            not in {
                "reference_baseline",
                "reference_time",
                "reference_date",
                "reference_refresh",
            }
            or not latest
        ):
            return result
        # A failed reference is not evidence against an independently computed
        # formal return. It must never conceal unresolved accounting evidence.
        if any(
            str(recent.get("interval_start") or latest.economic_date)
            <= value
            <= str(when)
            for value in evidence.nav_quarantines.get(iid, {})
        ):
            return {
                **item,
                "message": "正式净值来源存在差异，待核对后重新计算",
                "missing_reason_code": "nav_conflict",
            }
        if any(m.get("date_error") for m in movements if m["date"] <= when):
            return {
                **item,
                "message": "持仓交易日期未核实，暂不计算收益",
                "missing_reason_code": "trade_date_unverified",
            }
        quantity = sum((m["quantity"] for m in movements if m["date"] <= when), ZERO)
        check = evidence.read_check(evidence.space, account, instrument, quantity, when)
        if check and check.get("status") == "unresolved":
            return {
                **item,
                "message": "原持仓范围待核对，暂不计算收益",
                "missing_reason_code": "holding_reconciliation",
            }
        if recent.get("amount") is None or str(recent.get("nav_date")) != str(
            latest.economic_date
        ):
            return result
        return {
            **formal_item(
                f"{message}；显示最近正式收益（净值归属 {latest.economic_date}），不与参考相加，二者覆盖区间不一定相同。"
            ),
            "reference_unavailable_reason_code": reason,
            "reference_unavailable_message": message,
        }

    if (
        reference.get("code") != instrument.code
        or reference.get("currency") != instrument.currency
        or reference.get("kind") != "reference_estimate"
    ):
        return unavailable("参考产品或币种不匹配", "reference_identity")
    try:
        if not reference.get("base_nav_date"):
            raise DomainError("参考基准日期缺失")
        base_day = day(reference["base_nav_date"])
        base = dec(reference["base_nav"], nonnegative=True, places=18)
        price = dec(reference["price"], nonnegative=True, places=18)
    except (DomainError, TypeError, KeyError):
        return unavailable("参考基准净值或日期缺失", "reference_baseline")
    if base <= ZERO or price <= ZERO or base_day > when:
        return unavailable("参考基准净值或日期无效", "reference_baseline")
    if any(
        str(base_day) <= value <= str(when)
        for value in evidence.nav_quarantines.get(iid, {})
    ):
        return unavailable("正式净值来源存在差异，待核对后重新计算", "nav_conflict")
    if latest and (
        latest.economic_date > base_day
        or latest.economic_date == base_day
        and latest.value != base
    ):
        return formal_item(
            "新正式净值已到，旧参考基准失效；正式收益按净值归属日展示，不与旧参考相加。"
        )
    if not latest or latest.economic_date != base_day or latest.value != base:
        return unavailable(
            "参考基准与账簿最新正式净值不一致，等待匹配数据", "reference_baseline"
        )
    published, fetched = (
        _stamp(reference.get("published_at")),
        _stamp(reference.get("fetched_at")),
    )
    now = timezone.now()
    local_zone = ZoneInfo(evidence.space.timezone)
    if (
        published is None
        or fetched is None
        or published > now
        or fetched > now
        or published > fetched
    ):
        return unavailable("参考报价或获取时间无效", "reference_time")
    if published.astimezone(local_zone).date() != when:
        return unavailable("参考报价不是本次查看日期的数据，等待更新", "reference_date")
    if (
        state.get("refresh_status") == "failed"
        or not 0 <= (now - fetched).total_seconds() <= 600
    ):
        return unavailable(
            "参考来源未及时更新，保留缺数并继续等待", "reference_refresh"
        )
    if reference.get("base_ratio_consistent") is not True:
        return unavailable(
            "参考价格与来源基准涨幅不一致，等待核实", "reference_baseline"
        )
    item["window_label"] = (
        f"净值基准 {base_day} → 报价 {published.astimezone(local_zone).isoformat(timespec='minutes')}；收益归属日待公布"
    )
    if any(m.get("date_error") for m in movements if m["date"] <= when):
        return unavailable(
            "持仓交易日期未核实，暂不推算参考收益", "trade_date_unverified"
        )
    if (
        any(base_day < m["date"] <= when for m in movements)
        or any(
            base_day < event.economic_date <= when for event in evidence.dividends[key]
        )
        or any(
            base_day < action["date"] <= when
            for action in evidence.actions.get(iid, [])
        )
    ):
        return unavailable(
            "参考区间内有交易、分红或份额变化，不能使用当前全部份额推算",
            "reference_movement",
        )
    quantity = sum((m["quantity"] for m in movements if m["date"] <= base_day), ZERO)
    if quantity <= ZERO:
        return unavailable(
            "缺少参考基准日有效持仓，不能倒推历史份额", "reference_quantity"
        )
    check = evidence.read_check(evidence.space, account, instrument, quantity, when)
    if check and check.get("status") == "unresolved":
        return unavailable(
            "原持仓范围待核对，暂不计算参考收益", "holding_reconciliation"
        )
    automatic = has_automatic_shares(evidence.space, movements, base_day)
    amount, basis = quantity * (price - base), quantity * base
    return {
        **item,
        "status": "estimated",
        "amount": amount,
        "basis": basis,
        "return_rate": amount / basis,
        "quantity": quantity,
        "quantity_source": "automatic_estimate" if automatic else "recorded",
        "contains_automatic_estimates": automatic,
        "message": "按已保存的来源参考报价及基准日有效份额计算；非实时净值，来源持仓覆盖未保证完整，收益归属日待公布。",
    }
