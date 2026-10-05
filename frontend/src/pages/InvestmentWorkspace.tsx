import { helpColumns, HelpText } from "../help";
import {
  clearAutomaticSpecification,
  manualIdentityFields,
  productIdentityKey,
} from "../product-metadata";
import ProductIdentity from "./ProductIdentity";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Popover,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from "antd";
import {
  Plus,
  RefreshCw,
  Search,
  ArrowUpRight,
  MoreHorizontal,
  Pin,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ColumnsType } from "antd/es/table";
import HoldingDisplaySettings, {
  useHoldingDisplayPreferences,
} from "./HoldingDisplaySettings";
import HoldingsOverview, { HoldingDailyReturn } from "./HoldingsOverview";
import PendingPurchaseDetails from "./PendingPurchaseDetails";
import {
  configuredHoldingColumns,
  holdingLabels,
  holdingMatches,
  holdingRowKey,
  holdingSortOptions,
  hasPendingPurchases,
  holdingPendingAmount,
  pendingPurchaseItems,
  sortHoldings,
} from "../holding-display";
import "./holdings-workspace.css";
import {
  api,
  currencyOptions,
  dateToday,
  dateTimeNowLocal,
  listOf,
  send,
} from "../api";
import type { Item } from "../api";
import { Blank, Fields, LoadState, Money, Panel, Status } from "../components";
import { useDebounced, useResource, useWorkspace } from "../state";
import {
  compatibleAccountKinds,
  investmentKinds,
  percentText,
  profitTone,
} from "../investment";

import InvestmentTools from "./Investments";
import HoldingTrade from "./HoldingTrade";
import FundConvert from "./FundConvert";
import { DeletedEntities, EntityDeleteDialog } from "./EntityLifecycle";
import MarketSearch from "./MarketSearch";
import { holdingFundingPreview } from "../holding-funding";
import { positiveDecimalInput } from "../positive-input";
import {
  holdingReconciliation,
  holdingReconciliationPayload,
  ordinaryHoldingPayload,
} from "../holding-reconciliation";
import { HoldingReconciliation } from "./HoldingReconciliation";
import {
  HoldingCorrection,
  HoldingInstitutionCheck,
  PlaceholderHoldingVoid,
} from "./HoldingManagement";
import {
  holdingDisplayRows,
  optionPositionForProduct,
} from "../option-holding";
import {
  OptionHoldingFields,
  OptionHoldingEditor,
  OptionHoldingHistory,
} from "./OptionHoldingFields";

