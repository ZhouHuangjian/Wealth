import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Space,
  Table,
  Tag,
} from "antd";
import { dateToday, listOf, send } from "../api";
import type { Item } from "../api";
import { LoadState, Money } from "../components";
import { HelpText, helpColumns } from "../help";
import { useResource, useWorkspace } from "../state";
import { profitTone } from "../investment";
import {
  hasOptionValue,
  optionDecimal,
  optionHoldingPreview,
  optionPositionPayload,
  positiveOptionDecimal,
  positiveOptionInteger,
} from "../option-holding";

export function OptionHoldingFields({
  currency,
  prefix = [],
  multiplierSuggestion,
  productKey,
  identityLocked = false,
}: {
  currency: string;
  prefix?: string[];
  multiplierSuggestion?: unknown;
  productKey?: string;
  identityLocked?: boolean;
}) {
  const form = Form.useFormInstance();
  const field = (key: string) => [...prefix, key];
  const side = Form.useWatch(field("side"), form);
  const quantity = Form.useWatch(field("quantity"), form);
  const multiplier = Form.useWatch(field("contract_multiplier"), form);
  const opening = Form.useWatch(field("opening_price"), form);
  const current = Form.useWatch(field("current_value"), form);
  const asOf = Form.useWatch(field("as_of"), form);
  const purchaseDate = Form.useWatch(field("purchase_date"), form);
  const settlement = Form.useWatch(field("settlement_price"), form);
  const previousKey = useRef(productKey),
    manualMultiplier = useRef(false),
    previousSuggestion = useRef<unknown>(undefined);
  useEffect(() => {
    if (identityLocked) return;
    if (previousKey.current !== productKey) {
      form.setFieldValue(field("contract_multiplier"), undefined);
      previousKey.current = productKey;
      previousSuggestion.current = undefined;
      manualMultiplier.current = false;
    }
    if (
      !manualMultiplier.current &&
      positiveOptionDecimal(multiplierSuggestion) &&
      multiplierSuggestion !== previousSuggestion.current
    ) {
      form.setFieldValue(
        field("contract_multiplier"),
        String(multiplierSuggestion),
      );
      previousSuggestion.current = multiplierSuggestion;
    }
  }, [productKey, multiplierSuggestion, identityLocked]);
  const preview = optionHoldingPreview({
    side,
    quantity,
    contract_multiplier: multiplier,
    opening_price: opening,
    current_value: current,
  });
  const decimalRule = {
    validator: async (_: unknown, value: unknown) => {
      if (hasOptionValue(value) && optionDecimal(value) === null)
        throw new Error("填写非负数，最多 12 位小数");
    },
  };
  return (
    <div className="wizard-section">
      <h3>
        <HelpText text="期权参考持仓" />
      </h3>
      <Alert
        className="form-alert"
        type="info"
        showIcon
        message="用于查看这笔期权的价值与毛浮动盈亏"
        description="账户总权益用于统计净资产。这笔参考持仓不会重复加入净资产，也不会生成交易或现金扣款；账户权益仍需按机构实际数据核对。"
      />
      <Form.Item
        name={field("side")}
        label={<HelpText text="买卖方向" />}
        rules={[{ required: true, message: "选择买入或卖出持仓" }]}
        extra="买卖方向与认购、认沽不同；认购或认沽由所选合约决定。"
      >
        <Radio.Group
          disabled={identityLocked}
          options={[
            { value: "long", label: "买入持仓（多头）" },
            { value: "short", label: "卖出持仓（空头）" },
          ]}
        />
      </Form.Item>
      <div className="form-grid">
        <Form.Item
          name={field("quantity")}
          label="持仓手数"
          rules={[
            { required: true, message: "填写实际持仓手数" },
            {
              validator: async (_, value) => {
                if (hasOptionValue(value) && !positiveOptionInteger(value))
                  throw new Error("手数须为大于零的整数，不接受小数手数");
              },
            },
          ]}
        >
          <InputNumber
            stringMode
            min="1"
            step="1"
            addonAfter="手"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          name={field("contract_multiplier")}
          label={<HelpText text="合约乘数" />}
          extra={
            identityLocked
              ? "沿用这笔持仓已保存的合约单位；若需更正，请按交易所或机构资料核实。"
              : positiveOptionDecimal(multiplierSuggestion)
                ? "已按产品资料预填，请核实每手合约单位；可按机构确认信息修改。"
                : "尚未获取可靠的合约单位，请按交易所或机构资料填写，不默认按 1 计算。"
          }
          rules={[
            { required: true, message: "填写已核实的合约乘数" },
            {
              validator: async (_, value) => {
                if (hasOptionValue(value) && !positiveOptionDecimal(value))
                  throw new Error("合约乘数须大于零，最多 12 位小数");
              },
            },
          ]}
        >
          <InputNumber
            stringMode
            min="0.000000000001"
            style={{ width: "100%" }}
            onChange={() => {
              manualMultiplier.current = true;
            }}
          />
        </Form.Item>
        <Form.Item
          name={field("opening_price")}
          label={<HelpText text="开仓均价" />}
          extra="每个报价单位的开仓价格，不是这笔持仓的总金额。"
          rules={[{ required: true, message: "填写开仓均价" }, decimalRule]}
        >
          <InputNumber
            stringMode
            min="0"
            addonAfter={currency}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          name={field("current_value")}
          label={<HelpText text="当前持仓总市值" />}
          extra="填写这笔持仓合计的非负金额，不是合约报价。卖出持仓也填其估算平仓价值的绝对额。"
          rules={[
            { required: true, message: "填写当前持仓总市值" },
            decimalRule,
          ]}
        >
          <InputNumber
            stringMode
            min="0"
            addonAfter={currency}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          name={field("purchase_date")}
          label="实际开仓日期"
          dependencies={[field("as_of")]}
          rules={[
            { required: true, message: "填写实际开仓日期" },
            {
              validator: async (_, value) => {
                if (value && asOf && value > asOf)
                  throw new Error("开仓日期不能晚于当前市值对应日期");
              },
            },
          ]}
        >
          <Input type="date" max={asOf || dateToday()} />
        </Form.Item>
        <Form.Item
          name={field("as_of")}
          label="当前市值对应日期"
          dependencies={[field("purchase_date")]}
          extra="按机构显示的数据日期填写，可能早于今天；不把录入时间当作行情日期。"
          rules={[
            { required: true, message: "填写当前市值的数据日期" },
            {
              validator: async (_, value) => {
                if (
                  value &&
                  (value > dateToday() ||
                    (purchaseDate && value < purchaseDate))
                )
                  throw new Error("数据日期须在开仓日与今天之间");
              },
            },
          ]}
        >
          <Input type="date" min={purchaseDate} max={dateToday()} />
        </Form.Item>
        <Form.Item
          name={field("settlement_price")}
          label={<HelpText text="结算价" />}
          extra="选填，按每个报价单位填写；价格为 0 时也可以记录。"
          rules={[decimalRule]}
        >
          <InputNumber
            stringMode
            min="0"
            addonAfter={currency}
            style={{ width: "100%" }}
            onChange={(value) => {
              if (!hasOptionValue(value))
                form.setFieldValue(field("settlement_date"), undefined);
            }}
          />
        </Form.Item>
        {hasOptionValue(settlement) && (
          <Form.Item
            preserve={false}
            name={field("settlement_date")}
            label="结算价对应日期"
            dependencies={[field("as_of")]}
            rules={[
              { required: true, message: "填写该结算价对应的日期" },
              {
                validator: async (_, value) => {
                  if (value && asOf && value > asOf)
                    throw new Error("结算日期不能晚于当前市值对应日期");
                },
              },
            ]}
          >
            <Input type="date" max={asOf || dateToday()} />
          </Form.Item>
        )}
      </div>
      {preview && (
        <div className="data-caption">
          开仓权利金合计{" "}
          <Money value={preview.opening_premium} currency={currency} /> ·{" "}
          <HelpText text="毛浮动盈亏" />{" "}
          <Money value={preview.reference_profit} currency={currency} sign />
          （未扣手续费，不代表已到账收益）
        </div>
      )}
    </div>
  );
}

