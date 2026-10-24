import { useState } from "react";
import { Button, Drawer, Table, Tag } from "antd";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Blank, Money } from "../components";
import { dailyReturnNextAction } from "../business-action";
import { latestFundUpdateDisplay, latestFundUpdateRows } from "../fund-updates";
import { profitTone } from "../investment";
import { marketTime } from "../market-quality";
import { useWorkspace } from "../state";

export default function LatestFundUpdates({
  data,
}: {
  data: Record<string, any> | null | undefined;
}) {
  const { hidden, space } = useWorkspace();
  const [open, setOpen] = useState(false);
  const rows = latestFundUpdateRows(data);
  if (!rows.length) return null;
  return (
    <>
      <div className="daily-return-bottom">
        <small>{hidden ? "内容已隐藏" : "待公布估算与最近正式收益"}</small>
        <Button
          type="link"
          size="small"
          icon={<ChevronRight size={14} />}
          onClick={() => setOpen(true)}
        >
          最近基金收益更新
        </Button>
      </div>
      <Drawer
        title="最近基金收益更新"
        open={open}
        onClose={() => setOpen(false)}
        width={860}
        className="daily-return-drawer"
      >
        {hidden ? (
          <Blank
            title="金额已隐藏"
            description="关闭金额隐藏后可查看基金更新明细。"
          />
        ) : (
          <>
            <p className="data-caption">
              各基金覆盖区间可能不同，这里的金额不与今日收益相加。新正式净值到齐后更新展示，旧参考不再叠加，原记录保留。
            </p>
            <Table<Record<string, any>>
              rowKey={(row, index) =>
                `${row.account_id}:${row.instrument_id}:${index}`
              }
              size="small"
              dataSource={rows}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              scroll={{ x: 610 }}
              columns={[
                {
                  title: "基金",
                  width: 210,
                  render: (_, row) => (
                    <div className="cell-name">
                      <strong>
                        {row.instrument_name || row.name || row.code || "基金"}
                      </strong>
                      <small>{row.account_name}</small>
                    </div>
                  ),
                },
                {
                  title: "本次更新",
                  width: 185,
                  render: (_, row) => {
                    const view = latestFundUpdateDisplay(row);
                    return (
                      <div className={`cell-name ${profitTone(view.amount)}`}>
                        <Money
                          value={view.amount}
                          currency={view.currency}
                          sign
                        />
                        <Tag
                          color={
                            view.formal
                              ? "blue"
                              : view.estimated
                                ? "gold"
                                : undefined
                          }
                        >
                          {view.label}
                        </Tag>
                        <small>{view.window}</small>
                      </div>
                    );
                  },
                },
                {
                  title: "日期与依据",
                  render: (_, row) => {
                    const view = latestFundUpdateDisplay(row);
                    const action = dailyReturnNextAction(space.id, row);
                    return (
                      <div className="cell-name">
                        {view.navDate && <span>净值归属 {view.navDate}</span>}
                        {view.quotedAt && (
                          <small>
                            来源报价 {marketTime(view.quotedAt)}（北京时间）
                          </small>
                        )}
                        {view.recordedAt && (
                          <small>
                            记录时间 {marketTime(view.recordedAt)}（北京时间）
                          </small>
                        )}
                        {row.source && <small>{row.source}</small>}
                        <small>{view.message}</small>
                        <details>
                          <summary>查看计算依据</summary>
                          <div>
                            基准净值{" "}
                            <Money
                              value={view.baseNav}
                              currency={view.currency}
                              precision={6}
                            />
                            {" · "}
                            {view.baseNavDate || "日期待补全"}
                          </div>
                          <div>
                            {view.hasFormalNav ? "正式净值" : "来源参考值"}{" "}
                            <Money
                              value={view.quotePrice}
                              currency={view.currency}
                              precision={6}
                            />
                          </div>
                          {view.quantity != null && (
                            <div>
                              适用份额{" "}
                              <Money value={view.quantity} precision={6} />（
                              {view.quantitySourceLabel}）
                            </div>
                          )}
                          {view.fetchedAt && (
                            <div>
                              获取时间 {marketTime(view.fetchedAt)}（北京时间）
                            </div>
                          )}
                        </details>
                        {action && (
                          <Link to={action.to} onClick={() => setOpen(false)}>
                            {action.label}
                          </Link>
                        )}
                      </div>
                    );
                  },
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
