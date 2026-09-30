"""Deterministic management-accounting calculations, policy version 1."""

from calendar import monthrange
from datetime import date, datetime
from decimal import Decimal, DecimalException, ROUND_HALF_UP, localcontext
from functools import wraps


ZERO = Decimal("0")
ONE = Decimal("1")
PRECISION = 160


def _context(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            with localcontext() as context:
                context.prec = PRECISION
                context.rounding = ROUND_HALF_UP
                return function(*args, **kwargs)
        except DecimalException as exc:
            raise ValueError("数值超出计算范围或无法计算，请检查输入") from exc

    return wrapped


def _decimal(value, name="金额", minimum=None):
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise ValueError(f"{name}必须使用十进制字符串、整数或 Decimal，不接受浮点数")
    try:
        result = Decimal(value)
    except (DecimalException, ValueError) as exc:
        raise ValueError(f"{name}不是有效十进制数") from exc
    if not result.is_finite():
        raise ValueError(f"{name}必须是有限数值")
    if minimum is not None and result < minimum:
        raise ValueError(f"{name}不得小于 {minimum}")
    return result


def _date(value, name="日期"):
    if isinstance(value, datetime):
        raise ValueError(f"{name}必须是不含时区和时间的业务日期")
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise ValueError(f"{name}必须是 YYYY-MM-DD 或 date")


def _integer(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{name}必须是大于等于 {minimum} 的整数")
    return value


def add_months(value, months, day_policy="clamp", anchor_day=None):
    """Shift a date with an explicit short-month rule; never infer holidays.

    clamp: requested day or last day; end_of_month: always month end;
    strict: reject missing dates. To preserve a 31st anchor, pass the original
    date plus each offset (not the previous returned date), or anchor_day=31.
    """
    value = _date(value)
    if isinstance(months, bool) or not isinstance(months, int):
        raise ValueError("月份偏移必须是整数")
    anchor = value.day if anchor_day is None else _integer(anchor_day, "锚定日", 1)
    if anchor > 31:
        raise ValueError("锚定日不得超过 31")
    month_index = value.year * 12 + value.month - 1 + months
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    if not 1 <= year <= 9999:
        raise ValueError("日期超出支持范围")
    last_day = monthrange(year, month)[1]
    if day_policy in ("end_of_month", "eom"):
        day = last_day
    elif day_policy == "clamp":
        day = min(anchor, last_day)
    elif day_policy == "strict":
        if anchor > last_day:
            raise ValueError("该月不存在约定还款日，请选择短月处理规则")
        day = anchor
    else:
        raise ValueError("未知短月规则：支持 clamp、end_of_month、strict")
    return date(year, month, day)


def _quantum(value):
    quantum = _decimal(value, "金额最小单位")
    if quantum <= ZERO or quantum != Decimal(1).scaleb(quantum.adjusted()):
        raise ValueError("金额最小单位必须是 10 的整数次幂，例如 0.01")
    return quantum


@_context
def loan_schedule(
    principal,
    annual_rate,
    periods,
    first_due_date,
    method="annuity",
    custom_rows=None,
    day_policy="clamp",
    quantum="0.01",
    rate_basis="nominal",
    anchor_day=None,
):
    """Fixed monthly schedule or validated lender rows; annual_rate .03 = 3%.

    Returns rows and totals. Monthly interest is HALF_UP rounded. Final
    principal absorbs rounding residuals. No irregular-first-period accrual or
    holiday inference: use custom_rows for the actual institution schedule.
    """
    principal = _decimal(principal, "本金", ZERO)
    annual_rate = _decimal(annual_rate, "年利率", ZERO)
    periods = _integer(periods, "期数", 1)
    first_due_date = _date(first_due_date, "首期日期")
    quantum = _quantum(quantum)
    if principal != principal.quantize(quantum):
        raise ValueError("本金超过指定金额精度")
    if method not in ("annuity", "equal_principal", "custom"):
        raise ValueError("未知还款方式：支持 annuity、equal_principal、custom")
    if rate_basis == "nominal":
        monthly_rate = annual_rate / Decimal(12)
    elif rate_basis == "effective":
        monthly_rate = (ONE + annual_rate) ** (ONE / Decimal(12)) - ONE
    else:
        raise ValueError("利率换算规则必须是 nominal 或 effective")
    if method == "custom":
        if not isinstance(custom_rows, (list, tuple)) or len(custom_rows) != periods:
            raise ValueError("自定义计划行数必须等于期数")
    elif custom_rows is not None:
        raise ValueError("固定利率计划不能同时传入自定义逐期表")
    if monthly_rate == ZERO:
        unrounded_payment = principal / Decimal(periods)
    else:
        factor = (ONE + monthly_rate) ** periods
        unrounded_payment = principal * monthly_rate * factor / (factor - ONE)
    base_payment = unrounded_payment.quantize(quantum)
    base_principal = (principal / Decimal(periods)).quantize(quantum)
    balance, rows, previous_date = principal, [], None
    for index in range(periods):
        opening = balance
        if method == "custom":
            source = custom_rows[index]
            if not isinstance(source, dict):
                raise ValueError("自定义计划每行必须是对象")
            due_date = _date(source.get("due_date"), "自定义还款日期")
            if index == 0 and due_date != first_due_date:
                raise ValueError("自定义计划首期日期与输入不一致")
            paid_principal = _decimal(source.get("principal"), "逐期本金", ZERO)
            interest = _decimal(source.get("interest", "0"), "逐期利息", ZERO)
            fees = _decimal(source.get("fees", "0"), "逐期费用", ZERO)
            if any(v != v.quantize(quantum) for v in (paid_principal, interest, fees)):
                raise ValueError("自定义计划超过指定金额精度")
            if paid_principal > balance:
                raise ValueError("还款本金超过剩余本金")
            if (
                "payment" in source
                and _decimal(source["payment"], "月供")
                != paid_principal + interest + fees
            ):
                raise ValueError("月供必须等于本金、利息和费用之和")
        else:
            due_date = add_months(first_due_date, index, day_policy, anchor_day)
            if index == 0 and due_date != first_due_date:
                raise ValueError("首期日期与锚定日或月末规则冲突")
            interest = (opening * monthly_rate).quantize(quantum)
            fees = ZERO.quantize(quantum)
            if index == periods - 1:
                paid_principal = balance
            elif method == "equal_principal":
                paid_principal = min(base_principal, balance)
            else:
                paid_principal = min(max(base_payment - interest, ZERO), balance)
        if previous_date is not None and due_date <= previous_date:
            raise ValueError("逐期还款日期必须严格递增")
        balance = opening - paid_principal
        rows.append(
            {
                "installment": index + 1,
                "due_date": due_date,
                "opening_balance": opening,
                "principal": paid_principal,
                "interest": interest,
                "fees": fees,
                "payment": paid_principal + interest + fees,
                "closing_balance": balance,
            }
        )
        previous_date = due_date
    if balance != ZERO:
        raise ValueError("自定义计划本金合计必须等于贷款本金")
    totals = {
        key: sum((row[key] for row in rows), ZERO)
        for key in ("principal", "interest", "fees", "payment")
    }
    return {
        "method": method,
        "rate_basis": rate_basis,
        "annual_rate": annual_rate,
        "monthly_rate": monthly_rate,
        "day_policy": day_policy,
        "rounding": "ROUND_HALF_UP",
        "quantum": quantum,
        "rows": rows,
        "totals": totals,
        "policy_version": "loan-monthly-v1",
        "is_forecast": True,
        "first_period_assumption": "regular_month"
        if method != "custom"
        else "institution_schedule",
    }


def _position(quantity, total_cost):
    quantity = _decimal(quantity, "持仓数量", ZERO)
    total_cost = None if total_cost is None else _decimal(total_cost, "总成本", ZERO)
    if quantity == ZERO and total_cost not in (ZERO, None):
        raise ValueError("零持仓不得存在非零取得成本")
    return quantity, total_cost


@_context
def weighted_average_buy(quantity, total_cost, buy_quantity, unit_price, fee="0"):
    """Buy fee is capitalized once; unknown legacy cost remains unknown."""
    quantity, total_cost = _position(quantity, total_cost)
    buy_quantity = _decimal(buy_quantity, "买入数量", ZERO)
    unit_price = _decimal(unit_price, "买入价格", ZERO)
    fee = _decimal(fee, "买入费用", ZERO)
    if buy_quantity == ZERO:
        raise ValueError("买入数量必须大于零")
    acquisition_cost = buy_quantity * unit_price + fee
    new_quantity = quantity + buy_quantity
    # An empty position has no unknown historical holding to contaminate cost.
    new_cost = (
        acquisition_cost
        if quantity == ZERO
        else (None if total_cost is None else total_cost + acquisition_cost)
    )
    return {
        "quantity": new_quantity,
        "total_cost": new_cost,
        "average_cost": None if new_cost is None else new_cost / new_quantity,
        "acquisition_cost": acquisition_cost,
        "buy_fee": fee,
        "cost_status": "unknown" if new_cost is None else "known",
        "policy_version": "moving-average-fees-in-cost-v1",
    }


@_context
def weighted_average_sell(quantity, total_cost, sell_quantity, unit_price, fee="0"):
    """Net proceeds minus released fee-inclusive cost; never subtract buy fee twice."""
    quantity, total_cost = _position(quantity, total_cost)
    sell_quantity = _decimal(sell_quantity, "卖出数量", ZERO)
    unit_price = _decimal(unit_price, "卖出价格", ZERO)
    fee = _decimal(fee, "卖出费用", ZERO)
    if sell_quantity == ZERO or sell_quantity > quantity:
        raise ValueError("卖出数量必须大于零且不超过持仓数量")
    remaining = quantity - sell_quantity
    net_proceeds = sell_quantity * unit_price - fee
    released_cost = (
        None
        if total_cost is None
        else (
            total_cost if remaining == ZERO else total_cost * sell_quantity / quantity
        )
    )
    new_cost = (
        ZERO
        if remaining == ZERO
        else (None if total_cost is None else total_cost - released_cost)
    )
    return {
        "quantity": remaining,
        "total_cost": new_cost,
        "average_cost": None
        if new_cost is None
        else (new_cost / remaining if remaining else ZERO),
        "released_cost": released_cost,
        "net_proceeds": net_proceeds,
        "realized_profit": None
        if released_cost is None
        else net_proceeds - released_cost,
        "sell_fee": fee,
        "cost_status": "unknown" if released_cost is None else "known",
        "policy_version": "moving-average-fees-in-cost-v1",
    }


@_context
def period_profit(
    opening_value, closing_value, external_inflows="0", external_outflows="0"
):
    """Portfolio boundary defines external flows; internal transfers are excluded."""
    opening = _decimal(opening_value, "期初价值")
    closing = _decimal(closing_value, "期末价值")
    inflows = _decimal(external_inflows, "外部流入", ZERO)
    outflows = _decimal(external_outflows, "外部流出", ZERO)
    return closing - opening - inflows + outflows


class _NoConvergence(Exception):
    pass


def _variations(terms):
    signs = [coefficient > ZERO for coefficient, _ in terms if coefficient]
    return sum(left != right for left, right in zip(signs, signs[1:]))


def _isolate_roots(terms, lower, upper, tolerance, max_iterations):
    """Isolate zeros of an exponential sum through its derivative extrema.

    Positive exponential normalization removes one term at each derivative.
    This also detects even-multiplicity/tangent roots, unlike a sign-grid scan.
    """
    origin = terms[0][1]
    terms = [
        (coefficient, exponent - origin)
        for coefficient, exponent in terms
        if coefficient
    ]
    variations = _variations(terms)
    if variations == 0:
        return []
    magnitude = sum((abs(coefficient) for coefficient, _ in terms), ZERO)
    terms = [(coefficient / magnitude, exponent) for coefficient, exponent in terms]

    def evaluate(point):
        # Scale all exponentials by the largest exponent to avoid large values.
        exponents = [-exponent * point for _, exponent in terms]
        largest = max(exponents)
        values = [
            coefficient * (exponent - largest).exp()
            for (coefficient, _), exponent in zip(terms, exponents)
        ]
        return sum(values, ZERO) / sum((abs(value) for value in values), ZERO)

    if variations == 1:
        stationary = []
    else:
        if len(terms) > 32:
            raise _NoConvergence("非传统现金流日期过多，未证明根的唯一性")
        derivative = [
            (-coefficient * exponent, exponent)
            for coefficient, exponent in terms
            if exponent != ZERO
        ]
        stationary = _isolate_roots(derivative, lower, upper, tolerance, max_iterations)
    boundaries = [lower, *stationary, upper]
    roots = []
    for point in boundaries:
        if abs(evaluate(point)) <= tolerance:
            roots.append(point)
    for left, right in zip(boundaries, boundaries[1:]):
        left_value, right_value = evaluate(left), evaluate(right)
        if abs(left_value) <= tolerance or abs(right_value) <= tolerance:
            continue
        if (left_value > ZERO) == (right_value > ZERO):
            continue
        for _ in range(max_iterations):
            middle = (left + right) / Decimal(2)
            middle_value = evaluate(middle)
            if abs(middle_value) <= tolerance and right - left <= tolerance.sqrt():
                roots.append(middle)
                break
            if (left_value > ZERO) == (middle_value > ZERO):
                left, left_value = middle, middle_value
            else:
                right = middle
        else:
            raise _NoConvergence("在迭代上限内未收敛")
    distinct = []
    for root in sorted(roots):
        if not distinct or abs(root - distinct[-1]) > tolerance.sqrt():
            distinct.append(root)
    return distinct


@_context
def xirr(
    cashflows,
    lower_rate="-0.9999",
    upper_rate="1000",
    tolerance="1e-28",
    max_iterations=256,
):
    """ACT/365 XIRR with explicit bounded search and ambiguous-result states.

    cashflows: [{date: ISO/date, amount: Decimal/string}, ...] or (date, amount)
    pairs. Investor contributions are negative; withdrawals/ending value positive.
    Aggregate same-day flows. Caller must include opening and closing valuations.
    """
    lower = _decimal(lower_rate, "收益率搜索下界")
    upper = _decimal(upper_rate, "收益率搜索上界")
    tolerance = _decimal(tolerance, "收敛容差")
    max_iterations = _integer(max_iterations, "迭代次数", 1)
    if lower <= -ONE or upper <= lower:
        raise ValueError("搜索区间必须满足 -1 < 下界 < 上界")
    if not ZERO < tolerance < Decimal("0.000001"):
        raise ValueError("收敛容差须大于零且小于 0.000001")
    if not isinstance(cashflows, (list, tuple)):
        raise ValueError("现金流必须为日期与金额组成的列表")
    aggregated = {}
    for item in cashflows:
        if isinstance(item, dict):
            day, amount = item.get("date"), item.get("amount")
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            day, amount = item
        else:
            raise ValueError("每笔现金流须包含日期与金额")
        day, amount = _date(day), _decimal(amount, "现金流金额")
        aggregated[day] = aggregated.get(day, ZERO) + amount
    flows = sorted(
        (day, amount) for day, amount in aggregated.items() if amount != ZERO
    )
    result = {
        "status": None,
        "rate": None,
        "rates": [],
        "day_count": "ACT/365",
        "search_interval": [lower, upper],
        "tolerance": tolerance,
        "policy_version": "xirr-exponential-isolation-v1",
        "unique_within_search_interval": False,
        "annualized": True,
        "short_period": False,
        "message": "",
    }
    if len(flows) < 2:
        result.update(
            status="insufficient_data", message="至少需要两个不同日期的非零现金流"
        )
        return result
    result["short_period"] = (flows[-1][0] - flows[0][0]).days < 365
    if not (
        any(amount < ZERO for _, amount in flows)
        and any(amount > ZERO for _, amount in flows)
    ):
        result.update(
            status="no_solution", message="现金流须同时包含投资支出和回收价值"
        )
        return result
    origin = flows[0][0]
    terms = [
        (amount, Decimal((day - origin).days) / Decimal(365)) for day, amount in flows
    ]
    try:
        roots = _isolate_roots(
            terms, (ONE + lower).ln(), (ONE + upper).ln(), tolerance, max_iterations
        )
    except _NoConvergence as exc:
        result.update(status="not_converged", message=str(exc))
        return result
    rates = [root.exp() - ONE for root in roots]
    if not rates:
        result.update(status="no_solution", message="指定收益率搜索区间内未找到解")
    elif len(rates) > 1:
        result.update(
            status="multiple_roots",
            rates=rates,
            message="存在多个收益率解，不展示唯一年化收益率",
        )
    else:
        result.update(
            status="ok",
            rates=rates,
            rate=rates[0],
            unique_within_search_interval=True,
            message="搜索区间内唯一解；年化收益率受现金流与估值完整性限制",
        )
    return result


@_context
def available_cash(cash_balance, institution_frozen="0", reservations=None):
    """Avoid counting a reservation twice when it covers the same frozen funds.

    reservations: {id, amount, linked_freeze_amount='0', active=True, paid=False}.
    Exceeding available funds is returned as a deficit, never filled by holdings.
    """
    balance = _decimal(cash_balance, "现金余额")
    frozen = _decimal(institution_frozen, "机构冻结金额", ZERO)
    if reservations is not None and not isinstance(reservations, (list, tuple)):
        raise ValueError("资金预留必须为列表")
    reserved, linked, seen = ZERO, ZERO, set()
    for reservation in reservations or []:
        if (
            not isinstance(reservation, dict)
            or not isinstance(reservation.get("id"), str)
            or not reservation["id"]
        ):
            raise ValueError("每笔预留须有唯一编号")
        identifier = reservation["id"]
        if identifier in seen:
            raise ValueError("预留编号重复")
        seen.add(identifier)
        if not reservation.get("active", True) or reservation.get("paid", False):
            continue
        amount = _decimal(reservation.get("amount"), "预留金额", ZERO)
        overlap = _decimal(
            reservation.get("linked_freeze_amount", "0"), "关联冻结金额", ZERO
        )
        if overlap > amount:
            raise ValueError("关联冻结金额不能超过该笔预留")
        reserved += amount - overlap
        linked += overlap
    if linked > frozen:
        raise ValueError("预留关联的冻结总额超过机构冻结金额")
    available = balance - frozen - reserved
    return {
        "cash_balance": balance,
        "institution_frozen": frozen,
        "additional_reservations": reserved,
        "linked_freeze_amount": linked,
        "available": available,
        "deficit": max(-available, ZERO),
    }


@_context
def cashflow_scenario(opening_cash, start_date, end_date, items, reservations=None):
    """Project one independent scenario; never persist or execute payments.

    opening_cash is cash immediately BEFORE start_date. Signed amounts: positive
    inflow, negative outflow. Items: id,date,amount,status ('planned'/'actual'),
    optional occurrence_id. Actual rows replace planned rows of the same
    occurrence; partial remaining plans need their own distinct occurrence ID.
    Reservations optionally describe holds outstanding throughout this forecast.
    """
    start, end = _date(start_date), _date(end_date)
    if end < start:
        raise ValueError("预测结束日期不能早于开始日期")
    opening = _decimal(opening_cash, "期初可动用现金")
    if not isinstance(items, (list, tuple)):
        raise ValueError("预测项目必须为列表")
    normalized, seen = [], set()
    actual_occurrences = set()
    for item in items:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or not item["id"]
        ):
            raise ValueError("预测项目须有唯一编号")
        if item["id"] in seen:
            raise ValueError("预测项目编号重复")
        seen.add(item["id"])
        status = item.get("status", "planned")
        if status not in ("actual", "planned"):
            raise ValueError("预测项目状态必须是 planned 或 actual")
        if item.get("occurrence_id") is not None and not isinstance(
            item["occurrence_id"], str
        ):
            raise ValueError("计划期次编号必须是字符串")
        row = {
            "id": item["id"],
            "date": _date(item.get("date")),
            "amount": _decimal(item.get("amount"), "预测金额"),
            "status": status,
            "occurrence_id": item.get("occurrence_id"),
            "label": str(item.get("label", "")),
        }
        normalized.append(row)
        if status == "actual" and row["occurrence_id"]:
            actual_occurrences.add(row["occurrence_id"])
    effective = [
        row
        for row in normalized
        if start <= row["date"] <= end
        and not (
            row["status"] == "planned" and row["occurrence_id"] in actual_occurrences
        )
    ]
    effective.sort(key=lambda row: (row["date"], str(row["id"])))
    holds = available_cash(opening, reservations=reservations)[
        "additional_reservations"
    ]
    balance, minimum = opening, opening - holds
    minimum_date = start
    first_deficit = start if minimum < ZERO else None
    rows = []
    by_date = {}
    for row in effective:
        by_date.setdefault(row["date"], []).append(row)
    for day, day_items in sorted(by_date.items()):
        inflows = sum(
            (row["amount"] for row in day_items if row["amount"] > ZERO), ZERO
        )
        outflows = -sum(
            (row["amount"] for row in day_items if row["amount"] < ZERO), ZERO
        )
        balance += inflows - outflows
        spendable = balance - holds
        if spendable < minimum:
            minimum, minimum_date = spendable, day
        if first_deficit is None and spendable < ZERO:
            first_deficit = day
        rows.append(
            {
                "date": day,
                "inflows": inflows,
                "outflows": outflows,
                "closing_cash": balance,
                "spendable": spendable,
                "items": day_items,
            }
        )
    return {
        "opening_cash": opening,
        "closing_cash": balance,
        "closing_spendable": balance - holds,
        "minimum_balance": minimum,
        "minimum_date": minimum_date,
        "first_deficit_date": first_deficit,
        "rows": rows,
        "is_forecast": True,
        "intraday_order": "unknown",
        "policy_version": "daily-cashflow-scenario-v1",
    }
