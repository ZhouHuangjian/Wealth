import { accountKinds, kinds, states } from "./api.ts";

export const labels: Record<string, string> = {
  name: "名称",
  priority: "优先级",
  target_ratio: "目标占比",
  monthly_income: "每月收入",
  monthly_expense: "每月支出",
  budget: "预算金额",
  effective_from: "生效日期",
  plan_id: "收支计划",
  loan_id: "贷款计划",
  note_id: "投资手札",
  budget_id: "预算",
  strategy_id: "投资策略",
  snapshot_id: "机构权益记录",
  payment_event_id: "实际付款事项",
  title: "标题",
  body: "正文",
  description: "备注",
  category: "分类",
  kind: "类型",
  account_id: "资金账户",
  target_account_id: "转入账户",
  liability_account_id: "负债账户",
  account_ids: "关联账户",
  instrument_id: "投资产品",
  instrument_ids: "关联产品",
  primary_instrument_ids: "主要配置产品",
  tag_id: "投资标签",
  goal_id: "财富目标",
  scenario_id: "目标方案",
  reservation_id: "资金预留",
  event_id: "关联事项",
  related_event_id: "前一阶段事项",
  included_event_ids: "已计入权益的入金",
  currency: "币种",
  institution: "开户机构",
  owner_label: "持有人",
  tail: "账号尾号",
  opening_balance: "期初金额",
  opening_coverage: "期初权益包含范围",
  opening_coverage_confirmed: "已核对期初权益范围",
  opening_option_scope: "期初权益中的期权",
  opening_available: "期初可用资金",
  opening_date: "期初日期",
  funding_mode: "持仓资金来源",
  funding_account_id: "补足资金的账户",
  history_mode: "历史记录方式",
  valuation_date: "估值所属日期",
  institution_profit: "机构显示收益",
  reference_nav: "核对净值",
  reference_date: "核对净值日期",
  economic_date: "金额所属日期",
  as_of: "核对日期",
  valuation_mode: "账户计值方式",
  amount: "金额",
  quantity: "数量 / 份额",
  price: "成交单价",
  value: "价格 / 净值",
  rate: "汇率",
  base: "原币种",
  quote: "目标币种",
  cost: "持仓成本",
  equity: "机构总权益",
  coverage: "权益包含范围",
  complete: "已核对权益范围",
  includes_options: "总权益包含期权",
  published_at: "数据发布时间",
  source: "数据来源",
  purpose: "用途",
  code: "产品代码",
  market: "市场",
  share_class: "份额类别",
  status: "状态",
  archived: "已停用",
  enabled: "启用",
  frozen: "冻结金额",
  frequency: "频率",
  start_date: "开始日期",
  end_date: "结束日期",
  first_due_date: "首次还款日",
  due_date: "到期日",
  target_date: "目标日期",
  principal: "本金",
  annual_rate: "年利率（小数）",
  term_months: "还款期数",
  method: "还款方式",
  day_policy: "月末处理",
  rate_basis: "利率口径",
  tags: "标签",
  color: "标签颜色",
  target_weight: "目标占比（%）",
  match: "条件关系",
  conditions: "提醒条件",
  cooldown_hours: "提醒间隔（小时）",
  show_on_home: "首页显示",
  lookback_days: "回看天数",
  show_market_environment: "市场环境",
  show_valuation: "今日估值",
  show_signals: "条件提醒",
  side: "持仓方向",
  opening_price: "开仓价",
  current_value: "当前市值",
  settlement_price: "结算价",
  settlement_date: "结算价日期",
  contract_multiplier: "合约乘数",
  purchase_date: "开仓日期",
  closed_date: "平仓日期",
  institution_value: "机构显示金额 / 份额",
  metric: "判断参数",
  scope: "观察范围",
  operator: "比较方式",
  threshold: "触发值",
  baseline: "比较基准",
  reference_price: "自定基准值",
  fees: "手续费",
  fee: "手续费",
  tax: "税费",
  interest: "利息",
  linked_freeze_amount: "已关联冻结金额",
  released_at: "解除日期",
  payment_nodes: "付款安排",
  custom_rows: "自定义还款安排",
  total: "本息合计",
  date: "日期",
  paid: "已支付",
  is_paid: "已支付",
  ratio: "比例",
  note: "说明",
  timezone: "时区",
  calendar_id: "交易日历",
  provider: "行情来源",
  exchange: "交易所",
  option_type: "期权类型",
  option_right: "行权方向",
  strike: "行权价",
  expiry: "到期日",
  contract_month: "合约月份",
  underlying: "标的产品",
  multiplier: "乘数",
  settlement_days: "确认交易日数",
  settlement_cycle: "确认周期",
  nav_date: "净值日期",
  dividend_method: "分红方式",
  rounding_adjustment: "确认尾差",
  purchase_amount: "投入金额",
  target_amount: "目标金额",
  monthly_amount: "每月投入",
  capital: "本金",
  cash_amount: "资金金额",
  available: "可用金额",
  no_option_positions: "确认没有期权持仓",
  valuation_basis: "计值口径",
  valuation_observed_at: "核对时刻",
  specification: "产品设置",
  details: "补充信息",
  end_policy: "到期处理",
  date_rule: "日期规则",
  day_of_month: "每月日期",
  weekday: "每周日期",
  rate_changes: "利率调整",
  remaining_principal: "剩余本金",
};

