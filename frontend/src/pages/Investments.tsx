import { NavigationTabs } from "../navigation";
import { useState } from "react";
import DcaHistoryPreview from "./DcaHistoryPreview";
import DcaPlanManager from "./DcaPlanManager";
import { FundOrders } from "./FundBuy";
import { dcaPlanContext } from "../dca-preview";
import { Alert, App, Button, Space, Tabs } from "antd";
import { Plus } from "lucide-react";
import {
  EntityManager,
  Money,
  PageTitle,
  ResourceTable,
  Status,
} from "../components";
import {
  currencyOptions,
  dateToday,
  dateTimeNowLocal,
  kinds,
  listOf,
  send,
} from "../api";
import type { Item } from "../api";
import { Occurrences } from "./Cashbook";
import { useResource, useWorkspace } from "../state";
import { QuotesTable } from "./MarketValuation";
export default function InvestmentTools({
  section,
  context,
  onRecordHolding,
}: {
  section: "trading" | "market" | "plans";
  context?: Item;
  onRecordHolding?: (product: Item) => void;
}) {
  const { space, openEvent, reload, hidden } = useWorkspace();
  const { message } = App.useApp();
  const [historyPlan, setHistoryPlan] = useState<Item | null>(null);
  const planContext = dcaPlanContext(context);
  const instrumentState = useResource("instruments"),
    accountState = useResource("accounts");
  const instruments = listOf<Item>(instrumentState.data).map((a) => ({
      label: `${a.name} · ${a.code}`,
      value: a.id,
    })),
    accounts = listOf<Item>(accountState.data).map((a) => ({
      label: a.name,
      value: a.id,
    }));
  const items = [
    { key: "quotes", label: "自动行情", children: <QuotesTable /> },
    {
      key: "events",
      label: "交易记录",
      children: (
        <>
          <FundOrders
            instrumentId={planContext.instrumentId}
            accountId={planContext.defaultAccountId}
          />
          <ResourceTable
            resource="events"
            title="投资与资金事项"
            columns={[
              { title: "日期", dataIndex: "economic_date" },
              {
                title: "类型",
                dataIndex: "kind",
                render: (v) => kinds[v] || v,
              },
              { title: "说明", dataIndex: "description" },
              {
                title: "原币金额",
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
        </>
      ),
    },
    {
      key: "plans",
      label: "定投计划",
      children: (
        <DcaPlanManager
          queryParams={planContext.queryParams}
          accounts={listOf<Item>(accountState.data)}
          onHistory={setHistoryPlan}
          fields={[
            { name: "name", label: "计划名称", required: true },
            {
              name: "kind",
              label: "计划类型",
              type: "select",
              required: true,
              initial: "dca",
              options: [{ label: "定期投资", value: "dca" }],
            },
            {
              name: "account_id",
              label: "资金账户",
              initial: planContext.defaultAccountId,
              type: "select",
              options: accounts,
              required: true,
            },
            {
              name: "instrument_id",
              label: "投资产品",
              initial: planContext.instrumentId,
              type: "select",
              options: instruments,
              required: true,
            },
            {
              name: "amount",
              label: "每期计划金额",
              type: "number",
              required: true,
            },
            {
              name: "currency",
              label: "币种",
              type: "select",
              options: currencyOptions,
              required: true,
              initial: context?.currency || "CNY",
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
              initial: "daily",
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
              title: "金额",
              render: (_, r) => (
                <Money value={r.amount} currency={r.currency} />
              ),
            },
            { title: "首期日期", dataIndex: "start_date" },
            {
              title: "频率",
              dataIndex: "frequency",
              render: (v) =>
                ({ monthly: "每月", weekly: "每周", daily: "每日" })[
                  v as string
                ] || v,
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
      key: "transit",
      label: "计划期次与在途",
      children: <Occurrences />,
    },
    {
      key: "prices",
      label: "净值与行情",
      children: (
        <EntityManager
          resource="prices"
          title="价格记录"
          allowEdit={false}
          description="自动行情见「自动行情」。此处可以补充机构正式净值、收盘价和结算价。"
          fields={[
            {
              name: "instrument_id",
              label: "投资产品",
              type: "select",
              options: instruments,
              required: true,
            },
            {
              name: "value",
              label: "价格 / 单位净值",
              type: "number",
              required: true,
            },
            {
              name: "kind",
              label: "价格类别",
              type: "select",
              required: true,
              initial: "official_nav",
              options: [
                { label: "正式净值", value: "official_nav" },
                { label: "收盘价", value: "close" },
                { label: "结算价", value: "settlement" },
                { label: "实际成交价", value: "trade" },
                { label: "参考估值（非正式）", value: "estimate" },
              ],
            },
            {
              name: "economic_date",
              label: "价格有效日",
              type: "date",
              required: true,
              initial: dateToday(),
            },
            {
              name: "source",
              label: "来源说明",
              required: true,
              placeholder: "机构确认单或正式披露",
            },
          ]}
          columns={[
            {
              title: "产品",
              dataIndex: "instrument_id",
              render: (v) => instruments.find((x) => x.value === v)?.label || v,
            },
            {
              title: "价格",
              render: (_, r) => <Money value={r.value} />,
            },
            {
              title: "类别",
              dataIndex: "kind",
              render: (v) =>
                ({
                  official_nav: "正式净值",
                  close: "收盘价",
                  settlement: "结算价",
                  estimate: "参考估值",
                  trade: "成交价",
                })[v as string] || v,
            },
            { title: "有效日", dataIndex: "economic_date" },
            { title: "来源", dataIndex: "source" },
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
      key: "derivatives",
      label: "衍生品结算",
      children: (
        <EntityManager
          resource="snapshots"
          title="机构权益记录"
          allowEdit={false}
          description="按机构报告记录权益与覆盖范围；保证金和持仓名义金额不重复计入净资产。"
          fields={[
            {
              name: "account_id",
              label: "期货账户",
              type: "select",
              options: listOf<Item>(accountState.data)
                .filter((a) => a.kind === "futures" && !a.archived)
                .map((a) => ({ label: a.name, value: a.id })),
              referenceKinds: ["futures"],
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
              name: "economic_date",
              label: "机构交易日",
              type: "date",
              required: true,
              initial: dateToday(),
            },
            {
              name: "valuation_basis",
              label: "数据口径",
              type: "select",
              required: true,
              initial: "intraday",
              options: [
                { label: "盘中实时权益 / 估算", value: "intraday" },
                { label: "正式结算单权益", value: "settlement" },
                { label: "尚未核实", value: "unknown" },
              ],
              help: "盘中权益与正式结算分开保存；夜盘、周末和节假日按机构标明的交易日填写。",
            },
            {
              name: "valuation_observed_at",
              label: "查看时间",
              type: "datetime",
              initial: dateTimeNowLocal(),
              help: "当前设备时区，不等于机构交易日。",
            },
            {
              name: "calendar_id",
              label: "交易日历（可选）",
              type: "select",
              options: [{ label: "境内期货交易日历", value: "CN_FUTURES" }],
              help: "只在确认市场时选择；休市期间沿用最近正式结算并保留实际日期，不补造当天结算。",
            },
            {
              name: "equity",
              label: "机构权益",
              type: "number",
              required: true,
            },
            {
              name: "margin",
              label: "保证金（权益内占用）",
              type: "number",
            },
            { name: "available", label: "机构可用资金", type: "number" },
            {
              name: "source",
              label: "数据来源",
              required: true,
              placeholder: "例如机构结算单、交易软件权益页面",
            },
            {
              name: "coverage",
              label: "权益覆盖说明",
              type: "textarea",
              required: true,
              span: 2,
              help: "明确是否包含期权市值、负债及本期入出金。范围未知不能直接视为完整。",
            },
            {
              name: "includes_options",
              label: "机构权益的期权市值口径",
              type: "select",
              required: true,
              options: [
                { label: "已包含期权市值 / 负债", value: "yes" },
                { label: "无期权持仓（已核实）", value: "none" },
                { label: "不包含期权价值（覆盖不完整）", value: "no" },
              ],
            },
            {
              name: "included_event_ids",
              label: "本快照明确包含的资金事项",
              type: "multi",
              options: [],
              span: 2,
              help: "选择账户后加载相关事项。只勾选结算单已明确包含的收入、支出、转账或换汇等实际资金变化；不按日期自动全选。",
            },
            {
              name: "coverage_confirmed",
              label: "覆盖范围已核实",
              type: "switch",
              initial: false,
            },
          ]}
          columns={[
            {
              title: "账户",
              dataIndex: "account_id",
              render: (v) => accounts.find((a) => a.value === v)?.label || v,
            },
            { title: "交易日", dataIndex: "economic_date" },
            {
              title: "数据口径",
              render: (_, r) =>
                ({
                  settlement: "正式结算",
                  intraday: "盘中估算",
                  unknown: "待核实",
                })[r.details?.valuation_basis as string] || "机构记录",
            },
            {
              title: "机构权益",
              render: (_, r) => (
                <Money value={r.equity} currency={r.currency} />
              ),
            },
            {
              title: "保证金",
              render: (_, r) => (
                <Money
                  value={r.margin ?? r.details?.margin}
                  currency={r.currency}
                />
              ),
            },
            {
              title: "覆盖范围",
              render: (_, r) => (
                <Status
                  value={
                    (r.coverage_confirmed ?? r.complete)
                      ? "complete"
                      : "partial"
                  }
                />
              ),
            },
          ]}
        >
          <Alert
            type="warning"
            showIcon
            message="按实际来源区分正式结算与盘中权益。保证金及期权价值若已包含在总权益中，不再相加；合约实时行情不等于账户实时权益。"
          />
        </EntityManager>
      ),
    },
  ];
  if (section === "plans")
    return (
      <>
        {items.find((item) => item.key === "plans")?.children}
        {historyPlan && (
          <DcaHistoryPreview
            plan={historyPlan}
            onClose={() => setHistoryPlan(null)}
            onRecordHolding={
              onRecordHolding
                ? () => {
                    const product = listOf<Item>(instrumentState.data).find(
                      (item) => item.id === historyPlan.instrument_id,
                    );
                    if (product) onRecordHolding(product);
                  }
                : undefined
            }
          />
        )}
      </>
    );
  return (
    <>
      <NavigationTabs
        group={
          section === "market" ? "analytics.settlement" : "investment.trading"
        }
        items={items.filter((item) =>
          (section === "trading"
            ? ["events", "plans", "transit"]
            : ["quotes", "prices", "derivatives"]
          ).includes(item.key),
        )}
      />
      {historyPlan && (
        <DcaHistoryPreview
          plan={historyPlan}
          onClose={() => setHistoryPlan(null)}
          onRecordHolding={
            onRecordHolding
              ? () => {
                  const product = listOf<Item>(instrumentState.data).find(
                    (item) => item.id === historyPlan.instrument_id,
                  );
                  if (product) onRecordHolding(product);
                }
              : undefined
          }
        />
      )}
    </>
  );
}
