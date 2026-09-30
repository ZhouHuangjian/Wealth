type Values = Record<string, any>;

export const dcaHoldingKinds = ["fund", "broker", "securities"];
export const dcaAutomationNotice =
  "只补记账，不向银行或基金平台发起扣款；按计划和正式净值推算，保留自动推算标记，可后续核对。";

export function validDcaDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function dcaAutomationInitial(plan: Values, today: string): Values {
  if (!validDcaDate(today)) throw new Error("无法确定今天的日期，请刷新页面");
  const automation = plan.automation || {};
  const earliest =
    validDcaDate(plan.start_date) && plan.start_date > today
      ? plan.start_date
      : today;
  return {
    automatic_enabled: automation.enabled === true,
    automatic_start_date:
      automation.enabled === true && validDcaDate(automation.start_date)
        ? automation.start_date
        : earliest,
    target_account_id: automation.holding_account_id || plan.account_id,
    automatic_fee_mode: automation.fee_mode || "unknown",
    automatic_fee_amount: ["fixed", "rate"].includes(automation.fee_mode)
      ? automation.fee_amount
      : undefined,
    automatic_funding_source: automation.funding_source || "account",
    automatic_excluded_dates: (automation.excluded_dates || []).join("\n"),
    automatic_pause_ranges: (automation.pause_ranges || []).map(
      (range: Values) => ({ start: range.start, end: range.end }),
    ),
  };
}

function decimal(value: unknown, places: number, label: string): bigint {
  const text = String(value ?? "").trim();
  if (!new RegExp(`^\\d{1,40}(\\.\\d{1,${places}})?$`).test(text))
    throw new Error(`${label}须为非负数，最多 ${places} 位小数`);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(18, "0"));
}

export function dcaAutomationConfiguration(
  values: Values,
  previous?: Values,
): Values {
  // A hidden, previously edited field must never enable bookkeeping or prevent disabling it.
  if (values.automatic_enabled !== true) {
    const kept = Object.fromEntries(
      [
        "start_date",
        "holding_account_id",
        "fee_mode",
        "fee_amount",
        "excluded_dates",
        "pause_ranges",
        "funding_source",
      ]
        .filter((key) => previous?.[key] !== undefined)
        .map((key) => [key, previous![key]]),
    );
    return { ...kept, enabled: false };
  }
  const start = values.automatic_start_date;
  if (!validDcaDate(start)) throw new Error("请选择有效的自动补录生效日期");
  if (!validDcaDate(values.start_date) || start < values.start_date)
    throw new Error("自动补录生效日期不能早于计划首期日期");
  if (
    typeof values.target_account_id !== "string" ||
    !values.target_account_id.trim()
  )
    throw new Error("请选择基金或券商持仓账户");
  const feeMode = values.automatic_fee_mode || "unknown";
  if (!["unknown", "zero", "fixed", "rate"].includes(feeMode))
    throw new Error("请选择有效的费用规则");
  const amount = decimal(values.amount, 18, "每期计划金额");
  if (amount <= 0n) throw new Error("每期计划金额须大于零");
  let feeAmount: string | undefined;
  if (["fixed", "rate"].includes(feeMode)) {
    const fee = decimal(
      values.automatic_fee_amount,
      feeMode === "rate" ? 6 : 2,
      "申购费用",
    );
    if (feeMode === "fixed" && fee >= amount)
      throw new Error("每期手续费须小于每期计划金额");
    if (feeMode === "rate" && fee > 100n * 10n ** 18n)
      throw new Error("费率不能超过 100%");
    feeAmount = String(values.automatic_fee_amount).trim();
  }
  const rawDates = String(values.automatic_excluded_dates || "").trim();
  const dates = rawDates ? rawDates.split(/[\s,，;；]+/).filter(Boolean) : [];
  if (dates.length > 1097 || dates.some((value) => !validDcaDate(value)))
    throw new Error("排除日期须为有效日期，每行一个，最多 1097 天");
  const pauses = values.automatic_pause_ranges || [];
  if (!Array.isArray(pauses) || pauses.length > 100)
    throw new Error("暂停区间最多 100 段");
  const ranges = pauses.map((range: Values) => {
    if (
      !range ||
      !validDcaDate(range.start) ||
      !validDcaDate(range.end) ||
      range.start > range.end
    )
      throw new Error("请填写有效的暂停开始日和结束日，开始日不能晚于结束日");
    return { start: range.start, end: range.end };
  });
  return {
    enabled: true,
    start_date: start,
    holding_account_id: values.target_account_id,
    ...(values.automatic_funding_source === "untracked"
      ? { funding_source: "untracked" }
      : {}),
    fee_mode: feeMode,
    ...(feeAmount !== undefined ? { fee_amount: feeAmount } : {}),
    excluded_dates: [...new Set(dates)].sort(),
    pause_ranges: ranges,
  };
}

export function dcaPlanPayload(values: Values, previous?: Values): Values {
  const fields = [
    "name",
    "kind",
    "account_id",
    "instrument_id",
    "amount",
    "currency",
    "start_date",
    "frequency",
    "status",
  ];
  return {
    ...Object.fromEntries(
      fields
        .filter((key) => values[key] !== undefined)
        .map((key) => [key, values[key]]),
    ),
    automation: dcaAutomationConfiguration(values, previous?.automation),
    ...(previous ? { version: validPlanVersion(previous.version) } : {}),
  };
}

function validPlanVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("计划版本缺失，请关闭窗口后重新读取");
  return Number(value);
}

export function dcaAutomationRunRequest(plan: Values) {
  return { expected_plan_version: validPlanVersion(plan.version) };
}

const statusLabels: Record<string, string> = {
  scheduled: "等待自动检查",
  disabled: "自动补录已关闭",
  paused: "计划已暂停",
  excluded: "已排除",
  waiting_calendar: "交易日待核实",
  waiting_cash: "资金不足",
  waiting_nav: "等待正式净值",
  waiting_confirmation: "等待确认日",
  waiting_fee: "等待费用设置",
  recorded_estimate: "已自动推算入账",
  already_recorded: "已有记录",
  needs_review: "需要核对",
};

export function dcaAutomationStatusLabel(status: unknown): string {
  return statusLabels[String(status)] || "状态待核实";
}

export function dcaAutomationSummary(data: Values | null): string {
  if (!data) return "状态待读取";
  const summary = data.summary || {};
  const priorities = [
    "needs_review",
    "waiting_cash",
    "waiting_calendar",
    "waiting_fee",
    "waiting_nav",
    "waiting_confirmation",
    "scheduled",
    "recorded_estimate",
    "already_recorded",
    "excluded",
    "paused",
    "disabled",
  ];
  const states = priorities.filter(
    (status) => Number.isSafeInteger(summary[status]) && summary[status] > 0,
  );
  if (!states.length) return data.enabled ? "暂无到期待办" : "自动补录已关闭";
  const text = states
    .slice(0, 2)
    .map(
      (status) => `${dcaAutomationStatusLabel(status)} ${summary[status]} 期`,
    )
    .join(" · ");
  return data.has_more ? `近 500 期：${text}` : text;
}

export function eligibleDcaHolding(account: Values, currency: string): boolean {
  return (
    !account.archived &&
    !account.deleted_at &&
    account.currency === currency &&
    account.valuation_mode !== "snapshot" &&
    dcaHoldingKinds.includes(account.kind)
  );
}
