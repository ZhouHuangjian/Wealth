import { Tooltip } from "antd";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import { Money } from "../components";
import { HelpText } from "../help";
import { summarizeHoldings } from "../holding-display";
import {
  holdingDailyAmount,
  holdingLatestReturnAmount,
} from "../holding-display";
import type { HoldingRow } from "../holding-display";
import { useWorkspace } from "../state";
import { percentText, profitTone } from "../investment";
import PendingPurchaseDetails from "./PendingPurchaseDetails";
import { dateToday } from "../api";
import {
  dailyReturnIssueLabel,
  dailyReturnItemLabel,
  closedReturnPlaceholder,
  nativeReturnStatus,
  returnDateDisplay,
} from "../daily-return";
import { dailyReturnNextAction } from "../business-action";

export function HoldingDailyReturn({
  row,
  asOf,
  latest = false,
}: {
  row: HoldingRow;
  asOf: string;
  latest?: boolean;
}) {
  const { hidden, space } = useWorkspace();
  if (row.pending_only === true) return <span className="unknown">—</span>;
  const data = latest ? row.latest_confirmed_return : row.daily_return;
  const closed =
    !latest && data?.status === "market_closed" && data?.date === asOf;
  const dates = returnDateDisplay(data);
  const recent = row.latest_confirmed_return;
  const recentValue = !latest ? holdingLatestReturnAmount(row) : null;
  const value = latest
    ? holdingLatestReturnAmount(row)
    : holdingDailyAmount(row, asOf);
  const description = hidden
    ? "显示金额后可查看收益说明"
    : data?.message ||
      (closed
        ? "对应市场休市，没有当日收益观测；最近正式收益按原净值日期展示"
        : value != null
          ? `${latest && nativeReturnStatus(data) === "estimated" ? "按正式净值与推算份额计算" : nativeReturnStatus(data) === "confirmed" ? "按正式价格计算" : "参考估值，尚非最终结算"}${data?.interval_start ? `；计算基准 ${data.interval_start}` : ""}`
          : row.is_reference_position || row.contributes === false
            ? "参考持仓或已由机构权益覆盖，不重复计算日收益"
            : "缺少对应日期的行情或收益基准");
  const detail = hidden
    ? description
    : [
        description,
        dates.returnDate
          ? `${closed ? "休市日期" : "收益归属"} ${dates.returnDate}`
          : "",
        dates.navDate ? `净值归属 ${dates.navDate}` : "",
        dates.publishedAt ? `数据源公布 ${dates.publishedAt}（北京时间）` : "",
        dates.fetchedAt ? `系统获取 ${dates.fetchedAt}（北京时间）` : "",
        dates.observedAt
          ? `记录时间 ${dates.observedAt}（北京时间）；记录时间不改变收益归属日`
          : "",
      ]
        .filter(Boolean)
        .join("；");
  const issue =
    !hidden &&
    !closed &&
    !row.is_reference_position &&
    row.contributes !== false &&
    row.status !== "needs_reconciliation" &&
    row.scope_unconfirmed !== true &&
    (value == null || data?.missing_reason_code === "fx_missing");
  const action = issue
    ? dailyReturnNextAction(space.id, { ...row, ...data })
    : null;
  return (
    <Tooltip title={detail}>
      <div className={`cell-name ${hidden ? "" : profitTone(value)}`}>
        {closedReturnPlaceholder(closed ? "market_closed" : null, hidden) ?? (
          <Money value={value} currency={row.currency} precision={2} sign />
        )}
        {value != null && (hidden || percentText(data?.return_rate)) && (
          <small>{hidden ? "••••••" : percentText(data?.return_rate)}</small>
        )}
        <small className="holdings-daily-date">
          {latest && dates.returnDate ? "归属 " : ""}
          {dates.returnDate || (latest ? "" : asOf)}
          {dates.returnDate || !latest ? " · " : ""}
          {value == null
            ? closed
              ? "休市"
              : latest
                ? "等待正式净值"
                : "待更新"
            : dailyReturnItemLabel(data)}
        </small>
        {value == null && recentValue != null && (
          <small>
            最近净值收益{" "}
            <Money
              value={recentValue}
              currency={row.currency}
              precision={2}
              sign
            />
            {" · "}
            {returnDateDisplay(recent).returnDate}
          </small>
        )}
        {issue && data?.missing_reason_code && (
          <small>{dailyReturnIssueLabel(data)}</small>
        )}
        {action && (
          <Link to={action.to} title={action.description}>
            {action.label}
          </Link>
        )}
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
                  ) : metric.key === "daily" &&
                    group.dailyMarketClosedCount === metric.value.total ? (
                    closedReturnPlaceholder("market_closed", hidden)
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
                    : metric.key === "daily" && group.dailyMarketClosedCount > 0
                      ? [
                          group.daily.known > 0
                            ? `已计算 ${group.daily.known} 项`
                            : "",
                          `${group.dailyMarketClosedCount} 项休市`,
                          group.dailyMissingCount > 0
                            ? `${group.dailyMissingCount} 项待补全`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")
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
