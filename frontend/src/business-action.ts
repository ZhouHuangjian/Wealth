type Values = Record<string, any>;
export type BusinessAction = {
  kind:
    | "plan"
    | "cash"
    | "product"
    | "market"
    | "statement"
    | "transaction"
    | "match"
    | "holding";
  label: string;
  description: string;
  to: string;
};

function route(spaceId: string, page: string, values: Values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (typeof value === "string" && value.trim()) params.set(key, value);
  return `/spaces/${encodeURIComponent(spaceId)}/${page}?${params}`;
}

/** Resolve only known application destinations; never accept a URL from quote data. */
export function dailyReturnNextAction(
  spaceId: string,
  row: Values,
): BusinessAction | null {
  if (row.status === "market_closed") return null;
  if (row.missing_reason_code === "fx_missing")
    return {
      kind: "cash",
      label: "查看汇率记录",
      description: "补全收益日期适用的折算汇率；原币收益不因缺少汇率而消失。",
      to: route(spaceId, "manage", { tab: "fx" }),
    };
  if (row.missing_reason_code === "calendar_unverified" && row.instrument_id)
    return {
      kind: "product",
      label: "核实产品规则",
      description: "核实该产品的交易日与适用市场，不用其他市场的日期代替。",
      to: route(spaceId, "assets", {
        tab: "records",
        section: "products",
        action: "edit-product",
        instrument_id: row.instrument_id,
      }),
    };
  if (
    row.missing_reason_code === "holding_reconciliation" &&
    row.account_id &&
    row.instrument_id
  )
    return {
      kind: "holding",
      label: "核对这笔持仓",
      description:
        "对照相同日期和份额范围核对原持仓；进入后会重新检查这笔持仓是否仍可核对。",
      to: route(spaceId, "assets", {
        tab: "holdings",
        action: "check-holding",
        account_id: row.account_id,
        instrument_id: row.instrument_id,
      }),
    };
  if (
    [
      "opening_baseline",
      "trade_date_unverified",
      "corporate_action",
      "movement_gap",
      "missing_trade_cost",
      "unknown_movement",
      "missing_opening_cost",
    ].includes(row.missing_reason_code) &&
    row.account_id
  )
    return {
      kind: "transaction",
      label: "查看账户交易",
      description: "核实此账户的期初持仓及交易日期，不为补收益虚构历史流水。",
      to: route(spaceId, "cashbook", {
        tab: "investments",
        account_id: row.account_id,
      }),
    };
  if (
    row.instrument_id &&
    row.missing_reason_code !== "account_snapshot_needed"
  )
    return {
      kind: "market",
      label: "查看产品行情",
      description: "查看此产品的报价、日期与来源；可用数据到齐后系统重新计算。",
      to: route(spaceId, "analytics", {
        tab: "settlement",
        section: "quotes",
        instrument_id: row.instrument_id,
      }),
    };
  if (row.account_id)
    return {
      kind: "cash",
      label: "核对账户数据",
      description: "对照相同日期的机构权益与实际流水，核实缺少的账户依据。",
      to: route(spaceId, "assets", {
        tab: "records",
        section: "reconcile",
        account_id: row.account_id,
      }),
    };
  return null;
}

/** Navigation only: facts, amounts and automation settings remain untouched. */
export function dcaCashReconciliationAction(
  spaceId: string,
  row: Values,
  plan: Values = {},
): BusinessAction | null {
  const accountId = row.account_id || plan.account_id;
  if (!accountId) return null;
  return {
    kind: "cash",
    label: "核对扣款账户",
    description:
      "对照实际余额核对账簿流水，仅补录真实遗漏；持仓市值和货币基金份额不能直接当作可用现金。",
    to: route(spaceId, "assets", {
      tab: "records",
      section: "reconcile",
      account_id: accountId,
    }),
  };
}

