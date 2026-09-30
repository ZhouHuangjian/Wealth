import { useRef, useState } from "react";
import {
  Alert,
  App,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
} from "antd";
import type { Item } from "../api";
import { dateToday, listOf, send } from "../api";
import { useResource, useWorkspace } from "../state";

export default function FundConvert({
  holding,
  onClose,
}: {
  holding: Item;
  onClose: () => void;
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const products = useResource("instruments", "?limit=1000");
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  return (
    <Modal
      open
      title="记录基金转换"
      width={600}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={busy}
      okText="保存"
    >
      <p>
        <strong>{holding.instrument_name || holding.name}</strong>
      </p>
      <p className="muted">
        记录机构已执行的转换。转出份额按实际确认扣减，转入金额先列为待确认；不发起真实交易。
      </p>
      {error && <Alert message={error} type="error" showIcon />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ economic_date: dateToday(), fee: "0" }}
        disabled={busy}
        onFinish={async (values) => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await send(`/spaces/${space.id}/fund-orders/convert`, {
              ...values,
              account_id: holding.account_id,
              instrument_id: holding.instrument_id || holding.id,
            });
            reload();
            onClose();
            message.success("转换已记录，可在申购进度中确认转入份额");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <Form.Item
          name="target_instrument_id"
          label="转入基金"
          rules={[{ required: true }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={listOf<Item>(products.data)
              .filter(
                (p) =>
                  p.kind === "fund" &&
                  p.specification?.trading_channel !== "exchange" &&
                  p.currency === holding.currency &&
                  p.id !== holding.instrument_id,
              )
              .map((p) => ({ value: p.id, label: `${p.name} · ${p.code}` }))}
          />
        </Form.Item>
        <div className="form-grid">
          <Form.Item
            name="quantity"
            label="转出确认份额"
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
            label="转出确认净值"
            rules={[{ required: true }]}
          >
            <InputNumber
              stringMode
              min="0.00000001"
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            name="economic_date"
            label="机构转换执行日"
            rules={[{ required: true }]}
          >
            <Input type="date" max={dateToday()} />
          </Form.Item>
          <Form.Item name="fee" label="转出手续费（无费用填 0）">
            <InputNumber
              stringMode
              min="0"
              precision={2}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </div>
        <Collapse
          ghost
          items={[
            {
              key: "more",
              label: "转入份额与费用",
              children: (
                <p>
                  转入金额按转出净金额记录。申购费与确认份额可在「基金申购进度」补充，也可开启按正式净值推算。
                </p>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}
