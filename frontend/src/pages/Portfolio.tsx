import { helpColumns } from "../help";
import { NavigationTabs } from "../navigation";
import { useState } from "react";
import { Button, Drawer, Input, Space, Table, Tabs, Tag, Popover } from "antd";
import { Info, Tags } from "lucide-react";
import { EntityManager, LoadState, Money, Panel } from "../components";
import { dateToday, listOf } from "../api";
import type { Item } from "../api";
import { useResource, useWorkspace } from "../state";
import { Chart } from "./Home";
import { QuoteStatus } from "./InvestmentWorkspace";
export default function Portfolio() {
  const { space, hidden } = useWorkspace();
  const analysis = useResource("portfolio-analysis");
  const instruments = useResource("instruments", "?limit=200");
  const [tag, setTag] = useState<Item | null>(null);
  const options = listOf<Item>(instruments.data).map((r) => ({
    value: r.id,
    label: `${r.name} · ${r.code}`,
  }));
  const data = analysis.data;
  return (
    <>
      <NavigationTabs
        group="analytics.allocation"
        routeParam="section"
        items={[
          {
            key: "allocation",
            label: "当前配置",
            children: (
              <Panel
                title="持仓配置"
                action={
                  <Popover
                    trigger="click"
                    content="配置按每个产品的主标签唯一归属。同一产品可以有多个观察标签，但不会在配置金额中重复加总。目标权重由你设定。"
                  >
                    <Button
                      type="text"
                      icon={<Info size={16} />}
                      aria-label="持仓配置计算说明"
                    />
                  </Popover>
                }
              >
                <LoadState {...analysis}>
                  {data && (
                    <>
                      <div className="portfolio-total">
                        <span>
                          {data.total_value == null
                            ? "已知持仓价值"
                            : "持仓价值"}
                        </span>
                        <strong>
                          <Money
                            value={data.total_value ?? data.known_total_value}
                            precision={2}
                            currency={data.currency || space.base_currency}
                          />
                        </strong>
                        <QuoteStatus status={data.status} />
                      </div>
                      <Table<Item>
                        rowKey={(r) => r.tag_id || "unassigned"}
                        dataSource={data.groups || []}
                        pagination={false}
                        scroll={{ x: 850 }}
                        columns={helpColumns<Item>([
                          {
                            title: "主标签",
                            render: (_, r) => (
                              <Space>
                                <i
                                  className="allocation-dot"
                                  style={{ background: r.color || "#a6b496" }}
                                />
                                {r.name}
                              </Space>
                            ),
                          },
                          {
                            title: "持仓价值",
                            render: (_, r) => (
                              <div className="cell-name">
                                <Money
                                  value={r.value ?? r.known_value}
                                  precision={2}
                                  currency={data.currency}
                                />
                                {r.value == null && r.known_value != null && (
                                  <small>已知部分</small>
                                )}
                              </div>
                            ),
                          },
                          {
                            title: "当前权重",
                            render: (_, r) => (
                              <div className="allocation-weight">
                                <span>
                                  <Money
                                    value={r.current_weight}
                                    precision={2}
                                  />
                                  {r.current_weight != null && !hidden
                                    ? "%"
                                    : ""}
                                </span>
                                {!hidden && r.current_weight != null && (
                                  <div className="allocation-track">
                                    <i
                                      style={{
                                        width: `${Math.max(0, Math.min(100, Number(r.current_weight)))}%`,
                                        background: r.color || "#678a68",
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            ),
                          },
                          {
                            title: "目标权重",
                            render: (_, r) => (
                              <>
                                <Money value={r.target_weight} precision={2} />
                                {r.target_weight != null && !hidden ? "%" : ""}
                              </>
                            ),
                          },
                          {
                            title: "偏离",
                            render: (_, r) => (
                              <>
                                <Money
                                  value={r.deviation_pp}
                                  precision={2}
                                  sign
                                />
                                {r.deviation_pp != null && !hidden
                                  ? " 个百分点"
                                  : ""}
                              </>
                            ),
                          },
                          { title: "产品数", dataIndex: "product_count" },
                          {
                            title: "趋势",
                            render: (_, r) =>
                              r.tag_id && (
                                <Button type="link" onClick={() => setTag(r)}>
                                  查看
                                </Button>
                              ),
                          },
                        ])}
                      />
                    </>
                  )}
                </LoadState>
              </Panel>
            ),
          },
          {
            key: "tags",
            label: "标签与目标",
            children: (
              <EntityManager
                resource="investment-tags"
                title="投资标签"
                fields={[
                  {
                    name: "name",
                    label: "标签名称",
                    required: true,
                    placeholder: "黄金、红利低波、标普500",
                  },
                  {
                    name: "color",
                    label: "标签颜色",
                    initial: "#68896d",
                    placeholder: "#68896d",
                  },
                  {
                    name: "target_weight",
                    label: "目标权重（%）",
                    type: "number",
                    initial: "0",
                    help: "10 表示 10%；各主标签目标权重合计不能超过 100%。",
                  },
                  {
                    name: "instrument_ids",
                    label: "关联产品",
                    type: "multi",
                    options,
                    span: 2,
                  },
                  {
                    name: "primary_instrument_ids",
                    help: "只有一个标签时自动归类；多个标签时在这里选择归属，避免重复计算占比。",
                    label: "多标签产品的归属（选填）",
                    type: "multi",
                    options,
                    span: 2,
                  },
                ]}
                columns={[
                  {
                    title: "标签",
                    dataIndex: "name",
                    render: (v, r) => <Tag color={r.color}>{v}</Tag>,
                  },
                  {
                    title: "目标权重",
                    render: (_, r) => (
                      <>
                        <Money value={r.target_weight} precision={2} />
                        {hidden ? "" : "%"}
                      </>
                    ),
                  },
                  {
                    title: "关联产品",
                    render: (_, r) =>
                      (r.instrument_ids || [])
                        .map(
                          (id: string) =>
                            options.find((o) => o.value === id)?.label || id,
                        )
                        .join("、"),
                  },
                ]}
              />
            ),
          },
          {
            key: "holdings",
            label: "持仓明细",
            children: (
              <Panel title="配置明细">
                <LoadState {...analysis}>
                  <Table
                    rowKey={(r: any) =>
                      `${r.account_id}-${r.instrument_id || "equity"}`
                    }
                    dataSource={data?.items || data?.holdings || []}
                    pagination={{ pageSize: 12 }}
                    scroll={{ x: 850 }}
                    columns={helpColumns([
                      {
                        title: "产品 / 账户",
                        render: (_, r: any) => (
                          <div className="cell-name">
                            <strong>{r.name}</strong>
                            <small>{r.account_name}</small>
                          </div>
                        ),
                      },
                      {
                        title: "标签",
                        render: (_, r: any) =>
                          (r.labels || []).map((t: any) => (
                            <Tag key={t.id} color={t.color}>
                              {t.name}
                            </Tag>
                          )),
                      },
                      {
                        title: "持仓价值",
                        render: (_, r: any) => (
                          <Money
                            value={r.value}
                            currency={data?.currency}
                            precision={2}
                          />
                        ),
                      },
                      { title: "价格日期", dataIndex: "price_date" },
                      { title: "来源", dataIndex: "source" },
                      {
                        title: "状态",
                        render: (_, r: any) => (
                          <QuoteStatus status={r.status} />
                        ),
                      },
                    ])}
                  />
                </LoadState>
              </Panel>
            ),
          },
        ]}
      />
      <Drawer
        title={`${tag?.name || "标签"} · 固定持仓价格变化`}
        open={!!tag}
        onClose={() => setTag(null)}
        width={860}
      >
        {tag && <TagSeries tag={tag} />}
      </Drawer>
    </>
  );
}
function TagSeries({ tag }: { tag: Item }) {
  const [start, setStart] = useState(`${new Date().getFullYear()}-01-01`),
    [end, setEnd] = useState(dateToday());
  const state = useResource(
    "tag-series",
    `?${new URLSearchParams({ tag_id: tag.tag_id || tag.id, start, end })}`,
  );
  const data = state.data;
  return (
    <>
      <Space className="form-alert">
        <Input
          type="date"
          aria-label="标签价格起始日"
          value={start}
          onChange={(e) => e.target.value && setStart(e.target.value)}
        />
        <span>至</span>
        <Input
          type="date"
          aria-label="标签价格结束日"
          value={end}
          onChange={(e) => e.target.value && setEnd(e.target.value)}
        />
      </Space>
      <p className="data-caption">
        按当前持仓数量回看历史正式价格，不代表实际历史组合收益。
      </p>
      <LoadState {...state}>
        <Chart items={data?.days || []} xKey="date" yKey="value" />
        <Table
          rowKey="date"
          dataSource={data?.days || []}
          pagination={{ pageSize: 8 }}
          columns={helpColumns([
            { title: "日期", dataIndex: "date" },
            {
              title: "固定持仓价值",
              render: (_, r: any) => (
                <Money
                  value={r.value ?? r.known_value}
                  currency={r.currency || data?.currency}
                  precision={2}
                />
              ),
            },
            {
              title: "状态",
              render: (_, r: any) => <QuoteStatus status={r.status} />,
            },
          ])}
        />
      </LoadState>
    </>
  );
}
