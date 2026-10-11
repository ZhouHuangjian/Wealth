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

/** Navigation only: facts, amounts and automation settings remain untouched. */
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
  if (status === "waiting_cash")
    return action(
      "cash",
      "核对扣款账户",
      "先对照银行余额核对账簿中的余额和流水；仅补录真实遗漏，不自动向其他账户补款。",
      "assets",
      { tab: "records", section: "reconcile", account_id: accountId },
    );
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
