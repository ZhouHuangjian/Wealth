import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
} from "antd";
import {
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api, listOf, send } from "../api";
import type { Item } from "../api";
import { LoadState, Money, PageTitle } from "../components";
import { HelpText } from "../help";
import { useDebounced, useResource, useWorkspace } from "../state";
import {
  collectionDefaults,
  editableValues,
  fieldOptions,
  labels,
  numeric,
  references,
  optionalFields,
  fieldLabel,
  systemFields,
} from "../adminData";

import { WorkspaceIdentity } from "./WorkspaceIdentity";

type EditorProps = {
  field: string;
  category: string;
  value?: any;
  onChange?: (value: any) => void;
  id?: string;
  disabled?: boolean;
};

function ReferenceInput({ field, value, onChange, id }: EditorProps) {
  const { space } = useWorkspace();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Item[]>([]);
  const settled = useDebounced(query);
  const state = useResource(
    references[field],
    `?q=${encodeURIComponent(settled)}&limit=60`,
  );
  useEffect(() => {
    let active = true;
    const ids = (Array.isArray(value) ? value : [value]).filter(Boolean);
    Promise.allSettled(
      ids.map((id) => api(`/spaces/${space.id}/${references[field]}/${id}`)),
    ).then((results) => {
      if (active)
        setSelected(
          results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
        );
    });
    return () => {
      active = false;
    };
  }, [space.id, field, JSON.stringify(value)]);
  const rows = new Map(
    [...selected, ...listOf<Item>(state.data)].map((r) => [String(r.id), r]),
  );
  return (
    <Select
      id={id}
      aria-label={labels[field]}
      value={value || undefined}
      onChange={onChange}
      mode={field.endsWith("_ids") ? "multiple" : undefined}
      showSearch
      filterOption={false}
      onSearch={setQuery}
      allowClear
      loading={state.loading}
      placeholder="选择或搜索"
      options={Array.from(rows.values()).map((r) => ({
        value: String(r.id),
        label: [
          r.name || r.title || r.description || "交易事项",
          r.code || r.economic_date,
        ]
          .filter(Boolean)
          .join(" · "),
      }))}
      notFoundContent={state.error || "没有匹配记录"}
    />
  );
}

