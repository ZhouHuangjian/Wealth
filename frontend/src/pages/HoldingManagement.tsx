import { useEffect, useRef, useState } from "react";
import { Alert, App, Checkbox, Form, Input, InputNumber, Modal } from "antd";
import { send } from "../api";
import type { Item } from "../api";
import { Money } from "../components";
import { holdingCorrectionPayload } from "../holding-reconciliation";
import { useWorkspace } from "../state";
import { HoldingReconciliation } from "./HoldingReconciliation";
import { hasOptionValue } from "../option-holding";
import { positiveDecimalInput } from "../positive-input";

export function HoldingCorrection({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const correction = item.correction || {};
  const original = correction.initial_values || {};
  useEffect(() => {
    form.setFieldsValue({
      ...original,
      institution_profit: item.reconciliation?.institution_profit,
      reference_nav: item.reconciliation?.reference_nav,
      valuation_mode: "value",
      reason: "",
    });
  }, [item.id, correction.opening_event_id, correction.data_revision]);
  return (
    <Modal
      open
      title={`更正原始录入 · ${item.instrument_name || item.name}`}
      width={820}
      okText="保存更正"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => form.submit()}
      onCancel={() => {
        if (!lock.current) onClose();
      }}
      maskClosable={!busy}
      keyboard={!busy}
      closable={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      <Alert
        type="info"
        showIcon
        message="只更正原始录入的份额、成本和买入日期"
        description="市值、核对日期、账户和原资金分配保持不变。本次操作保留更正记录，不会从银行卡再补款或退回机构现金；买卖、定投、分红等实际交易须按实际业务记录。"
      />
      <p>
        {item.account_name} · {item.code || item.instrument_code} ·
        原持仓核对日期 {original.as_of}
      </p>
      <p>
        原记录持仓市值{" "}
        <Money value={original.current_value} currency={item.currency} /> ·{" "}
        {original.funding_mode === "allocate"
          ? "原机构资金分配额保持不变"
          : "原资金来源保持不变"}
      </p>
      <Form
        form={form}
        layout="vertical"
        disabled={busy}
        onFinish={async (values) => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await send(
              `/spaces/${space.id}/holdings/${correction.opening_event_id}/correct`,
              holdingCorrectionPayload(
                original,
                values,
                correction.data_revision,
              ),
            );
            message.success("原始持仓录入已更正，原市值与资金分配保持不变");
            reload();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {["valuation_mode", "current_value"].map((name) => (
          <Form.Item key={name} name={name} hidden>
            <Input />
          </Form.Item>
        ))}
        <div className="form-grid">
          <Form.Item
            name="quantity"
            label="持有数量 / 份额"
            extra="使用原核对日期、同一范围的持有份额，不要直接用可用份额代替。"
            rules={[
              { required: true, message: "填写核实后的持有份额" },
              {
                validator: async (_, value) => {
                  if (hasOptionValue(value) && !positiveDecimalInput(value))
                    throw new Error(
                      "持有份额须大于零，不能用极小占位数代替实际持仓",
                    );
                },
              },
            ]}
          >
            <InputNumber
              stringMode
              changeOnBlur={false}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            name="cost"
            label="持仓取得成本"
            extra="按实际取得成本更正，不能为了匹配机构收益反推成本。"
            rules={[{ required: true, message: "填写核实后的取得成本" }]}
          >
            <InputNumber
              stringMode
              min="0"
              addonAfter={item.currency}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            name="purchase_date"
            label="实际买入 / 取得日期"
            rules={[{ required: true, message: "填写实际买入日期" }]}
          >
            <Input type="date" max={original.as_of} />
          </Form.Item>
        </div>
        {item.reconciliation?.status === "unresolved" && (
          <p className="data-caption">
            原机构核对信息已带入。清空输入不会移除原有待核对依据；需要更新机构原值时，请使用“核对机构数据”。
          </p>
        )}
        <HoldingReconciliation currency={item.currency} />
        <Form.Item
          name="reason"
          label="更正原因"
          rules={[
            {
              required: true,
              whitespace: true,
              message: "填写核对依据与更正原因",
            },
          ]}
        >
          <Input.TextArea
            rows={2}
            maxLength={1000}
            placeholder="例如：核对原始成交单后发现份额录入错误"
          />
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </Modal>
  );
}

export function HoldingInstitutionCheck({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const existing = item.reconciliation || {};
  const asOf =
    existing.as_of ||
    item.reconciliation_eligibility?.as_of ||
    item.correction?.initial_values?.as_of ||
    item.as_of;
  const nav = Form.useWatch("reference_nav", form);
  useEffect(() => {
    form.setFieldsValue({ ...existing, scope_confirmed: false });
  }, [item.id, existing.version]);
  return (
    <Modal
      open
      title={`核对机构数据 · ${item.instrument_name || item.name}`}
      width={720}
      okText="保存核对结果"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => form.submit()}
      onCancel={() => {
        if (!lock.current) onClose();
      }}
      maskClosable={!busy}
      keyboard={!busy}
      closable={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      <Alert
        type="info"
        showIcon
        message="只登记机构页面的信息，不改动持仓或资金"
        description="机构收益与记录不一致，或金额范围尚未核实，都会保留为待核对。平台总资产可能包含申购在途或不同份额范围；仅数字相等不会自动解除，系统也不会倒推成本或把可用份额当成已确认份额。"
      />
      <p>
        {item.account_name} · 原核对日期 {asOf} · 原记录计算盈亏{" "}
        <Money
          value={item.computed_profit ?? item.profit}
          currency={item.currency}
          sign
        />
      </p>
      <Form
        form={form}
        layout="vertical"
        disabled={busy}
        onFinish={async (values) => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            const result = await send(
              `/spaces/${space.id}/holdings/${item.reconciliation_eligibility?.opening_event_id || item.correction?.opening_event_id || existing.opening_event_id}/check`,
              {
                institution_profit: String(values.institution_profit),
                reference_nav: hasOptionValue(values.reference_nav)
                  ? String(values.reference_nav)
                  : null,
                reference_date: hasOptionValue(values.reference_nav)
                  ? values.reference_date || null
                  : null,
                available_quantity: hasOptionValue(values.available_quantity)
                  ? String(values.available_quantity)
                  : null,
                note: values.note || "",
                scope_unconfirmed: values.scope_confirmed !== true,
                version: existing.version || 0,
                ...(item.correction?.data_revision != null
                  ? { expected_revision: item.correction.data_revision }
                  : {}),
              },
            );
            message.success(
              result.status === "matched"
                ? "机构数据与记录已匹配"
                : "已保存机构数据，持仓收益标记为待核对",
            );
            reload();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <Form.Item
          name="institution_profit"
          label="机构显示的持仓收益"
          extra="须与原持仓核对日期、范围一致；亏损填负数。"
          rules={[{ required: true, message: "填写机构显示的持仓收益" }]}
        >
          <InputNumber
            stringMode
            addonAfter={item.currency}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <div className="form-grid">
          <Form.Item
            name="reference_nav"
            label="对应单位净值（选填）"
            rules={[
              {
                validator: async (_, value) => {
                  if (hasOptionValue(value) && !positiveDecimalInput(value))
                    throw new Error("单位净值须大于零，请填写实际净值");
                },
              },
            ]}
          >
            <InputNumber
              stringMode
              changeOnBlur={false}
              style={{ width: "100%" }}
              onChange={(value) => {
                if (!hasOptionValue(value))
                  form.setFieldValue("reference_date", undefined);
              }}
            />
          </Form.Item>
          {hasOptionValue(nav) && (
            <Form.Item
              preserve={false}
              name="reference_date"
              label="净值对应日期"
              extra="以平台实际显示为准，不会自动视为今天。"
              rules={[{ required: true, message: "填写该净值实际对应日期" }]}
            >
              <Input type="date" max={asOf} />
            </Form.Item>
          )}
          <Form.Item
            name="available_quantity"
            label="机构显示的可用份额（选填）"
            extra="仅作为核对备注保存，不替换持有份额，不用于推断待确认份额。"
          >
            <InputNumber stringMode min="0" style={{ width: "100%" }} />
          </Form.Item>
        </div>
        <Form.Item name="note" label="核对备注（选填）">
          <Input.TextArea
            rows={3}
            maxLength={2000}
            placeholder="例如：平台未提供申购是否确认的明细，暂保留机构页面原值。"
          />
        </Form.Item>
        <Form.Item
          name="scope_confirmed"
          valuePropName="checked"
          extra="暂不确定时请留空，仍可保存机构原值。只有明确核实范围且金额匹配后，系统才恢复持有收益展示。"
        >
          <Checkbox>
            已核实资产、成本和收益对应同一数据日、同一份持仓范围
          </Checkbox>
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </Modal>
  );
}

export function PlaceholderHoldingVoid({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const metadata = item.placeholder_void;
  return (
    <Modal
      open
      title="撤销误录的占位持仓"
      width={650}
      okText="确认冲正这笔误录"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => form.submit()}
      onCancel={() => {
        if (!lock.current) onClose();
      }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      <Alert
        type="warning"
        showIcon
        message="仅撤销符合条件的极小占位记录"
        description="后端会重新核对：原份额极小、成本和原市值为零且没有后续持仓变动。操作生成冲正记录，保留审计；不扣退款项，不删除产品或定投计划。"
      />
      <p>
        {item.instrument_name || item.name} ·{" "}
        {item.code || item.instrument_code} · {item.account_name}
      </p>
      <p>
        当前记录份额 <Money value={item.quantity} /> · 成本{" "}
        <Money value={item.cost_basis ?? item.cost} currency={item.currency} />
      </p>
      <Form
        form={form}
        layout="vertical"
        disabled={busy}
        onFinish={async (values) => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await send(
              `/spaces/${space.id}/holdings/${metadata.opening_event_id}/void-placeholder`,
              {
                expected_revision: metadata.data_revision,
                reason: values.reason.trim(),
              },
            );
            message.success("误录占位持仓已冲正，资金、产品和定投计划未改动");
            reload();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <Form.Item
          name="reason"
          label="撤销原因"
          rules={[
            { required: true, whitespace: true, message: "请说明为何属于误录" },
          ]}
        >
          <Input.TextArea
            rows={2}
            maxLength={1000}
            placeholder="例如：创建定投时误把 0 自动变成了极小份额，实际没有这笔持仓"
          />
        </Form.Item>
        <Form.Item
          name="confirmed"
          valuePropName="checked"
          rules={[
            {
              validator: async (_, value) => {
                if (value !== true)
                  throw new Error("请先核实并确认是误录占位持仓");
              },
            },
          ]}
        >
          <Checkbox>已核实这是误录的占位持仓，确认撤销上述原始录入</Checkbox>
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </Modal>
  );
}
