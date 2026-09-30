/** Option references never create cash movements or contribute to net assets. */
export function hasOptionValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}
export function optionDecimal(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d+(\.\d{1,12})?$/.test(text) ? text : null;
}
export function positiveOptionInteger(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && BigInt(text) > 0n;
}
const scale = 10n ** 12n;
function scaled(value: unknown): bigint | null {
  const decimal = optionDecimal(value);
  if (decimal === null) return null;
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(12, "0"));
}
function text(value: bigint): string {
  const abs = value < 0n ? -value : value;
  const fraction = (abs % scale)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${abs / scale}${fraction ? `.${fraction}` : ""}`;
}
export function positiveOptionDecimal(value: unknown): boolean {
  const parsed = scaled(value);
  return parsed !== null && parsed > 0n;
}
/** Preserve precision for preview; the server is authoritative for saved values. */
export function optionHoldingPreview(values: Record<string, any>) {
  const price = scaled(values.opening_price),
    multiplier = scaled(values.contract_multiplier),
    current = scaled(values.current_value);
  if (
    price === null ||
    multiplier === null ||
    multiplier <= 0n ||
    current === null ||
    !positiveOptionInteger(values.quantity) ||
    !["long", "short"].includes(values.side)
  )
    return null;
  const openingScaledSquared =
    price * multiplier * BigInt(String(values.quantity));
  // Round only the displayed gross amount to 12 decimal places, never input prices.
  const opening = (openingScaledSquared + scale / 2n) / scale;
  return {
    opening_premium: text(opening),
    reference_profit: text(
      values.side === "short" ? opening - current : current - opening,
    ),
  };
}
/** Excludes stale hidden settlement dates and unrelated ordinary-holding fields. */
export function optionPositionPayload(
  values: Record<string, any>,
  accountId: string,
  patch = false,
): Record<string, any> {
  if (!positiveOptionInteger(values.quantity))
    throw new Error("期权手数须为正整数");
  if (!positiveOptionDecimal(values.contract_multiplier))
    throw new Error("请核实并填写大于零的合约乘数");
  if (!["long", "short"].includes(values.side))
    throw new Error("请选择买入或卖出方向");
  if (
    optionDecimal(values.opening_price) === null ||
    optionDecimal(values.current_value) === null
  )
    throw new Error("开仓价和当前市值须为非负金额");
  const result: Record<string, any> = {
    account_id: accountId,
    side: values.side,
    quantity: String(values.quantity).trim(),
    contract_multiplier: String(values.contract_multiplier).trim(),
    opening_price: String(values.opening_price).trim(),
    current_value: String(values.current_value).trim(),
    purchase_date: values.purchase_date,
    as_of: values.as_of,
  };
  if (hasOptionValue(values.settlement_price)) {
    if (
      optionDecimal(values.settlement_price) === null ||
      !values.settlement_date
    )
      throw new Error("填写结算价后，请同时填写结算日期");
    result.settlement_price = String(values.settlement_price).trim();
    result.settlement_date = values.settlement_date;
  } else if (patch) {
    result.settlement_price = null;
    result.settlement_date = null;
  }
  if (patch) result.status = values.status || "active";
  return result;
}
export function holdingDisplayRows(payload: any) {
  return [
    ...(Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : []),
    ...(Array.isArray(payload?.reference_items) ? payload.reference_items : []),
  ];
}

/** AntD preserves hidden fields; only an explicitly selected option position is submitted. */
export function optionPositionForProduct(values: Record<string, any>) {
  return values.kind === "option" && values.with_holding === true
    ? optionPositionPayload(values.option_position || {}, values.account_id)
    : undefined;
}