const productKinds = {
  fund: "基金",
  stock: "股票",
  etf: "ETF",
  future: "期货",
  option: "期权",
  gold: "黄金",
  index: "指数",
};
export function fieldOptions(
  category: string,
  key: string,
): Record<string, string> | undefined {
  if (key === "purpose" && category !== "fx") return undefined;
  if (key === "scope" && category !== "signal-rules") return undefined;
  if (key === "kind")
    return category === "accounts"
      ? accountKinds
      : category === "instruments"
        ? productKinds
        : category === "events"
          ? kinds
          : category === "plans"
            ? { expense: "支出计划", income: "收入计划", dca: "定投计划" }
            : category === "prices"
              ? {
                  official_nav: "正式净值",
                  close: "收盘价",
                  settlement: "结算价",
                  intraday_estimate: "盘中估值",
                  realtime: "实时价",
                }
              : category === "reconciliations"
                ? {
                    cash: "账户现金",
                    position: "持仓份额",
                    liability: "借款本金",
                    equity: "机构总权益",
                  }
                : undefined;
  if (["currency", "base", "quote"].includes(key))
    return { CNY: "人民币 CNY", USD: "美元 USD", HKD: "港币 HKD" };
  if (key === "status") {
    const keys =
      category === "notes"
        ? ["draft", "published", "archived"]
        : category === "reservations"
          ? ["active", "released", "consumed"]
          : category === "option-holdings"
            ? ["active", "closed"]
            : ["draft", "active", "paused", "completed", "archived"];
    return Object.fromEntries(
      keys.map((k) => [k, states[k] || (k === "closed" ? "已关闭" : k)]),
    );
  }
  return (
    {
      frequency: { daily: "每日", weekly: "每周", monthly: "每月" },
      valuation_mode: { detailed: "现金与持仓合计", snapshot: "机构总权益" },
      method: {
        annuity: "等额本息",
        equal_principal: "等额本金",
        custom: "自定义",
      },
      side: { long: "买入持仓", short: "卖出持仓" },
      match: { all: "全部满足", any: "任一满足" },
      metric: {
        drawdown: "从基准回撤",
        change_percent: "单日涨跌幅",
        price: "价格 / 点位",
      },
      scope: { instrument: "单个产品 / 指数", tag: "整个标签" },
      operator: { gte: "大于等于", lte: "小于等于" },
      baseline: {
        rolling_high: "阶段高点",
        cost: "持仓成本",
        manual: "自定基准",
      },
      purpose: { valuation: "估值汇率" },
      dividend_method: { cash: "现金分红", reinvest: "红利再投" },
      opening_option_scope: {
        unknown: "尚未核对",
        includes_options: "总权益已包含期权",
        no_options: "确认没有期权持仓",
      },
      funding_mode: {
        external: "另行补录已有持仓",
        allocate: "从机构留存资金分配",
      },
      history_mode: {
        snapshot_only: "仅录入当前持仓",
        unchanged_holding: "确认期间份额未变化，按历史净值回看",
      },
    } as Record<string, Record<string, string>>
  )[key];
}

