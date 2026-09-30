import { helpColumns } from "../help";
import { NavigationTabs } from "../navigation";
import { useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
} from "antd";
import { CalendarDays, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  EntityManager,
  Fields,
  LoadState,
  Money,
  PageTitle,
  Panel,
  ResourceTable,
  Status,
} from "../components";
import { currencyOptions, dateToday, listOf, send } from "../api";
import type { Item } from "../api";
import { useResource, useWorkspace } from "../state";
import { Occurrences } from "./Cashbook";
import { Chart } from "./Home";
export default function Planning() {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const { message, modal } = App.useApp();
  const [params] = useSearchParams();
  const state = useResource("accounts"),
    goalsState = useResource("goals"),
    scenariosState = useResource("scenarios");
  const [nodeEditor, setNodeEditor] = useState<{
    item: Item;
    resource: string;
  } | null>(null);
  const accountOpts = listOf<Item>(state.data).map((a) => ({
      label: `${a.name} · ${a.currency}`,
      value: a.id,
    })),
    goalOpts = listOf<Item>(goalsState.data).map((g) => ({
      label: g.name,
      value: g.id,
    }));
  const sections = [
    {
      key: "goals",
      label: "财富目标",
      children: (
        <EntityManager
          resource="goals"
          title="财富目标"
          extraActions={(r) => (
            <Button
              size="small"
              type="link"
              onClick={() =>
                requestReveal(() =>
                  setNodeEditor({ item: r, resource: "goals" }),
                )
              }
            >
              付款节点
            </Button>
          )}
          description="目标由你创建。仅启用方案占用规划预留，计划不会改变实际净资产。"
          fields={[
            {
              name: "name",
              label: "目标名称",
              required: true,
              placeholder: "购房、装修、购车或其他目标",
            },
            {
              name: "amount",
              label: "目标总预算",
              type: "number",
              required: true,
            },
            {
              name: "currency",
              label: "币种",
              type: "select",
              required: true,
              initial: "CNY",
              options: currencyOptions,
            },
            {
              name: "target_date",
              label: "目标日期",
              type: "date",
              required: true,
            },
            {
              name: "status",
              label: "方案状态",
              type: "select",
              required: true,
              initial: "draft",
              options: [
                { label: "草稿 / 比较方案", value: "draft" },
                { label: "启用", value: "active" },
                { label: "完成", value: "completed" },
                { label: "暂停", value: "paused" },
              ],
            },
            {
              name: "priority",
              label: "优先级",
              type: "select",
              initial: "normal",
              options: [
                { label: "必要支出", value: "high" },
                { label: "正常", value: "normal" },
                { label: "可调整", value: "low" },
              ],
            },
            {
              name: "description",
              label: "预算构成与假设",
              type: "textarea",
              span: 2,
              placeholder:
                "例如定金是否计入首付、税费是否已包含；不重复计算相同金额。",
            },
          ]}
          columns={[
            {
              title: "目标",
              dataIndex: "name",
              render: (v, r) => (
                <div className="cell-name">
                  <strong>{v}</strong>
                  <small>
                    {hidden ? "内容已隐藏" : r.description || "未补充预算说明"}
                  </small>
                </div>
              ),
            },
            {
              title: "预算",
              render: (_, r) => (
                <Money value={r.amount} currency={r.currency} />
              ),
            },
            { title: "目标日期", dataIndex: "target_date" },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
          ]}
        />
      ),
    },
    {
      key: "scenarios",
      label: "方案比较",
      children: (
        <EntityManager
          resource="scenarios"
          title="比较方案"
          description="同一目标只有一个启用方案；其他方案保持独立，不叠加预留。"
          extraActions={(r) => (
            <Button
              size="small"
              type="link"
              onClick={() =>
                requestReveal(() =>
                  setNodeEditor({ item: r, resource: "scenarios" }),
                )
              }
            >
              付款节点
            </Button>
          )}
          fields={[
            { name: "name", label: "方案名称", required: true },
            {
              name: "goal_id",
              label: "所属目标",
              type: "select",
              options: goalOpts,
              required: true,
            },
            {
              name: "amount",
              label: "本方案预算",
              type: "number",
              required: true,
            },
            {
              name: "currency",
              label: "币种",
              type: "select",
              required: true,
              initial: "CNY",
              options: currencyOptions,
            },
            {
              name: "target_date",
              label: "计划日期",
              type: "date",
              required: true,
            },
            {
              name: "status",
              label: "方案状态",
              type: "select",
              required: true,
              initial: "draft",
              options: [
                { label: "草稿 / 独立比较", value: "draft" },
                { label: "启用并替代同目标旧方案", value: "active" },
                { label: "暂停", value: "paused" },
              ],
            },
            {
              name: "description",
              label: "方案假设",
              type: "textarea",
              span: 2,
              placeholder: "记录首付、贷款期限、税费、装修与定投安排等假设",
            },
          ]}
          columns={[
            { title: "方案", dataIndex: "name" },
            {
              title: "目标",
              dataIndex: "goal_id",
              render: (v) => goalOpts.find((g) => g.value === v)?.label || v,
            },
            {
              title: "预算",
              render: (_, r) => (
                <Money value={r.amount} currency={r.currency} />
              ),
            },
            { title: "日期", dataIndex: "target_date" },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
          ]}
        />
      ),
    },
    {
      key: "reservations",
      label: "资金池与预留",
      children: (
        <EntityManager
          resource="reservations"
          title="资金预留"
          description="预留改变可安排金额，不提前扣除现金。机构冻结和同笔预留应关联去重。"
          fields={[
            {
              name: "account_id",
              label: "资金来源账户",
              type: "select",
              options: accountOpts,
              required: true,
            },
            {
              name: "goal_id",
              label: "关联目标",
              type: "select",
              options: goalOpts,
            },
            {
              name: "scenario_id",
              label: "关联比较方案（可选）",
              type: "select",
              options: listOf<Item>(scenariosState.data).map((s) => ({
                label: s.name,
                value: s.id,
              })),
              help: "非启用方案的预留只参与独立测算。",
            },
            {
              name: "amount",
              label: "预留金额",
              type: "number",
              required: true,
            },
            {
              name: "currency",
              label: "币种",
              type: "select",
              required: true,
              initial: "CNY",
              options: currencyOptions,
            },
            {
              name: "purpose",
              label: "用途",
              required: true,
              placeholder: "首付 / 生活备用金 / 月供",
            },
            {
              name: "status",
              label: "状态",
              type: "select",
              required: true,
              initial: "active",
              options: [
                { label: "启用", value: "active" },
                { label: "解除", value: "released" },
                { label: "已支付", value: "consumed" },
              ],
            },
            {
              name: "linked_freeze_amount",
              label: "与机构冻结重叠的金额",
              type: "number",
              initial: "0",
              help: "同笔已核实占用，累计不能超过账户机构冻结金额。",
            },
          ]}
          columns={[
            { title: "用途", dataIndex: "purpose" },
            {
              title: "账户",
              dataIndex: "account_id",
              render: (v) => accountOpts.find((a) => a.value === v)?.label || v,
            },
            {
              title: "目标",
              dataIndex: "goal_id",
              render: (v) =>
                goalOpts.find((g) => g.value === v)?.label || "独立预留",
            },
            {
              title: "金额",
              render: (_, r) => (
                <Money value={r.amount} currency={r.currency} />
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
          ]}
        />
      ),
    },
    {
      key: "loans",
      label: "贷款与还款计划",
      children: (
        <>
          <EntityManager
            resource="loans"
            title="贷款"
            description="既有贷款填剩余本金。生成的是未来计划，不代表银行实际扣款。"
            fields={[
              { name: "name", label: "贷款名称", required: true },
              {
                name: "account_id",
                label: "扣款账户",
                type: "select",
                required: true,
                options: accountOpts,
              },
              {
                name: "liability_account_id",
                label: "对应负债账户",
                type: "select",
                required: true,
                options: accountOpts,
              },
              {
                name: "principal",
                label: "本金 / 接续剩余本金",
                type: "number",
                required: true,
              },
              {
                name: "currency",
                label: "币种",
                type: "select",
                required: true,
                initial: "CNY",
                options: currencyOptions,
              },
              {
                name: "annual_rate",
                label: "合同年利率（小数）",
                type: "number",
                required: true,
                help: "例如 0.03 表示 3%，0 表示零利率；按合同口径填写。",
              },
              {
                name: "term_months",
                label: "剩余月数",
                type: "number",
                required: true,
              },
              {
                name: "method",
                label: "还款方式",
                type: "select",
                required: true,
                initial: "annuity",
                options: [
                  { label: "固定利率等额本息", value: "annuity" },
                  { label: "等额本金", value: "equal_principal" },
                ],
              },
              {
                name: "first_due_date",
                label: "首期还款日期",
                type: "date",
                required: true,
              },
            ]}
            columns={[
              { title: "贷款", dataIndex: "name" },
              {
                title: "本金",
                render: (_, r) => (
                  <Money value={r.principal} currency={r.currency} />
                ),
              },
              { title: "年利率（小数）", dataIndex: "annual_rate" },
              { title: "月数", dataIndex: "term_months" },
              { title: "首期日期", dataIndex: "first_due_date" },
            ]}
            extraActions={(r) =>
              space.role !== "viewer" && (
                <Button
                  type="link"
                  size="small"
                  onClick={() =>
                    modal.confirm({
                      title: "生成逐期还款计划",
                      content:
                        "将依据当前本金、利率和日期政策生成未来计划。已有真实还款保持不变。",
                      okText: "生成计划",
                      onOk: async () => {
                        try {
                          await send(
                            `/spaces/${space.id}/loans/${r.id}/generate`,
                          );
                          message.success("计划已生成");
                          reload();
                        } catch (e) {
                          message.error((e as Error).message);
                          throw e;
                        }
                      },
                    })
                  }
                >
                  生成计划
                </Button>
              )
            }
          />
          <Occurrences resource="installments" />
        </>
      ),
    },
    { key: "forecast", label: "现金流预测", children: <Forecast /> },
    {
      key: "calendar",
      label: "业务日历",
      children: (
        <ResourceTable
          resource="calendar"
          title="业务日历"
          description="按当前计划和已知证据列出。预计确认日到达不会自动增持或扣款。"
          columns={[
            { title: "日期", render: (_, r) => r.date || r.due_date },
            {
              title: "事项",
              render: (_, r) =>
                hidden && r.kind === "event"
                  ? "内容已隐藏"
                  : r.title || r.name || r.kind,
            },
            {
              title: "金额",
              render: (_, r) => (
                <Money value={r.amount} currency={r.currency} />
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
          ]}
        />
      ),
    },
    {
      key: "recurring",
      label: "周期收支",
      children: (
        <EntityManager
          resource="plans"
          title="周期收支计划"
          kindFilter="income,expense"
          fields={[
            { name: "name", label: "计划名称", required: true },
            {
              name: "kind",
              label: "类别",
              type: "select",
              required: true,
              initial: "expense",
              options: [
                { label: "计划支出", value: "expense" },
                { label: "计划收入", value: "income" },
              ],
            },
            {
              name: "account_id",
              label: "收付账户",
              type: "select",
              required: true,
              options: accountOpts,
            },
            {
              name: "amount",
              label: "每期金额",
              type: "number",
              required: true,
            },
            {
              name: "currency",
              label: "币种",
              type: "select",
              required: true,
              initial: "CNY",
              options: currencyOptions,
            },
            {
              name: "start_date",
              label: "首期日期",
              type: "date",
              required: true,
              initial: dateToday(),
            },
            {
              name: "frequency",
              label: "频率",
              type: "select",
              required: true,
              initial: "monthly",
              options: [
                { label: "每月", value: "monthly" },
                { label: "每周", value: "weekly" },
                { label: "每日", value: "daily" },
              ],
            },
            {
              name: "status",
              label: "状态",
              type: "select",
              required: true,
              initial: "active",
              options: [
                { label: "启用", value: "active" },
                { label: "暂停", value: "paused" },
              ],
            },
          ]}
          columns={[
            { title: "名称", dataIndex: "name" },
            {
              title: "类型",
              dataIndex: "kind",
              render: (v) => (v === "income" ? "计划收入" : "计划支出"),
            },
            {
              title: "金额",
              render: (_, r) => (
                <Money value={r.amount} currency={r.currency} />
              ),
            },
            { title: "首期日期", dataIndex: "start_date" },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
          ]}
        />
      ),
    },
    {
      key: "strategies",
      label: "配置与文字策略",
      children: (
        <EntityManager
          resource="strategies"
          title="配置策略"
          description="首版保存自主设定的配置与文字依据，不自动生成交易或触发加仓。"
          fields={[
            { name: "name", label: "策略名称", required: true },
            {
              name: "scope",
              label: "配置范围",
              required: true,
              placeholder: "例如长期投资 / 定投 / 衍生品",
            },
            {
              name: "target_ratio",
              label: "目标比例（小数，可选）",
              type: "number",
              help: "0.2 表示20%；仅保存自主设定的目标，不作推荐。",
            },
            {
              name: "status",
              label: "状态",
              type: "select",
              required: true,
              initial: "draft",
              options: [
                { label: "草稿", value: "draft" },
                { label: "启用", value: "active" },
                { label: "停用", value: "paused" },
              ],
            },
            {
              name: "body",
              label: "配置理由、限制与失效条件",
              type: "textarea",
              span: 2,
              required: true,
            },
          ]}
          columns={[
            { title: "策略", dataIndex: "name" },
            { title: "范围", dataIndex: "scope" },
            { title: "目标比例（小数）", dataIndex: "target_ratio" },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
          ]}
        />
      ),
    },
  ];
  const selected = params.get("section") || params.get("tab") || "goals";
  const cash = [
    "cashflow",
    "forecast",
    "calendar",
    "recurring",
    "loans",
  ].includes(params.get("tab") || "");
  const goalSections = sections
    .filter((s) => ["goals", "scenarios", "strategies"].includes(s.key))
    .map((s) =>
      s.key === "goals"
        ? {
            ...s,
            children: (
              <>
                {s.children}
                <Collapse
                  className="embedded-section"
                  items={[
                    {
                      key: "reservations",
                      label: "资金预留",
                      children: sections.find((s) => s.key === "reservations")
                        ?.children,
                    },
                  ]}
                />
              </>
            ),
          }
        : s,
    );
  return (
    <>
      <PageTitle eyebrow="" title="财富规划" />
      <NavigationTabs
        group="planning"
        routeParam="tab"
        activeKey={cash ? "cashflow" : "goals"}
        items={[
          {
            key: "goals",
            label: "目标与方案",
            children: (
              <NavigationTabs
                group="planning.goals"
                routeParam="section"
                activeKey={
                  ["goals", "scenarios", "strategies"].includes(selected)
                    ? selected
                    : "goals"
                }
                items={goalSections}
              />
            ),
          },
          {
            key: "cashflow",
            label: "现金流与还款",
            children: (
              <NavigationTabs
                group="planning.cashflow"
                routeParam="section"
                activeKey={
                  ["forecast", "calendar", "recurring", "loans"].includes(
                    selected,
                  )
                    ? selected
                    : "forecast"
                }
                items={sections.filter((s) =>
                  ["forecast", "recurring", "loans", "calendar"].includes(
                    s.key,
                  ),
                )}
              />
            ),
          },
        ]}
      />

      {nodeEditor && (
        <PaymentNodes
          resource={nodeEditor.resource}
          item={nodeEditor.item}
          onClose={() => setNodeEditor(null)}
        />
      )}
    </>
  );
}
function Forecast() {
  const { space, hidden, requestReveal } = useWorkspace();
  const scenarios = useResource("scenarios");
  const [form] = Form.useForm();
  const [result, setResult] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const chartRows = useMemo(() => result?.items || [], [result]);
  async function calculate(values: any) {
    setBusy(true);
    setError("");
    try {
      setResult(await send(`/spaces/${space.id}/forecast`, values));
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Panel
        title="现金流情景测算"
        subtitle="以当前可动用资金为起点，叠加已建计划及你明确填写的情景假设。"
      >
        <Alert
          className="form-alert"
          type="info"
          showIcon
          message="这里只计算未来情景，不写入实际账本。计划发生并关联真实事项后，不会再次扣除。"
        />
        {hidden && (
          <Alert
            type="info"
            message="情景假设内容已隐藏"
            action={
              <Button onClick={() => requestReveal(() => {})}>
                显示内容并继续
              </Button>
            }
          />
        )}
        <div hidden={hidden}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              days: "90",
              monthly_income: "0",
              monthly_expense: "0",
            }}
            onFinish={calculate}
          >
            <Fields
              fields={[
                {
                  name: "scenario_id",
                  label: "独立比较方案",
                  type: "select",
                  options: listOf<Item>(scenarios.data).map((s) => ({
                    label: s.name,
                    value: s.id,
                  })),
                  help: "不选择时使用当前启用安排。",
                },
                {
                  name: "days",
                  label: "预测区间",
                  type: "select",
                  required: true,
                  options: [
                    { label: "未来 30 天", value: "30" },
                    { label: "未来 90 天", value: "90" },
                    { label: "未来 365 天", value: "365" },
                  ],
                },
                {
                  name: "monthly_income",
                  label: "额外月收入假设",
                  type: "number",
                  required: true,
                  help: "仅填未包含在已建计划里的金额。",
                },
                {
                  name: "monthly_expense",
                  label: "额外月支出假设",
                  type: "number",
                  required: true,
                  help: "每次测算独立比较，不占用正式预留。",
                },
              ]}
            />
            <Button type="primary" htmlType="submit" loading={busy}>
              计算当前情景
            </Button>
          </Form>
        </div>
        {error && (
          <Alert className="form-alert" type="error" showIcon message={error} />
        )}
      </Panel>
      {result && (
        <Panel
          title="预测结果"
          subtitle={`当前空间 · ${space.base_currency} · 属于未来假设`}
        >
          <div className="forecast-summary">
            <span>最低预计可动用余额</span>
            <strong>
              <Money
                value={result.minimum_balance}
                currency={space.base_currency}
              />
            </strong>
            <Status value={result.completeness || "partial"} />
          </div>
          {result.gaps?.length > 0 && (
            <Alert
              showIcon
              type="warning"
              message="有未覆盖项目或资金缺口"
              description={
                hidden
                  ? "内容已隐藏"
                  : result.gaps
                      .map((g: any) =>
                        typeof g === "string"
                          ? g
                          : g.reason || g.date || JSON.stringify(g),
                      )
                      .join("；")
              }
            />
          )}
          <Chart items={chartRows} xKey="date" yKey="balance" />
          <details className="chart-data">
            <summary>查看预测数据表</summary>
            <Table
              rowKey="date"
              size="small"
              dataSource={chartRows}
              columns={helpColumns([
                { title: "日期", dataIndex: "date" },
                {
                  title: "流入",
                  render: (_, r: any) => <Money value={r.inflow ?? r.income} />,
                },
                {
                  title: "流出",
                  render: (_, r: any) => (
                    <Money value={r.outflow ?? r.expense} />
                  ),
                },
                {
                  title: "期末余额",
                  render: (_, r: any) => <Money value={r.balance} />,
                },
              ])}
              pagination={{ pageSize: 10 }}
            />
          </details>
        </Panel>
      )}
    </>
  );
}

function PaymentNodes({
  item,
  resource,
  onClose,
}: {
  item: Item;
  resource: string;
  onClose: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const eventState = useResource("events"),
    reservationState = useResource("reservations");
  const events = listOf<Item>(eventState.data)
    .filter((e) => !e.reversed)
    .map((e) => ({
      value: e.id,
      label: `${e.economic_date} · ${e.description || e.kind}`,
    }));
  const reservations = listOf<Item>(reservationState.data).map((r) => ({
    value: r.id,
    label: r.purpose || r.id.slice(0, 8),
  }));
  return (
    <Modal
      title={`${item.name} · 付款节点`}
      open
      onCancel={onClose}
      width={860}
      onOk={() => form.submit()}
      confirmLoading={busy}
      okText="保存节点与关联"
      cancelText="取消"
    >
      <Alert
        className="form-alert"
        type="info"
        showIcon
        message="节点合计按现金实际付款规划。定金若已计入首付，不重复列入；完成节点必须关联真实付款。"
      />
      {error && <Alert className="form-alert" type="error" message={error} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ payment_nodes: item.payment_nodes || [] }}
        onFinish={async (values) => {
          setBusy(true);
          try {
            await send(
              `/spaces/${space.id}/${resource}/${item.id}`,
              { ...values, version: item.version },
              "PATCH",
            );
            message.success("付款节点已保存");
            reload();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form.List name="payment_nodes">
          {(fields, { add, remove }) => (
            <>
              <div className="payment-node-list">
                {fields.map(({ key, name, ...rest }) => (
                  <div className="payment-node" key={key}>
                    <Form.Item {...rest} name={[name, "id"]} hidden>
                      <Input />
                    </Form.Item>
                    <div className="form-grid">
                      <Form.Item
                        {...rest}
                        name={[name, "name"]}
                        label="节点名称"
                        rules={[{ required: true, message: "填写节点名称" }]}
                      >
                        <Input placeholder="定金 / 剩余首付 / 税费 / 装修" />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[name, "date"]}
                        label="付款日期"
                        rules={[{ required: true, message: "填写日期" }]}
                      >
                        <Input type="date" />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[name, "amount"]}
                        label={`现金付款金额 ${item.currency}`}
                        rules={[{ required: true, message: "填写金额" }]}
                      >
                        <InputNumber stringMode style={{ width: "100%" }} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "status"]} label="状态">
                        <Select
                          options={[
                            { value: "pending", label: "计划待付" },
                            { value: "paid", label: "已核实付款" },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[name, "event_id"]}
                        label="已核实真实付款"
                      >
                        <Select
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          options={events}
                          placeholder="关联后不再预测重复扣款"
                        />
                      </Form.Item>
                      <Form.Item
                        {...rest}
                        name={[name, "reservation_id"]}
                        label="匹配预留"
                      >
                        <Select
                          allowClear
                          options={reservations}
                          placeholder="对应同一用途预留"
                        />
                      </Form.Item>
                    </div>
                    <Button danger type="link" onClick={() => remove(name)}>
                      移除此计划节点
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="dashed"
                block
                onClick={() =>
                  add({
                    id: crypto.randomUUID(),
                    status: "pending",
                    currency: item.currency,
                  })
                }
              >
                ＋ 添加付款节点
              </Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
