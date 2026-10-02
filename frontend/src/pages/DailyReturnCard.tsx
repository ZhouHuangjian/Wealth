import { useState } from "react";
import { Button, Drawer, Table, Tag } from "antd";
import { ChevronRight } from "lucide-react";
import { dateToday } from "../api";
import { Blank, Money } from "../components";
import {
  dailyReturnDisplay,
  dailyReturnLabels,
  returnDateDisplay,
} from "../daily-return";
import { HelpText } from "../help";
import { profitTone } from "../investment";
import { useWorkspace } from "../state";

const sourceLabels: Record<string, string> = {
  institution_snapshot: "机构账户权益",
  option_position_reference: "期权持仓参考",
  ledger: "已记录交易",
  manual: "手工录入",
};

export default function DailyReturnCard({
  data,
  asOf,
  currency,
}: {
  data: Record<string, any> | null | undefined;
  asOf: string;
  currency: string;
}) {
  const { hidden } = useWorkspace();
  const [open, setOpen] = useState(false);
  const view = dailyReturnDisplay(data);
  const displayCurrency = data?.currency || currency;
  const title = asOf === dateToday() ? "今日估算收益" : "当日估算收益";
  const rows = data?.items || [];
  return (
    <>
      <article className="net-worth-card daily-return-card">
        <div className="net-worth-heading">
          <span>
            <HelpText text={title} />
          </span>
          <Tag
            color={
              view.partial
                ? "gold"
                : view.status === "confirmed"
                  ? "blue"
                  : undefined
            }
          >
            {view.label}
          </Tag>
        </div>
        <strong className={hidden ? "" : profitTone(view.amount)}>
          <Money value={view.amount} currency={displayCurrency} sign />
        </strong>
        <div className="daily-return-secondary">
          {view.rate && !hidden ? (
            <span className={profitTone(data?.return_rate)}>{view.rate}</span>
          ) : view.partial ? (
            <span>已知部分</span>
          ) : (
            <span>
              {view.status === "no_position"
                ? "暂无投资持仓"
                : "按实际收益日统计"}
            </span>
          )}
          <time>{data?.date || asOf}</time>
        </div>
        <div className="daily-return-bottom">
          <small>{hidden ? "金额已隐藏" : view.coverage}</small>
          <Button
            type="link"
            size="small"
            onClick={() => setOpen(true)}
            icon={<ChevronRight size={14} />}
          >
            收益明细
          </Button>
        </div>
      </article>
      <Drawer
        title={`${title} · ${data?.date || asOf}`}
        open={open}
        onClose={() => setOpen(false)}
        width={860}
        className="daily-return-drawer"
      >
        {hidden ? (
          <Blank
            title="金额已隐藏"
            description="关闭金额隐藏后可查看收益明细。"
          />
        ) : (
          <>
            <div className="daily-return-detail-summary">
              <div>
                <small>{view.partial ? "已知部分收益" : title}</small>
                <strong className={profitTone(view.amount)}>
                  <Money value={view.amount} currency={displayCurrency} sign />
                </strong>
              </div>
              <div>
                <Tag>{view.label}</Tag>
                <span>{view.coverage}</span>
              </div>
            </div>
            <p className="data-caption">
              按价格变化、已记录买卖及分红计算，剔除投入本金；外币收益按当日汇率折算，不包含独立汇兑损益。
            </p>
            <Table<any>
              rowKey={(row) =>
                `${row.account_id}:${row.instrument_id || "equity"}`
              }
              size="small"
              dataSource={rows}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              scroll={{ x: 610 }}
              locale={{ emptyText: "暂无可计算的投资项目" }}
              columns={[
                {
                  title: "投资项目",
                  width: 220,
                  render: (_, row) => (
                    <div className="cell-name">
                      <strong>
                        {row.instrument_name ||
                          row.name ||
                          row.account_name ||
                          "机构账户权益"}
                      </strong>
                      <small>
                        {row.instrument_id
                          ? row.account_name
                          : "按机构总权益计算"}
                      </small>
                    </div>
                  ),
                },
                {
                  title: "当日收益",
                  width: 165,
                  render: (_, row) => (
                    <div className={`cell-name ${profitTone(row.base_amount)}`}>
                      <Money
                        value={row.base_amount}
                        currency={displayCurrency}
                        sign
                      />
                      {row.base_amount == null &&
                        row.latest_formal_return?.base_amount != null && (
                          <small>
                            最近净值收益{" "}
                            <Money
                              value={row.latest_formal_return.base_amount}
                              currency={displayCurrency}
                              sign
                            />
                            {" · "}
                            {
                              returnDateDisplay(row.latest_formal_return)
                                .returnDate
                            }
                          </small>
                        )}
                      {row.currency && row.currency !== displayCurrency && (
                        <small>
                          原币{" "}
                          <Money
                            value={row.amount}
                            currency={row.currency}
                            sign
                          />
                        </small>
                      )}
                    </div>
                  ),
                },
                {
                  title: "数据日期与状态",
                  render: (_, row) => (
                    <div className="cell-name">
                      <span>
                        {dailyReturnLabels[row.status] ||
                          row.status ||
                          "待更新"}
                        {returnDateDisplay(row).returnDate
                          ? ` · 收益归属 ${returnDateDisplay(row).returnDate}`
                          : ""}
                      </span>
                      {returnDateDisplay(row).navDate && (
                        <small>
                          净值 / 价格归属 {returnDateDisplay(row).navDate}
                        </small>
                      )}
                      {row.interval_start && (
                        <small>计算基准 {row.interval_start}</small>
                      )}
                      {row.source && (
                        <small>{sourceLabels[row.source] || row.source}</small>
                      )}
                      {row.message && <small>{row.message}</small>}
                    </div>
                  ),
                },
              ]}
            />
            <details className="compact-help daily-return-help">
              <summary>收益如何计算</summary>
              <p>
                {data?.message ||
                  "当日有效行情和可比基准齐备后计算。缺少行情或基准的项目保留缺口，不按零收益处理。"}
              </p>
              <p>
                基金待确认申购计入在途；期货、期权使用可核对的账户权益，合约参考市值不重复加总。QDII
                最近净值收益可能属于更早的交易日，在净值公布后回填该日。系统获取时间与净值归属日分别展示，不把延迟公布的收益再次计入今天。
              </p>
            </details>
          </>
        )}
      </Drawer>
    </>
  );
}
