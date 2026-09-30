import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Space, Table, Tag } from "antd";
import type { Item } from "../api";
import { ApiError, send } from "../api";
import { LoadState, Money } from "../components";
import { HelpText, helpColumns } from "../help";
import { useResource, useWorkspace } from "../state";
import {
  dcaAutomationNotice,
  dcaAutomationRunRequest,
  dcaAutomationStatusLabel,
  dcaAutomationSummary,
} from "../dca-automation";

export default function DcaPlanAutomationStatus({ plan }: { plan: Item }) {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const { message } = App.useApp();
  const state = useResource(`plans/${plan.id}/automation`);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    live = useRef(true),
    changed = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  function close() {
    if (busy) return;
    setOpen(false);
    if (changed.current) {
      changed.current = false;
      reload();
    }
  }
  async function run() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await send(
        `/spaces/${space.id}/plans/${plan.id}/automation/run`,
        dcaAutomationRunRequest(plan),
      );
      if (!live.current) return;
      changed.current = true;
      message.success("已检查到期计划，补录结果见下方明细");
      await state.retry();
    } catch (e) {
      if (live.current)
        setError(
          e instanceof ApiError && e.status === 412
            ? "计划已被修改，请刷新计划列表后重新检查。"
            : (e as Error).message,
        );
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  const enabled = plan.automation?.enabled === true;
  return (
    <>
      <div>
        <Tag>{enabled ? <HelpText text="按计划自动补录" /> : "手工确认"}</Tag>
      </div>
      <Button
        type="link"
        size="small"
        style={{
          paddingInline: 0,
          maxWidth: 330,
          whiteSpace: "normal",
          height: "auto",
          textAlign: "left",
        }}
        onClick={() => {
          setOpen(true);
          void state.retry();
        }}
      >
        {state.loading
          ? "正在读取进度…"
          : state.error
            ? "进度读取失败 · 重试"
            : dcaAutomationSummary(state.data)}
      </Button>
      <Drawer
        open={open}
        title={`自动补录 · ${plan.name}`}
        width={850}
        onClose={close}
        maskClosable={!busy}
        keyboard={!busy}
        closable={!busy}
      >
        <p className="muted">{dcaAutomationNotice}</p>
        <Space wrap style={{ marginBottom: 16 }}>
          <Tag>{enabled ? "自动补录已开启" : "自动补录已关闭"}</Tag>
          {plan.automation?.start_date && (
            <span>生效日期：{plan.automation.start_date}</span>
          )}
          <Button disabled={busy} onClick={() => void state.retry()}>
            刷新进度
          </Button>
          {space.role !== "viewer" && enabled && (
            <Button
              type="primary"
              loading={busy}
              disabled={
                state.loading ||
                !!state.error ||
                !state.data ||
                state.data.plan_version !== plan.version
              }
              onClick={() => requestReveal(() => void run())}
            >
              立即检查
            </Button>
          )}
        </Space>
        {state.data && state.data.plan_version !== plan.version && (
          <Alert
            type="info"
            showIcon
            message="计划已更新，请刷新计划列表后重新打开。"
            style={{ marginBottom: 12 }}
          />
        )}
        {error && (
          <Alert
            type="error"
            showIcon
            message={hidden ? "检查未完成，请显示金额后查看详细原因。" : error}
            style={{ marginBottom: 12 }}
          />
        )}
        <LoadState
          {...state}
          error={hidden && state.error ? "进度暂时无法读取" : state.error}
        >
          <p>{dcaAutomationSummary(state.data)}</p>
          {state.data?.has_more && (
            <p className="muted">
              仅展示最近 500 期；其他期次仍由后台继续检查。
            </p>
          )}
          <Table<Item>
            rowKey="occurrence_id"
            size="small"
            dataSource={[...(state.data?.items || [])].sort((a, b) =>
              String(b.date).localeCompare(String(a.date)),
            )}
            scroll={{ x: 730 }}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            locale={{
              emptyText: enabled
                ? "暂无到期待办；到期后系统会自动检查，也可使用上方立即检查。"
                : "暂无自动补录记录。",
            }}
            columns={helpColumns<Item>([
              { title: "计划日期", dataIndex: "date", width: 112 },
              {
                title: "计划金额",
                width: 130,
                render: (_, row) => (
                  <Money value={row.amount} currency={plan.currency} />
                ),
              },
              {
                title: "进度",
                width: 250,
                render: (_, row) => (
                  <>
                    <div>{dcaAutomationStatusLabel(row.status)}</div>
                    {row.status === "recorded_estimate" && (
                      <Tag>
                        <HelpText text="自动确认份额" />
                      </Tag>
                    )}
                    {row.message && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {hidden ? "说明已隐藏" : row.message}
                      </div>
                    )}
                    {row.status === "waiting_confirmation" &&
                      row.confirmation_date && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          预计确认：{row.confirmation_date}
                        </div>
                      )}
                  </>
                ),
              },
              {
                title: "采用净值",
                width: 120,
                render: (_, row) =>
                  row.nav == null ? (
                    "—"
                  ) : (
                    <>
                      <Money value={row.nav} precision={6} />
                      <div className="muted">
                        {row.nav_date || "日期待核实"}
                      </div>
                    </>
                  ),
              },
              {
                title: "确认份额",
                width: 140,
                render: (_, row) =>
                  row.quantity == null ? (
                    "—"
                  ) : (
                    <Money value={row.quantity} precision={6} />
                  ),
              },
            ])}
          />
        </LoadState>
        <p className="muted" style={{ fontSize: 12 }}>
          排除日期和暂停区间可在编辑计划中设置。已补记的扣款和份额不会因关闭自动补录而撤销；实际失败的已记账期次需核对并冲正。
        </p>
      </Drawer>
    </>
  );
}
