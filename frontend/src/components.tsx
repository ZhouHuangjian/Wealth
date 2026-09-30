import { useEffect, useId, useRef, useState } from "react";
import type { AriaAttributes, ReactNode } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popover,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
} from "antd";
import {
  Plus,
  RefreshCw,
  Search,
  ArrowUpRight,
  FileSearch,
} from "lucide-react";
import type { ColumnsType } from "antd/es/table";
import {
  api,
  ApiError,
  currencyOptions,
  dateToday,
  kinds,
  listOf,
  send,
  states,
  transferLabel,
} from "./api";
import type { Item } from "./api";
import { useDebounced, useResource, useWorkspace } from "./state";
import { formatDecimal } from "./format";
import { HelpText, helpColumns } from "./help";
export function PageTitle({
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <h1>
          <HelpText text={title} />
          <span className="title-dot" />
        </h1>
        {description && <p>{description}</p>}
      </div>
      <Space wrap>{actions}</Space>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`paper-panel ${className}`}>
      {(title || action) && (
        <div className="panel-heading">
          <div>
            <h2>
              <HelpText text={title} />
            </h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Money({
  value,
  currency = "",
  sign = false,
  precision = 2,
}: {
  value: any;
  currency?: string;
  sign?: boolean;
  precision?: number;
}) {
  const { hidden } = useWorkspace();
  if (hidden)
    return (
      <span aria-label="金额已隐藏" className="money">
        ••••••
      </span>
    );
  if (value === null || value === undefined || value === "")
    return <span className="unknown">待补全</span>;
  const text = formatDecimal(value, sign, precision);
  if (text === null) return <span className="unknown">待补全</span>;
  const negative = text.startsWith("−");
  return (
    <span
      className={`money ${negative ? "negative" : ""}`}
      title={
        formatDecimal(value) !== text
          ? `原始数值：${formatDecimal(value)}`
          : undefined
      }
    >
      {currency && <small>{currency} </small>}
      {text}
    </span>
  );
}
export function Status({ value }: { value?: string }) {
  const s = value || "unknown";
  return (
    <Tag
      color={
        ["complete", "confirmed", "committed", "completed", "active"].includes(
          s,
        )
          ? "green"
          : ["partial", "pending", "stale", "due"].includes(s)
            ? "gold"
            : ["failed", "reversed"].includes(s)
              ? "red"
              : undefined
      }
    >
      <HelpText text={states[s] || s} />
    </Tag>
  );
}
export function LoadState({
  loading,
  error,
  retry,
  children,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="loading-state">
        <Spin />
        <span>正在读取当前空间…</span>
      </div>
    );
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message="暂时无法读取数据"
        description={error}
        action={<Button onClick={retry}>重试</Button>}
      />
    );
  return <>{children}</>;
}
export function Blank({
  title = "这里还没有记录",
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="blank-state">
      <div className="blank-icon">
        <FileSearch size={29} strokeWidth={1.3} />
      </div>
      <h3>{title}</h3>
      <p>{description || "暂无数据"}</p>
      {action}
    </div>
  );
}
export type Field = {
  name: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "number"
    | "date"
    | "datetime"
    | "select"
    | "switch"
    | "multi";
  required?: boolean;
  options?: { label: string; value: string }[];
  initial?: any;
  help?: string;
  span?: number;
  createOnly?: boolean;
  placeholder?: string;
  referenceKinds?: string[];
  referenceCurrency?: string;
  visibleWhen?: (values: Record<string, any>) => boolean;
};
export function Fields({ fields }: { fields: Field[] }) {
  const form = Form.useFormInstance();
  const values = Form.useWatch([], { form, preserve: true }) || {};
  return (
    <div className="form-grid">
      {fields
        .filter((f) => !f.visibleWhen || f.visibleWhen(values))
        .map((f) => (
          <Form.Item
            key={f.name}
            name={f.name}
            label={<HelpText text={f.label} />}
            preserve={false}
            tooltip={f.help}
            rules={
              f.required
                ? [{ required: true, message: `请填写${f.label}` }]
                : []
            }
            valuePropName={f.type === "switch" ? "checked" : "value"}
            className={f.span === 2 ? "field-full" : ""}
          >
            {(f.type === "select" || f.type === "multi") &&
            referenceResource(f.name) ? (
              <ForeignSelect field={f} />
            ) : f.type === "select" || f.type === "multi" ? (
              <Select
                mode={f.type === "multi" ? "multiple" : undefined}
                showSearch
                optionFilterProp="label"
                allowClear={!f.required}
                options={f.options}
                placeholder={f.placeholder || `选择${f.label}`}
              />
            ) : f.type === "number" ? (
              <InputNumber
                stringMode
                style={{ width: "100%" }}
                placeholder={f.placeholder || "请输入精确数值"}
              />
            ) : f.type === "date" ? (
              <Input type="date" />
            ) : f.type === "datetime" ? (
              <Input type="datetime-local" />
            ) : f.type === "textarea" ? (
              <Input.TextArea rows={4} placeholder={f.placeholder} />
            ) : f.type === "switch" ? (
              <Switch />
            ) : (
              <Input placeholder={f.placeholder} />
            )}
          </Form.Item>
        ))}
    </div>
  );
}
function referenceResource(name: string): string | undefined {
  return (
    {
      account_id: "accounts",
      target_account_id: "accounts",
      liability_account_id: "accounts",
      instrument_id: "instruments",
      instrument_ids: "instruments",
      primary_instrument_ids: "instruments",
      event_id: "events",
      related_event_id: "events",
      included_event_ids: "events",
      goal_id: "goals",
      scenario_id: "scenarios",
      reservation_id: "reservations",
    } as Record<string, string>
  )[name];
}
function ForeignSelect({
  field,
  value,
  onChange,
  ...accessibility
}: {
  field: Field;
  value?: any;
  onChange?: (value: any) => void;
  id?: string;
} & AriaAttributes) {
  const { space } = useWorkspace();
  const selectedAccount = Form.useWatch("account_id");
  const accountFilter =
    field.name === "included_event_ids" ? selectedAccount : undefined;
  const previousAccount = useRef(accountFilter);
  const [query, setQuery] = useState(""),
    [loaded, setLoaded] = useState<{ value: string; label: string }[] | null>(
      null,
    ),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const settled = useDebounced(query);
  useEffect(() => {
    if (previousAccount.current !== accountFilter) {
      if (previousAccount.current) onChange?.([]);
      previousAccount.current = accountFilter;
    }
  }, [accountFilter, onChange]);
  useEffect(() => {
    if (field.name === "included_event_ids" && !accountFilter) {
      setLoaded([]);
      return;
    }
    if (!settled && !accountFilter) {
      setLoaded(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      q: settled,
      limit: "60",
      ...(accountFilter ? { account_id: accountFilter } : {}),
      ...(field.referenceKinds?.length
        ? { kind: field.referenceKinds.join(",") }
        : {}),
      ...(field.referenceCurrency ? { currency: field.referenceCurrency } : {}),
    });
    api(`/spaces/${space.id}/${referenceResource(field.name)}?${params}`)
      .then((result) => {
        if (active)
          setLoaded(
            listOf<Item>(result)
              .filter(
                (r) =>
                  (!field.referenceKinds?.length ||
                    (field.referenceKinds.includes(r.kind) && !r.archived)) &&
                  (!field.referenceCurrency ||
                    r.currency === field.referenceCurrency) &&
                  (field.name !== "included_event_ids" || !r.reversed),
              )
              .map((r) => ({
                value: r.id,
                label: [
                  r.economic_date,
                  r.name ||
                    r.title ||
                    r.description ||
                    r.purpose ||
                    r.code ||
                    r.id,
                ]
                  .filter(Boolean)
                  .join(" · "),
              })),
          );
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [
    settled,
    space.id,
    field.name,
    field.referenceKinds?.join(","),
    field.referenceCurrency,
    accountFilter,
  ]);
  return (
    <Select
      {...accessibility}
      aria-label={accessibility["aria-label"] || field.label}
      mode={field.type === "multi" ? "multiple" : undefined}
      value={value}
      onChange={onChange}
      showSearch
      onSearch={setQuery}
      filterOption={false}
      allowClear={!field.required}
      loading={loading}
      disabled={field.name === "included_event_ids" && !accountFilter}
      options={loaded ?? field.options}
      placeholder={
        field.name === "included_event_ids" && !accountFilter
          ? "请先选择账户"
          : field.placeholder || `选择${field.label}，可搜索全部`
      }
      notFoundContent={
        error ? (
          <span className="negative">{error}</span>
        ) : loading ? (
          <Spin size="small" />
        ) : (
          "未找到记录，可输入名称搜索"
        )
      }
    />
  );
}
export function EntityManager({
  resource,
  title,
  description,
  fields,
  columns,
  extraActions,
  toolbarActions,
  allowEdit = true,
  filter,
  kindFilter,
  queryParams,
  loadEdit,
  editContent,
  prepareEditValues,
  children,
}: {
  resource: string;
  title: string;
  description?: string;
  fields?: Field[];
  columns: ColumnsType<Item>;
  extraActions?: (item: Item) => ReactNode;
  toolbarActions?: ReactNode;
  allowEdit?: boolean;
  filter?: (item: Item) => boolean;
  kindFilter?: string;
  queryParams?: Record<string, string>;
  loadEdit?: (item: Item) => Promise<Item>;
  editContent?: (item: Item) => ReactNode;
  prepareEditValues?: (
    values: Record<string, any>,
    item: Item,
  ) => Record<string, any>;
  children?: ReactNode;
}) {
  const { space, reload, hidden, showDetail, requestReveal } = useWorkspace();
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10);
  const [form] = Form.useForm();
  const formId = useId();
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Item | null>(null),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false),
    [editLoadError, setEditLoadError] = useState(""),
    [editAttempt, setEditAttempt] = useState(0);
  const editLoader = useRef(loadEdit);
  const saveLock = useRef(false);
  editLoader.current = loadEdit;
  useEffect(() => {
    if (!open || !editing || !editLoader.current) return;
    let active = true;
    setLoadingEdit(true);
    setEditLoadError("");
    void editLoader
      .current(editing)
      .then((item) => {
        if (active) setEditing(item);
      })
      .catch((e) => {
        if (active) setEditLoadError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoadingEdit(false);
      });
    return () => {
      active = false;
    };
  }, [open, editing?.id, editAttempt, space.id, resource]);
  const debouncedQuery = useDebounced(query);
  useEffect(() => setPage(1), [debouncedQuery, kindFilter]);
  const params = new URLSearchParams({
    offset: String((page - 1) * pageSize),
    limit: String(pageSize),
    q: debouncedQuery,
    ...(kindFilter ? { kind: kindFilter } : {}),
    ...queryParams,
  });
  const state = useResource(resource, `?${params}`);
  const serverPaged =
    typeof state.data?.count === "number" && state.data?.limit !== undefined;
  const canWrite = space.role !== "viewer";
  let rows = listOf<Item>(state.data);
  if (filter) rows = rows.filter(filter);
  if (!serverPaged && query)
    rows = rows.filter((r) =>
      [r.name, r.title, r.code, r.description, r.category, r.id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  function openForm(item?: Item) {
    requestReveal(() => {
      setEditing(item || null);
      setError("");
      setDirty(false);
      setEditLoadError("");
      setLoadingEdit(!!item && !!loadEdit);
      setOpen(true);
    });
  }
  async function save(values: any) {
    if (saveLock.current || loadingEdit || editLoadError) return;
    values = { ...values };
    for (const field of fields || []) {
      if (field.visibleWhen && !field.visibleWhen(values))
        delete values[field.name];
    }
    if (resource === "notes" && typeof values.tags === "string")
      values.tags = values.tags
        .split(/[,，]/)
        .map((s: string) => s.trim())
        .filter(Boolean);
    const act = async () => {
      saveLock.current = true;
      setBusy(true);
      setError("");
      try {
        const payload =
          editing && prepareEditValues
            ? prepareEditValues(values, editing)
            : { ...values };
        for (const field of fields || []) {
          if (field.type === "datetime" && payload[field.name]) {
            const observed = new Date(payload[field.name]);
            if (Number.isNaN(observed.getTime()))
              throw new Error(`请检查${field.label}`);
            payload[field.name] = observed.toISOString();
          }
        }
        if (
          resource === "snapshots" &&
          payload.includes_options !== undefined
        ) {
          payload.asset_kind = "future";
          payload.no_option_positions = payload.includes_options === "none";
          payload.includes_options = payload.includes_options === "yes";
        }
        await send(
          `/spaces/${space.id}/${resource}${editing ? `/${editing.id}` : ""}`,
          { ...payload, ...(editing ? { version: editing.version } : {}) },
          editing ? "PATCH" : "POST",
        );
        message.success("已保存到当前空间");
        setOpen(false);
        setDirty(false);
        reload();
      } catch (e) {
        setError(
          e instanceof ApiError && e.status === 412 && loadEdit
            ? `${e.message}。请关闭此窗口后重新编辑，以读取最新记录。`
            : (e as Error).message,
        );
      } finally {
        saveLock.current = false;
        setBusy(false);
      }
    };
    await act();
  }
  const finalColumns: ColumnsType<Item> = [
    ...columns.map((column) =>
      hidden &&
      "dataIndex" in column &&
      [
        "description",
        "reason",
        "body",
        "summary",
        "purpose",
        "memo",
        "tags",
      ].includes(String(column.dataIndex))
        ? { ...column, render: () => "内容已隐藏" }
        : column,
    ),
    {
      title: "操作",
      key: "action",
      fixed: "right",
      width: 130,
      render: (_, item) => (
        <Space size={8}>
          {fields && canWrite && allowEdit ? (
            <Button size="small" type="link" onClick={() => openForm(item)}>
              编辑
            </Button>
          ) : (
            <Button size="small" type="link" onClick={() => showDetail(item)}>
              详情
            </Button>
          )}
          {extraActions?.(item)}
        </Space>
      ),
    },
  ];
  return (
    <Panel
      title={title}
      subtitle={description}
      action={
        <Space>
          <Button
            aria-label={`刷新${title}`}
            icon={<RefreshCw size={14} />}
            onClick={() => state.retry()}
          />
          {fields && canWrite && (
            <Button
              type="primary"
              icon={<Plus size={15} />}
              onClick={() => openForm()}
            >
              新增{title.replace("列表", "")}
            </Button>
          )}
        </Space>
      }
    >
      {children}
      <div className="table-toolbar">
        <Input
          prefix={<Search size={15} />}
          placeholder={`搜索${title}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
          style={{ maxWidth: 300 }}
        />
        {toolbarActions}
      </div>
      <LoadState {...state}>
        <Table
          rowKey="id"
          size="middle"
          columns={helpColumns(finalColumns)}
          dataSource={rows}
          scroll={{ x: "max-content" }}
          pagination={{
            current: page,
            pageSize,
            total: serverPaged ? state.data.count : rows.length,
            onChange: (next, size) => {
              setPage(next);
              setPageSize(size);
            },
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
          }}
          locale={{
            emptyText: (
              <Blank title={`尚未添加${title}`} description="暂无记录" />
            ),
          }}
        />
      </LoadState>
      <Modal
        open={open}
        title={`${editing ? "编辑" : "新增"}${title}`}
        onCancel={() => {
          if (busy) return;
          if (!dirty) {
            setOpen(false);
            return;
          }
          modal.confirm({
            title: "放弃尚未保存的修改？",
            okText: "放弃修改",
            cancelText: "继续编辑",
            onOk: () => {
              setOpen(false);
              setDirty(false);
            },
          });
        }}
        onOk={() => form.submit()}
        okButtonProps={{ disabled: loadingEdit || !!editLoadError }}
        cancelButtonProps={{ disabled: busy }}
        maskClosable={!busy}
        keyboard={!busy}
        closable={!busy}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        width={640}
        destroyOnHidden
      >
        <div data-dirty={dirty}>
          {loadingEdit ? (
            <Spin tip="正在读取账户与期初记录…">
              <div style={{ minHeight: 100 }} />
            </Spin>
          ) : editLoadError ? (
            <Alert
              type="error"
              showIcon
              message={editLoadError}
              action={
                <Button onClick={() => setEditAttempt((value) => value + 1)}>
                  重新读取
                </Button>
              }
            />
          ) : (
            <Form
              form={form}
              name={formId}
              clearOnDestroy
              initialValues={
                editing
                  ? {
                      ...(resource === "instruments"
                        ? editing.specification
                        : {}),
                      ...editing,
                      tags: Array.isArray(editing.tags)
                        ? editing.tags.join(", ")
                        : editing.tags,
                    }
                  : Object.fromEntries(
                      (fields || [])
                        .filter((f) => f.initial !== undefined)
                        .map((f) => [f.name, f.initial]),
                    )
              }
              layout="vertical"
              disabled={busy}
              onValuesChange={() => setDirty(true)}
              onFinish={save}
            >
              {error && (
                <Alert
                  className="form-alert"
                  type="error"
                  showIcon
                  message={error}
                />
              )}
              <Fields
                fields={(fields || []).filter((f) => !editing || !f.createOnly)}
              />
              {editing && editContent?.(editing)}
            </Form>
          )}
        </div>
      </Modal>
    </Panel>
  );
}
export function DetailDrawer({
  item,
  onClose,
}: {
  item: Item | null;
  onClose: () => void;
}) {
  const { hidden, space, reload } = useWorkspace();
  const { modal, message } = App.useApp();
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [item?.id]);
  const label: Record<string, string> = {
    id: "记录 ID",
    name: "名称",
    title: "标题",
    kind: "业务类型",
    amount: "金额",
    currency: "币种",
    economic_date: "经济归属日",
    created_at: "创建时间",
    updated_at: "更新时间",
    description: "说明",
    status: "状态",
    account_id: "账户 ID",
    instrument_id: "资产 ID",
    source: "来源",
    data_revision: "数据修订",
    version: "版本",
    fee: "费用",
    tax: "税费",
    quantity: "份额",
    price: "价格",
    principal: "本金",
    interest: "利息",
    category: "分类",
    body: "正文",
    related_event_id: "关联事项 ID",
    postings: "账务分录",
    evidence: "来源证据",
    reversed_by: "冲正事项",
  };
  return (
    <Drawer title="记录详情与来源" open={!!item} onClose={onClose} width={560}>
      {item &&
        (hidden ? (
          <Alert
            showIcon
            message="金额已遮挡"
            description="取消金额遮挡后，可查看完整详情与来源。"
          />
        ) : (
          <>
            <div className="detail-id">{item.id}</div>
            {item.economic_date && item.kind && kinds[item.kind] && (
              <Popover
                trigger="click"
                content="正式记账事项保留原始分录，不能覆盖修改。需要更正时请冲正后重新记录，原记录和更正关系会保留。"
              >
                <Button type="link" size="small">
                  为什么这笔记录不能直接编辑？
                </Button>
              </Popover>
            )}
            <Descriptions
              column={1}
              bordered
              size="small"
              items={Object.entries(item)
                .filter(([k]) => !["tenant_id", "space_id"].includes(k))
                .map(([key, value]) => ({
                  key,
                  label: label[key] || key,
                  children:
                    typeof value === "object" ? (
                      <pre className="detail-json">
                        {JSON.stringify(value, null, 2)}
                      </pre>
                    ) : (
                      String(value ?? "未知")
                    ),
                }))}
            />
            {item.economic_date &&
              item.kind &&
              kinds[item.kind] &&
              space.role !== "viewer" &&
              item.status !== "reversed" &&
              !item.reversed && (
                <div className="reverse-box">
                  <h3>冲正这条事项</h3>
                  <p>
                    保留原始记录与冲正链，恢复其账务影响；相关核对需重新检查。
                  </p>
                  <Input.TextArea
                    aria-label="冲正理由"
                    placeholder="请填写冲正理由"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    danger
                    disabled={!reason.trim()}
                    onClick={() =>
                      modal.confirm({
                        title: "确认冲正事项？",
                        content: `${kinds[item.kind]}：${item.description || item.id}。冲正不会删除原证据。`,
                        okText: "确认冲正",
                        cancelText: "取消",
                        onOk: async () => {
                          try {
                            await send(
                              `/spaces/${space.id}/events/${item.id}/reverse`,
                              { reason },
                            );
                            message.success("已冲正");
                            reload();
                            onClose();
                          } catch (e) {
                            message.error((e as Error).message);
                            throw e;
                          }
                        },
                      })
                    }
                  >
                    查看影响并确认冲正
                  </Button>
                </div>
              )}
          </>
        ))}
    </Drawer>
  );
}
export function EventModal({
  open,
  onClose,
  preset,
}: {
  open: boolean;
  onClose: () => void;
  preset?: Item;
}) {
  const { space, reload, hidden } = useWorkspace();
  const accounts = useResource("accounts"),
    instruments = useResource("instruments"),
    events = useResource("events");
  const defaults = useResource("entry-defaults");
  const [form] = Form.useForm();
  const kind = Form.useWatch("kind", form) || "expense";
  const sourceAccount = Form.useWatch("account_id", form),
    targetAccount = Form.useWatch("target_account_id", form);
  const transferName = transferLabel(
    listOf<Item>(accounts.data).find((a) => a.id === sourceAccount),
    listOf<Item>(accounts.data).find((a) => a.id === targetAccount),
  );
  const { modal, message } = App.useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const draftKey = `wealth:draft:${space.id}:event`;
  const saveLock = useRef(false);
  const accountOptions = listOf<Item>(accounts.data).map((a) => ({
    label: `${a.name} · ${a.currency}`,
    value: a.id,
  }));
  const instrumentOptions = listOf<Item>(instruments.data).map((a) => ({
    label: `${a.name} · ${a.code}`,
    value: a.id,
  }));
  useEffect(() => {
    if (open) {
      let draft = {};
      try {
        draft = preset
          ? {}
          : JSON.parse(sessionStorage.getItem(draftKey) || "{}");
      } catch {}
      form.resetFields();
      form.setFieldsValue({
        kind: "expense",
        currency: space.base_currency,
        economic_date: dateToday(),
        ...draft,
        ...preset,
      });
      setDirty(false);
      setError("");
    }
  }, [open, space.id, preset]);
  useEffect(() => {
    if (kind === "opening") form.setFieldValue("amount", "0");
  }, [kind, form]);
  useEffect(() => {
    if (!open || preset || !defaults.data?.[kind]) return;
    const saved = defaults.data[kind];
    for (const key of ["account_id", "category", "currency"]) {
      if (
        !form.isFieldTouched(key) &&
        (!form.getFieldValue(key) || key === "currency")
      ) {
        if (
          key !== "account_id" ||
          listOf<Item>(accounts.data).some(
            (a) => a.id === saved[key] && !a.archived,
          )
        )
          form.setFieldValue(key, saved[key]);
      }
    }
  }, [open, kind, defaults.data, accounts.data]);
  useEffect(() => {
    const account = listOf<Item>(accounts.data).find(
      (a) => a.id === sourceAccount,
    );
    if (account && ["expense", "income", "transfer"].includes(kind))
      form.setFieldValue("currency", account.currency);
  }, [sourceAccount, kind, accounts.data]);
  const computedAmountKinds = [
    "buy",
    "sell",
    "fund_confirm",
    "fund_redeem",
    "reinvest",
    "settlement",
  ];
  const fields: Field[] = [
    {
      name: "kind",
      label: "业务类型",
      type: "select",
      required: true,
      options: Object.entries(kinds)
        .filter(([value]) => value !== "fund_funding")
        .map(([value, label]) => ({
          value,
          label,
        })),
    },
    {
      name: "economic_date",
      label: ["expense", "income"].includes(kind) ? "日期" : "实际经济日期",
      type: "date",
      required: true,
    },
    {
      name: "account_id",
      label:
        kind === "expense"
          ? "付款账户"
          : kind === "income"
            ? "收款账户"
            : kind === "transfer"
              ? "转出账户"
              : "资金 / 持仓账户",
      type: "select",
      required: true,
      options: accountOptions,
    },
    {
      name: "currency",
      label: "原始币种",
      type: "select",
      required: true,
      options: currencyOptions,
    },
    ...([
      "transfer",
      "fx",
      "position_transfer",
      "property_purchase",
      "fund_confirm",
      "repayment",
      "repayment_allocate",
    ].includes(kind)
      ? [
          {
            name: "target_account_id",
            label:
              kind === "property_purchase"
                ? "房产资产账户"
                : ["repayment", "repayment_allocate"].includes(kind)
                  ? "负债账户"
                  : kind === "fund_confirm"
                    ? "确认至持仓账户（可选）"
                    : kind === "transfer"
                      ? "转入账户"
                      : "目标账户",
            type: "select" as const,
            required: kind !== "fund_confirm",
            options: accountOptions,
          },
        ]
      : []),
    {
      name: "amount",
      label: computedAmountKinds.includes(kind)
        ? "合计金额（可选核对值）"
        : kind === "opening"
          ? "现金金额（期初持仓填 0）"
          : "实际金额",
      type: "number",
      required: ![
        "split",
        "position_transfer",
        ...computedAmountKinds,
      ].includes(kind),
      help:
        kind === "opening"
          ? "本入口补录已有持仓；现金期初通过新增账户建立，固定填写 0，不重复增加现金。"
          : computedAmountKinds.includes(kind)
            ? "可留空，由后端按份额、价格、费用或剩余交收金额计算；填写时需与合计一致。"
            : undefined,
    },
    ...([
      "opening",
      "buy",
      "sell",
      "fund_confirm",
      "fund_redeem",
      "dividend",
      "reinvest",
      "split",
      "position_transfer",
    ].includes(kind)
      ? [
          {
            name: "instrument_id",
            label: "基金 / 证券 / 合约",
            type: "select" as const,
            required: true,
            options: instrumentOptions,
          },
          {
            name: "quantity",
            label: "实际确认份额 / 数量",
            type: "number" as const,
            required: !["dividend", "split"].includes(kind),
          },
          {
            name: "price",
            label: "实际确认 / 成交价格",
            type: "number" as const,
            required: [
              "buy",
              "sell",
              "fund_confirm",
              "fund_redeem",
              "reinvest",
            ].includes(kind),
          },
        ]
      : []),
    ...(kind === "fund_debit"
      ? [
          {
            name: "instrument_id",
            label: "申购基金",
            type: "select" as const,
            options: instrumentOptions,
            required: true,
          },
        ]
      : []),
    ...(kind === "opening"
      ? [
          {
            name: "cost",
            label: "取得成本（未知留空）",
            type: "number" as const,
            help: "填含买入相关费用的管理取得成本；未知不填 0。",
          },
        ]
      : []),
    ...(["fx"].includes(kind)
      ? [
          {
            name: "received_amount",
            label: "实际获得金额",
            type: "number" as const,
            required: true,
          },
          {
            name: "target_currency",
            label: "获得币种",
            type: "select" as const,
            required: true,
            options: currencyOptions,
          },
        ]
      : []),
    ...(["repayment", "repayment_allocate"].includes(kind)
      ? [
          {
            name: "principal",
            label: "本金部分（未知则留空）",
            type: "number" as const,
          },
          {
            name: "interest",
            label: "利息部分（未知则留空）",
            type: "number" as const,
          },
        ]
      : []),
    ...([
      "fund_confirm",
      "fund_refund",
      "settlement",
      "refund",
      "repayment_allocate",
    ].includes(kind)
      ? [
          {
            name: "related_event_id",
            label: "关联已记录事项",
            required: true,
            type: "select" as const,
            options: listOf<Item>(events.data).map((e) => ({
              label: `${e.economic_date} ${kinds[e.kind] || e.kind} ${e.description || e.id.slice(0, 8)}`,
              value: e.id,
            })),
            help: "用于在途结转、实际到账、退款或补充拆分；资金只记一次。",
          },
        ]
      : []),
    ...(kind === "split"
      ? [
          {
            name: "ratio",
            label: "拆分倍数",
            type: "number" as const,
            required: true,
            help: "例如 1 拆 2 填 2；只调整份额，不改变管理成本。",
          },
        ]
      : []),
    ...(kind === "property_purchase"
      ? [
          {
            name: "liability_account_id",
            label: "贷款负债账户",
            type: "select" as const,
            required: true,
            options: accountOptions,
          },
          {
            name: "loan_amount",
            label: "贷款实际直付金额",
            type: "number" as const,
            required: true,
          },
        ]
      : []),
    ...(![
      "expense",
      "income",
      "refund",
      "split",
      "fund_debit",
      "fund_refund",
      "settlement",
    ].includes(kind)
      ? [
          { name: "fee", label: "独立列示手续费", type: "number" as const },
          { name: "tax", label: "税费 / 预扣税", type: "number" as const },
        ]
      : []),
    { name: "category", label: "分类", placeholder: "例如餐饮、工资、交通" },
    {
      name: "description",
      label: "备注 / 凭证说明（选填）",
      type: "textarea",
      span: 2,
      placeholder: "可填写备注或凭证信息，也可留空",
    },
  ];
  async function submit(input: any) {
    if (saveLock.current) return;
    const fieldNames = new Set(fields.map((f) => f.name));
    const values: Record<string, any> = Object.fromEntries(
      Object.entries(input).filter(([key]) => fieldNames.has(key)),
    );
    if (values.kind === "opening") {
      values.amount = "0";
      delete values.price;
      delete values.fee;
      delete values.tax;
    }
    async function persist() {
      if (saveLock.current) return;
      saveLock.current = true;
      setBusy(true);
      setError("");
      try {
        const clean = Object.fromEntries(
          Object.entries(values).filter(([, v]) => v !== undefined && v !== ""),
        );
        if (preset?.occurrence_id) clean.occurrence_id = preset.occurrence_id;
        const result = await send(
          `/spaces/${space.id}/${preset?._editing_event_id ? `events/${preset._editing_event_id}/correct` : values.kind === "fund_confirm" ? "investment-trades/confirm" : "events"}`,
          preset?._editing_event_id
            ? { reason: "用户修改交易记录", replacement: clean }
            : clean,
        );
        sessionStorage.removeItem(draftKey);
        setDirty(false);
        onClose();
        reload();
        message.success({
          duration: 8,
          content: (
            <Space>
              已保存
              {["expense", "income", "transfer"].includes(values.kind) &&
                !preset?._editing_event_id && (
                  <Button
                    type="link"
                    size="small"
                    onClick={async () => {
                      try {
                        await send(
                          `/spaces/${space.id}/events/${result.id}/reverse`,
                          { reason: "保存后撤销" },
                        );
                        reload();
                        message.success("已撤销，原记录保留");
                      } catch (e) {
                        message.error((e as Error).message);
                      }
                    }}
                  >
                    撤销
                  </Button>
                )}
            </Space>
          ),
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        saveLock.current = false;
        setBusy(false);
      }
    }
    if (["expense", "income", "transfer", "refund"].includes(values.kind)) {
      await persist();
      return;
    }
    modal.confirm({
      title: "核对这笔真实事项",
      content: (
        <div className="impact-preview">
          <p>
            {values.kind === "transfer" ? transferName : kinds[values.kind]} ·{" "}
            {values.economic_date}
          </p>
          <p>
            {accountOptions.find((a) => a.value === values.account_id)?.label}
          </p>
          <strong>
            {hidden
              ? "金额已遮挡"
              : `${values.currency} ${values.amount ? formatDecimal(values.amount, false, 2) : "按份额记录"}`}
          </strong>
          <p>
            保存后更新当前空间账目。预计扣款或未来计划请到「财富规划」记录。
          </p>
        </div>
      ),
      okText: "确认入账",
      cancelText: "返回核对",
      onOk: persist,
    });
  }
  return (
    <Modal
      title="记一笔"
      forceRender
      open={open}
      onCancel={() => {
        if (dirty)
          modal.confirm({
            title: "保留本空间草稿并关闭？",
            content: "草稿仅保存在当前浏览器会话，切换空间后不会带入其他账簿。",
            okText: "保留并关闭",
            cancelText: "继续编辑",
            onOk: onClose,
          });
        else onClose();
      }}
      width={740}
      okText="保存"
      cancelText="稍后继续"
      confirmLoading={busy}
      onOk={() => form.submit()}
    >
      <div data-dirty={dirty}>
        {!["expense", "income"].includes(kind) && (
          <Alert
            className="form-alert"
            type="info"
            showIcon
            message={
              kind === "transfer"
                ? `${transferName} · 只记录资金划转，不计收入或消费。`
                : "记录已发生的收支，不会发起银行或投资交易。"
            }
          />
        )}
        {error && (
          <Alert className="form-alert" type="error" showIcon message={error} />
        )}
        <Form
          form={form}
          name={`event-${space.id}`}
          layout="vertical"
          onValuesChange={(_, all) => {
            setDirty(true);
            sessionStorage.setItem(draftKey, JSON.stringify(all));
          }}
          onFinish={submit}
        >
          <Fields
            fields={fields.filter(
              (f) =>
                (kind !== "opening" ||
                  !["price", "fee", "tax"].includes(f.name)) &&
                (!["expense", "income"].includes(kind) ||
                  !["description", "currency"].includes(f.name)),
            )}
          />
          {["expense", "income"].includes(kind) && (
            <Collapse
              ghost
              items={[
                {
                  key: "more",
                  forceRender: true,
                  label: "备注与币种（选填）",
                  children: (
                    <Fields
                      fields={fields.filter((f) =>
                        ["description", "currency"].includes(f.name),
                      )}
                    />
                  ),
                },
              ]}
            />
          )}
        </Form>
      </div>
    </Modal>
  );
}
export function ResourceTable({
  resource,
  columns,
  title,
  description,
}: {
  resource: string;
  columns: ColumnsType<Item>;
  title: string;
  description?: string;
}) {
  return (
    <EntityManager
      resource={resource}
      title={title}
      description={description}
      columns={helpColumns(columns)}
      allowEdit={false}
    />
  );
}
export function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={14} />
    </button>
  );
}
