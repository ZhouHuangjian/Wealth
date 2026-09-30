import { helpColumns } from "../help";
import ProductIdentity from "./ProductIdentity";
import { manualIdentityFields } from "../product-metadata";
import MarketCatalog from "./MarketCatalog";
import { NavigationTabs } from "../navigation";
import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
} from "antd";
import { Bell, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, currencyOptions, listOf, send } from "../api";
import type { Item } from "../api";
import {
  Blank,
  Fields,
  LinkButton,
  LoadState,
  Money,
  Panel,
} from "../components";
import { investmentKinds } from "../investment";
import { useResource, useWorkspace } from "../state";
import { Chart } from "./Home";
import { QuoteStatus } from "./InvestmentWorkspace";
import MarketSearch from "./MarketSearch";
const kinds: Record<string, string> = { ...investmentKinds, index: "指数" };
const conditionNames: Record<string, string> = {
  drawdown: "回撤",
  change_percent: "单日涨跌幅",
  price: "价格 / 指数点位",
};
export function Percentage({ value }: { value: unknown }) {
  const { hidden } = useWorkspace();
  return (
    <>
      <Money value={value} precision={2} />
      {!hidden && value != null ? "%" : ""}
    </>
  );
}
export function DashboardMarket() {
  const { space } = useWorkspace();
  const navigate = useNavigate();
  const state = useResource("market-watchlist");
  useEffect(() => {
    const timer = window.setInterval(() => {
      void state.retry();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [state.retry]);
  const rows = listOf<Item>(state.data).filter(
    (r) => r.enabled && r.show_on_home,
  );
  return (
    <Panel
      title="市场环境"
      action={
        <LinkButton
          onClick={() => navigate(`/spaces/${space.id}/analytics?tab=market`)}
        >
          管理自选
        </LinkButton>
      }
    >
      <LoadState {...state}>
        {rows.length ? (
          <div className="market-mini-grid">
            {rows.slice(0, 8).map((r) => (
              <article key={r.id}>
                <div>
                  <strong>{r.instrument_name || r.name || r.code}</strong>
                  <QuoteStatus status={r.quote?.status} />
                </div>
                <b>
                  <Money
                    value={r.quote?.price}
                    precision={r.kind === "index" ? 2 : 4}
                    currency={
                      r.kind === "index" ? "" : r.quote?.currency || r.currency
                    }
                  />
                </b>
                <small>{r.quote?.quote_unit || r.code}</small>
                <div className="market-mini-metrics">
                  <span>
                    单日 <Percentage value={r.quote?.change_percent} />
                  </span>
                  <span>
                    {r.lookback_days}日回撤{" "}
                    <Percentage value={r.drawdown_percent} />
                  </span>
                </div>
                <time>
                  {r.quote?.economic_date || "待更新"} ·{" "}
                  {r.quote?.source || "暂无来源"}
                </time>
              </article>
            ))}
          </div>
        ) : (
          <Blank
            title="尚未添加市场自选"
            description="可关注指数、商品或投资产品，并在分析复盘中设置显示项目。"
          />
        )}
      </LoadState>
    </Panel>
  );
}
export function DashboardSignals() {
  const { space, hidden } = useWorkspace();
  const navigate = useNavigate();
  const state = useResource("signals");
  useEffect(() => {
    const timer = window.setInterval(() => {
      void state.retry();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [state.retry]);
  const rows = listOf<Item>(state.data).filter((r) => r.status === "triggered");
  return (
    <Panel
      title="条件提醒"
      action={
        <LinkButton
          onClick={() =>
            navigate(`/spaces/${space.id}/analytics?tab=market&section=rules`)
          }
        >
          管理提醒
        </LinkButton>
      }
    >
      <LoadState {...state}>
        {rows.length ? (
          <div className="signal-list">
            {rows.slice(0, 4).map((r) => (
              <button
                key={r.id || r.rule_id}
                onClick={() =>
                  navigate(
                    `/spaces/${space.id}/analytics?tab=market&section=rules`,
                  )
                }
              >
                <Bell size={17} />
                <span>
                  <strong>{hidden ? "条件提醒" : r.name}</strong>
                  <small>
                    {r.last_triggered_at?.slice(0, 16).replace("T", " ") ||
                      r.evaluated_at?.slice(0, 16).replace("T", " ")}
                  </small>
                </span>
                <Tag color="gold">条件触发</Tag>
              </button>
            ))}
          </div>
        ) : (
          <div className="quiet-empty">暂无触发提醒</div>
        )}
      </LoadState>
    </Panel>
  );
}
export default function MarketEnvironment({
  initialSection = "watchlist",
}: {
  initialSection?: string;
}) {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const { message } = App.useApp();
  const watches = useResource("market-watchlist"),
    instruments = useResource("instruments", "?limit=200"),
    rules = useResource("signal-rules"),
    signals = useResource("signals"),
    tags = useResource("investment-tags"),
    preferences = useResource("dashboard-preferences");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [watchPreset, setWatchPreset] = useState<Item | undefined>(),
    [watchEditing, setWatchEditing] = useState<Item | undefined>(),
    [watchOpen, setWatchOpen] = useState(false),
    [ruleOpen, setRuleOpen] = useState(false),
    [editing, setEditing] = useState<Item | undefined>(),
    [chart, setChart] = useState<Item | null>(null),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState(initialSection);
  useEffect(() => setTab(initialSection), [initialSection]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void watches.retry();
      void signals.retry();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [watches.retry, signals.retry]);
  async function toggle(
    resource: string,
    item: Item,
    field: string,
    value: boolean,
  ) {
    try {
      await send(
        `/spaces/${space.id}/${resource}/${item.id}`,
        { version: item.version, [field]: value },
        "PATCH",
      );
      reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function pref(field: string, value: boolean) {
    try {
      const p = preferences.data;
      await send(`/spaces/${space.id}/dashboard-preferences`, {
        ...(p?.version ? { version: p.version } : {}),
        show_market_environment: p?.show_market_environment !== false,
        show_valuation: p?.show_valuation !== false,
        show_signals: p?.show_signals !== false,
        [field]: value,
      });
      reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  const instrumentOptions = listOf<Item>(instruments.data).map((r) => ({
      value: r.id,
      label: `${r.name} · ${r.code}`,
    })),
    tagOptions = listOf<Item>(tags.data).map((r) => ({
      value: r.id,
      label: r.name,
    }));
  return (
    <>
      <NavigationTabs
        group="analytics.market"
        routeParam="section"
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "watchlist",
            label: "市场自选",
            children: (
              <Panel
                title="市场环境"
                action={
                  space.role !== "viewer" && (
                    <Space>
                      <Button
                        onClick={() =>
                          requestReveal(() => setCatalogOpen(true))
                        }
                      >
                        从目录批量添加
                      </Button>
                      <Button
                        type="primary"
                        icon={<Plus size={15} />}
                        onClick={() => {
                          setWatchPreset(undefined);
                          setWatchEditing(undefined);
                          requestReveal(() => setWatchOpen(true));
                        }}
                      >
                        添加关注
                      </Button>
                    </Space>
                  )
                }
              >
                {!watches.loading &&
                  !listOf(watches.data).length &&
                  space.role !== "viewer" && (
                    <div className="market-templates">
                      <span>选择市场模板</span>
                      {[
                        {
                          code: "NDX",
                          name: "纳指100",
                          market: "US",
                          currency: "USD",
                        },
                        {
                          code: "SPX",
                          name: "标普500",
                          market: "US",
                          currency: "USD",
                        },
                        {
                          code: "VIX",
                          name: "VIX",
                          market: "US",
                          currency: "USD",
                        },
                        {
                          code: "H30269",
                          name: "红利低波",
                          market: "CN",
                          currency: "CNY",
                        },
                      ].map((t) => (
                        <Button
                          key={t.code}
                          onClick={() => {
                            setWatchEditing(undefined);
                            setWatchPreset({
                              ...t,
                              id: "",
                              kind: "index",
                              specification: { quote_unit: "点" },
                            });
                            requestReveal(() => setWatchOpen(true));
                          }}
                        >
                          {t.name}
                        </Button>
                      ))}
                    </div>
                  )}
                <LoadState {...watches}>
                  <Table<Item>
                    rowKey="id"
                    dataSource={listOf<Item>(watches.data)}
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    scroll={{ x: 1050 }}
                    columns={helpColumns<Item>([
                      {
                        title: "产品",
                        render: (_, r) => (
                          <div className="cell-name">
                            <strong>{r.instrument_name || r.name}</strong>
                            <small>
                              {r.code} · {kinds[r.kind] || r.kind}
                            </small>
                          </div>
                        ),
                      },
                      {
                        title: "价格",
                        render: (_, r) => (
                          <div className="cell-name">
                            <Money
                              value={r.quote?.price}
                              precision={r.kind === "index" ? 2 : 4}
                              currency={r.kind === "index" ? "" : r.currency}
                            />
                            <small>{r.quote?.quote_unit}</small>
                          </div>
                        ),
                      },
                      {
                        title: "单日涨跌",
                        render: (_, r) => (
                          <Percentage value={r.quote?.change_percent} />
                        ),
                      },
                      {
                        title: "区间回撤",
                        render: (_, r) => (
                          <div className="cell-name">
                            <Percentage value={r.drawdown_percent} />
                            <small>
                              {r.lookback_days} 日高点{" "}
                              <Money
                                value={r.baseline_price}
                                precision={r.kind === "index" ? 2 : 4}
                              />
                            </small>
                          </div>
                        ),
                      },
                      {
                        title: "日期 / 来源",
                        render: (_, r) => (
                          <div className="cell-name">
                            <span>{r.quote?.economic_date || "待更新"}</span>
                            <small>{r.quote?.source}</small>
                            <QuoteStatus
                              status={r.metric_status || r.quote?.status}
                            />
                          </div>
                        ),
                      },
                      {
                        title: "首页",
                        render: (_, r) => (
                          <Switch
                            size="small"
                            aria-label={`${r.instrument_name}首页显示`}
                            checked={!!r.show_on_home}
                            disabled={space.role === "viewer"}
                            onChange={(v) =>
                              toggle("market-watchlist", r, "show_on_home", v)
                            }
                          />
                        ),
                      },
                      {
                        title: "状态",
                        render: (_, r) => (
                          <Switch
                            size="small"
                            aria-label={`${r.instrument_name}行情更新`}
                            checked={!!r.enabled}
                            checkedChildren="启用"
                            unCheckedChildren="停用"
                            disabled={space.role === "viewer"}
                            onChange={(v) =>
                              toggle("market-watchlist", r, "enabled", v)
                            }
                          />
                        ),
                      },
                      {
                        title: "操作",
                        render: (_, r) => (
                          <Space size={0}>
                            <Button type="link" onClick={() => setChart(r)}>
                              历史
                            </Button>
                            {space.role !== "viewer" && (
                              <Button
                                type="link"
                                onClick={() => {
                                  setWatchEditing(r);
                                  requestReveal(() => setWatchOpen(true));
                                }}
                              >
                                设置
                              </Button>
                            )}
                          </Space>
                        ),
                      },
                    ])}
                  />
                </LoadState>
              </Panel>
            ),
          },
          {
            key: "rules",
            label: "条件提醒",
            children: (
              <Panel
                title="补仓条件提醒"
                action={
                  space.role !== "viewer" && (
                    <Space>
                      <Button
                        loading={busy}
                        icon={<RefreshCw size={15} />}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await send(`/spaces/${space.id}/signals/evaluate`);
                            message.success("条件已重新检查");
                            reload();
                          } catch (e) {
                            message.error((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        检查条件
                      </Button>
                      <Button
                        type="primary"
                        icon={<Plus size={15} />}
                        onClick={() => {
                          setEditing(undefined);
                          requestReveal(() => setRuleOpen(true));
                        }}
                      >
                        新增提醒
                      </Button>
                    </Space>
                  )
                }
              >
                <LoadState {...rules}>
                  <Table<Item>
                    rowKey="id"
                    dataSource={listOf<Item>(rules.data)}
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    expandable={{
                      expandedRowRender: (r) => {
                        const result = listOf<Item>(signals.data).find(
                          (s) => s.rule_id === r.id,
                        );
                        return <SignalDetails result={result} />;
                      },
                    }}
                    columns={helpColumns<Item>([
                      {
                        title: "提醒名称",
                        dataIndex: "name",
                        render: (v) => (hidden ? "提醒规则" : v),
                      },
                      {
                        title: "触发逻辑",
                        render: (_, r) =>
                          `${(r.conditions || []).length} 个条件 · ${r.match === "any" ? "满足任一" : "全部满足"}`,
                      },
                      {
                        title: "冷却",
                        render: (_, r) => `${r.cooldown_hours} 小时`,
                      },
                      {
                        title: "当前结果",
                        render: (_, r) => (
                          <QuoteStatus
                            status={
                              listOf<Item>(signals.data).find(
                                (s) => s.rule_id === r.id,
                              )?.status ||
                              (!r.enabled ? "disabled" : "unavailable")
                            }
                          />
                        ),
                      },
                      {
                        title: "启用",
                        render: (_, r) => (
                          <Switch
                            size="small"
                            aria-label={`${r.name}启用`}
                            checked={!!r.enabled}
                            disabled={space.role === "viewer"}
                            onChange={(v) =>
                              toggle("signal-rules", r, "enabled", v)
                            }
                          />
                        ),
                      },
                      {
                        title: "操作",
                        render: (_, r) =>
                          space.role !== "viewer" && (
                            <Space size={0}>
                              <Button
                                type="link"
                                onClick={() => {
                                  setEditing(r);
                                  requestReveal(() => setRuleOpen(true));
                                }}
                              >
                                编辑
                              </Button>
                              {listOf<Item>(signals.data).find(
                                (s) => s.rule_id === r.id,
                              )?.status === "triggered" && (
                                <Button
                                  type="link"
                                  onClick={async () => {
                                    await send(
                                      `/spaces/${space.id}/signals/${r.id}/ack`,
                                    );
                                    reload();
                                  }}
                                >
                                  已读
                                </Button>
                              )}
                            </Space>
                          ),
                      },
                    ])}
                  />
                </LoadState>
                <p className="data-caption">
                  规则只按你设定的条件提醒，不自动交易。多档补仓可分别建立回撤
                  10%、20% 等规则，各自计时去重。
                </p>
              </Panel>
            ),
          },
          {
            key: "display",
            label: "首页显示",
            children: (
              <Panel title="首页模块">
                <LoadState {...preferences}>
                  <div className="dashboard-toggles">
                    {[
                      ["show_valuation", "投资估值"],
                      ["show_market_environment", "市场环境"],
                      ["show_signals", "条件提醒"],
                    ].map(([key, label]) => (
                      <label key={key}>
                        <span>{label}</span>
                        <Switch
                          aria-label={`首页${label}`}
                          checked={preferences.data?.[key] !== false}
                          disabled={space.role === "viewer"}
                          onChange={(v) => pref(key, v)}
                        />
                      </label>
                    ))}
                  </div>
                </LoadState>
              </Panel>
            ),
          },
        ]}
      />
      {catalogOpen && (
        <MarketCatalog
          existing={listOf<Item>(watches.data)}
          onClose={() => setCatalogOpen(false)}
        />
      )}
      <WatchDialog
        editing={watchEditing}
        preset={watchPreset}
        open={watchOpen}
        onClose={() => setWatchOpen(false)}
        instruments={instrumentOptions}
      />
      <RuleDialog
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        editing={editing}
        instruments={instrumentOptions}
        tags={tagOptions}
        rawInstruments={listOf<Item>(instruments.data)}
      />
      <Drawer
        title={`${chart?.instrument_name || "行情"} · 历史价格`}
        open={!!chart}
        onClose={() => setChart(null)}
        width={850}
      >
        {chart && (
          <>
            <Chart
              items={chart.series || []}
              xKey="date"
              yKey="value"
              precision={chart.kind === "index" ? 2 : 4}
            />
            <Table
              rowKey="date"
              dataSource={chart.series || []}
              pagination={{ pageSize: 8 }}
              columns={helpColumns([
                { title: "日期", dataIndex: "date" },
                {
                  title: "价格",
                  render: (_, r: any) => (
                    <Money
                      value={r.value}
                      precision={chart.kind === "index" ? 2 : 4}
                      currency={chart.kind === "index" ? "" : chart.currency}
                    />
                  ),
                },
              ])}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
function WatchDialog({
  open,
  onClose,
  instruments,
  editing,
  preset,
}: {
  preset?: Item;
  editing?: Item;
  open: boolean;
  onClose: () => void;
  instruments: { value: string; label: string }[];
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const useExisting = Form.useWatch("use_existing", form);
  const kind = Form.useWatch("kind", form) || "index",
    market = Form.useWatch("market", form) || "US";
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({
        use_existing: false,
        kind: "index",
        market: "US",
        currency: "USD",
        enabled: true,
        show_on_home: true,
        lookback_days: "365",
        ...preset,
        ...editing,
        ...manualIdentityFields((editing || preset)?.specification),
        ...(editing ? { use_existing: true } : {}),
      });
      setError("");
    }
  }, [open, editing, preset]);
  return (
    <Modal
      title={editing ? "市场关注设置" : "添加市场关注"}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="添加"
      confirmLoading={busy}
      width={740}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={async (v) => {
          setBusy(true);
          setError("");
          try {
            await send(
              `/spaces/${space.id}/market-watchlist${editing ? `/${editing.id}` : ""}`,
              {
                ...(editing ? { version: editing.version } : {}),
                ...(v.use_existing
                  ? { instrument_id: v.instrument_id }
                  : {
                      product: {
                        code: v.code,
                        name: v.name,
                        kind: v.kind,
                        market: v.market,
                        currency: v.currency,
                        specification:
                          form.getFieldValue("specification") || {},
                      },
                    }),
                enabled: v.enabled,
                show_on_home: v.show_on_home,
                lookback_days: Number(v.lookback_days),
              },
              editing ? "PATCH" : "POST",
            );
            message.success("已添加，历史价格正在更新");
            reload();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <Alert className="form-alert" type="error" message={error} />}
        <Form.Item name="use_existing" valuePropName="checked">
          <Checkbox>从已有投资产品选择</Checkbox>
        </Form.Item>
        {useExisting ? (
          <Form.Item
            name="instrument_id"
            label="投资产品"
            rules={[{ required: true }]}
          >
            <Select showSearch optionFilterProp="label" options={instruments} />
          </Form.Item>
        ) : (
          <>
            <Fields
              fields={[
                {
                  name: "kind",
                  label: "类型",
                  type: "select",
                  options: Object.entries(kinds).map(([value, label]) => ({
                    value,
                    label,
                  })),
                  required: true,
                },
                {
                  name: "market",
                  label: "市场",
                  type: "select",
                  options: [
                    "CN",
                    "HK",
                    "US",
                    "SHFE",
                    "CFFEX",
                    "DCE",
                    "CZCE",
                    "INE",
                    "GFEX",
                    "SGE",
                  ].map((value) => ({ value, label: value })),
                  required: true,
                },
              ]}
            />
            <MarketSearch
              kind={kind}
              market={market}
              onSelect={(r) => form.setFieldsValue(r)}
            />
            <Fields
              fields={[
                { name: "code", label: "代码", required: true },
                { name: "name", label: "名称", required: true },
                {
                  name: "currency",
                  label: "币种",
                  type: "select",
                  options: currencyOptions,
                  required: true,
                },
              ]}
            />
          </>
        )}
        {!useExisting && <ProductIdentity form={form} />}
        <Fields
          fields={[
            {
              name: "lookback_days",
              label: "高点回看天数",
              type: "number",
              required: true,
              help: "7—1825 天，例如 365；历史数据不完整时不计算回撤。",
            },
            { name: "show_on_home", label: "显示在首页", type: "switch" },
            { name: "enabled", label: "启用行情更新", type: "switch" },
          ]}
        />
      </Form>
    </Modal>
  );
}
function RuleDialog({
  open,
  onClose,
  editing,
  instruments,
  tags,
  rawInstruments,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Item;
  instruments: { value: string; label: string }[];
  tags: { value: string; label: string }[];
  rawInstruments: Item[];
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const conditions = Form.useWatch("conditions", form) || [];
  const blank = {
    metric: "drawdown",
    scope: "instrument",
    operator: "gte",
    threshold: "10",
    baseline: "rolling_high",
    lookback_days: "365",
  };
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({
        enabled: false,
        match: "all",
        cooldown_hours: "24",
        conditions: [blank],
        ...editing,
      });
      setError("");
    }
  }, [open, editing]);
  function template(type: string) {
    const condition = { ...blank, threshold: type === "20" ? "20" : "10" };
    form.setFieldsValue(
      type === "vix"
        ? {
            name: "VIX 与纳指组合条件",
            enabled: false,
            match: "all",
            conditions: [
              {
                ...blank,
                metric: "price",
                threshold: "25",
                instrument_id: rawInstruments.find((r) =>
                  /^(\^?VIX)$/i.test(r.code),
                )?.id,
              },
              {
                ...blank,
                instrument_id: rawInstruments.find((r) =>
                  /^(\^?NDX|IXIC)$/i.test(r.code),
                )?.id,
              },
            ],
          }
        : {
            name: `回撤 ${condition.threshold}% 提醒`,
            enabled: false,
            match: "all",
            conditions: [condition],
          },
    );
  }
  return (
    <Modal
      title={editing ? "编辑条件提醒" : "新增条件提醒"}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={busy}
      okText="保存规则"
      width={920}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={async (v) => {
          setBusy(true);
          setError("");
          try {
            await send(
              `/spaces/${space.id}/signal-rules${editing ? `/${editing.id}` : ""}`,
              {
                ...(editing ? { version: editing.version } : {}),
                name: v.name,
                enabled: !!v.enabled,
                match: v.match,
                cooldown_hours: Number(v.cooldown_hours),
                conditions: v.conditions.map((c: any) => ({
                  metric: c.metric,
                  scope: c.scope,
                  operator: c.operator,
                  threshold: c.threshold,
                  baseline: c.baseline || "rolling_high",
                  lookback_days: Number(c.lookback_days || 365),
                  ...(c.scope === "tag"
                    ? { tag_id: c.tag_id }
                    : { instrument_id: c.instrument_id }),
                  ...(c.baseline === "manual"
                    ? { reference_price: c.reference_price }
                    : {}),
                })),
              },
              editing ? "PATCH" : "POST",
            );
            message.success("提醒规则已保存");
            reload();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <Alert className="form-alert" type="error" message={error} />}
        <div className="rule-templates">
          <span>可编辑模板</span>
          <Button size="small" onClick={() => template("10")}>
            回撤 10%
          </Button>
          <Button size="small" onClick={() => template("20")}>
            回撤 20%
          </Button>
          <Button size="small" onClick={() => template("vix")}>
            VIX ≥ 25 且纳指回撤 ≥ 10%
          </Button>
          <small>模板默认停用</small>
        </div>
        <Fields
          fields={[
            { name: "name", label: "规则名称", required: true },
            {
              name: "match",
              label: "组合条件",
              type: "select",
              options: [
                { value: "all", label: "全部满足（AND）" },
                { value: "any", label: "满足任一（OR）" },
              ],
              required: true,
            },
            {
              name: "cooldown_hours",
              label: "再次提醒冷却时间（小时）",
              type: "number",
              required: true,
            },
            { name: "enabled", label: "启用规则", type: "switch" },
          ]}
        />
        <Form.List
          name="conditions"
          rules={[
            {
              validator: async (_, value) => {
                if (!value?.length) throw new Error("至少设置一个条件");
              },
            },
          ]}
        >
          {(fields, { add, remove }, { errors }) => (
            <>
              <div className="rule-conditions">
                {fields.map(({ key, name, ...rest }, i) => (
                  <section key={key} className="rule-condition">
                    <div className="rule-condition-heading">
                      <strong>条件 {i + 1}</strong>
                      <Button
                        type="text"
                        danger
                        aria-label={`删除条件${i + 1}`}
                        icon={<Trash2 size={15} />}
                        onClick={() => remove(name)}
                      />
                    </div>
                    <div className="form-grid">
                      <Form.Item
                        {...rest}
                        name={[name, "scope"]}
                        label="对象类型"
                        rules={[{ required: true }]}
                      >
                        <Select
                          options={[
                            { value: "instrument", label: "投资产品 / 指数" },
                            { value: "tag", label: "标签固定持仓" },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[
                          name,
                          conditions[i]?.scope === "tag"
                            ? "tag_id"
                            : "instrument_id",
                        ]}
                        label="观察对象"
                        rules={[{ required: true, message: "请选择观察对象" }]}
                      >
                        <Select
                          showSearch
                          optionFilterProp="label"
                          options={
                            conditions[i]?.scope === "tag" ? tags : instruments
                          }
                        />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[name, "metric"]}
                        label="指标"
                        rules={[{ required: true }]}
                      >
                        <Select
                          options={Object.entries(conditionNames).map(
                            ([value, label]) => ({ value, label }),
                          )}
                        />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[name, "operator"]}
                        label="条件"
                        rules={[{ required: true }]}
                      >
                        <Select
                          options={[
                            { value: "gte", label: "大于或等于 ≥" },
                            { value: "lte", label: "小于或等于 ≤" },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[name, "threshold"]}
                        label={
                          conditions[i]?.metric === "price"
                            ? "价格 / 点位阈值"
                            : "阈值（%）"
                        }
                        rules={[{ required: true }]}
                      >
                        <InputNumber stringMode style={{ width: "100%" }} />
                      </Form.Item>
                      {conditions[i]?.metric === "drawdown" && (
                        <>
                          <Form.Item
                            {...rest}
                            name={[name, "baseline"]}
                            label="比较基准"
                            rules={[{ required: true }]}
                          >
                            <Select
                              options={[
                                { value: "rolling_high", label: "区间高点" },
                                { value: "cost", label: "当前持仓成本" },
                                { value: "manual", label: "手动参考价格" },
                              ]}
                            />
                          </Form.Item>
                          {conditions[i]?.baseline === "manual" ? (
                            <Form.Item
                              {...rest}
                              name={[name, "reference_price"]}
                              label="参考价格"
                              rules={[{ required: true }]}
                            >
                              <InputNumber
                                stringMode
                                min="0.00000001"
                                style={{ width: "100%" }}
                              />
                            </Form.Item>
                          ) : (
                            conditions[i]?.baseline !== "cost" && (
                              <Form.Item
                                {...rest}
                                name={[name, "lookback_days"]}
                                label="回看天数"
                                rules={[{ required: true }]}
                              >
                                <InputNumber
                                  stringMode
                                  min="7"
                                  max="1825"
                                  style={{ width: "100%" }}
                                />
                              </Form.Item>
                            )
                          )}
                        </>
                      )}
                    </div>
                  </section>
                ))}
              </div>
              <Form.ErrorList errors={errors} />
              <Button
                icon={<Plus size={15} />}
                onClick={() => add({ ...blank })}
              >
                增加条件
              </Button>
            </>
          )}
        </Form.List>
        <p className="data-caption">
          回撤填写正数，例如 10 代表从基准下跌 10%；单日跌幅可设“涨跌幅 ≤
          −10%”。数据不足时规则显示不可计算。
        </p>
      </Form>
    </Modal>
  );
}
function SignalDetails({ result }: { result?: Item }) {
  const { hidden } = useWorkspace();
  if (!result) return <div className="quiet-empty">尚未检查条件</div>;
  return (
    <>
      <Table
        rowKey={(_: any, i) => String(i)}
        dataSource={result.conditions || []}
        pagination={false}
        size="small"
        columns={helpColumns([
          {
            title: "指标",
            render: (_, r: any) => conditionNames[r.metric] || r.metric,
          },
          {
            title: "规则",
            render: (_, r: any) => (
              <>
                {r.operator === "lte" ? "≤" : "≥"}{" "}
                <Money
                  value={r.threshold}
                  precision={r.metric === "price" ? 4 : 2}
                />
                {hidden || r.metric === "price" ? "" : "%"}
              </>
            ),
          },
          {
            title: "当前值",
            render: (_, r: any) => (
              <>
                <Money
                  value={r.value}
                  precision={r.metric === "price" ? 4 : 2}
                />
                {hidden || r.metric === "price" || r.value == null ? "" : "%"}
              </>
            ),
          },
          {
            title: "状态",
            render: (_, r: any) => (
              <div className="cell-name">
                <QuoteStatus
                  status={
                    r.matched === true
                      ? "matched"
                      : r.matched === false
                        ? "not_matched"
                        : r.status
                  }
                />
                {r.message && (
                  <small>{hidden ? "内容已隐藏" : r.message}</small>
                )}
              </div>
            ),
          },
          {
            title: "来源 / 日期",
            render: (_, r: any) => (
              <div className="cell-name">
                <span>{r.source}</span>
                <small>{r.as_of}</small>
              </div>
            ),
          },
        ])}
      />
      {result.message && (
        <p className="data-caption">{hidden ? "内容已隐藏" : result.message}</p>
      )}
    </>
  );
}
