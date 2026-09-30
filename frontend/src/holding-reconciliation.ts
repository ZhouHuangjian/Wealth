/** Cross-check the same date and holding scope; never infer a missing transaction. */
const scale = 10n ** 12n;
const tolerance = scale / 50n;
function amount(value: unknown): bigint | null {
  const input = String(value ?? "").trim();
  if (!/^-?\d+(\.\d{1,12})?$/.test(input)) return null;
  const [whole, fraction = ""] = input.replace(/^-/, "").split(".");
  const absolute = BigInt(whole) * scale + BigInt(fraction.padEnd(12, "0"));
  return input.startsWith("-") ? -absolute : absolute;
}
function decimal(value: bigint, precision = 12): string {
  const base = 10n ** BigInt(precision);
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % base)
    .toString()
    .padStart(precision, "0")
    .replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${absolute / base}${fraction ? `.${fraction}` : ""}`;
}
function present(value: unknown) {
  return value != null && String(value).trim() !== "";
}
const abs = (value: bigint) => (value < 0n ? -value : value);
export function holdingReconciliation(values: Record<string, any>) {
  const mode = values.valuation_mode;
  if (!["value", "profit"].includes(mode)) return null;
  const cost = amount(values.cost);
  const input = amount(
    mode === "profit" ? values.current_profit : values.current_value,
  );
  if (cost === null || cost < 0n || input === null) return null;
  const value = mode === "profit" ? cost + input : input;
  if (value < 0n) return null;
  const profit = value - cost;
  const institutionProfit = amount(values.institution_profit);
  const quantity = amount(values.quantity),
    nav = amount(values.reference_nav);
  const conflicts: { field: string; difference: string; message: string }[] =
    [];
  if (
    institutionProfit !== null &&
    abs(profit - institutionProfit) > tolerance
  ) {
    const difference = decimal(abs(profit - institutionProfit));
    conflicts.push({
      field: "institution_profit",
      difference,
      message: `计算盈亏与机构显示收益相差 ${difference}，超过 0.02。市值可能混入申购在途，或成本、收益对应的份额范围不同。请核对同日同范围数据；不要把可用份额直接当作已确认份额，也不要倒推修改成本。`,
    });
  }
  const navProduct =
    quantity !== null && quantity > 0n && nav !== null && nav >= 0n
      ? quantity * nav
      : null;
  if (
    navProduct !== null &&
    abs(navProduct - value * scale) > tolerance * scale
  ) {
    const difference = decimal(abs(navProduct - value * scale), 24);
    conflicts.push({
      field: "reference_nav",
      difference,
      message: `持仓数量 × 对应单位净值与本次市值相差 ${difference}，超过 0.02。请使用同一天、同一范围的份额、净值和市值；不能用可用份额替代已确认持有份额。系统不会自动修改份额或成本。`,
    });
  }
  return {
    value: decimal(value),
    cost: decimal(cost),
    profit: decimal(profit),
    nav_value: navProduct === null ? null : decimal(navProduct, 24),
    conflicts,
  };
}
export function holdingReconciliationPayload(
  values: Record<string, any>,
  allowPending = false,
) {
  if (!["value", "profit"].includes(values.valuation_mode)) return {};
  const result: Record<string, string | boolean> = {};
  for (const field of ["institution_profit", "reference_nav"]) {
    if (!present(values[field])) continue;
    const parsed = amount(values[field]);
    if (parsed === null || (field === "reference_nav" && parsed <= 0n))
      throw new Error(
        field === "institution_profit"
          ? "机构显示收益须为数字，最多 12 位小数"
          : "对应单位净值须大于零，最多 12 位小数",
      );
    result[field] = String(values[field]).trim();
  }
  const check = holdingReconciliation(values);
  if (
    check?.conflicts.length &&
    allowPending &&
    values.confirm_unreconciled === true
  ) {
    if (!present(values.institution_profit))
      throw new Error("保存为待核对前，请填写机构显示的持仓收益");
    result.reconciliation_mode = "pending";
    result.confirm_unreconciled = true;
  } else if (check?.conflicts.length)
    throw new Error(check.conflicts.map((item) => item.message).join("\n"));
  return result;
}

/** Only the selected valuation mode is sent, even if hidden form values remain. */
export function ordinaryHoldingPayload(values: Record<string, any>) {
  return {
    account_id: values.account_id,
    instrument_id: values.instrument_id,
    quantity: values.quantity,
    cost: values.cost,
    purchase_date: values.purchase_date,
    as_of: values.as_of,
    funding_mode: values.funding_mode,
    ...(values.funding_mode === "allocate" && values.funding_account_id
      ? { funding_account_id: values.funding_account_id }
      : {}),
    history_mode: values.history_confirmed
      ? "unchanged_holding"
      : "snapshot_only",
    ...(values.valuation_mode !== "auto"
      ? {
          valuation_basis: values.valuation_basis,
          valuation_date: values.valuation_date || null,
          ...(values.valuation_observed_at
            ? {
                valuation_observed_at: new Date(
                  values.valuation_observed_at,
                ).toISOString(),
              }
            : {}),
        }
      : {}),
    ...(values.valuation_mode === "value"
      ? { current_value: values.current_value }
      : {}),
    ...(values.valuation_mode === "profit"
      ? { current_profit: values.current_profit }
      : {}),
    ...holdingReconciliationPayload(values, true),
  };
}

export function holdingCorrectionPayload(
  original: Record<string, any>,
  values: Record<string, any>,
  revision: number,
) {
  const updated = {
    ...original,
    quantity: values.quantity,
    cost: values.cost,
    purchase_date: values.purchase_date,
    institution_profit: values.institution_profit,
    reference_nav: values.reference_nav,
    valuation_mode: "value",
  };
  return {
    ...original,
    quantity: updated.quantity,
    cost: updated.cost,
    purchase_date: updated.purchase_date,
    ...holdingReconciliationPayload(updated),
    expected_revision: revision,
    reason: String(values.reason || "").trim(),
  };
}