export function OptionHoldingEditor({
  item,
  onClose,
  onSaved,
}: {
  item: Item;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    form.setFieldsValue(item);
    setError("");
  }, [item.id, item.version]);
  return (
    <Modal
      open
      title={`编辑期权持仓 · ${item.instrument_name || item.name}`}
      width={820}
      okText="保存持仓"
      cancelText="取消"
      onCancel={() => {
        if (!lock.current) onClose();
      }}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      onOk={() => form.submit()}
    >
      <p>
        {item.account_name} · {item.code} · {item.currency}
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
              `/spaces/${space.id}/option-holdings/${item.id}`,
              {
                ...optionPositionPayload(values, item.account_id, true),
                version: item.version,
              },
              "PATCH",
            );
            message.success(
              values.status === "closed"
                ? "参考持仓已标记为已平仓"
                : "期权参考持仓已更新",
            );
            reload();
            onSaved?.();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <OptionHoldingFields currency={item.currency} identityLocked />
        <Form.Item
          name="status"
          label="持仓状态"
          extra="标记已平仓后停止显示为当前参考持仓，不自动生成平仓交易、费用或资金记录。需要纠正账户、合约或买卖方向时，请关闭旧记录后新增。"
        >
          <Radio.Group
            options={[
              { value: "active", label: "持有中" },
              { value: "closed", label: "已平仓" },
            ]}
          />
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </Modal>
  );
}

