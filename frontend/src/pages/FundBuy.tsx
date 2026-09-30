import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import { api, dateToday, listOf, send } from "../api";
import type { Item } from "../api";
import { LoadState, Money, Panel } from "../components";
import { useResource, useWorkspace } from "../state";

const fundingOptions = [
  { value: "account", label: "从本账簿账户扣款" },
  { value: "untracked", label: "账外资金（不扣本账簿账户）" },
];
const feeOptions = [
  { value: "unknown", label: "费用暂不清楚" },
  { value: "zero", label: "无申购费" },
  { value: "rate", label: "申购费率（%）" },
  { value: "fixed", label: "实际手续费金额" },
];

export default function FundBuy({
  holding,
  order,
  onClose,
}: {
  holding: Item;
  order?: Item;
  onClose: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const accounts = useResource("accounts", "?limit=1000");
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const values = Form.useWatch([], form) || {};
  const instrumentId = holding.instrument_id || holding.id;
  const accountId = values.account_id || holding.account_id;
  const progressing = order && order.status !== "submitted";
  const currency = holding.currency || "CNY";
  const rows = listOf<Item>(accounts.data).filter(
    (a) =>
      !a.archived && a.valuation_mode !== "snapshot" && a.currency === currency,
  );
  const options = rows
    .filter((a) => ["fund", "broker", "securities"].includes(a.kind))
    .map((a) => ({ value: a.id, label: a.name }));
  const cashOptions = rows
    .filter((a) =>
      ["bank", "cash", "wallet", "fund", "broker", "securities"].includes(
        a.kind,
      ),
    )
    .map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }));
  useEffect(() => {
    if (order || !accountId) return;
    let live = true;
    api(
      `/spaces/${space.id}/fund-orders/defaults?${new URLSearchParams({ instrument_id: instrumentId, account_id: accountId })}`,
    )
      .then((d) => {
        if (
          live &&
          !form.isFieldsTouched([
            "funding_source",
            "cash_account_id",
            "fee_mode",
            "auto_estimate",
          ])
        )
          form.setFieldsValue(d);
      })
      .catch(() => {
        /* Defaults never block recording a known fact. */
      });
    return () => {
      live = false;
    };
  }, [space.id, accountId, instrumentId, order]);
  async function save(input: any) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      let result: Item;
      if (progressing) {
        result = await send(
          `/spaces/${space.id}/fund-orders/${order!.id}/transition`,
          {
            version: order!.version,
            action:
              input.status === "confirmed"
                ? order!.status === "estimated"
                  ? "verify"
                  : "confirm"
                : "configure",
            auto_estimate: !!input.auto_estimate,
            fee_mode: input.fee_mode,
            fee_value: ["rate", "fixed"].includes(input.fee_mode)
              ? input.fee_value || "0"
              : "0",
            ...(input.status === "confirmed"
              ? {
                  quantity: input.quantity,
                  price: input.price,
                  confirmation_date: input.confirmation_date,
                }
              : {}),
          },
        );
      } else {
        result = await send(
          `/spaces/${space.id}/fund-orders${order ? `/${order.id}` : ""}`,
          {
            ...input,
            instrument_id: instrumentId,
            ...(order ? { version: order.version } : {}),
            cash_account_id:
              input.funding_source === "untracked"
                ? undefined
                : input.cash_account_id || input.account_id,
            fee_value: ["rate", "fixed"].includes(input.fee_mode)
              ? input.fee_value || "0"
              : "0",
          },
        );
      }
      reload();
      onClose();
      message.success({
        duration: 8,
        content: (
          <Space>
            已保存：{result.status_label}
            {!progressing && (
              <Button
                size="small"
                type="link"
                onClick={async () => {
                  try {
                    await send(
                      `/spaces/${space.id}/fund-orders/${result.id}/transition`,
                      { action: "cancel", version: result.version },
                    );
                    reload();
                    message.success("已撤销，原记录保留在历史中");
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
      lock.current = false;
      setBusy(false);
    }
  }
  const confirmed = values.status === "confirmed";
  return (
    <Modal
      open
      title={progressing ? "补充确认信息" : "记录基金买入"}
      width={640}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="保存"
      confirmLoading={busy}
      maskClosable={!busy}
      closable={!busy}
      keyboard={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      <p>
        <strong>{holding.instrument_name || holding.name}</strong>
      </p>
      {error && (
        <Alert type="error" showIcon message={error} className="form-alert" />
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={busy}
        onFinish={save}
        initialValues={{
          account_id: holding.account_id,
          application_date: dateToday(),
          confirmation_date: dateToday(),
          status: "submitted",
          funding_source: "account",
          cash_account_id: holding.account_id,
          fee_mode: "unknown",
          auto_estimate: false,
          remember_defaults: true,
          after_cutoff: false,
          ...order,
          ...(order?.status === "estimated" ? { status: "confirmed" } : {}),
        }}
      >
        <div className="form-grid">
          <Form.Item
            name="amount"
            label={`申购金额（${currency}）`}
            rules={[{ required: true, message: "请输入金额" }]}
          >
            <InputNumber
              stringMode
              min="0.01"
              precision={2}
              disabled={!!progressing}
              style={{ width: "100%" }}
              autoFocus
            />
          </Form.Item>
          <Form.Item
            name="status"
            label="目前已知的状态"
            rules={[{ required: true }]}
          >
            <Select
              options={(progressing
                ? [
                    { value: "paid", label: "已扣款，等待份额" },
                    { value: "confirmed", label: "填写机构确认份额" },
                  ]
                : [
                    { value: "submitted", label: "已提交，尚未确认扣款" },
                    { value: "paid", label: "已扣款，份额还不知道" },
                    { value: "confirmed", label: "已确认份额" },
                  ]
              ).filter(
                (o) => order?.status !== "estimated" || o.value === "confirmed",
              )}
            />
          </Form.Item>
          {!progressing && (
            <>
              <Form.Item
                name="account_id"
                label="持仓账户"
                rules={[{ required: true, message: "请选择持仓账户" }]}
              >
                <Select options={options} disabled={!!holding.account_id} />
              </Form.Item>
              <Form.Item
                name="application_date"
                label="申请日期"
                rules={[{ required: true }]}
              >
                <Input type="date" max={dateToday()} />
              </Form.Item>
            </>
          )}
          {!progressing && (
            <>
              <Form.Item name="funding_source" label="扣款来源">
                <Select options={fundingOptions} />
              </Form.Item>
              {values.funding_source !== "untracked" && (
                <Form.Item
                  name="cash_account_id"
                  label="扣款账户"
                  rules={[{ required: true, message: "请选择扣款账户" }]}
                >
                  <Select options={cashOptions} />
                </Form.Item>
              )}
            </>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          {values.status === "submitted"
            ? "仅保存申请，暂不增加资产或扣减账户。"
            : (values.funding_source || order?.funding_source) === "untracked"
              ? "记为账外追加本金，不扣减本账簿账户、不计收入；可稍后关联实际扣款账户。"
              : "保存已扣款金额后，资金进入买入待确认；确认份额后转为持仓，不重复增加资产。"}
        </p>
        {confirmed && (
          <div className="form-grid">
            <Form.Item
              name="quantity"
              label="机构确认份额"
              rules={[{ required: true }]}
            >
              <InputNumber
                stringMode
                min="0.00000001"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="price"
              label="确认净值"
              rules={[{ required: true }]}
            >
              <InputNumber
                stringMode
                min="0.00000001"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="confirmation_date"
              label="确认日期"
              rules={[{ required: true }]}
            >
              <Input type="date" max={dateToday()} />
            </Form.Item>
          </div>
        )}
        {!confirmed && values.status !== "submitted" && (
          <Form.Item
            name="auto_estimate"
            label="正式净值公布后推算份额"
            tooltip="须有明确费用规则；只推算账簿份额，不操作机构账户，结果始终标记待核实。"
            valuePropName="checked"
          >
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
        )}
        <Collapse
          ghost
          defaultActiveKey={confirmed ? ["details"] : []}
          items={[
            {
              key: "details",
              forceRender: true,
              label: `费用与时间 · ${feeOptions.find((f) => f.value === values.fee_mode)?.label || "费用暂不清楚"} · ${values.after_cutoff ? "15:00 后" : "15:00 前"}`,
              children: (
                <>
                  <div className="form-grid">
                    <Form.Item name="fee_mode" label="费用规则">
                      <Select
                        options={feeOptions.filter(
                          (f) => !confirmed || f.value !== "unknown",
                        )}
                      />
                    </Form.Item>
                    {["rate", "fixed"].includes(values.fee_mode) && (
                      <Form.Item
                        name="fee_value"
                        label={
                          values.fee_mode === "rate"
                            ? "折扣后申购费率（%）"
                            : "实际手续费"
                        }
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          stringMode
                          min="0"
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    )}
                  </div>
                  {!progressing && (
                    <>
                      <Form.Item name="after_cutoff" valuePropName="checked">
                        <Checkbox>
                          15:00 后提交（预计顺延至下一开放日）
                        </Checkbox>
                      </Form.Item>
                      <Form.Item name="description" label="备注（选填）">
                        <Input.TextArea rows={2} />
                      </Form.Item>
                      <Form.Item
                        name="remember_defaults"
                        valuePropName="checked"
                      >
                        <Checkbox>
                          记住这只基金在此账户的扣款与费用设置
                        </Checkbox>
                      </Form.Item>
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}

export function FundOrders({
  pending = false,
  instrumentId,
  accountId,
}: {
  pending?: boolean;
  instrumentId?: string;
  accountId?: string;
}) {
  const { space, reload, requestReveal, hidden } = useWorkspace();
  const { modal, message } = App.useApp();
  const [editing, setEditing] = useState<Item | null>(null);
  const [linking, setLinking] = useState<Item | null>(null);
  const [linkForm] = Form.useForm();
  const accountState = useResource("accounts", "?limit=1000");
  const [linkBusy, setLinkBusy] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [space.id, pending, instrumentId, accountId]);
  const linkLock = useRef(false);
  const params = new URLSearchParams({
    limit: "10",
    offset: String((page - 1) * 10),
    ...(pending ? { pending: "true" } : {}),
    ...(instrumentId ? { instrument_id: instrumentId } : {}),
    ...(accountId ? { account_id: accountId } : {}),
  });
  const state = useResource("fund-orders", `?${params}`);
  async function cancel(row: Item) {
    try {
      await send(`/spaces/${space.id}/fund-orders/${row.id}/transition`, {
        action: "cancel",
        version: row.version,
      });
      reload();
      message.success("已撤销账簿记录");
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  return (
    <>
      <Panel
        title={pending ? "基金待核实" : "基金申购进度"}
        subtitle="申请、扣款、份额分阶段记录；推算结果始终保留来源。"
      >
        <LoadState {...state}>
          <Table
            rowKey="id"
            size="small"
            dataSource={listOf<Item>(state.data)}
            scroll={{ x: 760 }}
            pagination={{
              pageSize: 10,
              current: page,
              total: state.data?.count || 0,
              showSizeChanger: false,
              onChange: setPage,
              showTotal: (n) => `共 ${n} 笔`,
            }}
            columns={[
              {
                title: "基金 / 账户",
                render: (_, r) => (
                  <>
                    <strong>{r.instrument_name}</strong>
                    <div className="muted">{r.account_name}</div>
                  </>
                ),
              },
              { title: "申请日", dataIndex: "application_date" },
              {
                title: "金额 / 来源",
                render: (_, r) => (
                  <>
                    <Money value={r.amount} currency={r.currency} />
                    <div className="muted">
                      {r.funding_source === "untracked"
                        ? "账外追加本金"
                        : r.status === "submitted"
                          ? "拟从账户扣款"
                          : "账户扣款"}
                    </div>
                    {r.funding_source === "untracked" &&
                      !["submitted", "cancelled"].includes(r.status) &&
                      space.role !== "viewer" && (
                        <Button
                          type="link"
                          size="small"
                          onClick={() =>
                            requestReveal(() => {
                              linkForm.resetFields();
                              setLinking(r);
                            })
                          }
                        >
                          补充扣款账户
                        </Button>
                      )}
                  </>
                ),
              },
              {
                title: "进度",
                render: (_, r) => (
                  <>
                    <Tag
                      color={
                        r.status === "confirmed"
                          ? "green"
                          : r.status === "cancelled"
                            ? "default"
                            : "gold"
                      }
                    >
                      {r.status_label}
                    </Tag>
                    <div className="muted">{r.note}</div>
                    {r.expected_confirmation_date && (
                      <small>预计确认 {r.expected_confirmation_date}</small>
                    )}
                  </>
                ),
              },
              {
                title: "操作",
                width: 145,
                render: (_, r) =>
                  space.role !== "viewer" &&
                  r.status !== "cancelled" && (
                    <Space wrap size={0}>
                      {r.status !== "confirmed" && (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => requestReveal(() => setEditing(r))}
                        >
                          {r.status === "submitted" ? "补充 / 修改" : "核实"}
                        </Button>
                      )}
                      <Button
                        type="link"
                        size="small"
                        onClick={() =>
                          requestReveal(() =>
                            modal.confirm({
                              title: "撤销这笔账簿记录？",
                              content: `将撤回此笔申购及已关联的份额记录，重新计算本基金持仓和收益。原记录保留；不会向机构发起撤单。${hidden ? "" : ` 涉及 ${r.amount} ${r.currency}。`}`,
                              okText: "撤销记录",
                              onOk: () => cancel(r),
                            }),
                          )
                        }
                      >
                        撤销
                      </Button>
                    </Space>
                  ),
              },
            ]}
          />
        </LoadState>
      </Panel>
      {editing && (
        <FundBuy
          key={`${editing.id}:${editing.version}`}
          order={editing}
          holding={{ ...editing, id: editing.instrument_id, kind: "fund" }}
          onClose={() => setEditing(null)}
        />
      )}
      <Modal
        open={!!linking}
        title="补充实际扣款账户"
        onCancel={() => setLinking(null)}
        onOk={() => linkForm.submit()}
        confirmLoading={linkBusy}
        okText="保存关联"
      >
        <p>
          将从选定账户扣减原申购金额，并替换账外追加本金的来源；基金资产与收益不重复增加。仅当该扣款尚未在此账户记账时使用。
        </p>
        <Form
          form={linkForm}
          layout="vertical"
          onFinish={async (v) => {
            if (!linking || linkLock.current) return;
            linkLock.current = true;
            setLinkBusy(true);
            try {
              await send(
                `/spaces/${space.id}/fund-orders/${linking.id}/transition`,
                {
                  action: "associate",
                  version: linking.version,
                  cash_account_id: v.cash_account_id,
                },
              );
              setLinking(null);
              reload();
              message.success("已关联实际扣款账户");
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              linkLock.current = false;
              setLinkBusy(false);
            }
          }}
        >
          <Form.Item
            name="cash_account_id"
            label="实际扣款账户"
            rules={[{ required: true }]}
          >
            <Select
              options={listOf<Item>(accountState.data)
                .filter(
                  (a) =>
                    !a.archived &&
                    a.valuation_mode !== "snapshot" &&
                    a.currency === linking?.currency &&
                    [
                      "bank",
                      "cash",
                      "wallet",
                      "fund",
                      "broker",
                      "securities",
                    ].includes(a.kind),
                )
                .map((a) => ({ value: a.id, label: a.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
