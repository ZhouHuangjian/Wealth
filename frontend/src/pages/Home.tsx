import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Select, Space, Table, Tag } from "antd";
import {
  ArrowRight,
  Wallet,
  Landmark,
  ClipboardCheck,
  ShieldCheck,
  CalendarDays,
  FolderInput,
  Plus,
  ArrowUpRight,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);
import {
  Blank,
  LinkButton,
  LoadState,
  Money,
  PageTitle,
  Panel,
  Status,
} from "../components";
import { useResource, useWorkspace } from "../state";
import {
  accountKinds,
  currencyOptions,
  dateToday,
  listOf,
  kinds,
} from "../api";
import type { Item } from "../api";
import { HelpText, helpColumns } from "../help";
export function Chart({
  items,
  xKey,
  yKey,
  height = 250,
  precision = 2,
}: {
  items: any[];
  xKey: string;
  yKey: string;
  height?: number;
  precision?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { hidden } = useWorkspace();
  useEffect(() => {
    if (!ref.current || hidden || !items.length) return;
    const chart = echarts.init(ref.current);
    chart.setOption({
      grid: { top: 30, bottom: 35, left: 65, right: 25 },
      tooltip: {
        trigger: "axis",
        confine: true,
        valueFormatter: (value: unknown) =>
          typeof value === "number" && Number.isFinite(value)
            ? value.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: precision,
              })
            : "待补全",
      },
      xAxis: {
        type: "category",
        data: items.map((r) => r[xKey]),
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#d7ddd0" } },
        axisLabel: { color: "#7b7c70" },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#eaece4", type: "dashed" } },
        axisLabel: { color: "#7b7c70" },
      },
      series: [
        {
          type: "line",
          data: items.map((r) => (r[yKey] === null ? null : Number(r[yKey]))),
          connectNulls: false,
          smooth: false,
          symbolSize: 5,
          lineStyle: { width: 3, color: "#437665" },
          itemStyle: { color: "#437665" },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(107,154,117,.22)" },
              { offset: 1, color: "rgba(107,154,117,0)" },
            ]),
          },
        },
      ],
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [items, hidden, xKey, yKey, precision]);
  return hidden ? (
    <div className="chart-hidden">图表金额已遮挡</div>
  ) : (
    <div
      ref={ref}
      role="img"
      aria-label="金额变化图，下方提供数据表"
      style={{ height, width: "100%" }}
    />
  );
}
import MarketValuation from "./MarketValuation";
import NetWorthComparison from "./NetWorthComparison";
import PendingPurchaseSummary from "./PendingPurchaseSummary";
import { DashboardMarket, DashboardSignals } from "./MarketEnvironment";
export default function Home() {
  const { space, hidden } = useWorkspace();
  const navigate = useNavigate();
  const [asOf, setAsOf] = useState(dateToday());
  const [displayCurrency, setDisplayCurrency] = useState(space.base_currency);
  const state = useResource(
    "overview",
    `?as_of=${asOf}&currency=${displayCurrency}`,
  );
  const comparison = useResource(
    "net-worth-comparison",
    `?${new URLSearchParams({ as_of: asOf, currency: displayCurrency })}`,
  );
  const preferences = useResource("dashboard-preferences");
  const goals = useResource("goals");
  const notes = useResource("notes");
  const calendar = useResource("calendar");
  const home = state.data;
  const goto = (s: string) => navigate(`/spaces/${space.id}/${s}`);
  const accounts = (home?.accounts || []).map((account: any) => {
    const reference = comparison.data?.estimated?.accounts?.find(
      (row: any) => row.account_id === account.id,
    );
    const sources = (comparison.data?.estimated?.source_dates || []).filter(
      (row: any) => row.account_id === account.id,
    );
    const estimated = sources.some((row: any) =>
      [
        "estimate",
        "reference",
        "manual_estimate",
        "manual_unknown",
        "institution_estimate",
        "institution_unknown",
      ].includes(row.basis),
    );
    const referencePartial =
      sources.some((row: any) =>
        ["missing", "stale", "partial"].includes(row.data_state),
      ) ||
      (comparison.data?.estimated?.gaps || []).some(
        (gap: any) => typeof gap === "string" && gap.includes(account.name),
      );
    return {
      ...account,
      display_value: reference?.local_value ?? account.value,
      display_base_value: reference ? reference.value : account.base_value,
      pending_purchases:
        reference?.pending_purchases ?? account.pending_purchases,
      has_estimate: estimated,
      reference_partial: referencePartial,
      reference_known: reference?.local_value != null,
    };
  });
  const todos = home?.todos || [];
  const isEmpty = !accounts.length;
  return (
    <>
      <PageTitle
        eyebrow="YOUR FINANCIAL LANDSCAPE"
        title="首页"
        actions={
          <Space wrap>
            <Input
              type="date"
              aria-label="统计日期"
              value={asOf}
              onChange={(e) => {
                if (e.target.value) setAsOf(e.target.value);
              }}
              style={{ width: 145 }}
            />
            <Select
              aria-label="汇总显示币种"
              value={displayCurrency}
              options={currencyOptions}
              onChange={setDisplayCurrency}
              style={{ width: 90 }}
            />
          </Space>
        }
      />
      <LoadState {...state}>
        {home && (
          <>
            <NetWorthComparison
              asOf={asOf}
              currency={displayCurrency}
              state={comparison}
            />
            <div className="metric-grid">
              <Metric
                icon={<Wallet size={19} />}
                title="可动用现金"
                value={home.available_cash}
                currency={home.currency}
                foot={
                  home.accounts?.some(
                    (a: any) => a.available_estimated && a.available_eligible,
                  )
                    ? "含空仓期货账户的推算可提取金额"
                    : "已记录、可提取的资金"
                }
              />
              <Metric
                icon={<Landmark size={19} />}
                title="已启用预留"
                value={home.reserved}
                currency={home.currency}
                foot="用途分配，不减少净资产"
              />
              <Metric
                icon={<ClipboardCheck size={19} />}
                title="规划后可安排"
                value={home.allocatable}
                currency={home.currency}
                foot="可动用现金 − 未重复计算的预留"
              />
            </div>
            {home.gaps?.length > 0 && (
              <Alert
                className="section-alert"
                type="warning"
                showIcon
                message="部分数据仍待补全"
                description={
                  hidden ? (
                    "内容已隐藏"
                  ) : (
                    <details className="compact-help">
                      <summary>查看 {home.gaps.length} 项待核对事项</summary>
                      <ul>
                        {home.gaps.map((g: any, index: number) => (
                          <li key={index}>
                            {typeof g === "string"
                              ? g
                              : g.reason || g.message || g.kind}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )
                }
              />
            )}
            {isEmpty && (
              <div className="setup-strip">
                <div className="setup-number">01</div>
                <div>
                  <h3>添加第一个账户</h3>
                  <p>先建立账户与期初余额，再导入账单进行核对。</p>
                </div>
                <Button
                  type="primary"
                  icon={<Plus size={16} />}
                  onClick={() => goto("assets")}
                >
                  添加账户
                </Button>
              </div>
            )}
            {preferences.data?.show_valuation !== false && <MarketValuation />}
            {preferences.data?.show_market_environment !== false && (
              <DashboardMarket />
            )}
            {preferences.data?.show_signals !== false && <DashboardSignals />}
            <div className="two-column">
              <Panel
                title="账户一览"
                action={
                  <LinkButton onClick={() => goto("assets")}>
                    全部账户
                  </LinkButton>
                }
              >
                {accounts.length ? (
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    columns={helpColumns([
                      { title: "账户", dataIndex: "name" },
                      {
                        title: "类型",
                        dataIndex: "kind",
                        render: (v) => accountKinds[v] || v,
                      },
                      {
                        title: "资产金额",
                        render: (_, r: any) => (
                          <div className="cell-name">
                            <Money
                              value={r.display_value}
                              currency={r.currency}
                            />
                            <PendingPurchaseSummary
                              summary={r.pending_purchases}
                              currency={r.currency}
                              compact
                            />
                            {r.available_estimated && (
                              <small>
                                {r.available_message ||
                                  "未录入持仓，按权益推算可提取金额"}
                              </small>
                            )}
                            {r.has_estimate && (
                              <small>含盘中 / 手工参考值，非正式结算</small>
                            )}
                            {r.reference_partial && (
                              <small>已知部分，仍有数据待核对</small>
                            )}
                            {r.value_basis === "recorded_cash" && (
                              <small>已记录资金，需补机构总权益</small>
                            )}
                            {r.status === "unknown" &&
                              (["future", "futures"].includes(r.kind) ? (
                                <LinkButton
                                  onClick={() =>
                                    goto(
                                      "analytics?tab=settlement&section=derivatives",
                                    )
                                  }
                                >
                                  {r.reference_known
                                    ? "补充正式结算"
                                    : "补充机构总权益"}
                                </LinkButton>
                              ) : (
                                <small>请补充机构总权益</small>
                              ))}
                            {r.display_base_value == null &&
                              r.display_value != null && (
                                <small>缺汇率，暂未计入汇总</small>
                              )}
                          </div>
                        ),
                      },
                      {
                        title: "状态",
                        dataIndex: "status",
                        render: (v, r: any) =>
                          r.reference_partial ? (
                            <Tag color="gold">待核对</Tag>
                          ) : r.has_estimate ? (
                            <Tag color="gold">参考估算</Tag>
                          ) : (
                            <Status value={v} />
                          ),
                      },
                    ])}
                    dataSource={accounts}
                  />
                ) : (
                  <Blank
                    title="尚未建立账户"
                    description="银行卡、现金、基金和证券账户会汇集在这里。"
                  />
                )}
              </Panel>
              <Panel
                title="需要留意"
                subtitle="异常与到期事项优先展示"
                action={<Tag>{todos.length} 项</Tag>}
              >
                {todos.length ? (
                  <div className="todo-list">
                    {todos.slice(0, 5).map((t: any, i: number) => (
                      <button
                        key={t.id || i}
                        onClick={() => goto("cashbook?tab=todos")}
                      >
                        <span className="todo-dot" />
                        <div>
                          <strong>{t.title || t.kind || "待核对事项"}</strong>
                          <p>
                            {hidden && (t.reason || t.description)
                              ? "内容已隐藏"
                              : t.reason || t.description || t.due_date}
                          </p>
                        </div>
                        <ArrowRight size={16} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <Blank
                    title="暂无待处理事项"
                    description="缺失数据、待核对扣款和到期计划会在这里列出。"
                  />
                )}
              </Panel>
            </div>
            <div className="three-column">
              <Panel title="业务日历" action={<CalendarDays size={18} />}>
                <div className="mini-week">
                  {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
                    <span key={d}>{d}</span>
                  ))}
                </div>
                {calendar.loading ? (
                  <div className="quiet-empty">正在读取日历…</div>
                ) : calendar.error ? (
                  <p className="muted">{calendar.error}</p>
                ) : listOf<Item>(calendar.data).length ? (
                  <div className="compact-list">
                    {listOf<Item>(calendar.data)
                      .slice(0, 4)
                      .map((r, i) => (
                        <div key={r.id || i}>
                          <time>{r.date || r.due_date}</time>
                          <span>
                            {hidden && r.kind === "event"
                              ? "内容已隐藏"
                              : kinds[r.title] ||
                                kinds[r.name] ||
                                kinds[r.kind] ||
                                r.title ||
                                r.name ||
                                r.kind}
                          </span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="quiet-empty">暂无已安排的日历事项</div>
                )}
                <LinkButton onClick={() => goto("planning?tab=calendar")}>
                  查看全部安排
                </LinkButton>
              </Panel>
              <Panel
                title="我的财富目标"
                action={
                  <LinkButton onClick={() => goto("planning")}>管理</LinkButton>
                }
              >
                {goals.loading ? (
                  <div className="quiet-empty">正在读取目标…</div>
                ) : goals.error ? (
                  <Alert type="error" message={goals.error} />
                ) : listOf<Item>(goals.data).length ? (
                  <div className="compact-list">
                    {listOf<Item>(goals.data)
                      .slice(0, 3)
                      .map((g) => (
                        <div key={g.id}>
                          <span>{g.name}</span>
                          <Money value={g.amount} currency={g.currency} />
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="small-empty">
                    <span className="outlined-icon">↗</span>
                    <p>还没有设置财富目标</p>
                    <Button onClick={() => goto("planning")}>
                      创建一个目标
                    </Button>
                  </div>
                )}
              </Panel>
              <Panel
                title="最近手札"
                action={
                  <LinkButton onClick={() => goto("notebook")}>
                    打开手札
                  </LinkButton>
                }
              >
                {notes.loading ? (
                  <div className="quiet-empty">正在读取手札…</div>
                ) : notes.error ? (
                  <Alert type="error" message={notes.error} />
                ) : listOf<Item>(notes.data).length ? (
                  <div className="compact-list">
                    {listOf<Item>(notes.data)
                      .slice(0, 3)
                      .map((n) => (
                        <button onClick={() => goto("notebook")} key={n.id}>
                          <span>{n.title}</span>
                          <ArrowUpRight size={13} />
                        </button>
                      ))}
                  </div>
                ) : (
                  <div className="small-empty">
                    <span className="outlined-icon">✎</span>
                    <p>保存自己的判断与复盘</p>
                    <Button onClick={() => goto("notebook")}>写一篇手札</Button>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}
      </LoadState>
    </>
  );
}
function Metric({
  icon,
  title,
  value,
  currency,
  foot,
}: {
  icon: any;
  title: string;
  value: any;
  currency?: string;
  foot: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span>
          <HelpText text={title} />
        </span>
        <span className="metric-icon">{icon}</span>
      </div>
      <strong>
        <Money value={value} currency={currency} />
      </strong>
      <p>
        <HelpText text={foot} />
      </p>
    </div>
  );
}