export function OptionHoldingHistory() {
  const { space, hidden, requestReveal } = useWorkspace();
  const state = useResource("option-holdings", "?status=all&limit=200");
  const [editing, setEditing] = useState<Item | null>(null);
  return (
    <>
      <p className="data-caption">
        保留持有中和已平仓的期权参考记录；更新不生成真实交易或现金流水。
      </p>
      <LoadState {...state}>
        <Table<Item>
          rowKey="id"
          dataSource={listOf<Item>(state.data)}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 900 }}
          columns={helpColumns<Item>([
            {
              title: "产品 / 账户",
              render: (_, row) => (
                <div className="cell-name">
                  <strong>{row.instrument_name || row.name}</strong>
                  <small>
                    {row.code} · {row.account_name}
                  </small>
                </div>
              ),
            },
            {
              title: "方向 / 手数",
              render: (_, row) => (
                <Space>
                  {row.side === "short" ? "卖出" : "买入"}
                  <Money value={row.quantity} />手
                </Space>
              ),
            },
            {
              title: "当前持仓市值",
              render: (_, row) => (
                <div className="cell-name">
                  <Money value={row.current_value} currency={row.currency} />
                  <small>{row.as_of}</small>
                </div>
              ),
            },
            {
              title: "毛浮动盈亏",
              render: (_, row) => (
                <span
                  className={hidden ? "" : profitTone(row.reference_profit)}
                >
                  <Money
                    value={row.reference_profit}
                    currency={row.currency}
                    sign
                  />
                </span>
              ),
            },
            {
              title: "状态",
              render: (_, row) => (
                <Tag>{row.status === "closed" ? "已平仓" : "持有中"}</Tag>
              ),
            },
            {
              title: "操作",
              render: (_, row) =>
                space.role !== "viewer" && (
                  <Button
                    type="link"
                    onClick={() => requestReveal(() => setEditing(row))}
                  >
                    编辑
                  </Button>
                ),
            },
          ])}
        />
      </LoadState>
      {editing && (
        <OptionHoldingEditor
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void state.retry();
          }}
        />
      )}
    </>
  );
}
