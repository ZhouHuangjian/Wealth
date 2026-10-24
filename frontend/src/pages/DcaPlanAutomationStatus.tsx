import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, App, Button, Drawer, Space, Table, Tag, Tooltip } from "antd";
import type { Item } from "../api";
import { ApiError, send } from "../api";
import { LoadState, Money } from "../components";
import { helpColumns } from "../help";
import { marketTime } from "../market-quality";
import { useResource, useWorkspace } from "../state";
import { dcaCashReconciliationAction, dcaNextAction } from "../business-action";
import { newestFirst } from "../date-ordering";
import {
  dcaAutomationNotice,
  dcaAutomationRunRequest,
  dcaAutomationStatusLabel,
  dcaAutomationSummary,
} from "../dca-automation";

export default function DcaPlanAutomationStatus({ plan }: { plan: Item }) {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const navigate = useNavigate();
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
      message.success("已更新自动记账进度");
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
      <div className="dca-progress-heading">
        <Tag color={enabled && plan.status === "active" ? "green" : undefined}>
          {plan.status === "paused"
            ? "已暂停"
            : plan.status === "completed"
              ? "已结束"
              : enabled
                ? "自动记账"
                : "仅提醒"}
        </Tag>
        {enabled && plan.automation?.start_date && (
          <small>{plan.automation.start_date} 起</small>
        )}
      </div>
      <Button
        type="link"
        size="small"
        style={{
          paddingInline: 0,
          maxWidth: 230,
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
        title={`定投进度 · ${plan.name}`}
        width={850}
        className="dca-progress-drawer"
        onClose={close}
        maskClosable={!busy}
        keyboard={!busy}
        closable={!busy}
      >
        <div className="dca-progress-intro">
          <strong>
            {!enabled
              ? "自动记账已关闭"
              : plan.status === "completed"
                ? "计划已结束，已扣款期次继续处理"
                : plan.status === "paused"
                  ? "定投已暂停，已有记录保留"
                  : "每天处理到期计划，无需逐期确认"}
          </strong>
          <details className="dca-progress-help">
            <summary>自动记账说明</summary>
            <p>{dcaAutomationNotice}</p>
          </details>
        </div>
        <Space wrap style={{ marginBottom: 16 }}>
          {plan.automation?.start_date && (
            <span>生效日期：{plan.automation.start_date}</span>
          )}
          {state.data && (
            <span>
              最近检查（北京时间）：
              {marketTime(state.data.last_checked_at, "尚无检查记录")}
            </span>
          )}
          <Button
            loading={busy}
            disabled={busy || state.loading}
            onClick={() => {
              if (
                space.role !== "viewer" &&
                enabled &&
                !state.error &&
                state.data?.plan_version === plan.version
              )
                requestReveal(() => void run());
              else void state.retry();
            }}
          >
            刷新进度
          </Button>
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
          <p className="dca-progress-summary">
            {dcaAutomationSummary(state.data)}
          </p>
          {state.data && Number.isSafeInteger(state.data.completed_count) && (
            <div className="dca-progress-counts" aria-label="定投处理进度">
              <div>
                <small>已完成</small>
                <strong>{state.data.completed_count}</strong>
              </div>
              <div>
                <small>自动等待</small>
                <strong>{state.data.automatically_waiting_count ?? 0}</strong>
              </div>
              <div>
                <small>需处理</small>
                <strong>{state.data.needs_attention_count ?? 0}</strong>
              </div>
            </div>
          )}
          {state.data?.has_more && (
            <p className="muted">
              仅展示最近 500 期；其他期次仍由后台继续检查。
            </p>
          )}
          <Table<Item>
            rowKey="occurrence_id"
            size="small"
            dataSource={newestFirst<Item>(state.data?.items || [], ["date"])}
            scroll={{ x: 650 }}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            locale={{
              emptyText: enabled
                ? "等待下一期自动执行。"
                : "暂无自动补录记录。",
            }}
            columns={helpColumns<Item>([
              {
                title: "日期",
                width: 128,
                render: (_, row) => (
                  <div className="cell-name">
                    <strong>{row.application_date || row.date}</strong>
                    {row.scheduled_date &&
                    row.scheduled_date !==
                      (row.application_date || row.date) ? (
                      <small>原定 {row.scheduled_date} · 顺延</small>
                    ) : (
                      <small>计划执行日</small>
                    )}
                    {row.confirmation_date && (
                      <small>份额生效 {row.confirmation_date}</small>
                    )}
                  </div>
                ),
              },
              {
                title: "计划金额",
                width: 110,
                render: (_, row) => (
                  <Money value={row.amount} currency={plan.currency} />
                ),
              },
              {
                title: "进度",
                width: 210,
                render: (_, row) => (
                  <div className="cell-name">
                    <div>{dcaAutomationStatusLabel(row.status)}</div>
                    {row.status === "recorded_estimate" ? (
                      <small>推算来源 · 已完成记账</small>
                    ) : row.requires_action === true ? (
                      <small>
                        {row.action_scope === "plan"
                          ? "完善计划后自动继续"
                          : "有异常需要处理"}
                      </small>
                    ) : row.processing_state === "waiting" ||
                      [
                        "waiting_nav",
                        "waiting_confirmation",
                        "waiting_calendar",
                        "scheduled",
                      ].includes(row.status) ? (
                      <small>系统会自动继续</small>
                    ) : null}
                    {row.message && (
                      <Tooltip title={hidden ? "说明已隐藏" : row.message}>
                        <small className="dca-status-explanation" tabIndex={0}>
                          {hidden ? "说明已隐藏" : "查看本期原因"}
                        </small>
                      </Tooltip>
                    )}
                  </div>
                ),
              },
              {
                title: "下一步",
                width: 160,
                render: (_, row) => {
                  const action = dcaNextAction(space.id, row, plan);
                  const cashAction =
                    row.status === "waiting_cash" && action?.kind === "plan"
                      ? dcaCashReconciliationAction(space.id, row, plan)
                      : null;
                  if (!action)
                    return row.processing_state === "waiting" ? (
                      <small className="muted">系统继续重试</small>
                    ) : (
                      "—"
                    );
                  return (
                    <Space direction="vertical" size={0}>
                      <Tooltip
                        title={`${action.description}${space.role === "viewer" ? " 修正请联系空间管理员。" : ""}`}
                      >
                        <Button
                          disabled={busy}
                          size="small"
                          type="link"
                          onClick={() => {
                            close();
                            navigate(action.to);
                          }}
                        >
                          {action.label}
                        </Button>
                      </Tooltip>
                      {cashAction && (
                        <Button
                          disabled={busy}
                          size="small"
                          type="link"
                          onClick={() => {
                            close();
                            navigate(cashAction.to);
                          }}
                        >
                          {cashAction.label}
                        </Button>
                      )}
                    </Space>
                  );
                },
              },
              {
                title: "净值 / 日期",
                width: 130,
                render: (_, row) =>
                  row.nav == null ? (
                    "—"
                  ) : (
                    <>
                      <Money value={row.nav} precision={6} />
                      <div className="muted" style={{ fontSize: 11 }}>
                        {row.nav_date || "日期待核实"}
                      </div>
                    </>
                  ),
              },
              {
                title: "份额",
                width: 110,
                render: (_, row) =>
                  row.quantity == null ? (
                    "—"
                  ) : (
                    <Tooltip
                      title={
                        hidden ? "份额已隐藏" : `完整份额：${row.quantity}`
                      }
                    >
                      <span>
                        <Money value={row.quantity} precision={2} />
                      </span>
                    </Tooltip>
                  ),
              },
            ])}
          />
        </LoadState>
        <details className="dca-progress-help">
          <summary>失败、暂停或实际成交有变化</summary>
          <p>
            在编辑计划中排除失败日期或添加暂停区间。已记入的交易可修改或撤销；关闭自动记账只影响后续处理，已有记录保留。
          </p>
        </details>
      </Drawer>
    </>
  );
}
