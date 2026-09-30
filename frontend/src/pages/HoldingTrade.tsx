import { useState } from "react";
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
  Radio,
  Select,
} from "antd";
import type { Item } from "../api";
import { dateToday, listOf, send } from "../api";
import { LoadState, Money } from "../components";
import { useResource, useWorkspace } from "../state";
import { compatibleAccountKinds } from "../investment";
import { tradeAmountPreview } from "../trade-entry";
import FundBuy from "./FundBuy";

export default function HoldingTrade(props: {
  holding: Item;
  side: "buy" | "sell";
  onClose: () => void;
}) {
  const spec = props.holding.specification || {};
  if (
    props.holding.kind === "fund" &&
    spec.trading_channel !== "exchange" &&
    props.side === "buy"
  )
    return <FundBuy holding={props.holding} onClose={props.onClose} />;
  return <SpotTrade {...props} />;
}

function SpotTrade({
  holding,
  side,
  onClose,
}: {
  holding: Item;
  side: "buy" | "sell";
  onClose: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const accounts = useResource("accounts", "?limit=1000");
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = Form.useWatch("pending", form) === true;
  const accountId = Form.useWatch("account_id", form);
  const values = Form.useWatch([], form) || {};
  const isFund =
    holding.kind === "fund" &&
    holding.specification?.trading_channel !== "exchange";
  const buy = side === "buy";
  const title = buy ? "记录买入" : "记录卖出";
  const currency = holding.currency || "CNY";
  const accountRows = listOf<Item>(accounts.data).filter(
    (a) => !a.archived && a.currency === currency,
  );
  const options = accountRows
    .filter((a) =>
      (compatibleAccountKinds[holding.kind] || []).includes(a.kind),
    )
    .map((a) => ({ value: a.id, label: a.name }));
  const cashOptions = accountRows
    .filter(
      (a) =>
        ![
          "future",
          "futures",
          "loan",
          "credit",
          "credit_card",
          "property",
          "receivable",
        ].includes(a.kind),
    )
    .map((a) => ({ value: a.id, label: a.name }));
  const expected = pending
    ? values.amount
    : values.amount ||
      tradeAmountPreview(
        side,
        values.quantity,
        values.price,
        values.fee,
        values.tax,
      );
  async function submit(input: any) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        instrument_id: holding.instrument_id || holding.id,
        side,
        economic_date: input.economic_date,
        account_id: input.account_id,
        cash_account_id: input.cash_account_id || input.account_id,
        description: input.description || "",
        pending,
        settled: isFund && buy ? true : input.settled !== false,
        ...(pending
          ? { amount: input.amount }
          : {
              quantity: input.quantity,
              price: input.price,
              ...(input.amount ? { amount: input.amount } : {}),
              fee: input.fee || "0",
              tax: isFund && buy ? "0" : input.tax || "0",
            }),
      };
      await send(`/spaces/${space.id}/investment-trades`, body);
      message.success(
        pending
          ? "已记录申购在途，确认份额后再转为持仓"
          : "已更新持仓与资金记录",
      );
      reload();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${title} · ${holding.instrument_name || holding.name}`}
      open
      width={640}
      onCancel={onClose}
      confirmLoading={busy}
      okText={title}
      cancelText="取消"
      onOk={() => form.submit()}
    >
      <p className="data-caption">
        填写已发生的交易。保存后更新账簿，不会向机构发出买卖指令。
      </p>
      <LoadState {...accounts}>
        <Form
          form={form}
          layout="vertical"
          onFinish={submit}
          initialValues={{
            economic_date: dateToday(),
            account_id: holding.account_id || holding.account_ids?.[0],
            pending: false,
            settled: true,
          }}
        >
          {isFund && buy && (
            <Form.Item name="pending" label="申购进度">
              <Radio.Group
                options={[
                  { value: false, label: "份额已确认" },
                  { value: true, label: "已扣款，份额待确认" },
                ]}
              />
            </Form.Item>
          )}
          <div className="form-grid">
            <Form.Item
              name="economic_date"
              label={pending ? "实际扣款日" : "实际成交 / 确认日"}
              rules={[{ required: true, message: "请选择日期" }]}
            >
              <Input type="date" max={dateToday()} />
            </Form.Item>
            <Form.Item
              name="account_id"
              label="持仓账户"
              rules={[{ required: true, message: "请选择持仓账户" }]}
            >
              <Select options={options} disabled={!!holding.account_id} />
            </Form.Item>
            {pending ? (
              <Form.Item
                name="amount"
                label={`实际扣款金额（${currency}）`}
                rules={[{ required: true, message: "请输入实际扣款金额" }]}
              >
                <InputNumber
                  stringMode
                  min="0.01"
                  precision={2}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  name="quantity"
                  label="成交份额 / 数量"
                  rules={[{ required: true, message: "请输入实际成交数量" }]}
                  extra={
                    !buy && holding.quantity ? (
                      <Button
                        type="link"
                        size="small"
                        onClick={() =>
                          form.setFieldValue(
                            "quantity",
                            String(holding.quantity),
                          )
                        }
                      >
                        填入全部持有份额
                      </Button>
                    ) : undefined
                  }
                >
                  <InputNumber stringMode style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  name="price"
                  label="实际成交价 / 确认净值"
                  rules={[{ required: true, message: "请输入实际成交价格" }]}
                >
                  <InputNumber stringMode style={{ width: "100%" }} />
                </Form.Item>
              </>
            )}
          </div>
          <Form.Item
            name="cash_account_id"
            label={buy ? "付款账户" : "到账账户"}
          >
            <Select
              allowClear
              placeholder={
                accountRows.find((a) => a.id === accountId)?.name ||
                "默认使用持仓账户的现金"
              }
              options={cashOptions}
            />
          </Form.Item>
          <div className="trade-total">
            <span>{buy ? "预计记录付款" : "预计记录收款"}</span>
            <Money value={expected} currency={currency} />
          </div>
          <Collapse
            ghost
            items={[
              {
                key: "details",
                label: "费用与其他信息",
                children: (
                  <>
                    {!pending && (
                      <Form.Item
                        name="amount"
                        label={
                          buy ? "实际付款总额（选填）" : "实际到账总额（选填）"
                        }
                        extra="默认按成交数量、价格及费用算到分；差额作为尾差保留。金额明显不符时请核对，不能直接改收益。"
                      >
                        <InputNumber
                          stringMode
                          precision={2}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    )}
                    {!pending && (
                      <div className="form-grid">
                        <Form.Item name="fee" label="手续费（选填）">
                          <InputNumber
                            stringMode
                            min="0"
                            precision={2}
                            style={{ width: "100%" }}
                          />
                        </Form.Item>
                        {!(isFund && buy) && (
                          <Form.Item name="tax" label="税费（选填）">
                            <InputNumber
                              stringMode
                              min="0"
                              precision={2}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        )}
                      </div>
                    )}
                    {!(isFund && buy) && (
                      <Form.Item name="settled" valuePropName="checked">
                        <Checkbox>
                          {buy ? "款项已在同日扣除" : "款项已在同日到账"}
                        </Checkbox>
                      </Form.Item>
                    )}
                    <Form.Item
                      name="description"
                      label="备注 / 凭证说明（选填）"
                    >
                      <Input.TextArea rows={2} />
                    </Form.Item>
                    <p className="data-caption">
                      未勾选到账或扣款时，先记录待交收金额；实际交收后可在「记一笔
                      → 交易款项交收」补充。
                    </p>
                  </>
                ),
              },
            ]}
          />
          {error && <Alert type="error" showIcon message={error} />}
        </Form>
      </LoadState>
    </Modal>
  );
}
