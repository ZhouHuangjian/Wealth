import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
} from "antd";
import { Minus, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { dateToday, send } from "../api";
import type { Item } from "../api";
import { Money } from "../components";
import { useWorkspace } from "../state";
import {
  dcaExcludedDates,
  dcaHistoryRefreshRequest,
  dcaInitialRange,
  dcaPreviewCoverage,
  dcaPreviewMetric,
  dcaPreviewRequest,
  toggleDcaExcludedDate,
} from "../dca-preview";
import DcaHistoryImport from "./DcaHistoryImport";

const statuses: Record<string, string> = {
  estimated: "可估算",
  excluded: "已排除",
  calendar_unknown: "交易日待核实",
  fee_unknown: "费用待补全",
  missing_nav: "缺净值",
};
export default function DcaHistoryPreview({
  plan,
  onClose,
  onRecordHolding,
}: {
  plan: Item;
  onClose: () => void;
  onRecordHolding?: () => void;
}) {
  const { space, hidden, requestReveal } = useWorkspace();
  const navigate = useNavigate(),
    { message } = App.useApp();
  const [form] = Form.useForm();
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [previewFeeMode, setPreviewFeeMode] = useState("unknown"),
    [importOpen, setImportOpen] = useState(false),
    [committing, setCommitting] = useState(false),
    [sections, setSections] = useState<string[]>([]);
  const active = useRef(true),
    sequence = useRef(0);
  const feeMode = Form.useWatch("fee_mode", { form, preserve: true }),
    excludedInput = Form.useWatch("excluded_dates_text", {
      form,
      preserve: true,
    });
  function markDirty() {
    setDirty(true);
    sequence.current++;
    setBusy(false);
  }
  async function preview(values: any) {
    const current = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const result = await send(
        "/spaces/" + space.id + "/plans/" + plan.id + "/history-preview",
        dcaPreviewRequest(values),
      );
      if (active.current && current === sequence.current) {
        setData(result);
        setPreviewFeeMode(result.fee_mode || values.fee_mode);
        setDirty(false);
      }
    } catch (e) {
      if (active.current && current === sequence.current)
        setError((e as Error).message);
    } finally {
      if (active.current && current === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    const initial = {
      ...dcaInitialRange(plan, dateToday()),
      fee_mode: "unknown",
      excluded_dates_text: "",
      pause_ranges: [],
    };
    form.setFieldsValue(initial);
    void preview(initial);
    return () => {
      active.current = false;
      sequence.current++;
    };
  }, [plan.id]);
  const theoretical = previewFeeMode === "unknown",
    coverage = dcaPreviewCoverage(data || {}, theoretical);
  const metrics = [
    ["计划投入", "selected_amount", "known_selected_amount"],
    theoretical
      ? [
          "理论份额（未扣费）",
          "theoretical_quantity",
          "known_theoretical_quantity",
        ]
      : ["估算份额", "estimated_quantity", "known_quantity"],
    theoretical
      ? ["理论市值（未扣费）", "theoretical_value", "known_theoretical_value"]
      : ["估算市值", "estimated_value", "known_value"],
    theoretical
      ? ["理论收益（未扣费）", "theoretical_profit", "known_theoretical_profit"]
      : ["估算收益", "estimated_profit", "known_profit"],
  ];
  const notes = [
    ...(data?.warnings || []),
    ...(data?.gaps || data?.summary?.gaps || []),
  ]
    .map((item: any) =>
      typeof item === "string" ? item : item.message || item.reason,
    )
    .filter(Boolean);
  const partial =
    data?.status === "partial" || data?.summary?.status === "partial";
  function existingHolding() {
    setImportOpen(false);
    onClose();
    if (onRecordHolding) onRecordHolding();
    else navigate("/spaces/" + space.id + "/assets?tab=products");
  }
  return (
    <Modal
      open
      className="dca-dialog"
      title={"历史定投 · " + plan.name}
      width={1000}
      onCancel={() => !committing && onClose()}
      closable={!committing}
      maskClosable={!committing}
      keyboard={!committing}
      footer={
        importOpen ? null : (
          <Space wrap>
            <Button onClick={onClose}>关闭</Button>
            {dirty && (
              <Button loading={busy} onClick={() => form.submit()}>
                更新预览
              </Button>
            )}
            {space.role !== "viewer" && (
              <Button
                type="primary"
                disabled={
                  !data ||
                  dirty ||
                  busy ||
                  !(data.items || []).some((row: any) => row.selected === true)
                }
                onClick={() => requestReveal(() => setImportOpen(true))}
              >
                按此预览补录
              </Button>
            )}
          </Space>
        )
      }
    >
      <Steps
        size="small"
        current={importOpen ? 1 : 0}
        items={[{ title: "估算预览" }, { title: "确认补录" }]}
      />
      {importOpen && data ? (
        <DcaHistoryImport
          plan={plan}
          preview={data}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            void preview(form.getFieldsValue(true));
          }}
          onRecordHolding={existingHolding}
          onCommittingChange={setCommitting}
        />
      ) : (
        <div className="dca-step-content">
          <div className="dca-toolbar">
            <span>
              {data?.start || plan.start_date} 至 {data?.end || dateToday()} ·
              每期{" "}
              <Money
                value={plan.amount}
                currency={plan.currency}
                precision={2}
              />
            </span>
            <Button
              type="link"
              onClick={() =>
                setSections((current) =>
                  current.includes("settings")
                    ? current.filter((key) => key !== "settings")
                    : [...current, "settings"],
                )
              }
            >
              调整日期 / 费用
            </Button>
          </div>
          {busy && !data ? <Spin /> : null}
          {data && (
            <div className="dca-summary-grid">
              {metrics.map(([label, total, known]) => {
                const metric = dcaPreviewMetric(data.summary, total, known);
                return (
                  <div className="dca-summary-card" key={total}>
                    <span>
                      {label}
                      {metric.partial ? " · 已知部分" : ""}
                    </span>
                    <strong>
                      <Money
                        value={metric.value}
                        precision={2}
                        currency={
                          total.endsWith("quantity") ? "" : data.currency
                        }
                        sign={total.endsWith("profit")}
                      />
                    </strong>
                    {total !== "selected_amount" && (
                      <small>
                        覆盖 {coverage.known_count} / {coverage.selected_count}{" "}
                        期
                      </small>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <Alert
            className="dca-status"
            showIcon
            type={error || dirty || partial ? "warning" : "info"}
            message={
              error ||
              (dirty
                ? "参数已改变，请更新预览"
                : theoretical
                  ? "费用尚未填写，当前为未扣费理论值"
                  : "按参考交易日估算，预览本身不改账")
            }
            description={
              data ? (
                <>
                  <span>
                    可估算投入{" "}
                    <Money
                      value={coverage.known_amount}
                      currency={data.currency}
                      precision={2}
                    />
                    （{coverage.known_count} 期），尚不可估算{" "}
                    <Money
                      value={coverage.unknown_amount}
                      currency={data.currency}
                      precision={2}
                    />
                    （{coverage.unknown_count} 期）。
                  </span>
                  {coverage.pending_count > 0 && (
                    <span>
                      {" "}
                      全部期次中预计仍在途{" "}
                      <Money
                        value={coverage.pending_amount}
                        currency={data.currency}
                        precision={2}
                      />
                      （{coverage.pending_count}{" "}
                      期），估算份额不等于已确认份额。
                    </span>
                  )}
                  {coverage.unknown_calendar_count > 0 && (
                    <span>
                      {" "}
                      另有 {coverage.unknown_calendar_count}{" "}
                      个日期的交易日信息未知，未计入确定投入。
                    </span>
                  )}
                  {theoretical && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() =>
                        setSections((current) => [
                          ...new Set([...current, "settings"]),
                        ])
                      }
                    >
                      设置每期费用
                    </Button>
                  )}
                </>
              ) : undefined
            }
          />
          <Form
            form={form}
            layout="vertical"
            onFinish={preview}
            onValuesChange={markDirty}
          >
            <Collapse
              ghost
              activeKey={sections}
              onChange={(keys) =>
                setSections(Array.isArray(keys) ? keys : [keys])
              }
              items={[
                {
                  key: "settings",
                  label: "日期、费用与排除设置",
                  forceRender: true,
                  children: (
                    <>
                      <div className="dca-row-fields">
                        <Form.Item
                          name="start"
                          label="开始日期"
                          rules={[{ required: true }]}
                        >
                          <Input type="date" max={dateToday()} />
                        </Form.Item>
                        <Form.Item
                          name="end"
                          label="结束及估值日期"
                          rules={[{ required: true }]}
                        >
                          <Input type="date" max={dateToday()} />
                        </Form.Item>
                        <Form.Item
                          name="fee_mode"
                          label="每期费用"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={[
                              { value: "unknown", label: "暂不清楚" },
                              { value: "zero", label: "每期为 0" },
                              { value: "fixed", label: "每期固定金额" },
                            ]}
                          />
                        </Form.Item>
                        {feeMode === "fixed" && (
                          <Form.Item
                            name="fee_amount"
                            label="费用金额"
                            preserve={false}
                            rules={[{ required: true }]}
                          >
                            <InputNumber
                              stringMode
                              changeOnBlur={false}
                              style={{ width: "100%" }}
                              addonAfter={plan.currency}
                            />
                          </Form.Item>
                        )}
                      </div>
                      <Form.Item
                        name="excluded_dates_text"
                        label="排除日期（失败扣款 / 暂停申购）"
                      >
                        <Input.TextArea
                          rows={2}
                          placeholder="YYYY-MM-DD，多日用逗号分隔"
                        />
                      </Form.Item>
                      <Form.List name="pause_ranges">
                        {(fields, { add, remove }) => (
                          <>
                            {fields.map(({ key, name, ...rest }) => (
                              <Space key={key} align="baseline" wrap>
                                <Form.Item
                                  {...rest}
                                  name={[name, "start"]}
                                  label="暂停开始"
                                  rules={[{ required: true }]}
                                >
                                  <Input type="date" max={dateToday()} />
                                </Form.Item>
                                <Form.Item
                                  {...rest}
                                  name={[name, "end"]}
                                  label="暂停结束"
                                  rules={[{ required: true }]}
                                >
                                  <Input type="date" max={dateToday()} />
                                </Form.Item>
                                <Button
                                  type="text"
                                  aria-label="移除暂停区间"
                                  icon={<Minus size={16} />}
                                  onClick={() => {
                                    remove(name);
                                    markDirty();
                                  }}
                                />
                              </Space>
                            ))}
                            <Button
                              icon={<Plus size={14} />}
                              onClick={() => {
                                add();
                                markDirty();
                              }}
                            >
                              添加暂停区间
                            </Button>
                          </>
                        )}
                      </Form.List>
                      <div className="dca-toolbar">
                        <Button type="primary" htmlType="submit" loading={busy}>
                          更新预览
                        </Button>
                        {space.role !== "viewer" && (
                          <Button
                            loading={refreshing}
                            onClick={async () => {
                              setRefreshing(true);
                              try {
                                await send(
                                  "/spaces/" + space.id + "/market/refresh",
                                  dcaHistoryRefreshRequest(
                                    plan,
                                    form.getFieldsValue(true),
                                    dateToday(),
                                  ),
                                );
                                message.success(
                                  "历史行情更新已提交后台，稍后更新预览核对",
                                );
                              } catch (e) {
                                message.error((e as Error).message);
                              } finally {
                                setRefreshing(false);
                              }
                            }}
                          >
                            刷新历史行情
                          </Button>
                        )}
                      </div>
                    </>
                  ),
                },
                {
                  key: "details",
                  label:
                    "查看每期明细" +
                    (data ? "（" + (data.items || []).length + "期）" : ""),
                  children: (
                    <Table<Item>
                      size="small"
                      rowKey={(row) => row.date}
                      dataSource={data?.items || []}
                      pagination={{ pageSize: 10, showSizeChanger: true }}
                      scroll={{ x: 720 }}
                      columns={[
                        { title: "计划日期", dataIndex: "date", width: 125 },
                        {
                          title: "投入",
                          width: 100,
                          render: (_, row) => (
                            <Money value={row.amount} precision={2} />
                          ),
                        },
                        {
                          title: "份额",
                          width: 120,
                          render: (_, row) => (
                            <Money
                              value={
                                theoretical
                                  ? row.theoretical_quantity
                                  : row.estimated_quantity
                              }
                              precision={2}
                            />
                          ),
                        },
                        {
                          title: "市值 / 收益",
                          width: 180,
                          render: (_, row) => (
                            <div className="cell-name">
                              <Money
                                value={
                                  theoretical
                                    ? row.theoretical_value
                                    : row.current_value
                                }
                                precision={2}
                              />
                              <small>
                                <Money
                                  value={
                                    theoretical
                                      ? row.theoretical_profit
                                      : row.estimated_profit
                                  }
                                  precision={2}
                                  sign
                                />
                              </small>
                            </div>
                          ),
                        },
                        {
                          title: "状态",
                          width: 150,
                          render: (_, row) => (
                            <div className="cell-name">
                              <Tag>{statuses[row.status] || row.status}</Tag>
                              {row.pending_forecast === true && (
                                <small>预计在途</small>
                              )}
                            </div>
                          ),
                        },
                        {
                          title: "操作",
                          width: 90,
                          render: (_, row) =>
                            row.excluded_reason === "paused" ? (
                              <small>暂停区间</small>
                            ) : (
                              <Button
                                size="small"
                                type="link"
                                onClick={() => {
                                  form.setFieldValue(
                                    "excluded_dates_text",
                                    toggleDcaExcludedDate(
                                      form.getFieldValue("excluded_dates_text"),
                                      row.date,
                                    ),
                                  );
                                  markDirty();
                                }}
                              >
                                {dcaExcludedDates(excludedInput).includes(
                                  row.date,
                                )
                                  ? "恢复"
                                  : "排除"}
                              </Button>
                            ),
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: "notes",
                  label: "估算口径与数据来源",
                  children: (
                    <div className="data-caption">
                      <p>
                        参考交易日不保证基金开放申购；请排除实际未扣款日期。确认前不改账，补录后保留“按预览补录”来源，不标成机构原始确认。未知费用和缺净值不按零或前一日数据代替。
                      </p>
                      <p>
                        估值净值{" "}
                        <Money value={data?.current_nav?.value} precision={2} />{" "}
                        · {data?.current_nav?.date || "待补全"} ·{" "}
                        {data?.current_nav?.source || "暂无来源"}
                        {data?.current_nav?.is_stale ? " · 历史净值" : ""}
                        。金额展示 2 位、份额 6 位；预填补录份额取 2
                        位，可展开修改。
                      </p>
                      {data?.overlap?.exists && (
                        <p>
                          {hidden ? "已有记录提示已隐藏" : data.overlap.message}
                        </p>
                      )}
                      {[...new Set<string>(notes)].map((note, index) => (
                        <p key={index}>{hidden ? "内容已隐藏" : note}</p>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          </Form>
        </div>
      )}
    </Modal>
  );
}
