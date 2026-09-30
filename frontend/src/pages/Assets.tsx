import { NavigationTabs } from "../navigation";
import { Tabs, Button, Space, Alert, Dropdown } from "antd";
import { useState } from "react";
import { Plus, FolderInput, MoreHorizontal } from "lucide-react";
import { Navigate, useSearchParams } from "react-router-dom";
import InvestmentWorkspace from "./InvestmentWorkspace";
import ProfitCalendar from "./ProfitCalendar";
import InvestmentTools from "./Investments";
import AccountOpeningDate, {
  loadAccountForEdit,
  prepareAccountEdit,
} from "./AccountOpeningDate";
import { DeletedEntities, EntityDeleteDialog } from "./EntityLifecycle";
import {
  EntityManager,
  Money,
  PageTitle,
  ResourceTable,
  Status,
} from "../components";
import type { Field } from "../components";
import {
  accountKinds,
  currencyOptions,
  dateToday,
  dateTimeNowLocal,
  listOf,
} from "../api";
import type { Item } from "../api";
import { useResource, useWorkspace } from "../state";
const usesInstitutionEquity = (values: Record<string, any>) =>
  ["future", "futures", "option", "options"].includes(values.kind) ||
  values.valuation_mode === "snapshot";

export default function Assets() {
  const [deleteAccount, setDeleteAccount] = useState<Item | null>(null),
    [deletedAccountsOpen, setDeletedAccountsOpen] = useState(false);
  const state = useResource("accounts");
  const accounts = listOf<Item>(state.data).map((a) => ({
    label: a.name,
    value: a.id,
  }));
  const accountFields: Field[] = [
    {
      name: "name",
      label: "账户名称",
      required: true,
      placeholder: "例如日常银行卡（尾号可选）",
    },
    {
      name: "kind",
      label: "账户类型",
      type: "select",
      required: true,
      options: Object.entries(accountKinds).map(([value, label]) => ({
        value,
        label,
      })),
      initial: "bank",
    },
    {
      name: "currency",
      label: "账户币种",
      type: "select",
      options: currencyOptions,
      required: true,
      initial: "CNY",
    },
    {
      name: "opening_balance",
      createOnly: true,
      label: "开始记账时的金额",
      type: "number",
      required: true,
      initial: "0",
      help: "银行卡填余额；基金公司或券商可先填机构总金额，暂记为留存资金，随后新增持仓选择“从机构已有资金中分配”，避免重复计入。若这里只填闲置现金，新增原有持仓时选“另行补录”。贷款填未还本金；期货填客户总权益，不能填保证金。",
    },
    {
      name: "opening_date",
      createOnly: true,
      label: "金额对应日期",
      type: "date",
      required: true,
      initial: dateToday(),
      help: "这笔金额从该日计入首页。今天开户不会替你推断昨天的余额。",
    },
    {
      name: "opening_valuation_basis",
      createOnly: true,
      label: "这笔权益是哪种数据",
      type: "select",
      required: true,
      initial: "intraday",
      visibleWhen: usesInstitutionEquity,
      options: [
        { label: "盘中实时权益 / 估算", value: "intraday" },
        { label: "正式结算单权益", value: "settlement" },
        { label: "尚未核实", value: "unknown" },
      ],
      help: "盘中权益只用于估算，不能代替正式结算。金额对应日期请按机构交易日填写，周末或节假日不要直接改成今天。",
    },
    {
      name: "opening_valuation_observed_at",
      createOnly: true,
      label: "查看这笔权益的时间",
      type: "datetime",
      initial: dateTimeNowLocal(),
      visibleWhen: usesInstitutionEquity,
      help: "按当前设备时区记录；查看时间与结算单上的交易日可以不同。",
    },
    {
      name: "opening_calendar_id",
      createOnly: true,
      label: "机构交易日历（可选）",
      type: "select",
      visibleWhen: usesInstitutionEquity,
      options: [{ label: "境内期货交易日历", value: "CN_FUTURES" }],
      help: "确认属于境内期货账户时选择。用于识别周末、已公布节假日；不确定可留空，系统保留数据日期提示。",
    },
    {
      name: "opening_coverage",
      createOnly: true,
      label: "总权益包含哪些内容",
      type: "textarea",
      required: true,
      visibleWhen: usesInstitutionEquity,
      placeholder: "例如：结算单客户总权益，包含全部持仓盈亏和期权价值",
      help: "按机构结算单说明填写；保证金若已包含在总权益中，不要再加一次。",
    },
    {
      name: "opening_option_scope",
      createOnly: true,
      label: "期权价值是否包含在金额中",
      type: "select",
      required: true,
      initial: "unknown",
      visibleWhen: usesInstitutionEquity,
      options: [
        { label: "尚未核实", value: "unknown" },
        { label: "已包含所有期权价值", value: "includes_options" },
        { label: "已确认账户没有期权持仓", value: "no_options" },
      ],
      help: "不确定时可先保存，首页会显示为已知部分并提示核对。",
    },
    {
      name: "opening_coverage_confirmed",
      createOnly: true,
      label: "已核对金额包含账户的全部权益",
      type: "switch",
      initial: false,
      visibleWhen: usesInstitutionEquity,
    },
    {
      name: "opening_available",
      createOnly: true,
      label: "当日可提取金额（可选）",
      type: "number",
      visibleWhen: usesInstitutionEquity,
      help: "以机构显示的可提取金额为准。期货账户留空且未录入期货、期权或保证金占用时，按最新已记录权益推算；已填金额（含 0）优先。",
    },
    {
      name: "frozen",
      label: "机构已冻结金额",
      type: "number",
      initial: "0",
      help: "仅填写已证实冻结，不含系统规划预留。",
    },
    {
      name: "institution",
      label: "所属机构",
      placeholder: "银行、基金公司或券商名称",
    },
    {
      name: "valuation_mode",
      label: "记录与计值方式",
      type: "select",
      required: true,
      initial: "detailed",
      visibleWhen: (values) =>
        !["future", "futures", "option", "options"].includes(values.kind),
      options: [
        { label: "交易明细：记录收支与买卖", value: "detailed" },
        { label: "余额记录：定期更新机构余额 / 权益", value: "snapshot" },
      ],
      help: "余额记录适合只关心资产总额的账户，余额上涨不等于投资收益；交易明细支持基于已记录买卖的分析。期货按机构结算权益管理。",
    },
    {
      name: "history_status",
      label: "从开始日期起的交易是否完整",
      type: "select",
      initial: "unknown",
      options: [
        { value: "unknown", label: "暂未核实" },
        { value: "partial", label: "只录入了一部分" },
        { value: "complete_since_start", label: "已核对，自开始日期起完整" },
      ],
      help: "开始日期之前的历史不自动视为完整；缺失交易不补成零收益。",
    },
    {
      name: "archived",
      label: "归档账户",
      type: "switch",
      initial: false,
      help: "存在余额、持仓或开放计划时不可归档。",
    },
  ];
  const [params] = useSearchParams();
  const tab = params.get("tab") || "holdings";
  const { space, requestReveal } = useWorkspace();
  const group = [
    "products",
    "accounts",
    "liabilities",
    "reconcile",
    "records",
  ].includes(tab)
    ? "records"
    : tab === "market"
      ? "market"
      : "holdings";
  const recordTab = [
    "products",
    "accounts",
    "liabilities",
    "reconcile",
  ].includes(tab)
    ? tab
    : params.get("section") || "products";
  const sections = [
    { key: "holdings", label: "持仓", children: <InvestmentWorkspace /> },
    {
      key: "products",
      label: "投资产品",
      children: <InvestmentWorkspace products />,
    },
    {
      key: "accounts",
      label: "账户档案",
      children: (
        <EntityManager
          resource="accounts"
          title="账户"
          fields={accountFields}
          loadEdit={(account) => loadAccountForEdit(space.id, account)}
          editContent={(account) => <AccountOpeningDate account={account} />}
          prepareEditValues={prepareAccountEdit}
          toolbarActions={
            space.role !== "viewer" && (
              <Button
                type="text"
                size="small"
                onClick={() => setDeletedAccountsOpen(true)}
              >
                已删除
              </Button>
            )
          }
          extraActions={(account) =>
            space.role !== "viewer" && (
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [{ key: "delete", label: "删除账户", danger: true }],
                  onClick: () => requestReveal(() => setDeleteAccount(account)),
                }}
              >
                <Button
                  type="text"
                  size="small"
                  aria-label={`更多账户操作：${account.name}`}
                  icon={<MoreHorizontal size={16} />}
                />
              </Dropdown>
            )
          }
          columns={[
            {
              title: "账户名称",
              dataIndex: "name",
              render: (v, r) => (
                <div className="cell-name">
                  <strong>{v}</strong>
                  <small>{r.institution || "未填写机构"}</small>
                </div>
              ),
            },
            {
              title: "类型",
              dataIndex: "kind",
              render: (v) => accountKinds[v] || v,
            },
            { title: "币种", dataIndex: "currency" },
            {
              title: "当前账面余额",
              render: (_, r) => (
                <Money value={r.balance} currency={r.currency} />
              ),
            },
            {
              title: "计值口径",
              dataIndex: "valuation_mode",
              render: (_, row) => (
                <>
                  <div>
                    {row.recording_mode === "balance"
                      ? "余额记录"
                      : usesInstitutionEquity(row)
                        ? "机构结算与资金记录"
                        : "交易明细"}
                  </div>
                  <small className="muted">
                    {row.recording_start_date || "尚无记录"} 起 ·{" "}
                    {row.history_status === "complete_since_start"
                      ? "已核对完整"
                      : row.history_status === "partial"
                        ? "历史不完整"
                        : "历史待核实"}
                  </small>
                </>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (v, row) => (
                <Status value={row.archived ? "archived" : v || "active"} />
              ),
            },
          ]}
        />
      ),
    },
    { key: "profits", label: "收益日历", children: <ProfitCalendar /> },
    {
      key: "trading",
      label: "交易与定投",
      children: <InvestmentTools section="trading" />,
    },
    {
      key: "market",
      label: "行情与结算",
      children: <InvestmentTools section="market" />,
    },
    {
      key: "liabilities",
      label: "负债",
      children: (
        <ResourceTable
          resource="loans"
          title="贷款档案"
          columns={[
            { title: "名称", dataIndex: "name" },
            {
              title: "剩余本金 / 原本金",
              render: (_, r) => (
                <Money
                  value={r.remaining_principal ?? r.principal}
                  currency={r.currency}
                />
              ),
            },
            { title: "期数", dataIndex: "term_months" },
            {
              title: "还款方式",
              dataIndex: "method",
              render: (v) =>
                v === "equal_principal"
                  ? "等额本金"
                  : v === "annuity"
                    ? "等额本息"
                    : v,
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v || "active"} />,
            },
          ]}
        />
      ),
    },
    {
      key: "reconcile",
      label: "账户核对",
      children: (
        <EntityManager
          resource="reconciliations"
          title="核对记录"
          allowEdit={false}
          fields={[
            {
              name: "account_id",
              label: "核对账户",
              type: "select",
              required: true,
              options: accounts,
            },
            {
              name: "currency",
              label: "币种",
              type: "select",
              required: true,
              options: currencyOptions,
              initial: "CNY",
            },
            {
              name: "as_of",
              label: "核对时点",
              type: "date",
              required: true,
              initial: dateToday(),
            },
            {
              name: "kind",
              label: "核对口径",
              type: "select",
              required: true,
              initial: "balance",
              options: [
                { label: "现金余额", value: "balance" },
                { label: "机构权益", value: "equity" },
                { label: "负债本金", value: "liability" },
              ],
            },
            {
              name: "institution_value",
              label: "机构凭证金额",
              type: "number",
              required: true,
            },
            {
              name: "reason",
              label: "凭证与差异说明",
              type: "textarea",
              span: 2,
              required: true,
            },
          ]}
          columns={[
            {
              title: "账户",
              dataIndex: "account_id",
              render: (v) => accounts.find((a) => a.value === v)?.label || v,
            },
            { title: "核对时点", dataIndex: "as_of" },
            {
              title: "机构金额",
              render: (_, r) => (
                <Money value={r.institution_value} currency={r.currency} />
              ),
            },
            {
              title: "系统金额",
              render: (_, r) => (
                <Money value={r.system_value} currency={r.currency} />
              ),
            },
            {
              title: "差额",
              render: (_, r) => (
                <Money value={r.difference} currency={r.currency} />
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
          ]}
        >
          <Alert
            type="info"
            showIcon
            message="核对不自动调平。差异保留为待处理事项，历史更正后需重新核对。"
          />
        </EntityManager>
      ),
    },
  ];
  if (tab === "market")
    return (
      <Navigate
        to={`/spaces/${space.id}/analytics?tab=settlement${params.get("section") ? `&section=${params.get("section")}` : ""}`}
        replace
      />
    );
  if (tab === "profits")
    return (
      <Navigate to={`/spaces/${space.id}/analytics?tab=calendar`} replace />
    );
  return (
    <>
      <PageTitle eyebrow="" title="资产与投资" />
      <NavigationTabs
        group="assets"
        routeParam="tab"
        activeKey={group}
        items={[
          {
            key: "holdings",
            label: "持仓",
            children: sections.find((s) => s.key === "holdings")?.children,
          },
          {
            key: "records",
            label: "产品与账户",
            children: (
              <NavigationTabs
                group="assets.records"
                routeParam="section"
                activeKey={recordTab}
                items={sections.filter((s) =>
                  ["products", "accounts", "liabilities", "reconcile"].includes(
                    s.key,
                  ),
                )}
              />
            ),
          },
        ]}
      />
      {deleteAccount && (
        <EntityDeleteDialog
          resource="accounts"
          item={deleteAccount}
          onClose={() => setDeleteAccount(null)}
        />
      )}
      {deletedAccountsOpen && (
        <DeletedEntities
          resource="accounts"
          onClose={() => setDeletedAccountsOpen(false)}
        />
      )}
    </>
  );
}
