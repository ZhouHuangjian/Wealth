import { useEffect } from "react";
import { Tag } from "antd";
import { ArrowRight } from "lucide-react";
import { dateToday } from "../api";
import { LoadState, Money, Status } from "../components";
import { useWorkspace } from "../state";
import { HelpText } from "../help";
import DailyReturnCard from "./DailyReturnCard";
import PendingPurchaseSummary from "./PendingPurchaseSummary";
const basisLabels: Record<string, string> = {
  formal: "正式价格",
  official: "正式价格",
  manual_formal: "正式净值 / 收盘（手工核对）",
  estimate: "参考估值",
  reference: "参考估值",
  manual_estimate: "手工估算",
  manual: "手工核对",
  manual_unknown: "手工金额 · 口径待核实",
  institution_snapshot: "机构结算",
  institution_settlement: "正式结算",
  institution_estimate: "盘中权益",
  institution_unknown: "机构权益 · 口径待核实",
  cash: "账户余额",
  ledger: "已记账余额",
  recorded_cash: "已记录资金（总权益待核对）",
  institution: "机构权益记录",
  fx: "汇率",
};
function DataSources({ data, hidden }: { data: any; hidden: boolean }) {
  const sources: any[] = data.source_dates || [];
  const groups = { formal: 0, estimate: 0, other: 0 };
  for (const row of sources) {
    if (["fx", "cash", "ledger"].includes(row.basis)) continue;
    if (
      [
        "formal",
        "official",
        "manual_formal",
        "institution_settlement",
        "institution_snapshot",
      ].includes(row.basis)
    )
      groups.formal++;
    else if (
      [
        "estimate",
        "reference",
        "manual_estimate",
        "institution_estimate",
      ].includes(row.basis)
    )
      groups.estimate++;
    else groups.other++;
  }
  return (
    <div className="net-worth-sources">
      {!hidden && (
        <div className="net-worth-source-tags">
          {groups.formal > 0 && (
            <Tag color="blue">正式 / 结算 {groups.formal} 项</Tag>
          )}
          {groups.estimate > 0 && (
            <Tag color="gold">估算 {groups.estimate} 项</Tag>
          )}
          {groups.other > 0 && <Tag>手工 / 待核实 {groups.other} 项</Tag>}
        </div>
      )}
      <details>
        <summary>来源与日期</summary>
        <div className="net-worth-source-details">
          {hidden
            ? "内容已隐藏"
            : sources.length
              ? sources.map((row, index) => (
                  <p key={index}>
                    <strong>
                      {row.instrument_name ||
                        row.name ||
                        row.account_name ||
                        row.source}
                    </strong>
                    <span>
                      {basisLabels[row.basis] || row.basis} · 数据日期{" "}
                      {row.date || "待核实"}
                    </span>
                    {row.holiday_carry_forward && (
                      <span>休市期间沿用最近正式结算</span>
                    )}
                    {row.observed_at && (
                      <span>
                        查看时间{" "}
                        {new Date(row.observed_at).toLocaleString("zh-CN")}
                      </span>
                    )}
                  </p>
                ))
              : "暂无数据来源"}
          {!hidden &&
            (data.gaps || []).map((gap: any, index: number) => (
              <p key={`gap-${index}`} className="data-caption">
                {typeof gap === "string" ? gap : gap.message || gap.reason}
              </p>
            ))}
        </div>
      </details>
    </div>
  );
}
export default function NetWorthComparison({
  asOf,
  currency,
  state,
}: {
  asOf: string;
  currency: string;
  state: {
    data: any;
    loading: boolean;
    error: string;
    retry: () => Promise<void>;
  };
}) {
  const { hidden } = useWorkspace();
  const d = state.data;
  useEffect(() => {
    const timer = window.setInterval(() => {
      void state.retry();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [state.retry]);
  return (
    <LoadState {...state} loading={state.loading && !d}>
      {d && (
        <section className="net-worth-comparison">
          <div className="net-worth-cards">
            {[
              {
                key: "previous",
                title:
                  asOf === dateToday() ? "昨日结算净资产" : "前一日结算净资产",
              },
              {
                key: "estimated",
                title:
                  asOf === dateToday() ? "今日估算净资产" : "当日估算净资产",
              },
            ].map(({ key, title }) => {
              const r = d[key];
              if (!r) return null;
              return (
                <article
                  key={key}
                  className={`net-worth-card ${key === "estimated" ? "estimated" : ""}`}
                >
                  <div className="net-worth-heading">
                    <span>
                      <HelpText text={title} />
                    </span>
                    <Status value={r.completeness} />
                  </div>
                  <strong>
                    <Money
                      value={
                        r.net_assets ??
                        (r.known_account_count === 0
                          ? null
                          : r.known_net_assets)
                      }
                      currency={d.currency || currency}
                    />
                  </strong>
                  <div className="net-worth-caption">
                    <time>{r.date}</time>
                    {r.net_assets == null && (
                      <Tag color="gold">
                        <HelpText
                          text={
                            r.known_account_count === 0
                              ? "暂无可汇总金额"
                              : "已知部分"
                          }
                        />
                      </Tag>
                    )}
                  </div>
                  <PendingPurchaseSummary
                    summary={r.pending_purchases}
                    currency={d.currency || currency}
                  />
                  <DataSources data={r} hidden={hidden} />
                </article>
              );
            })}
            <DailyReturnCard
              data={d.daily_return}
              asOf={asOf}
              currency={d.currency || currency}
            />
          </div>
          <div className="net-worth-change">
            <span>
              <HelpText text="净资产变化" /> <ArrowRight size={14} />
            </span>
            <Money
              value={
                d.change?.completeness === "partial" ? null : d.change?.amount
              }
              currency={d.currency || currency}
              sign
            />
            {d.change?.completeness === "partial" && (
              <Tag color="gold">暂不可比</Tag>
            )}
            <small>含资金进出；投资收益见“今日估算收益”</small>
            <details className="net-worth-explanation">
              <summary>统计说明</summary>
              <p>
                净资产按各市场实际数据日期计值，休市或净值尚未发布时可能沿用最近数据；估算净资产包含正式数据和参考估值。
              </p>
              <p>
                净资产变化包含收入、支出及资金进出，不等同于投资收益。今日收益只汇总有当日数据和可比基准的投资项目。
              </p>
              <p>
                买入待确认显示已记扣款中尚未确认份额的余额，与已确认持仓市值分开列示，不额外叠加到净资产；仅有计划、尚未记入扣款的金额不计入。
              </p>
              {!hidden && d.change?.message && <p>{d.change.message}</p>}
            </details>
          </div>
        </section>
      )}
    </LoadState>
  );
}
