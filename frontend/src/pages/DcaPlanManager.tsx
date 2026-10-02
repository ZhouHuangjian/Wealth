import { useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { Plus, RefreshCw, Search } from "lucide-react";
import { api, ApiError, dateToday, listOf, send } from "../api";
import type { Item } from "../api";
import { Fields, LoadState, Panel } from "../components";
import type { Field } from "../components";
import { helpColumns } from "../help";
import { useDebounced, useResource, useWorkspace } from "../state";
import { dcaAutomationInitial, dcaPlanPayload } from "../dca-automation";
import DcaAutomationFields from "./DcaAutomationFields";
import DcaPlanAutomationStatus from "./DcaPlanAutomationStatus";
import "./fund-experience.css";

export default function DcaPlanManager({
  fields,
  columns,
  queryParams,
  accounts,
  onHistory,
}: {
  fields: Field[];
  columns: ColumnsType<Item>;
  queryParams?: Record<string, string>;
  accounts: Item[];
  onHistory: (plan: Item) => void;
}) {
  const { space, reload, hidden, requestReveal, showDetail } = useWorkspace();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm(),
    formId = useId();
  const automaticEnabled = Form.useWatch("automatic_enabled", form) === true;
  const frequency = Form.useWatch("frequency", form);
  const currency = Form.useWatch("currency", form) || "CNY";
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [query, setQuery] = useState("");
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Item | null>(null),
    [initial, setInitial] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const loadSequence = useRef(0),
    live = useRef(true),
    saveLock = useRef(false);
  const settled = useDebounced(query);
  const queryKey = JSON.stringify(queryParams || {});
  useEffect(() => {
    setPage(1);
  }, [settled, queryKey]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      loadSequence.current++;
    };
  }, [space.id]);
  const params = new URLSearchParams({
    kind: "dca",
    offset: String((page - 1) * pageSize),
    limit: String(pageSize),
    q: settled,
    ...queryParams,
  });
  const state = useResource("plans", `?${params}`);
  const instrumentState = useResource("instruments");
  const instruments = listOf<Item>(instrumentState.data);
  const rows = listOf<Item>(state.data);
  const canWrite = space.role !== "viewer";
  useEffect(() => {
    if (open && !editing && frequency && !form.isFieldTouched("holiday_policy"))
      form.setFieldValue(
        "holiday_policy",
        frequency === "monthly" ? "next_open" : "skip",
      );
  }, [frequency, editing, open, form]);
  async function loadPlan(plan: Item) {
    const seq = ++loadSequence.current;
    setLoading(true);
    setLoadError("");
    try {
      const current = await api<Item>(`/spaces/${space.id}/plans/${plan.id}`);
      if (!live.current || seq !== loadSequence.current) return;
      setEditing(current);
      setInitial({ ...current, ...dcaAutomationInitial(current, dateToday()) });
    } catch (e) {
      if (live.current && seq === loadSequence.current)
        setLoadError((e as Error).message);
    } finally {
      if (live.current && seq === loadSequence.current) setLoading(false);
    }
  }
  function openForm(plan?: Item) {
    requestReveal(() => {
      setEditing(plan || null);
      setDirty(false);
      setError("");
      setLoadError("");
      setOpen(true);
      if (plan) void loadPlan(plan);
      else {
        loadSequence.current++;
        setLoading(false);
        const values = Object.fromEntries(
          fields
            .filter((field) => field.initial !== undefined)
            .map((field) => [field.name, field.initial]),
        );
        setInitial({
          name: "我的定投",
          ...values,
          ...dcaAutomationInitial(values, dateToday(), { newPlan: true }),
        });
      }
    });
  }
  function closeForm() {
    if (busy) return;
    const close = () => {
      loadSequence.current++;
      setOpen(false);
      setDirty(false);
    };
    if (!dirty) close();
    else
      modal.confirm({
        title: "放弃尚未保存的修改？",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: close,
      });
  }
  async function save(values: Record<string, any>) {
    if (saveLock.current || loading || loadError || !canWrite) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
      const product = instruments.find(
        (item) => item.id === values.instrument_id,
      );
      if (!editing && values.name === "我的定投" && product)
        values.name = `${product.name} · ${({ daily: "每日", weekly: "每周", monthly: "每月" } as Record<string, string>)[values.frequency] || "定期"}定投`;
      await send(
        `/spaces/${space.id}/plans${editing ? `/${editing.id}` : ""}`,
        dcaPlanPayload(values, editing || undefined),
        editing ? "PATCH" : "POST",
      );
      if (!live.current) return;
      message.success(
        values.automatic_enabled
          ? "已保存，后续按计划自动记账"
          : "定投计划已保存",
      );
      setOpen(false);
      setDirty(false);
      reload();
    } catch (e) {
      if (live.current)
        setError(
          e instanceof ApiError && e.status === 412
            ? "计划已被修改，请关闭窗口后重新编辑，以读取最新设置。"
            : (e as Error).message,
        );
    } finally {
      saveLock.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <div className="dca-plan-workspace">
      <Panel
        title="定投计划"
        subtitle="一次设置，自动记账与计算份额。"
        action={
          <Space>
            <Button
              aria-label="刷新定投计划"
              icon={<RefreshCw size={14} />}
              onClick={() => state.retry()}
            />
            {canWrite && (
              <Button
                type="primary"
                icon={<Plus size={15} />}
                onClick={() => openForm()}
              >
                新增定投计划
              </Button>
            )}
          </Space>
        }
      >
        <div className="table-toolbar">
          <Input
            prefix={<Search size={15} />}
            placeholder="搜索定投计划"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            allowClear
            style={{ maxWidth: 300 }}
          />
        </div>
        <LoadState {...state}>
          <Table<Item>
            rowKey="id"
            size="middle"
            dataSource={rows}
            columns={helpColumns([
              ...columns.filter(
                (column) =>
                  !("dataIndex" in column && column.dataIndex === "status"),
              ),
              {
                title: "运行进度",
                width: 230,
                render: (_, plan) =>
                  plan.automation ? (
                    <DcaPlanAutomationStatus
                      key={`${space.id}:${plan.id}:${plan.version}`}
                      plan={plan}
                    />
                  ) : (
                    <Tag>{plan.status === "paused" ? "已暂停" : "仅提醒"}</Tag>
                  ),
              },
              {
                title: "操作",
                key: "action",
                fixed: "right",
                width: 150,
                render: (_, plan) => (
                  <Space size={4}>
                    <Button
                      size="small"
                      type="link"
                      onClick={() =>
                        canWrite ? openForm(plan) : showDetail(plan)
                      }
                    >
                      {canWrite ? "编辑" : "详情"}
                    </Button>
                    {plan.frequency === "daily" &&
                      plan.holiday_policy !== "next_open" && (
                        <Button
                          size="small"
                          type="link"
                          onClick={() => onHistory(plan)}
                        >
                          历史估算
                        </Button>
                      )}
                  </Space>
                ),
              },
            ])}
            scroll={{ x: "max-content" }}
            pagination={{
              current: page,
              pageSize,
              total: state.data?.count ?? rows.length,
              onChange: (next, size) => {
                setPage(next);
                setPageSize(size);
              },
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
            }}
            locale={{ emptyText: "尚未添加定投计划" }}
          />
        </LoadState>
        <Modal
          open={open}
          title={editing ? "编辑定投计划" : "新增定投计划"}
          width={720}
          className="dca-plan-modal"
          onCancel={closeForm}
          onOk={() => form.submit()}
          okText={automaticEnabled ? "保存自动记账计划" : "保存"}
          cancelText="取消"
          confirmLoading={busy}
          okButtonProps={{ disabled: loading || !!loadError }}
          cancelButtonProps={{ disabled: busy }}
          maskClosable={!busy}
          keyboard={!busy}
          closable={!busy}
          destroyOnHidden
        >
          <div data-dirty={dirty}>
            {loading ? (
              <Spin tip="正在读取计划…">
                <div style={{ minHeight: 120 }} />
              </Spin>
            ) : loadError ? (
              <Alert
                type="error"
                showIcon
                message={hidden ? "计划暂时无法读取" : loadError}
                action={
                  <Button onClick={() => editing && void loadPlan(editing)}>
                    重试
                  </Button>
                }
              />
            ) : (
              <Form
                form={form}
                name={formId}
                initialValues={initial}
                clearOnDestroy
                layout="vertical"
                disabled={busy}
                onValuesChange={() => setDirty(true)}
                onFinish={save}
              >
                {error && (
                  <Alert
                    type="error"
                    showIcon
                    className="form-alert"
                    message={
                      hidden ? "保存未完成，请显示金额后查看详细原因。" : error
                    }
                  />
                )}
                <Fields
                  fields={[
                    ...fields
                      .filter(
                        (f) =>
                          ![
                            "name",
                            "kind",
                            "currency",
                            "status",
                            "account_id",
                          ].includes(f.name),
                      )
                      .map((f) =>
                        f.name === "amount"
                          ? { ...f, label: `每期金额（${currency}）` }
                          : f,
                      ),
                    {
                      name: "holiday_policy",
                      label: "遇到非开放日",
                      type: "select",
                      required: true,
                      options: [
                        { value: "skip", label: "跳过本期" },
                        { value: "next_open", label: "顺延至下个开放日" },
                      ],
                      help: "按该基金的申购日历处理，后续计划仍按原定日期执行。",
                    },
                  ]}
                />
                <DcaAutomationFields
                  accounts={accounts}
                  instruments={instruments}
                  useDefaults={!editing}
                />
                <Collapse
                  ghost
                  items={[
                    {
                      key: "more",
                      forceRender: true,
                      label: `计划名称 · ${currency} · 状态设置`,
                      children: (
                        <Fields
                          fields={fields.filter((f) =>
                            ["name", "kind", "currency", "status"].includes(
                              f.name,
                            ),
                          )}
                        />
                      ),
                    },
                  ]}
                />
              </Form>
            )}
          </div>
        </Modal>
      </Panel>
    </div>
  );
}
