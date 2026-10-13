import { formatDecimal } from "./format.ts";
import { percentText } from "./investment.ts";

export const dailyReturnLabels: Record<string, string> = {
  estimated: "估算",
  confirmed: "已确认",
  partial: "部分可计算",
  unavailable: "待更新",
  no_position: "暂无持仓",
};

const missingReasonLabels: Record<string, string> = {
  no_estimate: "暂无盘中估值",
  no_current_price: "缺少对应日期价格",
  missing_baseline: "缺少收益基准",
  nav_conflict: "净值来源待核对",
  refresh_failed: "行情更新失败",
  fetch_expired: "行情等待刷新",
  quote_time_missing: "报价时间待核实",
  quote_metadata_mismatch: "估值记录等待更新",
  quote_delayed: "报价已延迟",
  calendar_unverified: "产品交易日待核实",
  opening_baseline: "期初持仓基准待核实",
  fx_missing: "折算汇率待补全",
  holding_reconciliation: "持仓范围待核对",
  corporate_action: "分红或折算待核对",
  trade_date_unverified: "成交日期待核实",
  account_snapshot_needed: "机构权益待补全",
  movement_gap: "持仓变动待核对",
  missing_trade_cost: "交易成本待补全",
  unknown_movement: "持仓变动待核实",
  missing_opening_cost: "期初成本待补全",
};

export function dailyReturnIssueLabel(
  data: Record<string, any> | null | undefined,
) {
  return (
    missingReasonLabels[data?.missing_reason_code] || "行情或计算依据待补全"
  );
}

/** Count missing items, not their market values; a zero known part is still partial. */
export function dailyReturnIssues(
  data: Record<string, any> | null | undefined,
) {
  const groups = new Map<string, number>();
  for (const row of data?.items || []) {
    if (["estimated", "confirmed"].includes(row.status)) continue;
    const label = dailyReturnIssueLabel(row);
    groups.set(label, (groups.get(label) || 0) + 1);
  }
  return [...groups].map(([label, count]) => ({ label, count }));
}

/** FX conversion may be unavailable while the original-currency result is sound. */
export function nativeReturnStatus(
  data: Record<string, any> | null | undefined,
) {
  return data?.native_status || data?.status || "unavailable";
}

export function dailyReturnItemLabel(
  data: Record<string, any> | null | undefined,
) {
  const status = nativeReturnStatus(data);
  if (!["confirmed", "estimated"].includes(status))
    return dailyReturnLabels[status] || "待更新";
  const formal =
    data?.observation_kind === "formal" || data?.price_basis === "formal";
  const inferred =
    data?.contains_automatic_estimates === true ||
    ["automatic_estimate", "estimated"].includes(data?.quantity_source);
  const label = formal
    ? inferred
      ? "正式价格 · 含推算份额"
      : "正式价格计算"
    : status === "confirmed"
      ? "已确认"
      : "估算";
  return data?.missing_reason_code === "fx_missing"
    ? `${label}（原币，待折算）`
    : label;
}

/** NAV attribution and observation timestamps are deliberately separate. */
export function returnDateDisplay(
  data: Record<string, any> | null | undefined,
) {
  const validDay = (value: unknown) =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : null;
  const stamp = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[T ].*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    )
      return null;
    const date = new Date(value.replace(" ", "T"));
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(date)
      : null;
  };
  return {
    returnDate: validDay(data?.return_date) || validDay(data?.date),
    navDate: validDay(data?.nav_date) || validDay(data?.price_date),
    publishedAt: stamp(data?.published_at),
    fetchedAt: stamp(data?.fetched_at),
    observedAt: stamp(data?.observed_at),
  };
}

/** Unknown components are never silently converted to zero or a complete total. */
export function dailyReturnDisplay(
  data: Record<string, any> | null | undefined,
) {
  const status = data?.status || "unavailable";
  const complete = ["estimated", "confirmed"].includes(status);
  const known = Number(data?.known_count || 0);
  const total = Number(data?.total_count || 0);
  const candidate = complete
    ? data?.amount
    : status === "partial" && known > 0
      ? data?.known_amount
      : null;
  const amount = formatDecimal(candidate, false, 2) === null ? null : candidate;
  return {
    status,
    label: dailyReturnLabels[status] || "待更新",
    amount,
    rate: complete ? percentText(data?.return_rate) : null,
    partial: status === "partial",
    coverage:
      status === "no_position"
        ? "暂无投资持仓"
        : total > 0
          ? `${known} / ${total} 项可计算（按条目数）`
          : "等待当日行情与计算基准",
  };
}