export const references: Record<string, string> = {
  plan_id: "plans",
  loan_id: "loans",
  note_id: "notes",
  budget_id: "budgets",
  strategy_id: "strategies",
  snapshot_id: "snapshots",
  payment_event_id: "events",
  account_id: "accounts",
  target_account_id: "accounts",
  liability_account_id: "accounts",
  account_ids: "accounts",
  instrument_id: "instruments",
  instrument_ids: "instruments",
  primary_instrument_ids: "instruments",
  tag_id: "investment-tags",
  goal_id: "goals",
  scenario_id: "scenarios",
  reservation_id: "reservations",
  event_id: "events",
  related_event_id: "events",
  included_event_ids: "events",
  funding_account_id: "accounts",
};
export const numeric = new Set(
  "amount quantity price value rate cost institution_profit reference_nav equity frozen principal annual_rate term_months target_weight cooldown_hours lookback_days opening_price current_value settlement_price contract_multiplier institution_value threshold reference_price fees fee tax interest linked_freeze_amount total ratio multiplier strike opening_balance available monthly_amount target_amount".split(
    " ",
  ),
);
export const collectionDefaults: Record<string, Record<string, unknown>> = {
  conditions: {
    metric: "drawdown",
    scope: "instrument",
    instrument_id: "",
    operator: "gte",
    threshold: "10",
    baseline: "rolling_high",
    lookback_days: 365,
  },
  payment_nodes: { name: "", date: "", amount: "", currency: "CNY" },
  custom_rows: { due_date: "", principal: "", interest: "" },
  rate_changes: { date: "", annual_rate: "" },
};
export function editableValues(values: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !key.startsWith("_") && !systemFields.has(key),
    ),
  );
}

export const systemFields = new Set([
  "id",
  "tenant_id",
  "created_by_id",
  "created_at",
  "version",
  "storage_key",
  "token_hash",
  "operation_id",
  "stage_key",
  "opening_source",
  "holding_funding_transfer",
  "opening_event_id",
]);
export const fieldLabel = (key: string) => labels[key] || `补充字段 · ${key}`;

export const optionalFields: Record<string, Record<string, any>> = {
  accounts: {
    owner_label: "",
    tail: "",
    frozen: "0",
    valuation_mode: "detailed",
    opening_coverage: "",
    opening_coverage_confirmed: false,
    opening_option_scope: "unknown",
    opening_available: "",
  },
  instruments: {
    share_class: "",
    account_ids: [],
    specification: {
      exchange: "",
      contract_multiplier: "",
      option_right: "",
      strike: "",
      expiry: "",
    },
  },
  events: {
    target_account_id: "",
    instrument_id: "",
    related_event_id: "",
    quantity: "",
    price: "",
    cost: "",
    fee: "0",
    tax: "0",
    principal: "",
    interest: "",
  },
  prices: { published_at: null },
  snapshots: { details: { available: "", no_option_positions: false } },
  plans: { end_date: "", category: "", description: "" },
  loans: { custom_rows: [], description: "" },
  goals: { payment_nodes: [], description: "", target_date: "" },
  scenarios: { payment_nodes: [], description: "" },
  reservations: {
    goal_id: "",
    scenario_id: "",
    linked_freeze_amount: "0",
    description: "",
  },
  notes: { instrument_id: "", event_id: "", goal_id: "", kind: "journal" },
  "investment-tags": { primary_instrument_ids: [] },
  "market-watchlist": { lookback_days: 365 },
  "option-holdings": {
    settlement_price: "",
    settlement_date: "",
    closed_date: "",
  },
};
