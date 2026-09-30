# 财务计算内核

独立、无数据库、无外部依赖的 Python 3.12 模块。以下计算不创建实账，不触发扣款。政策版本随返回值记录；机构实际计划和结算证据优先于测算。

所有金额、价格、份额、利率输入接受 `str` / `int` / `Decimal`，拒绝 `float`、`bool`、NaN 与 Infinity。局部 Decimal 精度为 160，不修改调用者的全局精度。日期接受 `date` 或 ISO 日期，返回 `date`；接口层应把 Decimal 转为字符串、日期转为 ISO，不能先转换为 float。

## API

```python
from finance_math import (
    add_months,
    loan_schedule,
    weighted_average_buy,
    weighted_average_sell,
    xirr,
    period_profit,
    available_cash,
    cashflow_scenario,
)

add_months(value, months, day_policy="clamp", anchor_day=None)
loan_schedule(
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
)
weighted_average_buy(quantity, total_cost, buy_quantity, unit_price, fee="0")
weighted_average_sell(quantity, total_cost, sell_quantity, unit_price, fee="0")
period_profit(opening_value, closing_value, external_inflows="0", external_outflows="0")
xirr(
    cashflows,
    lower_rate="-0.9999",
    upper_rate="1000",
    tolerance="1e-28",
    max_iterations=256,
)
available_cash(cash_balance, institution_frozen="0", reservations=None)
cashflow_scenario(opening_cash, start_date, end_date, items, reservations=None)
```

### 贷款及月历

- `annual_rate="0.03"` 表示年利率 3%。`nominal` 按年利率 / 12，`effective` 按 `(1+年利率)^(1/12)-1`。首期视为完整常规计息月；非整期、浮息、混合贷款必须使用机构逐期表。
- `method`：`annuity` 等额本息、`equal_principal` 等额本金、`custom` 自定义计划。每期利息和计划金额 `ROUND_HALF_UP` 舍入，最终一期本金吸收尾差；本金合计必须等于输入本金。零利率单独计算。
- `day_policy`：`clamp` 将短月缺失日期落到月末，下一月恢复原锚定日；`end_of_month` / `eom` 始终月底；`strict` 遇缺失日拒绝。首期日期不能与锚定日冲突。不会自行推断节假日顺延。
- `custom_rows` 每行：`due_date`, `principal`, `interest`, 可选 `fees`, `payment`。日期严格递增且首期相符，月供须等于本金＋利息＋费用；不改写机构日期。
- 返回 `rows` 每行包含 `installment`, `due_date`, `opening_balance`, `principal`, `interest`, `fees`, `payment`, `closing_balance`；`totals` 汇总本金、利息、费用、月供。稳定期次 ID、计划修订和实账幂等由业务层负责，此模块的行号不是永久 ID。

### 移动加权成本

- 买入：新增取得成本＝份额×价格＋买入费。返回新 `quantity`, `total_cost`, `average_cost`, `acquisition_cost`。
- 卖出：处置净额＝数量×价格－卖出费；处置损益＝净额－按比例释放的含费成本。全部卖出释放全部剩余成本，避免尾差残留。返回 `released_cost`, `net_proceeds`, `realized_profit` 及剩余持仓。
- `total_cost=None` 表示未知成本，已有持仓新增买入不会将未知部分补零；未知成本卖出的损益仍为 `None`。清仓后的剩余成本可归零，但不能据此改写本次处置损益。
- 这是管理口径，不是税务批次成本。费用已包含于成本/净额，汇总时不得再次减费；机构成本、真实批次由业务层保留。

### XIRR 与期间损益

`period_profit` 返回期末价值－期初价值－外部流入＋外部流出。内部划转不得传作外部流。所有值应在同一口径和币种下。

`xirr` 输入 `[{"date": "2025-01-01", "amount": "-100"}, ...]` 或 `(date, amount)` 列表。投入为负，取回为正；必须由调用者补齐期间期初和期末估值，同日现金流先合并。日期基准固定 ACT/365。

返回 `status` 为 `ok`, `multiple_roots`, `no_solution`, `not_converged`, `insufficient_data`；仅 `ok` 返回 `rate`，多解保留诊断用 `rates`，其余不填零。短于 365 天设置 `short_period=True`，UI 应解释短期年化放大。

算法在 `log(1+r)` 区间隔离指数和的零点，利用导函数极值分区，能够识别仅扫描变号会漏掉的相切根。`unique_within_search_interval` 只说明声明区间内、声明数值容差下的唯一性，不能宣称区间外无根；无解同样限于返回的搜索区间。正负号仅变化一次的常规现金流支持任意日期数；复杂非传统现金流超过 32 个非零日期会返回未收敛状态，避免假定唯一解。计算不是输入历史完整性的证明，业务层仍须在缺估值或现金流时禁止完整收益展示。

### 可用资金与情景

`available_cash` 预留行格式：`id`, `amount`, 可选 `linked_freeze_amount`, `active`, `paid`。关联冻结额从同笔系统预留中扣除，避免再次扣冻结；已支付/未启用预留不占用。返回 `available` 可为负数，`deficit` 为正缺口。

`cashflow_scenario` 的期初值是 `start_date` 当日事件之前的可动用现金。项目字段：`id`, `date`, **有符号** `amount`，可选 `status` (`planned` / `actual`), `occurrence_id`, `label`。同一期次的实际记录替换其计划；部分已支付且尚有未来余额时，应将剩余计划作为独立剩余期次传入。实际发生在预测开始之前时，期初现金应已含该实际影响，它不会再次计入本期。

同日汇总计算日终余额，不臆测日内先后顺序。返回 `rows`, `closing_cash`, `minimum_balance`, `minimum_date`, `first_deficit_date`。每次仅接受一个互斥情景，从同一起点独立计算。可选 `reservations` 仅用于全预测期间仍保持的独立预留；随计划消费释放的预留必须由业务层先转换为现金流，不能同时传入持久预留与同笔支出。

## 验证

在项目根目录运行：

```sh
PYTHONPATH=backend python3 -m unittest discover -s backend/tests -p test_finance_math.py -v
```

测试包含 V2 附录 A1 基金全生命周期净收益 4.80、A3 可安排资金 5,000、A4 期间损益 -120；零利率/跨年闰月/末期尾差/大额 360 期贷款；未知成本；XIRR 正负收益、多解、相切根、无解、未收敛、数据不足；预测替换与互斥情景。测试通过不等于完整产品的发布验收通过。
