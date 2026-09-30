import { helpColumns } from "../help";
import InvestmentTools from "./Investments";
import { NavigationTabs } from "../navigation";
import { useSearchParams } from "react-router-dom";
import Portfolio from "./Portfolio";
import MarketEnvironment from "./MarketEnvironment";
import { Alert, Descriptions, Table, Tabs } from "antd";
import {
  Blank,
  LoadState,
  Money,
  PageTitle,
  Panel,
  ResourceTable,
  Status,
} from "../components";
import { listOf } from "../api";
import type { Item } from "../api";
import { useResource, useWorkspace } from "../state";
import ProfitCalendar from "./ProfitCalendar";
export default function Analytics() {
  const [params] = useSearchParams();
  const state = useResource("performance");
  const { space, hidden } = useWorkspace();
  const p = state.data;
  const legacy = [
    {
      key: "performance",
      label: "收益与口径",
      children: (
        <Panel
          title="投资表现"
          subtitle="净资产规模变化不等于投资收益；内部转账不算组合外部投入。"
        >
          <LoadState {...state}>
            {p && (
              <>
                <div className="analytics-metrics">
                  <div>
                    <span>期间净损益</span>
                    <strong>
                      <Money
                        value={
                          p.scope_account_ids?.length === 0
                            ? null
                            : (p.net_profit ?? p.net_pnl)
                        }
                        currency={p.currency || space.base_currency}
                        sign
                      />
                    </strong>
                    <Status value={p.completeness || p.status} />
                  </div>
                  <div>
                    <span>资金加权收益率 XIRR</span>
                    <strong>
                      {hidden
                        ? "••••••"
                        : p.xirr?.rate === null || p.xirr?.rate === undefined
                          ? "暂不可计算"
                          : `${p.xirr.rate}（小数）`}
                    </strong>
                    <small>
                      {hidden
                        ? "内容已隐藏"
                        : p.xirr_reason ||
                          p.xirr?.reason ||
                          "以完整资金流与期末价值计算，具体口径以返回结果为准"}
                    </small>
                  </div>
                  <div>
                    <span>费用与税费</span>
                    <strong>
                      <Money
                        value={p.fees ?? p.total_fees}
                        currency={p.currency || space.base_currency}
                      />
                    </strong>
                    <small>已进入净损益的费用不重复扣除</small>
                  </div>
                </div>
                {(p.reason || p.gaps?.length > 0) && (
                  <Alert
                    type="warning"
                    showIcon
                    message="当前结果存在数据限制"
                    description={
                      hidden
                        ? "内容已隐藏"
                        : p.reason ||
                          (p.gaps || [])
                            .map((x: any) =>
                              typeof x === "string" ? x : x.reason,
                            )
                            .join("；")
                    }
                  />
                )}
                <Descriptions
                  className="report-scope"
                  column={2}
                  bordered
                  items={[
                    {
                      key: "scope",
                      label: "统计范围",
                      children: p.scope || "当前空间已记录资产",
                    },
                    {
                      key: "asof",
                      label: "统计时点",
                      children: p.end || p.as_of || "未提供",
                    },
                    {
                      key: "from",
                      label: "起始日期",
                      children: p.start || p.start_date || "未指定 / 数据不足",
                    },
                    {
                      key: "revision",
                      label: "数据修订",
                      children: p.data_revision ?? "未提供",
                    },
                  ]}
                />
                {listOf<Item>(p.breakdown || p.items).length ? (
                  <Table
                    rowKey="id"
                    dataSource={listOf<Item>(p.breakdown || p.items)}
                    columns={helpColumns<Item>([
                      { title: "项目", dataIndex: "name" },
                      {
                        title: "净损益",
                        render: (_, r) => (
                          <Money
                            value={r.net_profit ?? r.value}
                            currency={r.currency}
                          />
                        ),
                      },
                      {
                        title: "状态",
                        dataIndex: "status",
                        render: (v) => <Status value={v} />,
                      },
                    ])}
                  />
                ) : (
                  <Blank
                    title="尚无可用的完整收益分项"
                    description="补充期初、实际交易、正式价格和汇率后再查看。没有依据的收益不会填为零。"
                  />
                )}
              </>
            )}
          </LoadState>
        </Panel>
      ),
    },
    {
      key: "calendar",
      label: "收益日历",
      children: <ProfitCalendar />,
    },
    {
      key: "audit",
      label: "修订与审计",
      children: (
        <ResourceTable
          resource="audit"
          title="操作与修订记录"
          description="按当前权限展示本空间审计，保留账目变更与数据来源。"
          columns={[
            {
              title: "时间",
              dataIndex: "created_at",
              render: (v) => v?.slice(0, 19).replace("T", " "),
            },
            { title: "操作", render: (_, r) => r.action || r.kind },
            {
              title: "对象",
              render: (_, r) => r.resource || r.object_type,
            },
            {
              title: "记录 ID",
              render: (_, r) => r.object_id || r.entity_id,
            },
            {
              title: "说明",
              render: (_, r) =>
                hidden ? "内容已隐藏" : r.reason || r.description,
            },
          ]}
        />
      ),
    },
  ];
  const tab = params.get("tab") || "calendar";
  return (
    <>
      <PageTitle eyebrow="" title="分析复盘" />
      <NavigationTabs
        group="analytics"
        routeParam="tab"
        activeKey={["performance", "audit"].includes(tab) ? "reports" : tab}
        items={[
          { key: "calendar", label: "收益日历", children: <ProfitCalendar /> },
          { key: "allocation", label: "持仓配置", children: <Portfolio /> },
          {
            key: "market",
            label: "市场环境与提醒",
            children: (
              <MarketEnvironment
                initialSection={params.get("section") || "watchlist"}
              />
            ),
          },
          {
            key: "settlement",
            label: "行情与结算",
            children: <InvestmentTools section="market" />,
          },
          {
            key: "reports",
            label: "收益指标与审计",
            children: (
              <NavigationTabs
                group="analytics.reports"
                routeParam="section"
                defaultActiveKey={tab === "audit" ? "audit" : "performance"}
                items={legacy.filter((item) => item.key !== "calendar")}
              />
            ),
          },
        ]}
      />
    </>
  );
}