export function dcaNextAction(
  spaceId: string,
  row: Values,
  plan: Values = {},
): BusinessAction | null {
  const automation = row.automation || row;
  // The pending-list projection has a generic label; retain the stored explanation.
  const message = String(
    row.details?.automation?.message || automation.message || "",
  );
  const status = String(automation.status || "");
  const reasonCode =
    row.details?.automation?.reason_code || automation.reason_code;
  const instrumentId = row.instrument_id || plan.instrument_id;
  const accountId = row.account_id || plan.account_id;
  const holdingAccountId =
    row.holding_account_id || plan.automation?.holding_account_id;
  const planId = row.plan_id || plan.id;
  const eventId = automation.debit_event_id || row.event_id;
  const action = (
    kind: BusinessAction["kind"],
    label: string,
    description: string,
    page: string,
    values: Values,
  ): BusinessAction => ({
    kind,
    label,
    description,
    to: route(spaceId, page, values),
  });
  if (
    ["waiting_fee", "configuration_required"].includes(status) ||
    (status === "needs_review" && /费用配置/.test(message))
  )
    return action(
      "plan",
      "完善计划设置",
      "核实扣款账户、持仓账户和申购费；保存后系统继续处理。",
      "assets",
      {
        tab: "holdings",
        action: "edit-plan",
        plan_id: planId,
        instrument_id: instrumentId,
      },
    );
  const invalidTopUp =
    status === "needs_review" && reasonCode === "dca_top_up_account_invalid";
  if (status === "waiting_cash" || invalidTopUp)
    return planId
      ? action(
          "plan",
          invalidTopUp ? "检查补足资金设置" : "设置补足资金来源",
          invalidTopUp
            ? "原补足账户已不可用或不符合本计划要求；请重新选择同币种现金账户，或清除补足来源。尚未转入或扣款。"
            : "核实扣款账户的现金；如需自动补足，可在计划中明确选择来源账户及生效日期。保存后仅对适用且未扣款的期次继续处理。",
          "assets",
          {
            tab: "holdings",
            action: "edit-plan",
            focus: "funding",
            plan_id: planId,
            instrument_id: instrumentId,
          },
        )
      : invalidTopUp
        ? null
        : dcaCashReconciliationAction(spaceId, row, plan);
  if (
    status === "waiting_calendar" ||
    (status === "needs_review" && /开放日|份额精度配置/.test(message))
  )
    return action(
      "product",
      "核实产品规则",
      "核实该产品的申购开放日、确认周期及份额精度；不要用周末规则代替机构日历。",
      "assets",
      {
        tab: "records",
        section: "products",
        action: "edit-product",
        instrument_id: instrumentId,
      },
    );
  if (status === "needs_review" && /净值来源|正式净值来源/.test(message))
    return action(
      "market",
      "查看净值差异",
      "查看同一产品、同一净值日的来源差异；可信数据恢复后系统自动重试，不用手工调平。",
      "analytics",
      { tab: "settlement", section: "quotes", instrument_id: instrumentId },
    );
  if (status === "needs_review" && /同日已有.*扣款.*关联待办/.test(message))
    return action(
      "match",
      "关联已有扣款",
      "对照机构订单及实际扣款选择已有记录，确认同一期次后再关联，避免重复记账。",
      "cashbook",
      { tab: "todos", occurrence_id: row.id || row.occurrence_id },
    );
  if (
    status === "needs_review" &&
    /舍入差异|有效份额|分笔|份额确认未完整/.test(message)
  )
    return action(
      "statement",
      "核对实际账单",
      "上传机构确认账单，匹配已有扣款，核实份额、净值、费用和日期；差异须有依据后更正。",
      "cashbook",
      {
        tab: "imports",
        action: "fund-check",
        account_id: holdingAccountId,
        instrument_id: instrumentId,
      },
    );
  if (status === "needs_review")
    return action(
      "transaction",
      "查看并核对原记录",
      "先核实原扣款及关联份额；实际失败或录入有误时按原记录更正，不再次生成扣款。",
      "cashbook",
      { tab: "investments", account_id: accountId, event_id: eventId },
    );
  return null;
}

export function holdingNextAction(
  spaceId: string,
  holding: Values,
): BusinessAction {
  if (holding.reconciliation_eligibility?.eligible)
    return {
      kind: "holding",
      label: "核对这笔持仓",
      description:
        "对照同一日期、同一份额范围的机构数据，填写机构收益、对应净值，并核实持有份额范围。发现原录入有误时再使用更正录入。",
      to: route(spaceId, "assets", {
        tab: "holdings",
        action: "check-holding",
        account_id: holding.account_id,
        instrument_id: holding.instrument_id,
      }),
    };
  const fund = holding.kind === "fund";
  return {
    kind: fund ? "statement" : "transaction",
    label: fund ? "核对实际账单" : "核对交易记录",
    description:
      holding.reconciliation_eligibility?.reason ||
      "此持仓需先核对原交易与已执行定投。对照实际记录查明差异，不能为了匹配收益倒推成本。",
    to: route(spaceId, "cashbook", {
      tab: fund ? "imports" : "investments",
      ...(fund ? { action: "fund-check" } : {}),
      account_id: holding.account_id,
      instrument_id: holding.instrument_id,
    }),
  };
}

export function holdingForAction<T extends Values>(
  rows: T[],
  accountId: string | null,
  instrumentId: string | null,
): T | undefined {
  if (!accountId || !instrumentId) return undefined;
  return rows.find(
    (row) => row.account_id === accountId && row.instrument_id === instrumentId,
  );
}
