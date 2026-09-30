import { useEffect, useState } from "react";
import { Button, Drawer, Table, Tag } from "antd";
import { Money } from "../components";
import { HelpText, helpColumns } from "../help";
import { pendingPurchaseItems } from "../holding-display";
import type { HoldingRow } from "../holding-display";
import { useWorkspace } from "../state";

export type PendingPurchaseDetailsProps = {
  items: HoldingRow[];
  amount?: string | number | null;
  currency?: string;
  label?: string;
  title?: string;
  compact?: boolean;
};

/** Reuses the server's remaining-transit projection; never creates or confirms a trade. */
export default function PendingPurchaseDetails({
  items,
  amount,
  currency,
  label = "买入待确认",
  title = "买入待确认明细",
  compact = false,
}: PendingPurchaseDetailsProps) {
  const { space, hidden } = useWorkspace();
  const [open, setOpen] = useState(false);
  const rows = pendingPurchaseItems(items);
  useEffect(() => setOpen(false), [space.id]);
  return (
    <>
      <Button
        type="link"
        size="small"
        onClick={() => setOpen(true)}
        aria-label={`查看${title}`}
        style={{
          paddingInline: 0,
          height: "auto",
          fontSize: compact ? 11 : "inherit",
          textAlign: "left",
          whiteSpace: "normal",
        }}
      >
        {label}
        {amount !== undefined && (
          <>
            {label ? " " : ""}
            <Money value={amount} currency={currency} precision={2} />
          </>
        )}
      </Button>
      <Drawer
        open={open}
        title={title}
        width={920}
        onClose={() => setOpen(false)}
      >
        <p className="data-caption">
          已记扣款，等待份额；与已确认市值分开列示，不另加到净资产。部分确认或退款后，仅显示尚未确认的剩余金额。
        </p>
        <Table<HoldingRow>
          size="small"
          rowKey={(row) => String(row.debit_event_id || row.id)}
          dataSource={rows}
          scroll={{ x: 850 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{ emptyText: "当前范围没有剩余买入待确认款" }}
          columns={helpColumns<HoldingRow>([
            {
              title: "产品 / 持仓账户",
              width: 215,
              render: (_, row) => (
                <div className="cell-name">
                  <strong>{row.instrument_name || "产品待核对"}</strong>
                  <small>
                    {row.code || ""}
                    {row.code ? " · " : ""}
                    {row.holding_account_name ||
                      (row.target_status === "conflict"
                        ? "持仓账户待核对"
                        : "尚未明确持仓账户")}
                  </small>
                </div>
              ),
            },
            {
              title: "未确认金额",
              width: 140,
              render: (_, row) => (
                <Money value={row.amount} currency={row.currency} />
              ),
            },
            {
              title: "资金账户 / 扣款日",
              width: 160,
              render: (_, row) => (
                <div className="cell-name">
                  <span>
                    {row.funding_source === "untracked"
                      ? "账外资金（未扣本账簿账户）"
                      : row.source_account_name || "资金账户待核对"}
                  </span>
                  <small>{row.debit_date || "扣款日期待核对"}</small>
                </div>
              ),
            },
            {
              title: "来源 / 计划日",
              width: 155,
              render: (_, row) => (
                <div className="cell-name">
                  <span>{row.is_dca ? "定投" : "单笔买入"}</span>
                  {row.is_dca && (
                    <small>{row.scheduled_date || "计划日期待核对"}</small>
                  )}
                  {row.automatic_estimate === true ? (
                    <Tag>
                      <HelpText text="自动推算" />
                    </Tag>
                  ) : row.entry_basis === "preview_confirmed" ? (
                    <Tag>
                      <HelpText text="按预览补录" />
                    </Tag>
                  ) : (
                    <small>已录入扣款</small>
                  )}
                </div>
              ),
            },
            {
              title: "预计确认日",
              width: 155,
              render: (_, row) => (
                <div className="cell-name">
                  <span>{row.expected_confirmation_date || "待确定"}</span>
                  {row.message &&
                    (row.target_status !== "assigned" ||
                      row.valuation_scope === "institution_snapshot") && (
                      <small>{hidden ? "说明已隐藏" : row.message}</small>
                    )}
                </div>
              ),
            },
          ])}
        />
        <p className="data-caption">
          预计确认日按交易日和产品规则计算；正式净值、费用或日历未齐备时，份额仍可能继续等待。自动推算记录不代表机构已实际成交。
        </p>
      </Drawer>
    </>
  );
}