export function QuoteStatus({ status }: { status?: string }) {
  const labels: Record<string, string> = {
    fresh: "已更新",
    needs_reconciliation: "待核对",
    empty: "暂无持仓",
    triggered: "条件触发",
    not_triggered: "未触发",
    disabled: "已停用",
    matched: "已满足",
    not_matched: "未满足",
    live: "盘中参考",
    available: "已更新",
    confirmed: "已确认",
    complete: "已更新",
    manual: "手动录入",
    unknown: "待补全",
    reference: "参考行情",
    official: "正式净值",
    stale: "历史行情",
    missing: "暂无行情",
    unavailable: "暂不可用",
    unsupported: "暂不支持",
    partial: "部分更新",
    estimate: "参考估值",
    quotes_only: "合约行情",
    product_quotes: "产品行情",
    no_position: "无持仓",
    future: "未发生",
    current: "已更新",
    ok: "已更新",
  };
  return (
    <Tag
      color={
        [
          "fresh",
          "live",
          "available",
          "confirmed",
          "complete",
          "official",
          "current",
          "ok",
        ].includes(status || "")
          ? "green"
          : ["stale", "partial", "estimate"].includes(status || "")
            ? "gold"
            : undefined
      }
    >
      {labels[status || ""] || status || "待更新"}
    </Tag>
  );
}
export function Rate({ value }: { value: unknown }) {
  const { hidden } = useWorkspace();
  return (
    <span className={hidden ? "" : profitTone(value)}>
      {hidden ? "••••••" : percentText(value) || "—"}
    </span>
  );
}
export function RefreshQuotes({ onDone }: { onDone?: () => void }) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const id = window.setTimeout(() => {
      setBusy(false);
      reload();
      onDone?.();
    }, 5000);
    return () => window.clearTimeout(id);
  }, [busy]);
  if (space.role === "viewer") return null;
  return (
    <Button
      icon={<RefreshCw size={15} />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await send(`/spaces/${space.id}/market/refresh`);
          message.success(
            result.status === "queued"
              ? "行情更新已提交，稍后自动刷新"
              : "行情已更新",
          );
        } catch (e) {
          message.error((e as Error).message);
          setBusy(false);
        }
      }}
    >
      更新行情
    </Button>
  );
}
export default function InvestmentWorkspace({
  products = false,
}: {
  products?: boolean;
}) {
  const { space, requestReveal, hidden, refresh } = useWorkspace();
  const navigate = useNavigate();
  const { modal } = App.useApp();
  const [kind, setKind] = useState(""),
    [converting, setConverting] = useState<Item | null>(null),
    [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState<Item | undefined>(),
    [manage, setManage] = useState(false),
    [trade, setTrade] = useState<{
      holding: Item;
      side: "buy" | "sell";
    } | null>(null),
    [planHolding, setPlanHolding] = useState<Item | null>(null),
    [plansOpen, setPlansOpen] = useState(false),
    [optionHistoryOpen, setOptionHistoryOpen] = useState(false),
    [optionEditing, setOptionEditing] = useState<Item | null>(null),
    [holdingCorrection, setHoldingCorrection] = useState<Item | null>(null),
    [holdingCheck, setHoldingCheck] = useState<Item | null>(null),
    [placeholderVoid, setPlaceholderVoid] = useState<Item | null>(null),
    [deleteProduct, setDeleteProduct] = useState<Item | null>(null),
    [deletedProductsOpen, setDeletedProductsOpen] = useState(false);
  const params = new URLSearchParams({
    limit: "200",
    ...(products && kind ? { kind } : {}),
  });
  const state = useResource(
    products ? "instruments" : "holdings",
    `?${params}`,
  );
  const quotes = useResource("market/quotes");
  const debouncedQuery = useDebounced(query);
  const display = useHoldingDisplayPreferences(space.id);
  const asOf = state.data?.as_of || dateToday();
  const filteredRows = (
    products ? listOf<Item>(state.data) : holdingDisplayRows(state.data)
  ).filter((row) => holdingMatches(row, debouncedQuery, products ? "" : kind));
  const rows = products
    ? filteredRows
    : (sortHoldings(filteredRows, display.preferences, asOf) as Item[]);
  const visibleColumns = configuredHoldingColumns(display.preferences);
  const showPendingColumn = visibleColumns.some(
    (column) => column.key === "pending",
  );
  const unassignedPending = pendingPurchaseItems(
    state.data?.pending_purchases?.items,
  ).filter((item) => !item.holding_account_id);
  const configureColumns = (columns: ColumnsType<Item>): ColumnsType<Item> =>
    visibleColumns.map((column) => ({
      ...columns.find((c) => c.key === column.key)!,
      key: column.key,
      width: column.width,
      fixed: column.fixed,
    }));
  function togglePin(row: Item) {
    const key = holdingRowKey(row);
    const pinned = display.preferences.pinned;
    display.save({
      ...display.preferences,
      pinned: pinned.includes(key)
        ? pinned.filter((value) => value !== key)
        : [...pinned, key],
    });
  }
  const quoteRows = listOf<Item>(quotes.data);
  function add(item?: Item, edit = false) {
    requestReveal(() => {
      setSelected(item);
      setManage(edit);
      setOpen(true);
    });
  }
  useEffect(() => {
    const timer = window.setInterval(() => {
      void quotes.retry();
      void state.retry();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [space.id, refresh, kind, products]);
  return (
    <>
      <Panel
        title={products ? "投资产品" : "我的持仓"}
        className={products ? "" : "holdings-workspace"}
        action={
          <Space wrap>
            {products && space.role !== "viewer" && (
              <Button
                type="text"
                size="small"
                onClick={() => setDeletedProductsOpen(true)}
              >
                已删除
              </Button>
            )}
            <RefreshQuotes />
            {!products && (
              <Dropdown
                menu={{
                  items: [
                    {
                      key: "option-history",
                      label: "期权持仓记录",
                      onClick: () => setOptionHistoryOpen(true),
                    },
                    {
                      key: "plans",
                      label: "全部定投计划",
                      onClick: () => {
                        setPlanHolding(null);
                        setPlansOpen(true);
                      },
                    },
                  ],
                }}
                trigger={["click"]}
              >
                <Button
                  aria-label="持仓更多操作"
                  icon={<MoreHorizontal size={16} />}
                />
              </Dropdown>
            )}
            {space.role !== "viewer" && (
              <Button
                type="primary"
                icon={<Plus size={15} />}
                onClick={() => add()}
              >
                新增投资产品
              </Button>
            )}
          </Space>
        }
      >
        {!products && !state.loading && !state.error && (
          <HoldingsOverview
            rows={filteredRows}
            asOf={asOf}
            filtered={!!kind || !!debouncedQuery.trim()}
            truncated={state.data?.has_more === true}
          />
        )}
        {!products &&
          !state.loading &&
          !state.error &&
          unassignedPending.length > 0 && (
            <p className="data-caption">
              当前账簿另有 {unassignedPending.length}{" "}
              笔买入待确认款尚未明确持仓账户。
              <PendingPurchaseDetails
                items={unassignedPending}
                label="查看明细"
                title="持仓账户待核对的买入款"
                compact
              />
            </p>
          )}
        <div className={products ? "investment-toolbar" : "holdings-toolbar"}>
          <div
            className="asset-kind-tabs"
            role="group"
            aria-label="投资产品分类"
          >
            {[["", "全部"], ...Object.entries(investmentKinds)].map(
              ([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={kind === value}
                  onClick={() => setKind(value)}
                >
                  {label}
                </button>
              ),
            )}
          </div>
          <div className={products ? undefined : "holdings-toolbar-right"}>
            <Input
              prefix={<Search size={15} />}
              placeholder={
                products ? "名称、代码或账户" : "名称、代码、账户或标签"
              }
              aria-label={products ? "搜索投资产品" : "搜索持仓"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              allowClear
              className="investment-search"
            />
            {!products && (
              <>
                <Select
                  aria-label="持仓排序"
                  size="small"
                  value={display.preferences.sort}
                  options={[...holdingSortOptions]}
                  style={{ minWidth: 158 }}
                  disabled={!display.ready}
                  onChange={(sort) =>
                    display.save({ ...display.preferences, sort })
                  }
                />
                <HoldingDisplaySettings
                  preferences={display.preferences}
                  onChange={display.save}
                  ready={display.ready}
                  notice={display.notice}
                />
              </>
            )}
          </div>
        </div>
        <LoadState {...state}>
          <Table<Item>
            rowKey={(r) => (products ? r.id : holdingRowKey(r))}
            rowClassName={(r) =>
              !products && display.preferences.pinned.includes(holdingRowKey(r))
                ? "holding-pinned"
                : ""
            }
            size={products ? "middle" : "small"}
            dataSource={rows}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              hideOnSinglePage: true,
            }}
            scroll={{
              x: products
                ? 800
                : visibleColumns.reduce((sum, column) => sum + column.width, 0),
            }}
            locale={{
              emptyText: (
                <Blank
                  title={products ? "暂无投资产品" : "暂无持仓"}
                  description="点击右上方「新增投资产品」，可录入已有持仓或添加自选产品。"
                />
              ),
            }}
            columns={helpColumns<Item>(
              products
                ? [
                    {
                      title: "产品",
                      render: (_, r) => (
                        <div className="cell-name">
                          <strong>{r.name}</strong>
                          <small>
                            {r.code} · {r.market} {r.share_class}
                          </small>
                        </div>
                      ),
                    },
                    {
                      title: "类型",
                      width: 70,
                      dataIndex: "kind",
                      render: (v) => investmentKinds[v] || v,
                    },
                    {
                      title: "关联账户",
                      render: (_, r) =>
                        r.account_names?.join("、") ||
                        r.accounts?.map((a: Item) => a.name).join("、") ||
                        "未关联",
                    },
                    {
                      title: "最新价格",
                      render: (_, r) => {
                        const q = quoteRows.find(
                          (q) => q.instrument_id === r.id,
                        );
                        return (
                          <div className="cell-name">
                            <Money value={q?.price} currency={r.currency} />
                            <small>
                              {q?.quote_unit || r.specification?.quote_unit}
                            </small>
                            <small>{q?.economic_date || "待更新"}</small>
                          </div>
                        );
                      },
                    },
                    {
                      title: "行情状态",
                      render: (_, r) => (
                        <QuoteStatus
                          status={
                            quoteRows.find((q) => q.instrument_id === r.id)
                              ?.status
                          }
                        />
                      ),
                    },
                    {
                      title: "操作",
                      width: 160,
                      render: (_, r) =>
                        space.role !== "viewer" && (
                          <Space size={0}>
                            {r.kind === "index" ? (
                              <Button
                                type="link"
                                onClick={() =>
                                  navigate(
                                    `/spaces/${space.id}/analytics?tab=market`,
                                  )
                                }
                              >
                                行情管理
                              </Button>
                            ) : (
                              <Space size={0}>
                                {r.kind !== "future" && (
                                  <Button type="link" onClick={() => add(r)}>
                                    录入持仓
                                  </Button>
                                )}
                                {["fund", "stock", "etf", "gold"].includes(
                                  r.kind,
                                ) && (
                                  <Button
                                    type="link"
                                    onClick={() => {
                                      setPlanHolding(r);
                                      setPlansOpen(true);
                                    }}
                                  >
                                    定投
                                  </Button>
                                )}
                              </Space>
                            )}
                            <Dropdown
                              trigger={["click"]}
                              menu={{
                                items: [
                                  ...(["fund", "stock", "etf", "gold"].includes(
                                    r.kind,
                                  )
                                    ? [{ key: "buy", label: "记录买入" }]
                                    : []),
                                  ...(r.kind !== "index"
                                    ? [{ key: "edit", label: "编辑产品" }]
                                    : []),
                                  {
                                    key: "delete",
                                    label: "删除投资产品",
                                    danger: true,
                                  },
                                ],
                                onClick: ({ key }) =>
                                  key === "buy"
                                    ? requestReveal(() =>
                                        setTrade({ holding: r, side: "buy" }),
                                      )
                                    : key === "edit"
                                      ? add(r, true)
                                      : requestReveal(() =>
                                          setDeleteProduct(r),
                                        ),
                              }}
                            >
                              <Button
                                type="text"
                                size="small"
                                aria-label={`更多产品操作：${r.name}`}
                                icon={<MoreHorizontal size={16} />}
                              />
                            </Dropdown>
                          </Space>
                        ),
                    },
                  ]
                : configureColumns([
                    {
                      key: "product",
                      title: "产品 / 账户",
                      width: 225,
                      render: (_, r) => (
                        <div className="cell-name">
                          <div className="holdings-product-title">
                            <button
                              type="button"
                              className="holdings-pin"
                              disabled={!display.ready}
                              aria-label={`${display.preferences.pinned.includes(holdingRowKey(r)) ? "取消置顶" : "置顶"}${r.instrument_name || r.name}`}
                              aria-pressed={display.preferences.pinned.includes(
                                holdingRowKey(r),
                              )}
                              onClick={() => togglePin(r)}
                            >
                              <Pin size={12} />
                            </button>
                            <strong>{r.instrument_name || r.name}</strong>
                          </div>
                          <small>
                            {r.code || r.instrument_code} · {r.account_name}
                          </small>
                          {!showPendingColumn && hasPendingPurchases(r) && (
                            <PendingPurchaseDetails
                              items={r.pending_purchases.items || []}
                              amount={holdingPendingAmount(r)}
                              currency={r.currency}
                              title={`${r.instrument_name || r.name} · 买入待确认`}
                              compact
                            />
                          )}
                          {holdingLabels(r).length > 0 && (
                            <div
                              className="holdings-labels"
                              title={holdingLabels(r).join("、")}
                            >
                              {holdingLabels(r)
                                .slice(0, 2)
                                .map((label) => (
                                  <span key={label}>{label}</span>
                                ))}
                              {holdingLabels(r).length > 2 && (
                                <span>+{holdingLabels(r).length - 2}</span>
                              )}
                            </div>
                          )}
                          {r.status === "needs_reconciliation" && (
                            <small>金额范围待核对</small>
                          )}
                          {(r.contains_preview_entries ||
                            r.contains_automatic_estimates ||
                            r.history_warning) && (
                            <small>
                              {(r.contains_preview_entries ||
                                r.contains_automatic_estimates) && (
                                <HelpText
                                  text={
                                    r.entry_basis_label ||
                                    (r.contains_automatic_estimates
                                      ? "含自动推算"
                                      : "按预览补录")
                                  }
                                />
                              )}
                              {r.history_warning && (
                                <Tooltip
                                  title={
                                    hidden
                                      ? "显示金额后可查看历史记录说明"
                                      : r.history_warning
                                  }
                                >
                                  <span>
                                    {r.contains_preview_entries ||
                                    r.contains_automatic_estimates
                                      ? " · "
                                      : ""}
                                    历史记录待核对
                                  </span>
                                </Tooltip>
                              )}
                            </small>
                          )}
                          {(r.is_reference_position ||
                            (r.contributes === false &&
                              r.pending_only !== true)) && (
                            <small>参考明细 · 不重复计入汇总</small>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: "pending",
                      title: "买入待确认",
                      render: (_, r) =>
                        hasPendingPurchases(r) ? (
                          <PendingPurchaseDetails
                            items={r.pending_purchases.items || []}
                            amount={holdingPendingAmount(r)}
                            currency={r.currency}
                            label=""
                            title={`${r.instrument_name || r.name} · 买入待确认`}
                          />
                        ) : (
                          "—"
                        ),
                    },
                    {
                      key: "daily",
                      title: "今日估算收益",
                      render: (_, r) => (
                        <HoldingDailyReturn row={r} asOf={asOf} />
                      ),
                    },
                    {
                      key: "latest",
                      title: "最近净值收益",
                      render: (_, r) => (
                        <HoldingDailyReturn row={r} asOf={asOf} latest />
                      ),
                    },
                    {
                      key: "tags",
                      title: "投资标签",
                      render: (_, r) => holdingLabels(r).join("、") || "未设置",
                    },
                    {
                      key: "kind",
                      title: "类型",
                      width: 70,
                      dataIndex: "kind",
                      render: (v) => investmentKinds[v] || v,
                    },
                    {
                      key: "cost",
                      title: "数量 / 成本",
                      render: (_, r) => (
                        <div className="cell-name">
                          {r.pending_only === true ? (
                            <span className="unknown">尚未确认份额</span>
                          ) : r.is_reference_position ? (
                            <>
                              <span>
                                {r.side === "short"
                                  ? "卖出（空头）"
                                  : "买入（多头）"}{" "}
                                · <Money value={r.quantity} /> 手
                              </span>
                              <small>
                                <HelpText text="开仓均价" />{" "}
                                <Money
                                  value={r.opening_price}
                                  currency={r.currency}
                                />
                              </small>
                              <small>
                                <HelpText text="合约乘数" />{" "}
                                <Money value={r.contract_multiplier} />
                              </small>
                            </>
                          ) : (
                            <>
                              <Money value={r.quantity} />
                              <small>
                                <Money
                                  value={r.cost_basis ?? r.cost}
                                  currency={r.currency}
                                />
                              </small>
                            </>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: "value",
                      title: "最新持仓价值",
                      render: (_, r) =>
                        r.pending_only === true ? (
                          <span className="unknown">尚未确认份额</span>
                        ) : (
                          <div className="cell-name">
                            <Money
                              value={
                                r.is_reference_position
                                  ? r.current_value
                                  : (r.manual_value ??
                                    r.market_value ??
                                    r.value)
                              }
                              currency={r.currency}
                              precision={2}
                            />
                            <small>
                              {r.is_reference_position
                                ? `手动市值 · ${r.as_of}`
                                : r.manual_value != null
                                  ? `手动录入 · ${r.manual_value_date}`
                                  : `${r.status === "stale" ? "历史数据 · " : ""}${r.price_date || r.as_of || "价格日期待补全"}`}
                            </small>
                          </div>
                        ),
                    },
                    {
                      key: "profit",
                      title: "持有收益 / 毛浮盈",
                      render: (_, r) =>
                        r.pending_only === true ? (
                          <span className="unknown">—</span>
                        ) : (
                          <div
                            className={`cell-name ${hidden ? "" : profitTone(r.is_reference_position ? r.reference_profit : r.profit)}`}
                          >
                            {r.status === "needs_reconciliation" ? (
                              <>
                                <Tag color="orange">待核对</Tag>
                                <small>
                                  机构显示{" "}
                                  <Money
                                    value={r.institution_profit}
                                    currency={r.currency}
                                    precision={2}
                                    sign
                                  />
                                </small>
                                <small>
                                  原记录计算{" "}
                                  <Money
                                    value={r.computed_profit}
                                    currency={r.currency}
                                    precision={2}
                                    sign
                                  />
                                </small>
                              </>
                            ) : (
                              <>
                                <Money
                                  value={
                                    r.is_reference_position
                                      ? r.reference_profit
                                      : r.profit
                                  }
                                  currency={r.currency}
                                  precision={2}
                                  sign
                                />
                                <small>
                                  {r.is_reference_position ? (
                                    <>
                                      <HelpText text="毛浮动盈亏" /> · 未扣费用
                                    </>
                                  ) : (
                                    <Rate value={r.profit_rate} />
                                  )}
                                </small>
                              </>
                            )}
                          </div>
                        ),
                    },
                    {
                      key: "estimate",
                      title: "盘中估值 / 结算参考",
                      render: (_, r) =>
                        r.pending_only === true ? (
                          <span className="unknown">确认份额后估值</span>
                        ) : r.is_reference_position ? (
                          <div className="cell-name">
                            {r.settlement_price != null ? (
                              <>
                                <span>
                                  <HelpText text="结算价" />{" "}
                                  <Money
                                    value={r.settlement_price}
                                    currency={r.currency}
                                  />
                                </span>
                                <small>{r.settlement_date} · 每报价单位</small>
                              </>
                            ) : (
                              <span>未填结算价</span>
                            )}
                          </div>
                        ) : (
                          <div className="cell-name">
                            <Money
                              value={r.estimate_value}
                              currency={r.currency}
                            />
                            <small>
                              持有收益 <Money value={r.estimate_profit} sign />
                            </small>
                            {r.estimate_date && (
                              <small>
                                {r.estimate_date} · {r.estimate_source}
                              </small>
                            )}
                            {r.estimate_status && (
                              <QuoteStatus status={r.estimate_status} />
                            )}
                          </div>
                        ),
                    },
                    {
                      key: "purchase",
                      title: "买入 / 开仓日期",
                      dataIndex: "purchase_date",
                      render: (v) => v || "—",
                    },
                    {
                      key: "status",
                      title: "状态",
                      render: (_, r) => (
                        <div className="cell-name">
                          {r.pending_only === true ? (
                            <Tag>等待份额确认</Tag>
                          ) : r.is_reference_position ? (
                            <>
                              <Tag color="blue">
                                <HelpText text="期权参考持仓" />
                              </Tag>
                              <small>不重复计入净资产</small>
                            </>
                          ) : (
                            <QuoteStatus status={r.status} />
                          )}
                          {(r.contains_preview_entries ||
                            r.contains_automatic_estimates) && (
                            <Tag>
                              <HelpText
                                text={
                                  r.entry_basis_label ||
                                  (r.contains_automatic_estimates
                                    ? "含自动推算"
                                    : "按预览补录")
                                }
                              />
                            </Tag>
                          )}
                          {r.history_warning && (
                            <small
                              style={{ maxWidth: 180, whiteSpace: "normal" }}
                            >
                              {hidden ? "内容已隐藏" : r.history_warning}
                            </small>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: "actions",
                      title: "操作",
                      width: 215,
                      render: (_: unknown, r: Item) =>
                        r.is_reference_position ? (
                          space.role !== "viewer" && (
                            <Button
                              type="link"
                              onClick={() =>
                                requestReveal(() => setOptionEditing(r))
                              }
                            >
                              编辑持仓
                            </Button>
                          )
                        ) : (
                          <Space size={0}>
                            {space.role !== "viewer" &&
                              ["fund", "stock", "etf", "gold"].includes(
                                r.kind,
                              ) && (
                                <>
                                  <Button
                                    type="link"
                                    size="small"
                                    onClick={() =>
                                      requestReveal(() =>
                                        setTrade({ holding: r, side: "buy" }),
                                      )
                                    }
                                  >
                                    买入
                                  </Button>
                                  {r.pending_only !== true && (
                                    <Button
                                      type="link"
                                      size="small"
                                      onClick={() =>
                                        requestReveal(() =>
                                          setTrade({
                                            holding: r,
                                            side: "sell",
                                          }),
                                        )
                                      }
                                    >
                                      卖出
                                    </Button>
                                  )}
                                </>
                              )}
                            {["fund", "stock", "etf", "gold"].includes(
                              r.kind,
                            ) && (
                              <Button
                                type="link"
                                onClick={() => {
                                  setPlanHolding(r);
                                  setPlansOpen(true);
                                }}
                              >
                                定投
                              </Button>
                            )}
                            {space.role !== "viewer" &&
                              r.pending_only !== true && (
                                <Dropdown
                                  menu={{
                                    items: [
                                      ...(r.kind === "fund" &&
                                      r.specification?.trading_channel !==
                                        "exchange"
                                        ? [
                                            {
                                              key: "convert",
                                              label: "基金转换",
                                              onClick: () =>
                                                requestReveal(() =>
                                                  setConverting(r),
                                                ),
                                            },
                                            {
                                              key: "dividends",
                                              label: "分红与红利再投",
                                              onClick: () =>
                                                navigate(
                                                  `/spaces/${space.id}/cashbook?tab=dividends`,
                                                ),
                                            },
                                            {
                                              key: "fund-progress",
                                              label: "申购进度 / 交易记录",
                                              onClick: () =>
                                                navigate(
                                                  `/spaces/${space.id}/cashbook?tab=investments`,
                                                ),
                                            },
                                          ]
                                        : []),
                                      ...(r.placeholder_void?.eligible
                                        ? [
                                            {
                                              key: "void-placeholder",
                                              label: "撤销误录持仓",
                                              onClick: () =>
                                                requestReveal(() =>
                                                  setPlaceholderVoid(r),
                                                ),
                                            },
                                          ]
                                        : []),
                                      {
                                        key: "correct",
                                        label: "更正录入",
                                        onClick: () =>
                                          requestReveal(() => {
                                            if (r.correction?.eligible)
                                              setHoldingCorrection(r);
                                            else
                                              modal.info({
                                                title: "当前持仓不能直接更正",
                                                content:
                                                  r.correction?.reason ||
                                                  "请按原始交易及依赖关系冲正后补录，不直接改写当前持仓。",
                                              });
                                          }),
                                      },
                                      {
                                        key: "check",
                                        label: "核对机构数据",
                                        onClick: () =>
                                          requestReveal(() => {
                                            if (
                                              r.reconciliation_eligibility
                                                ?.eligible
                                            )
                                              setHoldingCheck(r);
                                            else
                                              modal.info({
                                                title: "当前持仓不能直接核对",
                                                content:
                                                  r.reconciliation_eligibility
                                                    ?.reason ||
                                                  "此入口需要可追溯的原始持仓录入；请先核对交易与定投记录。",
                                              });
                                          }),
                                      },
                                    ],
                                  }}
                                  trigger={["click"]}
                                >
                                  <Button
                                    type="text"
                                    size="small"
                                    aria-label="持仓更多操作"
                                    icon={<MoreHorizontal size={16} />}
                                  />
                                </Dropdown>
                              )}
                          </Space>
                        ),
                    },
                  ]),
            )}
          />
        </LoadState>
        {!products && (
          <p className="data-caption">
            盘中估值按可用行情更新；基金正式净值发布后归属到对应交易日。期货权益见「分析复盘
            →
            行情与结算」。期权参考持仓的市值和毛浮动盈亏单独展示，不重复计入账户权益。
          </p>
        )}
      </Panel>
      <Drawer
        title={
          planHolding
            ? `定投 · ${planHolding.instrument_name || planHolding.name || ""}`
            : "全部定投计划"
        }
        open={plansOpen}
        onClose={() => setPlansOpen(false)}
        width={850}
      >
        {plansOpen && (
          <InvestmentTools
            section="plans"
            context={planHolding || undefined}
            onRecordHolding={(product) => {
              setPlansOpen(false);
              add(product);
            }}
          />
        )}
      </Drawer>
      <Drawer
        title="期权持仓记录"
        open={optionHistoryOpen}
        onClose={() => setOptionHistoryOpen(false)}
        width={1000}
      >
        {optionHistoryOpen && <OptionHoldingHistory />}
      </Drawer>
      {placeholderVoid && (
        <PlaceholderHoldingVoid
          item={placeholderVoid}
          onClose={() => setPlaceholderVoid(null)}
        />
      )}
      {holdingCorrection && (
        <HoldingCorrection
          item={holdingCorrection}
          onClose={() => setHoldingCorrection(null)}
        />
      )}
      {holdingCheck && (
        <HoldingInstitutionCheck
          item={holdingCheck}
          onClose={() => setHoldingCheck(null)}
        />
      )}
      {optionEditing && (
        <OptionHoldingEditor
          item={optionEditing}
          onClose={() => setOptionEditing(null)}
        />
      )}
      <ProductWizard
        open={open}
        onClose={() => setOpen(false)}
        existing={selected}
        manage={manage}
      />
      {trade && (
        <HoldingTrade
          holding={trade.holding}
          side={trade.side}
          onClose={() => setTrade(null)}
        />
      )}
      {converting && (
        <FundConvert holding={converting} onClose={() => setConverting(null)} />
      )}
      {deleteProduct && (
        <EntityDeleteDialog
          resource="instruments"
          item={deleteProduct}
          onClose={() => setDeleteProduct(null)}
        />
      )}
      {deletedProductsOpen && (
        <DeletedEntities
          resource="instruments"
          onClose={() => setDeletedProductsOpen(false)}
        />
      )}
    </>
  );
}
function ProductWizard({
  open,
  onClose,
  existing,
  manage,
}: {
  open: boolean;
  onClose: () => void;
  existing?: Item;
  manage: boolean;
}) {
  const { space, reload } = useWorkspace();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const saveLock = useRef(false);
  const kind = Form.useWatch("kind", form) || "fund";
  const code = Form.useWatch("code", form);
  const market = Form.useWatch("market", form) || "CN";
  const currency = Form.useWatch("currency", form) || "CNY";
  const withHolding = Form.useWatch("with_holding", form) ?? true;
  const savePending =
    Form.useWatch(
      (values) =>
        values.confirm_unreconciled === true &&
        !!holdingReconciliation(values)?.conflicts.length &&
        !["future", "option"].includes(values.kind),
      form,
    ) === true;
  const valuationMode = Form.useWatch("valuation_mode", form) || "auto";
  const fundingMode = Form.useWatch("funding_mode", form) || "allocate";
  const selectedAccountId = Form.useWatch("account_id", form);
  const asOf = Form.useWatch("as_of", form) || dateToday();
  const currentValue = Form.useWatch("current_value", form);
  const currentProfit = Form.useWatch("current_profit", form);
  const valuationBasis = Form.useWatch("valuation_basis", form) || "formal";
  const holdingCost = Form.useWatch("cost", form);
  const specification =
    Form.useWatch("specification", { form, preserve: true }) || {};
  const [identityBusy, setIdentityBusy] = useState(false);
  const [query, setQuery] = useState(""),
    [matches, setMatches] = useState<Item[]>([]),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [savedProduct, setSavedProduct] = useState<Item | undefined>();
  const accountState = useResource("accounts", "?limit=200");
  const fundingState = useResource(
    "overview",
    `?as_of=${encodeURIComponent(asOf)}`,
  );
  const fundingAccounts: Item[] =
    fundingState.data?.as_of === asOf ? fundingState.data.accounts || [] : [];
  const holdingAccount = fundingAccounts.find(
    (account) => account.id === selectedAccountId,
  );
  const fundingPreview = holdingFundingPreview({
    mode: valuationMode,
    currentValue,
    cost: holdingCost,
    profit: currentProfit,
    available: holdingAccount?.available,
  });
  const sourceOptions = fundingAccounts
    .filter(
      (account) =>
        account.id !== selectedAccountId &&
        !account.archived &&
        account.currency === currency &&
        account.valuation_mode !== "snapshot" &&
        ["bank", "cash", "wallet", "fund", "broker", "securities"].includes(
          account.kind,
        ),
    )
    .map((account) => ({
      value: account.id,
      label: `${account.name} · ${account.currency}`,
    }));
  const settledQuery = useDebounced(query, 450);
  const derivatives = ["future", "option"].includes(kind);
  const accountKinds = compatibleAccountKinds[kind] || [];
  const accountOptions = listOf<Item>(accountState.data)
    .filter(
      (a) =>
        !a.archived && accountKinds.includes(a.kind) && a.currency === currency,
    )
    .map((a) => ({ label: `${a.name} · ${a.currency}`, value: a.id }));
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      kind: "fund",
      market: "CN",
      currency: "CNY",
      purchase_date: dateToday(),
      as_of: dateToday(),
      valuation_mode: "value",
      funding_mode: "allocate",
      valuation_basis: "formal",
      valuation_date: undefined,
      valuation_observed_at: dateTimeNowLocal(),
      history_confirmed: false,
      confirm_unreconciled: false,
      ...existing,
      ...manualIdentityFields(existing?.specification),
      strategy: existing?.strategy || existing?.specification?.strategy || "",
      watchlisted:
        existing?.watchlisted ?? existing?.specification?.watchlisted ?? true,
      with_holding: !manage,
      option_position: {
        side: "long",
        purchase_date: dateToday(),
        as_of: dateToday(),
      },
      account_id: existing?.account_ids?.[0],
    });
    setQuery("");
    setMatches([]);
    setError("");
    setSearchError("");
    setSavedProduct(existing);
  }, [open, existing, manage]);
  async function save(values: any) {
    if (saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
      let product = savedProduct;
      const optionPosition = optionPositionForProduct(values);
      if (values.with_holding && !["future", "option"].includes(values.kind))
        holdingReconciliationPayload(values, true);
      if (!product) {
        product = await send(`/spaces/${space.id}/instruments`, {
          name: values.name.trim(),
          code: values.code.trim(),
          kind: values.kind,
          market: values.market,
          currency: values.currency,
          share_class: values.share_class || "",
          strategy: values.strategy || "",
          watchlisted: values.watchlisted ?? true,
          account_ids: [values.account_id],
          specification: form.getFieldValue("specification") || {},
          ...(optionPosition ? { option_position: optionPosition } : {}),
        });
        setSavedProduct(product);
      } else {
        product = await send(
          `/spaces/${space.id}/instruments/${product.id}`,
          {
            version: product.version,
            ...(optionPosition ? { option_position: optionPosition } : {}),
            account_ids: Array.from(
              new Set([
                ...(product.account_ids || existing?.account_ids || []),
                values.account_id,
              ]),
            ),
            ...(manage
              ? {
                  name: values.name.trim(),
                  code: values.code.trim(),
                  kind: values.kind,
                  market: values.market,
                  currency: values.currency,
                  share_class: values.share_class || "",
                  strategy: values.strategy || "",
                  watchlisted: values.watchlisted ?? true,
                  specification: form.getFieldValue("specification") || {},
                }
              : {}),
          },
          "PATCH",
        );
        setSavedProduct(product);
      }
      if (values.with_holding && !derivatives) {
        await send(
          `/spaces/${space.id}/holdings`,
          ordinaryHoldingPayload({ ...values, instrument_id: product!.id }),
        );
      }
      message.success(
        optionPosition
          ? "产品与期权参考持仓已保存"
          : values.with_holding && !derivatives
            ? savePending
              ? "持仓原值已保存，收益暂列为待核对"
              : "产品与持仓已保存，行情将自动更新"
            : "投资产品已保存",
      );
      reload();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        existing
          ? `${manage ? "管理产品" : "录入持仓"} · ${existing.name}`
          : "新增投资产品"
      }
      open={open}
      onCancel={() => {
        if (busy) return;
        if (form.isFieldsTouched())
          modal.confirm({
            title: "关闭并放弃未保存的内容？",
            okText: "关闭",
            cancelText: "继续编辑",
            onOk: onClose,
          });
        else onClose();
      }}
      width={820}
      okText={
        kind === "future" || !withHolding
          ? "保存产品"
          : !derivatives && savePending
            ? "保存并标记待核对"
            : "保存产品与持仓"
      }
      cancelText="取消"
      onOk={() => form.submit()}
      confirmLoading={busy}
      okButtonProps={{ disabled: identityBusy }}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={save}
        className="product-wizard"
        data-dirty={form.isFieldsTouched()}
      >
        {error && (
          <Alert type="error" showIcon message={error} className="form-alert" />
        )}
        {error && savedProduct && !existing && (
          <Alert
            type="info"
            message="产品已保存，请完善持仓信息后重试。"
            className="form-alert"
          />
        )}
        <Form.Item name="kind" label="产品分类" rules={[{ required: true }]}>
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            disabled={!!savedProduct && !manage}
            options={Object.entries(investmentKinds)
              .filter(([value]) => value !== "index")
              .map(([value, label]) => ({
                value,
                label,
              }))}
            onChange={(e) => {
              form.setFieldValue("option_position", {
                side: "long",
                purchase_date: dateToday(),
                as_of: dateToday(),
              });
              form.setFieldsValue({
                account_id: undefined,
                name: undefined,
                code: undefined,
                specification: clearAutomaticSpecification(
                  form.getFieldValue("specification") || {},
                ),
                ...(!form.getFieldValue("identity_manual")
                  ? {
                      market: ["future", "option"].includes(e.target.value)
                        ? "SHFE"
                        : "CN",
                      currency: "CNY",
                    }
                  : {}),
              });
              setQuery("");
            }}
          />
        </Form.Item>
        {!savedProduct && (
          <MarketSearch
            kind={kind}
            market={market}
            onSelect={(item) =>
              form.setFieldsValue({ ...item, account_id: undefined })
            }
          />
        )}
        {savedProduct && !manage && (
          <Popover
            trigger="click"
            content="此处只录入持仓，产品资料请在产品列表选择编辑。已有交易后代码、币种等身份字段需新建产品更正。"
          >
            <Button type="link" size="small">
              为什么产品资料不可修改？
            </Button>
          </Popover>
        )}
        <div className="form-grid">
          <Form.Item
            label="产品名称"
            name="name"
            rules={[{ required: true, message: "请输入产品名称" }]}
          >
            <Input disabled={!!savedProduct && !manage} />
          </Form.Item>
          <Form.Item
            label="代码 / 合约"
            name="code"
            rules={[{ required: true, message: "请输入产品代码" }]}
          >
            <Input disabled={!!savedProduct && !manage} />
          </Form.Item>
          <Form.Item
            label="市场 / 交易所"
            name="market"
            rules={[{ required: true }]}
          >
            <Select
              disabled={!!savedProduct && !manage}
              options={[
                ["CN", "境内"],
                ["HK", "香港"],
                ["US", "美国"],
                ["GLOBAL", "国际现货"],
                ["SHFE", "上海期货交易所"],
                ["CFFEX", "中国金融期货交易所"],
                ["DCE", "大连商品交易所"],
                ["CZCE", "郑州商品交易所"],
                ["INE", "上海国际能源交易中心"],
                ["GFEX", "广州期货交易所"],
                ["SGE", "上海黄金交易所"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(v) =>
                form.setFieldsValue({
                  currency: v === "HK" ? "HKD" : v === "US" ? "USD" : "CNY",
                  identity_manual: true,
                  account_id: undefined,
                })
              }
            />
          </Form.Item>
          <Form.Item label="币种" name="currency" rules={[{ required: true }]}>
            <Select
              disabled={!!savedProduct && !manage}
              options={currencyOptions}
              onChange={() =>
                form.setFieldsValue({
                  account_id: undefined,
                  identity_manual: true,
                })
              }
            />
          </Form.Item>
          {kind === "fund" && (
            <Form.Item label="份额类别（选填）" name="share_class">
              <Input
                disabled={!!savedProduct && !manage}
                placeholder="A / C / 美元现汇"
              />
            </Form.Item>
          )}
          <Form.Item label="策略标签（选填）" name="strategy">
            <Input
              disabled={!!savedProduct && !manage}
              placeholder="红利低波、QDII 等"
            />
          </Form.Item>
        </div>
        <ProductIdentity
          form={form}
          disabled={!!savedProduct && !manage}
          onPendingChange={setIdentityBusy}
        />
        <Form.Item name="watchlisted" valuePropName="checked">
          <Checkbox>加入自选</Checkbox>
        </Form.Item>
        <div className="wizard-section">
          <h3>关联账户</h3>
          <Fields
            fields={[
              {
                name: "account_id",
                label: "持有账户",
                type: "select",
                required: true,
                options: accountOptions,
                referenceKinds: accountKinds,
                referenceCurrency: currency,
                help: "仅显示可持有该类型产品且币种匹配的账户。",
              },
            ]}
          />
          {!accountState.loading && !accountOptions.length && (
            <Alert
              type="info"
              showIcon
              message="暂无匹配账户"
              description={
                <span>
                  请先创建对应类型、币种的账户。
                  <Button
                    type="link"
                    onClick={() => {
                      onClose();
                      navigate(`/spaces/${space.id}/assets?tab=accounts`);
                    }}
                  >
                    前往账户
                  </Button>
                </span>
              }
            />
          )}
        </div>
        {kind === "option" ? (
          <>
            <Form.Item name="with_holding" valuePropName="checked">
              <Checkbox>同时录入已有期权持仓</Checkbox>
            </Form.Item>
            {withHolding && (
              <OptionHoldingFields
                currency={currency}
                prefix={["option_position"]}
                productKey={productIdentityKey({ kind, code })}
                multiplierSuggestion={
                  !specification.metadata_identity ||
                  productIdentityKey(specification.metadata_identity) ===
                    productIdentityKey({ kind, code })
                    ? specification.contract_multiplier
                    : undefined
                }
              />
            )}
          </>
        ) : derivatives ? (
          <Alert
            type="info"
            message="期货先关联账户并获取行情；账户权益和保证金请在「行情与结算」录入机构结算单。"
          />
        ) : (
          <>
            <Form.Item name="with_holding" valuePropName="checked">
              <Checkbox>同时录入已有持仓</Checkbox>
            </Form.Item>
            {!withHolding && (
              <p className="data-caption">
                只保存产品和自选，不生成持仓。保存后可从产品行直接创建定投计划，无需填写占位份额。
              </p>
            )}
            {withHolding && (
              <div className="wizard-section">
                <h3>已有持仓</h3>
                <div className="form-grid">
                  <Form.Item
                    label="实际买入 / 取得日期"
                    name="purchase_date"
                    rules={[{ required: true, message: "请选择实际买入日期" }]}
                  >
                    <Input type="date" max={dateToday()} />
                  </Form.Item>
                  <Form.Item
                    label={
                      specification.quote_unit
                        ? `持仓数量（报价单位：${specification.quote_unit}）`
                        : "当前持仓数量 / 份额"
                    }
                    name="quantity"
                    rules={[
                      { required: true, message: "请输入当前份额" },
                      {
                        validator: async (_, value) => {
                          if (
                            value != null &&
                            value !== "" &&
                            !positiveDecimalInput(value)
                          )
                            throw new Error(
                              "持仓份额须大于零；只创建产品或定投计划时请取消同时录入持仓",
                            );
                        },
                      },
                    ]}
                  >
                    <InputNumber
                      stringMode
                      changeOnBlur={false}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item
                    label="当前持仓取得成本"
                    name="cost"
                    extra="包含买入费用；不是账户现金余额。"
                    rules={[{ required: true, message: "请输入持仓成本" }]}
                  >
                    <InputNumber
                      stringMode
                      min="0"
                      addonAfter={currency}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item
                    label={<HelpText text="持仓核对日期" />}
                    name="as_of"
                    rules={[{ required: true }]}
                  >
                    <Input type="date" max={dateToday()} />
                  </Form.Item>
                </div>
                <Form.Item name="funding_mode" label="这笔持仓的钱从哪里来">
                  <Radio.Group
                    onChange={(event) => {
                      if (
                        event.target.value === "allocate" &&
                        form.getFieldValue("valuation_mode") === "auto"
                      ) {
                        form.setFieldValue("valuation_mode", "value");
                      }
                      form.setFieldValue("funding_account_id", undefined);
                    }}
                    options={[
                      { label: "从机构已有资金中分配", value: "allocate" },
                      { label: "另行补录已有持仓", value: "external" },
                    ]}
                  />
                </Form.Item>
                <p className="data-caption">
                  {fundingMode === "allocate"
                    ? "适合已登记机构总金额、现在逐项拆分现金宝和持仓的情况。按当前市值减少未分配资金，取得成本另存用于计算收益。"
                    : "适合开户金额只填了闲置现金、尚未包含这笔持仓的情况。持仓另行增加，不扣现有资金。"}
                </p>
                <Form.Item name="valuation_mode" label="当前价值与收益">
                  <Radio.Group
                    options={[
                      {
                        label: "自动获取行情计算",
                        value: "auto",
                        disabled: fundingMode === "allocate",
                      },
                      { label: "录入当前持有收益", value: "profit" },
                      { label: "录入当前市值", value: "value" },
                    ]}
                  />
                </Form.Item>
                {valuationMode !== "auto" && (
                  <Form.Item
                    name={
                      valuationMode === "profit"
                        ? "current_profit"
                        : "current_value"
                    }
                    label={
                      valuationMode === "profit"
                        ? "截至核对日期的持有收益（亏损填负数）"
                        : "截至核对日期的持仓市值"
                    }
                    rules={[{ required: true, message: "请输入金额" }]}
                  >
                    <InputNumber
                      stringMode
                      min={valuationMode === "value" ? "0" : undefined}
                      addonAfter={currency}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                )}
                {valuationMode !== "auto" && (
                  <HoldingReconciliation currency={currency} allowPending />
                )}
                {fundingMode === "allocate" && (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      className="form-alert"
                      message="资金分配预览"
                      description={
                        fundingState.loading ? (
                          "正在核对该日期的账户资金…"
                        ) : fundingState.error ? (
                          fundingState.error
                        ) : fundingPreview ? (
                          <span>
                            机构内分配{" "}
                            <Money
                              value={fundingPreview.used}
                              currency={currency}
                            />
                            ， 需从其他账户补入{" "}
                            <Money
                              value={fundingPreview.shortfall}
                              currency={currency}
                            />
                            ， 分配后机构内留存{" "}
                            <Money
                              value={fundingPreview.remaining}
                              currency={currency}
                            />
                            。
                          </span>
                        ) : (
                          "选择持有账户并填写当前市值，或填写成本和持有收益后显示。"
                        )
                      }
                    />
                    <Form.Item
                      name="funding_account_id"
                      label="机构资金不足时，从哪个账户补入"
                      extra="只补不足的部分；不选择就不会扣其他账户。现金宝若已记为基金持仓，需按赎回转购记录，不能再次当现金使用。"
                      rules={[
                        {
                          required:
                            !!fundingPreview &&
                            fundingPreview.shortfall !== "0",
                          message: "请选择补入资金的账户，或先补充机构资金",
                        },
                      ]}
                    >
                      <Select
                        allowClear
                        placeholder="选择银行卡或其他同币种资金账户"
                        options={sourceOptions}
                      />
                    </Form.Item>
                  </>
                )}
                {valuationMode !== "auto" && (
                  <div className="form-grid">
                    <Form.Item
                      name="valuation_basis"
                      label={<HelpText text="当前市值依据" />}
                      rules={[{ required: true }]}
                    >
                      <Select
                        options={[
                          {
                            value: "formal",
                            label: "已公布净值 / 正式收盘数据",
                          },
                          { value: "estimate", label: "盘中行情 / 估算数据" },
                          { value: "unknown", label: "尚未核实数据口径" },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      name="valuation_date"
                      label={<HelpText text="净值 / 行情对应日期" />}
                      extra="照平台显示的净值日或交易日填写。QDII、周末和节假日可能早于昨天；晚间也以实际发布为准。"
                      rules={[
                        {
                          required: valuationBasis !== "unknown",
                          message: "请填写平台显示的数据日期，不是录入日期",
                        },
                      ]}
                    >
                      <Input type="date" max={asOf} />
                    </Form.Item>
                    <Form.Item
                      name="valuation_observed_at"
                      label={<HelpText text="查看这笔市值的时间" />}
                      extra="按当前设备时区记录；不会据此推断净值日期。"
                    >
                      <Input type="datetime-local" />
                    </Form.Item>
                  </div>
                )}
                <Form.Item
                  name="history_confirmed"
                  valuePropName="checked"
                  extra="勾选后按历史价格回溯每日收益。若有定投、买卖、分红或拆分，请分别补录实际交易；仅录入当前持有收益不会摊分成历史日收益。"
                >
                  <Checkbox>
                    确认自买入日期起，期间无买卖、定投、分红或拆分，持仓数量与成本未变
                  </Checkbox>
                </Form.Item>
                {valuationMode === "auto" && (
                  <p className="data-caption">
                    保存后自动获取可用历史与最新价格；缺少价格、汇率或未发布净值的日期显示待更新。
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </Form>
    </Modal>
  );
}