function ValueInput(props: EditorProps) {
  const { field, category, value, onChange, id, disabled } = props;
  const options = fieldOptions(category, field);
  if (references[field]) return <ReferenceInput {...props} />;
  if (field === "includes_options")
    return (
      <Select
        id={id}
        value={value === null ? "unknown" : String(value)}
        onChange={(v) => onChange?.(v === "unknown" ? null : v === "true")}
        options={[
          { value: "unknown", label: "尚未核对" },
          { value: "true", label: "已包含期权" },
          { value: "false", label: "未包含期权" },
        ]}
      />
    );
  if (typeof value === "boolean")
    return <Switch id={id} checked={value} onChange={onChange} />;
  if (Array.isArray(value)) {
    if (!collectionDefaults[field] && !value.some((v) => typeof v === "object"))
      return (
        <Select
          id={id}
          mode="tags"
          value={value}
          onChange={onChange}
          tokenSeparators={[",", "，"]}
          placeholder="输入后按回车添加"
        />
      );
    return (
      <div className="admin-value-list" id={id}>
        {value.map((row, index) => (
          <div className="admin-value-entry" key={index}>
            <div className="admin-value-entry-heading">
              <span>第 {index + 1} 项</span>
              <Tooltip title="删除此项">
                <Button
                  type="text"
                  danger
                  aria-label={`删除第 ${index + 1} 项`}
                  icon={<Trash2 size={15} />}
                  onClick={() =>
                    onChange?.(value.filter((_: any, i: number) => i !== index))
                  }
                />
              </Tooltip>
            </div>
            <ValueInput
              category={category}
              field={`${field}_item`}
              value={row}
              onChange={(next) =>
                onChange?.(
                  value.map((v: any, i: number) => (i === index ? next : v)),
                )
              }
            />
          </div>
        ))}
        <Button
          onClick={() =>
            onChange?.([
              ...value,
              structuredClone(collectionDefaults[field] || value[0] || {}),
            ])
          }
          icon={<Plus size={14} />}
        >
          添加一项
        </Button>
      </div>
    );
  }
  if (value && typeof value === "object") {
    const known = Object.entries(value).filter(
      ([key]) => !key.startsWith("_") && !systemFields.has(key),
    );
    return (
      <div className="admin-nested-grid">
        {known.map(([key, v]) => (
          <div
            key={key}
            className={
              Array.isArray(v) || (v && typeof v === "object")
                ? "field-full"
                : ""
            }
          >
            <label>
              <HelpText text={fieldLabel(key)} />
            </label>
            <ValueInput
              category={category}
              field={key}
              value={v}
              onChange={(next) => onChange?.({ ...value, [key]: next })}
            />
          </div>
        ))}
      </div>
    );
  }
  if (options)
    return (
      <Select
        id={id}
        value={value || undefined}
        onChange={onChange}
        options={Object.entries(options).map(([value, label]) => ({
          value,
          label,
        }))}
      />
    );
  if (field.endsWith("_date") || ["date", "as_of", "expiry"].includes(field))
    return (
      <Input
        id={id}
        type="date"
        disabled={disabled}
        value={value || ""}
        onChange={(e) => onChange?.(e.target.value)}
      />
    );
  if (["published_at", "valuation_observed_at"].includes(field))
    return (
      <Input
        id={id}
        type="datetime-local"
        value={String(value || "").slice(0, 16)}
        onChange={(e) => onChange?.(e.target.value)}
      />
    );
  if (numeric.has(field))
    return (
      <InputNumber
        id={id}
        stringMode={typeof value !== "number"}
        value={value === "" ? null : value}
        onChange={onChange}
        style={{ width: "100%" }}
      />
    );
  if (["body", "description", "coverage", "note"].includes(field))
    return (
      <Input.TextArea
        id={id}
        value={value || ""}
        onChange={(e) => onChange?.(e.target.value)}
        autoSize={{ minRows: 2, maxRows: 6 }}
      />
    );
  return (
    <Input
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

export default function AdminDataManagement() {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const { message, modal } = App.useApp();
  const metadata = useResource("administration");
  const [category, setCategory] = useState("accounts");
  const [status, setStatus] = useState("active");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const settled = useDebounced(query);
  const state = useResource(
    `administration/${category}`,
    `?status=${status}&q=${encodeURIComponent(settled)}&offset=${(page - 1) * 20}&limit=20`,
  );
  const [selection, setSelection] = useState<Item | null>(null);
  const [action, setAction] = useState<
    "edit" | "delete" | "restore" | "purge" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [form] = Form.useForm();
  const info = metadata.data?.categories?.find((v: Item) => v.key === category);
  const values = Form.useWatch("values", { form, preserve: true }) || {};
  useEffect(() => setPage(1), [category, status, settled]);
  const close = () => {
    if (busy) return;
    if (dirty)
      modal.confirm({
        title: "放弃未保存的修改？",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: () => {
          setAction(null);
          setDirty(false);
        },
      });
    else setAction(null);
  };
  async function open(
    row: Item | null,
    next: "edit" | "delete" | "restore" | "purge",
    targetCategory = category,
  ) {
    setBusy(true);
    setError("");
    try {
      const detail = row
        ? await api(
            `/spaces/${space.id}/administration/${targetCategory}/${row.id}${next === "purge" ? "/purge-preview" : ""}`,
          )
        : await api(`/spaces/${space.id}/administration`);
      setSelection(detail);
      setCategory(targetCategory);
      form.resetFields();
      form.setFieldsValue({
        values: editableValues(
          row
            ? detail.item.values
            : detail.categories.find((c: Item) => c.key === targetCategory)
                .defaults,
        ),
        reason:
          next === "edit"
            ? row
              ? "核对后更正"
              : "帮助录入"
            : next === "delete"
              ? "清理不再使用的记录"
              : next === "purge"
                ? "清理已删除记录"
                : "恢复误删记录",
        include_related: false,
      });
      setAction(next);
      setDirty(false);
      setExpanded([]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    let data;
    try {
      data = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const item = selection?.item;
      const path = `/spaces/${space.id}/administration/${category}${item ? `/${item.id}` : ""}${["restore", "purge"].includes(action || "") ? `/${action}` : ""}`;
      await send(
        path,
        {
          expected_revision: selection?.data_revision,
          version: item?.version,
          reason: data.reason,
          ...(action === "purge"
            ? {
                confirm: data.confirm === true,
                confirm_name: data.confirm_name,
                preview_token: selection?.preview_token,
              }
            : {}),
          ...(action === "edit"
            ? { values: { ...(item?.values || {}), ...data.values } }
            : action === "delete"
              ? {
                  confirm: true,
                  include_related: data.include_related === true,
                }
              : {}),
        },
        action === "delete"
          ? "DELETE"
          : action === "edit" && item
            ? "PATCH"
            : "POST",
      );
      message.success(
        action === "purge"
          ? "已彻底删除关联记录"
          : action === "delete"
            ? "已移除，统计已更新"
            : action === "restore"
              ? "已恢复"
              : "已保存",
      );
      setAction(null);
      setDirty(false);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const mainKeys = selection?.item?.holding_correction?.eligible
    ? [
        "account_id",
        "instrument_id",
        "quantity",
        "cost",
        "current_value",
        "as_of",
        "purchase_date",
        "funding_mode",
        "funding_account_id",
      ]
    : Object.keys(info?.defaults || {});
  const additionalKeys =
    category === "accounts" && !selection?.item && values.kind === "futures"
      ? [
          "opening_coverage",
          "opening_coverage_confirmed",
          "opening_option_scope",
        ]
      : category === "events"
        ? ["buy", "sell", "fund_confirm", "fund_redeem", "reinvest"].includes(
            values.kind,
          )
          ? [
              "instrument_id",
              "quantity",
              "price",
              "fee",
              ...(values.kind.startsWith("fund_") ? ["related_event_id"] : []),
            ]
          : ["transfer", "fx"].includes(values.kind)
            ? ["target_account_id"]
            : ["fund_refund", "settlement", "refund"].includes(values.kind)
              ? ["related_event_id"]
              : []
        : [];
  mainKeys.push(...additionalKeys.filter((k) => !mainKeys.includes(k)));
  useEffect(() => {
    if (action !== "edit") return;
    const next = { ...values };
    let changed = false;
    for (const key of additionalKeys)
      if (!(key in next)) {
        next[key] = structuredClone(optionalFields[category]?.[key] ?? "");
        changed = true;
      }
    if (changed) form.setFieldValue("values", next);
  }, [category, values.kind, action, selection?.item?.id]);
  const fields = (keys: string[]) => (
    <div className="form-grid">
      {keys
        .filter((k) => !systemFields.has(k))
        .map((key) => (
          <Form.Item
            key={key}
            name={["values", key]}
            label={<HelpText text={fieldLabel(key)} />}
            help={
              key === "opening_date" &&
              selection?.opening &&
              !selection.opening.editable
                ? selection.opening.reason
                : undefined
            }
            className={
              Array.isArray(values[key]) ||
              (values[key] && typeof values[key] === "object") ||
              ["body", "description", "coverage"].includes(key)
                ? "field-full"
                : ""
            }
            rules={
              ["name", "title"].includes(key)
                ? [{ required: true, message: `请填写${labels[key]}` }]
                : undefined
            }
          >
            <ValueInput
              category={category}
              field={key}
              disabled={
                key === "opening_date" &&
                selection?.opening &&
                !selection.opening.editable
              }
            />
          </Form.Item>
        ))}
    </div>
  );
  const extraKeys = Object.keys(values).filter((k) => !mainKeys.includes(k));
  const canDirectEdit =
    !selection?.item?.holding_correction ||
    selection.item.holding_correction.eligible;
  if (!space.administration)
    return <Alert type="error" message="仅管理员代管时可使用此页面" />;
  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION"
        title="代管数据管理"
        actions={
          <Button
            type="primary"
            icon={<Plus size={16} />}
            onClick={() => requestReveal(() => void open(null, "edit"))}
          >
            新增{info?.label || "记录"}
          </Button>
        }
      />
      <div className="admin-data-context">
        <ShieldCheck size={16} />
        <span>{space.name}</span>
        <span className="muted">更改会记录管理员身份</span>
      </div>
      <WorkspaceIdentity />
      <div className="panel admin-data-panel">
        <div className="admin-data-toolbar">
          <Select
            aria-label="管理内容"
            showSearch
            optionFilterProp="label"
            value={category}
            className="admin-category-select"
            onChange={setCategory}
            options={(metadata.data?.categories || []).map((c: Item) => ({
              value: c.key,
              label: c.label,
            }))}
          />
          <Select
            aria-label="记录状态"
            value={status}
            onChange={setStatus}
            options={[
              { value: "active", label: "使用中" },
              { value: "deleted", label: "已删除 / 已撤销" },
              { value: "all", label: "全部记录" },
            ]}
          />
          <Input.Search
            placeholder="搜索名称或备注"
            aria-label="搜索管理记录"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            allowClear
          />
          <Tooltip title="刷新">
            <Button
              aria-label="刷新管理记录"
              icon={<RefreshCw size={16} />}
              onClick={reload}
            />
          </Tooltip>
        </div>
        <LoadState
          loading={state.loading || metadata.loading}
          error={state.error || metadata.error}
          retry={() => {
            state.retry();
            metadata.retry();
          }}
        >
          <Table
            rowKey="id"
            size="middle"
            dataSource={listOf<Item>(state.data)}
            scroll={{ x: 760 }}
            pagination={{
              current: page,
              pageSize: 20,
              total: state.data?.count || 0,
              showSizeChanger: false,
              onChange: setPage,
              showTotal: (n) => `共 ${n} 条`,
            }}
            columns={[
              {
                title: "记录",
                key: "name",
                width: 280,
                render: (_, r) => (
                  <div className="admin-record-name">
                    <strong>{hidden ? "••••••" : r.name}</strong>
                    <small>
                      {[r.values.code, r.date].filter(Boolean).join(" · ")}
                    </small>
                  </div>
                ),
              },
              {
                title: "金额 / 数值",
                key: "amount",
                width: 190,
                render: (_, r) => {
                  const v = r.values;
                  const amount =
                    v.amount ??
                    v.equity ??
                    v.value ??
                    v.rate ??
                    v.current_value ??
                    v.principal;
                  return amount !== undefined ? (
                    <Money value={amount} currency={v.currency || undefined} />
                  ) : (
                    "—"
                  );
                },
              },
              {
                title: "状态",
                key: "status",
                width: 130,
                render: (_, r) => (
                  <Tag color={r.deleted ? undefined : "green"}>
                    {r.deleted
                      ? category === "events"
                        ? "已撤销"
                        : "已移除"
                      : "使用中"}
                  </Tag>
                ),
              },
              {
                title: "操作",
                key: "actions",
                width: 145,
                fixed: "right",
                render: (_, r) => (
                  <Space size={2}>
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        requestReveal(
                          () => void open(r, r.deleted ? "restore" : "edit"),
                        )
                      }
                      disabled={r.deleted && r.can_restore === false}
                    >
                      {r.deleted ? "恢复" : "编辑"}
                    </Button>
                    {
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: r.deleted
                            ? [
                                {
                                  key: "purge",
                                  danger: true,
                                  label: "彻底删除",
                                  onClick: () =>
                                    requestReveal(() => void open(r, "purge")),
                                },
                              ]
                            : [
                                {
                                  key: "delete",
                                  danger: true,
                                  label:
                                    category === "events"
                                      ? "撤销交易"
                                      : "删除记录",
                                  onClick: () =>
                                    requestReveal(() => void open(r, "delete")),
                                },
                              ],
                        }}
                      >
                        <Button
                          type="text"
                          size="small"
                          aria-label={`更多操作：${r.name}`}
                          icon={<MoreHorizontal size={17} />}
                        />
                      </Dropdown>
                    }
                  </Space>
                ),
              },
            ]}
          />
        </LoadState>
      </div>
      <Drawer
        title={`${selection?.item ? "编辑" : "新增"}${info?.label || "记录"}`}
        width={720}
        open={action === "edit"}
        onClose={close}
        destroyOnClose
        className="admin-data-drawer"
        footer={
          <div className="dialog-actions">
            <Button disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!canDirectEdit}
              onClick={() => void save()}
            >
              保存更改
            </Button>
          </div>
        }
      >
        {action === "edit" && (
          <Form
            form={form}
            layout="vertical"
            onValuesChange={() => setDirty(true)}
          >
            {error && <Alert showIcon type="error" message={error} />}
            {!canDirectEdit ? (
              <Alert
                type="info"
                message="请先处理关联交易"
                description={
                  selection?.item?.holding_correction?.reason ||
                  "此持仓已有后续交易，请先更正或撤销后续交易，再修改期初持仓。"
                }
              />
            ) : (
              <>
                {category === "events" && selection?.item && (
                  <p className="form-context">
                    保存时撤销原交易并生成更正记录，原始凭证保留。
                  </p>
                )}
                {fields(mainKeys.filter((k) => k in values))}
                {selection?.item?.holding_correction && (
                  <p className="form-context">
                    按更正后的市值重新分配机构资金；原流水保留，更正不会操作外部银行或券商。
                  </p>
                )}
                {!!extraKeys.length && (
                  <Collapse
                    ghost
                    activeKey={expanded}
                    onChange={(keys) =>
                      setExpanded(Array.isArray(keys) ? keys : [keys])
                    }
                    items={[
                      {
                        key: "extra",
                        label: "更多设置",
                        children: fields(extraKeys),
                      },
                    ]}
                  />
                )}
                {Object.keys(optionalFields[category] || {}).some(
                  (key) =>
                    !(key in values) &&
                    !(selection?.item && key.startsWith("opening_")),
                ) && (
                  <Select
                    className="admin-add-field"
                    aria-label="补充填写项"
                    placeholder="补充填写项（可选）"
                    value={undefined}
                    options={Object.keys(optionalFields[category] || {})
                      .filter(
                        (key) =>
                          !(key in values) &&
                          !(selection?.item && key.startsWith("opening_")),
                      )
                      .map((key) => ({ value: key, label: labels[key] }))}
                    onChange={(key: string) => {
                      form.setFieldValue(
                        ["values", key],
                        structuredClone(optionalFields[category][key]),
                      );
                      setDirty(true);
                      setExpanded(["extra"]);
                    }}
                  />
                )}
              </>
            )}
            <Form.Item
              name="reason"
              label="操作说明"
              rules={[{ required: true, message: "请填写操作说明" }]}
            >
              <Input maxLength={500} />
            </Form.Item>
          </Form>
        )}
      </Drawer>
      <Modal
        title={
          action === "purge"
            ? "彻底删除记录"
            : action === "restore"
              ? "恢复记录"
              : category === "events"
                ? "撤销交易"
                : "删除记录"
        }
        open={action === "delete" || action === "restore" || action === "purge"}
        onCancel={close}
        width={560}
        onOk={() => void save()}
        okText={
          action === "purge"
            ? "彻底删除"
            : action === "restore"
              ? "恢复"
              : "确认移除"
        }
        confirmLoading={busy}
        okButtonProps={{ danger: action === "delete" || action === "purge" }}
        destroyOnClose
      >
        {(action === "delete" ||
          action === "restore" ||
          action === "purge") && (
          <Form
            form={form}
            layout="vertical"
            onValuesChange={() => setDirty(true)}
          >
            <p className="admin-delete-title">{selection?.item?.name}</p>
            <p>
              {action === "purge"
                ? "此操作会永久删除选中记录和以下关联内容，不能从回收站恢复。"
                : action === "restore"
                  ? "恢复后重新出现在业务页面。关联计划需要单独恢复。"
                  : category === "events"
                    ? "撤销后重新计算余额和持仓，原始记录保留。"
                    : "删除后移出当前页面及相关统计，可以在已删除列表中恢复。"}
            </p>
            {action === "purge" && (
              <>
                <div className="admin-impact-list">
                  {selection?.counts?.map((r: Item) => (
                    <div key={r.name}>
                      {r.name}：{r.count} 条
                    </div>
                  ))}
                </div>
                {!!selection?.cash_effects?.length && (
                  <div className="admin-impact-list">
                    {selection.cash_effects.map((r: Item) => (
                      <div key={`${r.account_id}-${r.currency}`}>
                        <span>
                          {r.account_name}
                          {r.account_removed ? "（账户一并删除）" : "余额变化"}
                        </span>
                        <Money value={r.change} currency={r.currency} />
                      </div>
                    ))}
                  </div>
                )}
                {!!selection?.affected_items?.length && (
                  <Collapse
                    size="small"
                    items={[
                      {
                        key: "affected",
                        label: `查看关联内容（${selection.affected_items.length} 项）`,
                        children: (
                          <ul className="admin-purge-list">
                            {selection.affected_items.map((r: Item) => (
                              <li key={r.id}>
                                {r.type} · {r.name}
                                {r.account ? ` · ${r.account}` : ""}
                              </li>
                            ))}
                          </ul>
                        ),
                      },
                    ]}
                  />
                )}
                <p className="form-context">{selection?.retained}</p>
                <Form.Item
                  name="confirm_name"
                  label="输入完整名称确认"
                  rules={[
                    {
                      validator: (_, value) =>
                        value === selection?.item?.name
                          ? Promise.resolve()
                          : Promise.reject(new Error("请输入上方完整名称")),
                    },
                  ]}
                >
                  <Input autoComplete="off" />
                </Form.Item>
                <Form.Item
                  name="confirm"
                  valuePropName="checked"
                  rules={[
                    {
                      validator: (_, value) =>
                        value === true
                          ? Promise.resolve()
                          : Promise.reject(new Error("请核对并确认删除影响")),
                    },
                  ]}
                >
                  <Checkbox>
                    已核对关联内容和账户余额变化，确认彻底删除
                  </Checkbox>
                </Form.Item>
              </>
            )}
            {action === "delete" && selection?.impact && (
              <div className="admin-impact">
                <span>移出资产金额</span>
                <Money
                  value={selection.impact.removed_value}
                  currency={selection.impact.currency}
                />
              </div>
            )}
            {action === "delete" && selection?.dependencies?.length > 0 && (
              <Collapse
                size="small"
                items={[
                  {
                    key: "dependencies",
                    label: `关联内容（${selection?.dependencies.reduce((n: number, d: Item) => n + d.count, 0)} 项）`,
                    children: (
                      <>
                        {["accounts", "instruments"].includes(category) && (
                          <p>
                            关联计划、预留和提醒一并移入已删除列表。历史流水保留，机构总权益不因单个产品被删除而改变。
                          </p>
                        )}
                        {selection?.dependencies.map((d: Item) => (
                          <div key={d.code}>
                            <strong>
                              {["accounts", "instruments"].includes(category)
                                ? "关联记录"
                                : d.message}
                            </strong>
                            <ul>
                              {d.items?.map((i: Item) => (
                                <li key={i.id}>{i.name}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </>
                    ),
                  },
                ]}
              />
            )}
            {action === "delete" && selection?.related_count > 1 && (
              <Form.Item
                name="include_related"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_, v) =>
                      v
                        ? Promise.resolve()
                        : Promise.reject(new Error("请核对并勾选关联交易")),
                  },
                ]}
              >
                <Checkbox>
                  一并撤销关联的 {selection?.related_count} 条交易
                </Checkbox>
              </Form.Item>
            )}
            <Form.Item
              name="reason"
              label="操作说明"
              rules={[{ required: true, message: "请填写操作说明" }]}
            >
              <Input maxLength={500} />
            </Form.Item>
            {error && <Alert showIcon type="error" message={error} />}
          </Form>
        )}
      </Modal>
    </>
  );
}
