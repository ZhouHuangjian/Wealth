import { formatDecimal } from "./format.ts";
import { percentText } from "./investment.ts";

export const dailyReturnLabels: Record<string, string> = {
  estimated: "估算",
  confirmed: "已确认",
  partial: "部分更新",
  unavailable: "待更新",
  no_position: "暂无持仓",
};

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
          ? `${known} / ${total} 项有当日收益数据`
          : "等待当日行情与计算基准",
  };
}
