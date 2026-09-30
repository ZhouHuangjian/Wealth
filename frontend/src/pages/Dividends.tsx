import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
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
import { dividendConfirmation } from "../investment";
import { dateToday, listOf, send } from "../api";
import { Fields, LoadState, Money, Panel } from "../components";
import { HelpText, helpColumns } from "../help";
import { useResource, useWorkspace } from "../state";

export default function Dividends() {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false),
    [polls, setPolls] = useState(0),
    [error, setError] = useState("");
  const state = useResource("dividends", `?offset=${(page - 1) * 20}&limit=20`);
  const { message } = App.useApp();
  const submitLock = useRef(false);
  const [form] = Form.useForm();
  const mode = Form.useWatch("mode", form);
  const writable = space.role !== "viewer";
  useEffect(() => {
    if (!polls) return;
    const timer = window.setTimeout(() => {
      void state.retry();
      setPolls((n) => n - 1);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [polls, state.retry]);
  const sources = state.data?.sources || [];
  const failed = sources.filter((r: any) => r.status === "failed");
  function review(item: any) {
    requestReveal(() => {
      setError("");
      setSelected(item);
      form.resetFields();
      form.setFieldsValue({
        mode: item.matching_events?.length ? "link" : "cash",
        economic_date: dateToday(),
        fee: "0",
        tax: "0",
        actual_confirmed: false,
      });
    });
  }
  return (
    <Panel
      title="基金分红"
      action={
        <Space>
          <Button
            loading={checking}
            disabled={!writable}
            onClick={async () => {
              setChecking(true);
              try {
                const r: any = await send(
                  `/spaces/${space.id}/dividends/refresh`,
                  {},
                );
                message.info(r.message);
                await state.retry();
                setPolls(8);
              } catch (e) {
                message.error((e as Error).message);
              } finally {
                setChecking(false);
              }
            }}
          >
            检查分红公告
          </Button>
          <Button onClick={() => void state.retry()}>刷新结果</Button>
        </Space>
      }
    >
      <Alert
        showIcon
        message="自动查公告，核对后入账"
        description={
          state.data?.support ||
          "自动匹配登记日份额并估算分红；请按机构实际记录确认现金到账或红利再投。"
        }
      />
      <Space className="form-alert" wrap>
        <Switch
          aria-label="自动检查基金分红"
          checked={!!state.data?.settings.enabled}
          disabled={!writable || !state.data}
          onChange={async (enabled) => {
            try {
              await send(
                `/spaces/${space.id}/dividends/settings`,
                { enabled, version: state.data.settings.version },
                "PUT",
              );
              await state.retry();
              message.success(enabled ? "已开启定期检查" : "已关闭定期检查");
            } catch (e) {
              message.error((e as Error).message);
            }
          }}
        />
        <span>定期检查分红公告</span>
        <span className="muted">公告缓存每日更新；机构到账后再确认金额。</span>
      </Space>
      {polls > 0 && (
        <Alert
          type="info"
          message="检查已排队，结果会自动刷新。若暂未完成，可稍后点击“刷新结果”。"
        />
      )}
      {!!failed.length && (
        <Alert
          type="warning"
          message={`${failed.length} 个产品的公告暂未更新，已有记录仍可核对。`}
          description={failed
            .map((r: any) => r.message)
            .filter(Boolean)
            .join("；")}
        />
      )}
      <LoadState {...state}>
        <Table<any>
          rowKey="id"
          scroll={{ x: 950 }}
          dataSource={listOf<any>(state.data)}
          pagination={{
            current: page,
            pageSize: 20,
            total: state.data?.count || 0,
            onChange: setPage,
            showSizeChanger: false,
          }}
          columns={helpColumns([
            {
              title: "基金 / 账户",
              render: (_: any, r: any) => (
                <div className="cell-name">
                  <strong>{hidden ? "名称已隐藏" : r.instrument_name}</strong>
                  <small>{hidden ? "账户已隐藏" : r.account_name}</small>
                </div>
              ),
            },
            { title: "权益登记日", dataIndex: "record_date" },
            { title: "除息日", dataIndex: "ex_date" },
            { title: "公告发放日", dataIndex: "payment_date" },
            {
              title: "每 10 份分红",
              render: (_: any, r: any) => (
                <Money value={r.amount_per_10} currency={r.currency} />
              ),
            },
            {
              title: "估算分红",
              render: (_: any, r: any) =>
                r.estimated_amount == null ? (
                  <Tag>份额待核对</Tag>
                ) : (
                  <Money value={r.estimated_amount} currency={r.currency} />
                ),
            },
            {
              title: "状态",
              render: (_: any, r: any) => (
                <Tag color={r.status === "confirmed" ? "green" : "orange"}>
                  {r.status === "confirmed"
                    ? "已确认"
                    : r.status === "reversed"
                      ? "已冲正，待重核"
                      : "待确认"}
                </Tag>
              ),
            },
            {
              title: "操作",
              render: (_: any, r: any) => (
                <Button
                  type="link"
                  disabled={!writable || !r.can_confirm}
                  onClick={() => review(r)}
                >
                  {r.matching_events?.length ? "核对已有流水" : "确认分红"}
                </Button>
              ),
            },
          ])}
        />
      </LoadState>
      {!state.loading && !sources.length && (
        <p className="muted">
          录入境内人民币基金持仓后，开启检查或点击“检查分红公告”。登记日没有份额记录时，将提示按机构记录核对。
        </p>
      )}
      {!!sources.length && (
        <details className="form-alert">
          <summary>公告更新记录</summary>
          <Table<any>
            size="small"
            rowKey="id"
            pagination={{ pageSize: 8 }}
            dataSource={sources}
            columns={helpColumns<any>([
              { title: "产品代码", render: (_, r) => r.identity?.code || "—" },
              {
                title: "状态",
                render: (_, r) =>
                  (
                    ({
                      ready: "已更新",
                      fetching: "检查中",
                      failed: "暂未更新",
                      superseded: "产品已变更",
                    }) as any
                  )[r.status] || "待检查",
              },
              { title: "公告数", dataIndex: "notice_count" },
              {
                title: "最近成功",
                render: (_, r) =>
                  r.fetched_at ? new Date(r.fetched_at).toLocaleString() : "—",
              },
            ])}
          />
        </details>
      )}
      <Modal
        title="核对并确认基金分红"
        open={!!selected}
        width={640}
        onCancel={() => {
          if (!submitLock.current) setSelected(null);
        }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        cancelButtonProps={{ disabled: busy }}
        okText={mode === "link" ? "关联已有流水" : "确认并记账"}
        confirmLoading={busy}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Descriptions
          size="small"
          column={2}
          items={[
            { key: "p", label: "基金", children: selected?.instrument_name },
            { key: "a", label: "账户", children: selected?.account_name },
            {
              key: "d",
              label: <HelpText text="权益登记日" />,
              children: selected?.record_date,
            },
            {
              key: "s",
              label: "参考金额",
              children:
                selected?.estimated_amount == null ? (
                  "登记日份额不足，待核对"
                ) : (
                  <Money
                    value={selected?.estimated_amount}
                    currency={selected?.currency}
                  />
                ),
            },
          ]}
        />
        <Alert
          className="form-alert"
          showIcon
          message={selected?.message || "请以机构实际记录为准。"}
        />
        {!!selected?.matching_events?.length && (
          <Alert
            className="form-alert"
            type="warning"
            message="账本中有可能对应的分红，请核对后关联，避免重复计入。"
            description="未指定产品的导入流水也会列出，请确认它确实属于此基金。若均不匹配，请先核对账本中的产品、日期和金额。"
          />
        )}
        <Form
          form={form}
          disabled={busy}
          layout="vertical"
          onFinish={async (values) => {
            if (submitLock.current) return;
            submitLock.current = true;
            setBusy(true);
            setError("");
            try {
              const body = dividendConfirmation(values);
              await send(
                `/spaces/${space.id}/dividends/${selected.id}/confirm`,
                { ...body, version: selected.version },
              );
              setSelected(null);
              reload();
              message.success(
                mode === "link" ? "已关联，未重复记账" : "分红已记入账本",
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              submitLock.current = false;
              setBusy(false);
            }
          }}
        >
          <Form.Item
            name="mode"
            label="分红处理方式"
            rules={[{ required: true }]}
          >
            <Select
              options={
                selected?.matching_events?.length
                  ? [{ value: "link", label: "关联已有分红流水" }]
                  : [
                      { value: "cash", label: "现金分红：金额到账户" },
                      { value: "reinvest", label: "红利再投：增加基金份额" },
                    ]
              }
            />
          </Form.Item>
          {mode === "link" ? (
            <Form.Item
              name="event_id"
              label="已有记录"
              rules={[{ required: true, message: "请选择核对一致的流水" }]}
            >
              <Select
                options={(selected?.matching_events || []).map((e: any) => ({
                  value: e.id,
                  label: `${e.economic_date} · ${e.kind === "dividend" ? "现金分红" : "红利再投"} · ${e.amount ?? "金额见原流水"} ${selected.currency}${e.product_match === "unassigned_product" ? " · 尚未指定基金" : ""}`,
                }))}
              />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name="economic_date"
                label={mode === "cash" ? "实际到账日期" : "实际再投确认日期"}
                rules={[{ required: true }]}
              >
                <Input
                  type="date"
                  max={dateToday()}
                  min={selected?.record_date}
                />
              </Form.Item>
              {mode === "cash" ? (
                <Form.Item
                  name="amount"
                  label="实际分红金额（税费前）"
                  rules={[{ required: true, message: "请填写机构确认金额" }]}
                >
                  <InputNumber
                    stringMode
                    min="0.01"
                    style={{ width: "100%" }}
                    addonAfter={selected?.currency}
                  />
                </Form.Item>
              ) : (
                <Fields
                  fields={[
                    {
                      name: "quantity",
                      label: "实际再投份额",
                      type: "number",
                      required: true,
                    },
                    {
                      name: "price",
                      label: "再投确认净值",
                      type: "number",
                      required: true,
                    },
                  ]}
                />
              )}
              <Fields
                fields={[
                  { name: "fee", label: "手续费", type: "number" },
                  {
                    name: "tax",
                    label: "税款",
                    type: "number",
                    visibleWhen: (v) => v.mode === "cash",
                  },
                ]}
              />
            </>
          )}
          <Form.Item
            name="actual_confirmed"
            valuePropName="checked"
            rules={[
              {
                validator: (_, v) =>
                  v
                    ? Promise.resolve()
                    : Promise.reject(new Error("请核对机构记录后勾选确认")),
              },
            ]}
          >
            <Checkbox>我已核对机构实际到账或红利再投记录</Checkbox>
          </Form.Item>
        </Form>
        {error && <Alert type="error" message={error} />}
      </Modal>
    </Panel>
  );
}
