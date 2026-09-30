import { helpColumns } from "../help";
import { useEffect, useState } from "react";
import { Alert, Input, Space, Table, Tag } from "antd";
import {
  Search,
  Activity,
  Landmark,
  BarChart3,
  Gem,
  Layers,
  CircleDollarSign,
} from "lucide-react";
import { listOf } from "../api";
import type { Item } from "../api";
import { Blank, LoadState, Money, Panel } from "../components";
import { investmentKinds } from "../investment";
import { useResource, useWorkspace } from "../state";
import { QuoteStatus, RefreshQuotes } from "./InvestmentWorkspace";
function quoteTime(value?: string) {
  if (!value) return "待更新";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
}

const icons = {
  fund: Layers,
  stock: BarChart3,
  etf: Landmark,
  future: Activity,
  option: CircleDollarSign,
  gold: Gem,
};
export default function MarketValuation() {
  const { space, refresh } = useWorkspace();
  const state = useResource("market/valuation");
  useEffect(() => {
    const timer = window.setInterval(() => {
      void state.retry();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [space.id, refresh]);
  const rows = listOf<Item>(state.data).filter((r) => r.kind !== "index");
  return (
    <Panel
      title="投资估值"
      action={<RefreshQuotes onDone={state.retry} />}
      className="valuation-panel"
    >
      <LoadState {...state}>
        {rows.length ? (
          <div className="valuation-grid">
            {rows.map((r, i) => {
              const Icon = icons[r.kind as keyof typeof icons] || Activity;
              const quotesOnly =
                r.display_basis === "quotes_only" || r.status === "quotes_only";
              const quoteLabel = ["future", "option"].includes(r.kind)
                ? "合约行情"
                : "产品行情";
              const amount = r.display_value ?? r.known_display_value;
              const profit = r.display_profit ?? r.known_display_profit;
              const valuePartial =
                r.display_value == null && r.known_display_value != null;
              const profitPartial =
                r.display_profit == null && r.known_display_profit != null;
              const valueLabel =
                (
                  {
                    formal: "正式市值",
                    estimate: "参考持仓估值",
                    manual: "手工估值",
                    mixed: "综合参考估值",
                  } as Record<string, string>
                )[r.display_basis] || "持仓价值";
              return (
                <article
                  className="valuation-card"
                  key={`${r.kind}-${r.currency}-${i}`}
                >
                  <div className="valuation-title">
                    <span>
                      <Icon size={17} />
                      {investmentKinds[r.kind] || r.label}
                    </span>
                    <QuoteStatus
                      status={
                        quotesOnly && !["future", "option"].includes(r.kind)
                          ? "product_quotes"
                          : r.status
                      }
                    />
                  </div>
                  <small>
                    {quotesOnly
                      ? quoteLabel
                      : `${valueLabel}${valuePartial ? "（部分持仓）" : ""}`}
                  </small>
                  {quotesOnly ? (
                    <div className="valuation-contracts">
                      {(r.quotes || []).slice(0, 3).map((q: any) => (
                        <div key={q.instrument_id || q.code}>
                          <span>
                            {q.name || q.code}
                            {q.quote_unit && <small> · {q.quote_unit}</small>}
                          </span>
                          <Money
                            value={q.price}
                            currency={q.currency || r.currency}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <strong className="valuation-amount">
                      <Money
                        value={amount}
                        currency={r.currency || state.data?.currency}
                      />
                    </strong>
                  )}
                  {!quotesOnly && (
                    <div className="valuation-profit">
                      <span>
                        {["estimate", "mixed"].includes(r.display_basis)
                          ? "参考收益"
                          : "持有收益"}
                        {profitPartial ? "（已知部分）" : ""}
                      </span>
                      <Money value={profit} sign />
                    </div>
                  )}
                  <p>
                    {quotesOnly
                      ? `${(r.quotes || []).length} 项产品行情`
                      : `${r.priced_count ?? 0} / ${r.holdings_count ?? 0} 项持仓有价格`}
                  </p>
                  <div className="valuation-source">
                    <span>
                      {Array.isArray(r.source)
                        ? r.source.join("、")
                        : r.source || "暂无行情来源"}
                    </span>
                    <time>{quoteTime(r.as_of)}</time>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Blank
            title="暂无投资估值"
            description="添加产品与持仓后，这里展示基金、股票、期货、期权及黄金的可用行情。"
          />
        )}
      </LoadState>
      <p className="data-caption">
        行情每 5
        分钟尝试更新，页面每分钟刷新。基金盘中数据为参考估值；期货、期权的合约价格不直接计入账户权益。
      </p>
    </Panel>
  );
}
export function QuotesTable() {
  const { space, refresh } = useWorkspace();
  const [query, setQuery] = useState("");
  const state = useResource("market/quotes");
  useEffect(() => {
    const timer = window.setInterval(() => {
      void state.retry();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [space.id, refresh]);
  const rows = listOf<Item>(state.data).filter((r) =>
    [r.name, r.code].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Panel title="自动行情" action={<RefreshQuotes onDone={state.retry} />}>
      <div className="table-toolbar">
        <Input
          prefix={<Search size={16} />}
          placeholder="搜索产品名称或代码"
          aria-label="搜索行情"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 260 }}
          allowClear
        />
        <small>最近获取：{quoteTime(state.data?.refreshed_at)}</small>
      </div>
      <LoadState {...state}>
        <Table<Item>
          rowKey="instrument_id"
          size="middle"
          dataSource={rows}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 1000 }}
          locale={{ emptyText: "暂无产品行情" }}
          columns={helpColumns<Item>([
            {
              title: "产品",
              render: (_, r) => (
                <div className="cell-name">
                  <strong>{r.name}</strong>
                  <small>
                    {r.code} · {investmentKinds[r.kind] || r.kind}
                  </small>
                </div>
              ),
            },
            {
              title: "最新价格",
              render: (_, r) => (
                <div className="cell-name">
                  <Money
                    value={r.price}
                    currency={r.kind === "index" ? "" : r.currency}
                    precision={r.kind === "index" ? 2 : undefined}
                  />
                  {r.quote_unit && <small>{r.quote_unit}</small>}
                  <small>
                    {(
                      {
                        official_nav: "正式净值",
                        close: "收盘价",
                        settlement: "结算价",
                        estimate: "参考行情",
                      } as Record<string, string>
                    )[r.price_kind] || r.price_kind}
                  </small>
                </div>
              ),
            },
            {
              title: "盘中估值",
              render: (_, r) => (
                <div className="cell-name">
                  <Money
                    value={r.estimate?.price ?? r.estimate?.value}
                    currency={r.kind === "index" ? "" : r.currency}
                    precision={r.kind === "index" ? 2 : undefined}
                  />
                  <small>
                    {quoteTime(
                      r.estimate?.published_at || r.estimate?.economic_date,
                    )}
                  </small>
                </div>
              ),
            },
            {
              title: "价格有效日",
              dataIndex: "economic_date",
              render: (v) => v || "—",
            },
            {
              title: "数据来源",
              render: (_, r) => (
                <div className="cell-name">
                  <span>{r.source || "—"}</span>
                  <small>{quoteTime(r.published_at)}</small>
                </div>
              ),
            },
            {
              title: "状态",
              render: (_, r) => (
                <div className="cell-name">
                  <QuoteStatus status={r.status} />
                  {r.message && <small>{r.message}</small>}
                </div>
              ),
            },
          ])}
        />
      </LoadState>
      <Alert
        type="info"
        showIcon
        className="form-alert"
        message="数据源未覆盖的市场、代码或时段会显示暂无行情。可在「净值与行情」手动补充价格，自动行情不会代替实际交易。"
      />
    </Panel>
  );
}
