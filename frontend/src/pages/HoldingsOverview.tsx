import { Tooltip } from "antd";
import { Info } from "lucide-react";
import { Money } from "../components";
import { HelpText } from "../help";
import { summarizeHoldings } from "../holding-display";
import { holdingDailyAmount } from "../holding-display";
import type { HoldingRow } from "../holding-display";
import { useWorkspace } from "../state";
import { percentText, profitTone } from "../investment";
import PendingPurchaseDetails from "./PendingPurchaseDetails";
import { dateToday } from "../api";

export function HoldingDailyReturn({
  row,
  asOf,
  latest = false,
}: {
  row: HoldingRow;
  asOf: string;
  latest?: boolean;
}) {
  const { hidden } = useWorkspace();
  if (row.pending_only === true) return <span className="unknown">—</span>;
  const data = latest ? row.latest_confirmed_return : row.daily_return;
  const value = latest
    ? data?.observation_kind === "formal" &&
      ["confirmed", "estimated"].includes(data.status) &&
      data.currency === row.currency &&
      row.status !== "needs_reconciliation" &&
      !row.is_reference_position &&
      row.contributes !== false
      ? data.amount
      : null
    : holdingDailyAmount(row, asOf);
  const detail = hidden
    ? "显示金额后可查看收益说明"
    : data?.message ||
      (value != null
        ? `${latest && data?.status === "estimated" ? "按正式净值与推算份额计算" : data?.status === "confirmed" ? "按正式价格计算" : "参考估值，尚非最终结算"}${data?.interval_start ? `；计算基准 ${data.interval_start}` : ""}`
        : row.is_reference_position || row.contributes === false
          ? "参考持仓或已由机构权益覆盖，不重复计算日收益"
          : "缺少对应日期的行情或收益基准");
  return (
    <Tooltip title={detail}>
      <div className={`cell-name ${hidden ? "" : profitTone(value)}`}>
        <Money value={value} currency={row.currency} precision={2} sign />
        {value != null && (hidden || percentText(data?.return_rate)) && (
          <small>{hidden ? "••••••" : percentText(data?.return_rate)}</small>
        )}
        <small className="holdings-daily-date">
          {data?.date || (latest ? "" : asOf)}
          {data?.date || !latest ? " · " : ""}
          {value == null
            ? latest
              ? "等待正式净值"
              : "待更新"
            : latest
              ? data?.quantity_source === "estimated" ||
                data?.status === "estimated"
                ? "净值收益 · 含推算份额"
                : "净值收益"
              : data?.status === "confirmed"
                ? "正式收益"
                : "估算"}
        </small>
      </div>
    </Tooltip>
  );
}

export default function HoldingsOverview({
  rows,
  asOf,
  filtered,
  truncated = false,
}: {
  rows: HoldingRow[];
  asOf: string;
  filtered: boolean;
  truncated?: boolean;
}) {
  const { hidden } = useWorkspace();
  const summary = summarizeHoldings(rows, asOf);
  const notes = [
    summary.referenceCount > 0
      ? `另有 ${summary.referenceCount} 项机构权益覆盖明细或期权参考持仓，未重复汇总。`
      : "",
    summary.unknownCurrencyCount > 0
      ? `${summary.unknownCurrencyCount} 项币种待核对，暂未汇总。`
      : "",
    truncated ? "列表尚未加载完整，汇总仅包含已加载记录。" : "",
  ].filter(Boolean);
  return (
    <div className="holdings-overview" aria-label="持仓概览">
      <div className="holdings-overview-heading">
        <span>
          {truncated
            ? "当前已加载持仓"
            : filtered
              ? "当前筛选持仓"
              : "全部持仓"}
          <small> · {rows.length} 项</small>
        </span>
        <Tooltip title="按原币分别汇总最近有效数据，不换算或混加币种；数据不足显示已知部分。市值仅含已确认份额，买入待确认另列，不再加到净资产。机构权益覆盖明细与期权参考持仓不重复加总。持有收益不包含已卖出部分，今日收益使用对应日期的数据。">
          <button
            className="holdings-info"
            type="button"
            aria-label="持仓概览计算说明"
          >
            <Info size={14} />
          </button>
        </Tooltip>
      </div>
      {summary.groups.map((group) => {
        const showPending =
          group.pending.amount !== null && group.pending.amount !== "0";
        return (
          <section
            className={`holdings-currency-summary${showPending ? " holdings-currency-summary-with-pending" : ""}`}
            key={group.currency}
            aria-label={`${group.currency}持仓汇总`}
          >
            <div className="holdings-currency">
              <strong>{group.currency}</strong>
              <small>
                {group.count} 项产品
                {group.pendingOnlyCount > 0
                  ? ` · ${group.pendingOnlyCount} 项待确认`
                  : ""}
              </small>
            </div>
            {(
              [
                { key: "value", label: "已确认持仓市值", value: group.value },
                ...(showPending
                  ? [
                      {
                        key: "pending",
                        label: "买入待确认",
                        value: group.pending,
                      },
                    ]
                  : []),
                { key: "profit", label: "持有收益", value: group.profit },
                {
                  key: "daily",
                  label: asOf === dateToday() ? "今日估算收益" : "当日估算收益",
                  value: group.daily,
                },
              ] as const
            ).map((metric) => (
              <div className="holdings-metric" key={metric.key}>
                <span>
                  <HelpText text={metric.label} />
                  {!metric.value.complete && metric.value.known > 0 && (
                    <small> · 已知部分</small>
                  )}
                </span>
                <strong
                  className={
                    !hidden && ["profit", "daily"].includes(metric.key)
                      ? profitTone(metric.value.amount)
                      : undefined
                  }
                >
                  {metric.key === "pending" ? (
                    <PendingPurchaseDetails
                      items={group.pendingItems}
                      amount={metric.value.amount}
                      currency={group.currency}
                      label=""
                      title={`${group.currency}买入待确认明细`}
                    />
                  ) : metric.value.total === 0 ? (
                    <span className="unknown">—</span>
                  ) : (
                    <Money
                      value={metric.value.amount}
                      precision={2}
                      sign={metric.key === "profit" || metric.key === "daily"}
                    />
                  )}
                </strong>
                <small>
                  {metric.key === "daily" ? `${asOf} · ` : ""}
                  {metric.value.total === 0
                    ? "尚无已确认份额"
                    : metric.value.complete
                      ? metric.key === "value"
                        ? "按最近有效价格"
                        : metric.key === "pending"
                          ? "在途金额 · 查看明细"
                          : metric.key === "profit"
                            ? "当前持有部分"
                            : "按对应日期行情"
                      : `${metric.value.total - metric.value.known} 项待补全`}
                </small>
              </div>
            ))}
          </section>
        );
      })}
      {notes.length > 0 && (
        <details className="holdings-overview-note">
          <summary>
            汇总范围说明{notes.length > 1 ? ` · ${notes.length} 项` : ""}
          </summary>
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </details>
      )}
    </div>
  );
}
