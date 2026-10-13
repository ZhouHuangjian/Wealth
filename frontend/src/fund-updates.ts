import { formatDecimal } from "./format.ts";

type Values = Record<string, any>;

/** These rows cover product-specific periods, never an extra today's total. */
export function latestFundUpdateRows(
  data: Values | null | undefined,
): Values[] {
  return Array.isArray(data?.items)
    ? data.items.filter(
        (item: unknown): item is Values =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

export function latestFundUpdateDisplay(row: Values) {
  const status = row.native_status || row.status;
  const formal = status === "formal";
  const estimated = status === "estimated";
  const amount =
    (formal || estimated) && formatDecimal(row.amount, false, 2) !== null
      ? row.amount
      : null;
  const inferred =
    row.contains_automatic_estimates === true ||
    ["automatic_estimate", "estimated"].includes(row.quantity_source);
  return {
    amount,
    currency: row.currency || "",
    label: formal
      ? inferred
        ? "正式净值 · 推算份额"
        : "按正式净值计算"
      : estimated
        ? inferred
          ? "待公布估算 · 含推算份额"
          : "待公布区间估算"
        : "依据待补全",
    formal,
    estimated,
    window:
      row.window_label ||
      (formal && row.nav_date ? `净值归属 ${row.nav_date}` : "覆盖区间待核实"),
    navDate: row.nav_date || null,
    hasFormalNav: !!row.nav_date,
    baseNavDate: row.base_nav_date || null,
    baseNav: row.base_nav ?? null,
    quotePrice: row.quote_price ?? null,
    quantity: row.quantity ?? null,
    quantitySourceLabel: inferred
      ? row.quantity_source === "automatic_estimate"
        ? "系统推算"
        : "含系统推算"
      : row.quantity_source === "recorded"
        ? "已记录"
        : "来源待核实",
    quotedAt: row.quoted_at || null,
    // The formal branch retains the old reference's fetch metadata; it is not
    // evidence of when the new formal NAV was fetched.
    fetchedAt: formal || row.nav_date ? null : row.fetched_at || null,
    recordedAt: row.nav_date ? row.formal_updated_at || null : null,
    message:
      [row.native_message, row.message]
        .filter(
          (value, index, values) => value && values.indexOf(value) === index,
        )
        .join(" ") || "各基金覆盖区间可能不同，与今日收益分开查看。",
  };
}
