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
    ? data?.status === "confirmed" &&
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
        ? `${data?.status === "confirmed" ? "按正式价格计算" : "参考估值，尚非最终结算"}${data?.interval_start ? `；计算基准 ${data.interval_start}` : ""}`
        : row.is_reference_position || row.contributes === false
          ? "参考持仓或已由机构权益覆盖，不重复计算日收益"
          : "缺少对应日期的行情或收益基准");
  return (
    <Tooltip title={detail}>
      <div className={`cell-name ${hidden ? "" : profitTone(value)}`}>
        <Money value={value} currency={row.currency} precision={2} sign />
        {value != null && (
          <small>
            {hidden
              ? "••••••"
              : percentText(data?.return_rate) || "收益率待补全"}
          </small>
        )}
        <small className="holdings-daily-date">
          {data?.date || (latest ? "尚无确认日期" : asOf)} ·{" "}
          {value == null
            ? "待补全"
            : data?.status === "confirmed"
              ? "已确认"
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
  const summary = summarizeHoldings(rows, asOf);
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
                { key: "daily", label: "今日估算收益", value: group.daily },
              ] as const
            ).map((metric) => (
              <div className="holdings-metric" key={metric.key}>
                <span>
                  <HelpText text={metric.label} />
                  {!metric.value.complete && metric.value.known > 0 && (
                    <small> · 已知部分</small>
                  )}
                </span>
                <strong>
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
                        ? "各项数据日期见列表"
                        : metric.key === "pending"
                          ? "仅剩余在途款 · 点击明细"
                          : `${metric.value.known} 项数据齐备`
                      : `${metric.value.total - metric.value.known} 项待补全`}
                </small>
              </div>
            ))}
          </section>
        );
      })}
      {summary.referenceCount > 0 && (
        <p className="holdings-overview-note">
          另有 {summary.referenceCount}{" "}
          项机构权益覆盖明细或期权参考持仓，单独展示，不重复汇总。
        </p>
      )}
      {summary.unknownCurrencyCount > 0 && (
        <p className="holdings-overview-note">
          {summary.unknownCurrencyCount} 项币种待核对，暂未汇总。
        </p>
      )}
      {truncated && (
        <p className="holdings-overview-note">
          列表尚未加载完整，汇总仅包含已加载记录。
        </p>
      )}
    </div>
  );
}
