import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Table,
  Tag,
} from "antd";
import { FileUp } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, listOf, send } from "../api";
import type { Item } from "../api";
import { LoadState, Money } from "../components";
import { useResource, useWorkspace } from "../state";
import {
  fundApplyRequest,
  fundCandidateLinkable,
  fundMappingDefaults,
  fundPreviewRequest,
} from "../fund-reconciliation";

const statuses: Record<string, { label: string; color?: string }> = {
  exact_match: { label: "一致 · 可绑定", color: "green" },
  review: { label: "待复核", color: "orange" },
  unmatched: { label: "未找到原记录" },
  duplicate: { label: "已有来源 · 仅关联证据" },
  applied: { label: "已核对", color: "green" },
  error: { label: "字段需修正", color: "red" },
};
const numericFields = new Set(["amount", "quantity", "nav", "fee"]);
const labels: Record<string, string> = {
  code: "基金代码",
  application_date: "申请日",
  payment_date: "实际扣款日",
  confirmation_date: "实际确认日",
  amount: "扣款金额",
  quantity: "确认份额",
  nav: "确认净值",
  fee: "实际费用",
  external_id: "机构订单号",
  source_row_id: "机构行标识",
  currency: "币种",
};
function issueText(issue: any) {
  return typeof issue === "string"
    ? issue
    : issue?.message || issue?.label || "此行需要核对";
}

export default function FundReconciliation({
  initialBatch,
  onClose,
  onDone,
}: {
  initialBatch?: Item;
  onClose: () => void;
  onDone: () => void;
}) {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const navigate = useNavigate(),
    { message } = App.useApp();
  const accountsState = useResource("accounts", "?limit=1000"),
    instrumentsState = useResource("instruments", "?limit=1000");
  const [form] = Form.useForm();
  const accountId = Form.useWatch("account_id", form);
  const [file, setFile] = useState<File | null>(null),
    [batch, setBatch] = useState<any>(initialBatch || null),
    [headers, setHeaders] = useState<string[]>([]),
    [settings, setSettings] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [step, setStep] = useState(initialBatch ? 1 : 0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!initialBatch),
    [stale, setStale] = useState(false),
    [settingsRevision, setSettingsRevision] = useState(0),
    [resumeFailed, setResumeFailed] = useState(false),
    [choices, setChoices] = useState<Record<string, any>>({});
  const settingSeq = useRef(0),
    lock = useRef(false);
  const readOnly = space.role === "viewer";
  const accounts = listOf<Item>(accountsState.data).filter(
    (a) => !a.archived && a.valuation_mode !== "snapshot",
  );
  const holdingOptions = accounts
    .filter((a) =>
      ["fund", "broker", "securities", "bank", "wallet"].includes(a.kind),
    )
    .map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }));
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const fundingOptions = accounts
    .filter(
      (a) =>
        ["bank", "cash", "wallet", "fund", "broker", "securities"].includes(
          a.kind,
        ) &&
        (!selectedAccount || a.currency === selectedAccount.currency),
    )
    .map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }));
  const instruments = listOf<Item>(instrumentsState.data).filter(
    (i) => i.kind === "fund",
  );
  const fields: any[] = settings?.fields || [];
  const rows: any[] = preview?.rows || [];
  const mappedLocked = [
    "committed",
    "partially_committed",
    "reversed",
  ].includes(batch?.status);
  async function resume() {
    if (!initialBatch) return;
    setLoading(true);
    setError("");
    setResumeFailed(false);
    try {
      const result = await api(
        `/spaces/${space.id}/imports/${initialBatch.id}/fund-preview`,
      );
      setBatch(result.batch || initialBatch);
      setHeaders(result.headers || []);
      form.setFieldsValue({
        account_id:
          result.account_id ||
          result.context?.account_id ||
          result.batch?.account_id ||
          initialBatch.account_id,
        instrument_id: result.instrument_id || result.context?.instrument_id,
        funding_account_id:
          result.funding_account_id || result.context?.funding_account_id,
        mapping: result.mapping || {},
      });
      if (result.rows?.length) {
        setPreview(result);
        setStep(2);
      }
    } catch (e) {
      setError((e as Error).message);
      setResumeFailed(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void resume();
  }, [initialBatch?.id, space.id]);
  useEffect(() => {
    if (!accountId || hidden) return;
    const seq = ++settingSeq.current;
    setSettings(null);
    api(
      `/spaces/${space.id}/fund-reconciliation/settings?${new URLSearchParams({ account_id: accountId })}`,
    )
      .then((result) => {
        if (seq !== settingSeq.current) return;
        setSettings(result);
        form.setFieldValue(
          "mapping",
          fundMappingDefaults(headers, result.fields || [], {
            ...result.mapping,
            ...form.getFieldValue("mapping"),
          }),
        );
      })
      .catch((e) => {
        if (seq === settingSeq.current) setError(e.message);
      });
    return () => {
      settingSeq.current++;
    };
  }, [accountId, space.id, headers.join("\u0001"), hidden, settingsRevision]);

  async function upload() {
    if (lock.current || readOnly || hidden) return;
    setError("");
    try {
      const values = await form.validateFields(["account_id"]);
      if (!file) throw new Error("请选择标准 CSV 或 XLSX 文件");
      if (!/\.(csv|xlsx)$/i.test(file.name))
        throw new Error("请使用标准 CSV 或 XLSX 文件");
      lock.current = true;
      setBusy(true);
      const data = new FormData();
      data.append("file", file);
      data.append("source", "standard_fund");
      data.append("account_id", values.account_id);
      const result = await api(`/spaces/${space.id}/imports`, {
        method: "POST",
        body: data,
      });
      setBatch(result);
      setHeaders(result.diagnostics?.headers || result.columns || []);
      if (result.parser_version === "fund-confirmation-1") {
        const previous = await api(
          `/spaces/${space.id}/imports/${result.id}/fund-preview`,
        );
        setPreview(previous);
        setBatch(previous.batch || result);
        setHeaders(previous.headers || []);
        setStep(2);
        form.setFieldsValue({
          ...previous.context,
          mapping: previous.mapping || {},
        });
        message.info("同一文件已存在，已打开原核对结果。");
      } else setStep(1);
      onDone();
    } catch (e) {
      if (e instanceof Error) setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function makePreview() {
    if (lock.current || !batch || readOnly || hidden) return;
    setError("");
    try {
      const values = await form.validateFields();
      const body = fundPreviewRequest(values, fields, headers);
      lock.current = true;
      setBusy(true);
      const result = await send(
        `/spaces/${space.id}/imports/${batch.id}/fund-preview`,
        body,
      );
      setPreview(result);
      setHeaders(result.headers || headers);
      setChoices({});
      setStale(false);
      setStep(2);
    } catch (e) {
      if (e instanceof Error) setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function refreshPreview() {
    if (lock.current || !batch || readOnly || hidden) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await send(
        `/spaces/${space.id}/imports/${batch.id}/fund-preview`,
        { refresh_only: true },
      );
      setPreview(result);
      setBatch(result.batch || batch);
      setChoices({});
      setStale(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function loadMore() {
    if (lock.current || !preview?.has_more || hidden) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await api(
        `/spaces/${space.id}/imports/${batch.id}/fund-preview?offset=${rows.length}&limit=500`,
      );
      if (
        next.preview_version !== preview.preview_version ||
        next.preview_hash !== preview.preview_hash ||
        next.ledger_revision !== preview.ledger_revision
      ) {
        setStale(true);
        throw new Error("核对结果已更新，请重新核对后载入剩余行");
      }
      setPreview({ ...next, rows: [...rows, ...next.rows] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  let applyBody: any = null;
  let decisionError = "";
  if (preview) {
    try {
      applyBody = fundApplyRequest(preview, choices);
    } catch (e) {
      if (Object.values(choices).some((choice) => choice.action))
        decisionError = (e as Error).message;
    }
  }
  async function apply() {
    if (lock.current || readOnly || hidden || stale) return;
    setError("");
    try {
      const body = fundApplyRequest(preview, choices);
      lock.current = true;
      setBusy(true);
      const result = await send(
        `/spaces/${space.id}/imports/${batch.id}/fund-apply`,
        body,
      );
      message.success(
        `已绑定 ${result.linked || 0} 行、更正 ${result.corrected || 0} 行、跳过 ${result.skipped || 0} 行`,
      );
      setChoices({});
      setStale(true);
      reload();
      onDone();
      try {
        const fresh = await api(
          `/spaces/${space.id}/imports/${batch.id}/fund-preview`,
        );
        setPreview(fresh);
        setBatch(fresh.batch || batch);
        setStale(false);
      } catch {
        setError("本次核对已保存。请重新生成结果后继续处理剩余行。");
      }
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && [409, 412].includes(e.status))
        setStale(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const changeChoice = (row: any, patch: any) =>
    setChoices((current) => ({
      ...current,
      [row.id]: { ...current[row.id], ...patch },
    }));
  const detail = (row: any) => {
    const choice = choices[row.id] || {},
      candidates = row.candidates || [];
    const candidate =
      candidates.find((c: any) => c.debit_event_id === choice.debit_event_id) ||
      (candidates.length === 1 ? candidates[0] : null);
    return (
      <div className="fund-row-detail">
        <div className="fund-facts">
          {Object.entries(row.normalized || {})
            .filter(([key]) => key in labels)
            .map(([key, value]) => (
              <div key={key}>
                <span>{labels[key]}</span>
                <strong>
                  {numericFields.has(key) ? (
                    <Money
                      value={value}
                      precision={["quantity", "nav"].includes(key) ? 6 : 2}
                    />
                  ) : (
                    String(value ?? "未提供")
                  )}
                </strong>
              </div>
            ))}
        </div>
        {!!row.missing_fields?.length && (
          <p className="data-caption">
            未提供：
            {row.missing_fields
              .map(
                (f: any) =>
                  labels[typeof f === "string" ? f : f.key] || issueText(f),
              )
              .join("、")}
            。仅核对已提供的事实，不补造费用或份额。
          </p>
        )}
        {!!row.errors?.length && (
          <ul>
            {row.errors.map((issue: any, i: number) => (
              <li key={i}>{issueText(issue)}</li>
            ))}
          </ul>
        )}
        {candidates.length > 1 && (
          <Select
            aria-label={`第${row.row_number}行原记录`}
            placeholder="选择要核对的原记录"
            style={{ width: "100%" }}
            value={choice.debit_event_id}
            options={candidates.map((c: any, i: number) => ({
              value: c.debit_event_id,
              label: `记录 ${i + 1} · ${c.payment_date || "日期未提供"} · ${c.debit_amount || "金额未提供"}`,
            }))}
            onChange={(debit_event_id) =>
              changeChoice(row, {
                debit_event_id,
                action: undefined,
                reason: "",
              })
            }
          />
        )}
        {candidate && (
          <>
            {!!candidate.differences?.length && (
              <Table
                size="small"
                rowKey="field"
                pagination={false}
                dataSource={candidate.differences}
                columns={[
                  {
                    title: "差异字段",
                    render: (_, d: any) =>
                      d.label || labels[d.field] || d.field,
                  },
                  {
                    title: "原记录",
                    render: (_, d: any) =>
                      numericFields.has(d.field) ? (
                        <Money value={d.recorded} precision={6} />
                      ) : (
                        String(d.recorded ?? "未提供")
                      ),
                  },
                  {
                    title: "机构账单",
                    render: (_, d: any) =>
                      numericFields.has(d.field) ? (
                        <Money value={d.actual} precision={6} />
                      ) : (
                        String(d.actual ?? "未提供")
                      ),
                  },
                ]}
              />
            )}
            {candidate.correction_allowed && candidate.correction_impact && (
              <p className="fund-impact">
                如选择更正，扣款为{" "}
                <Money value={candidate.correction_impact.new_amount} />
                ；付款账户余额变化{" "}
                <Money value={candidate.correction_impact.cash_delta} sign />。
                {candidate.correction_impact.requires_reversal === true
                  ? "原自动记录将保留冲正轨迹。"
                  : "追加机构实际确认份额，不再次扣款。"}
              </p>
            )}
            {candidate.blocked_reason && (
              <p className="data-caption">
                更正限制：{candidate.blocked_reason}
              </p>
            )}
          </>
        )}
        {row.note && <p className="data-caption">{row.note}</p>}
        {row.status !== "applied" && (
          <div className="fund-row-actions">
            <Select
              aria-label={`第${row.row_number}行处理方式`}
              style={{ width: 260, maxWidth: "100%" }}
              value={choice.action || "pending"}
              disabled={busy}
              options={[
                {
                  value: "pending",
                  label: ["exact_match", "duplicate"].includes(row.status)
                    ? "默认：核对并绑定一致记录"
                    : "暂不处理",
                },
                ...(fundCandidateLinkable(candidate) && !row.errors?.length
                  ? [
                      {
                        value: "link",
                        label:
                          candidate.exact === true
                            ? "绑定一致记录"
                            : "仅核实已提供的事实",
                      },
                    ]
                  : []),
                ...(candidate?.correction_allowed && !row.errors?.length
                  ? [{ value: "correct", label: "按机构账单更正原记录" }]
                  : []),
                { value: "skip", label: "跳过此行" },
              ]}
              onChange={(action) =>
                changeChoice(row, {
                  action: action === "pending" ? undefined : action,
                  debit_event_id: candidate?.debit_event_id,
                })
              }
            />
            {choice.action === "correct" && (
              <Input.TextArea
                aria-label={`第${row.row_number}行更正原因`}
                placeholder="更正原因（必填）"
                maxLength={500}
                value={choice.reason}
                onChange={(e) => changeChoice(row, { reason: e.target.value })}
                autoSize={{ minRows: 1, maxRows: 3 }}
              />
            )}
          </div>
        )}
        {row.status === "unmatched" && (
          <p>
            这里不会新建交易。
            <Button
              size="small"
              type="link"
              onClick={() => {
                onClose();
                navigate(`/spaces/${space.id}/cashbook?tab=investments`);
              }}
            >
              前往基金买入记录
            </Button>
          </p>
        )}
      </div>
    );
  };
  return (
    <Modal
      open
      title="基金交易核对"
      width={1100}
      className="fund-reconciliation-dialog"
      destroyOnHidden
      onCancel={busy ? undefined : onClose}
      footer={
        hidden ? (
          <Button onClick={() => requestReveal(() => {})}>显示数据</Button>
        ) : (
          <Space wrap>
            <Button onClick={onClose} disabled={busy}>
              关闭
            </Button>
            {step > 0 && !mappedLocked && (
              <Button
                disabled={busy}
                onClick={() => {
                  setStep(1);
                  setError("");
                }}
              >
                字段映射
              </Button>
            )}
            {step === 0 ? (
              <Button
                type="primary"
                onClick={() => void upload()}
                loading={busy}
                disabled={readOnly}
              >
                上传并读取
              </Button>
            ) : step === 1 ? (
              <Button
                type="primary"
                onClick={() => void makePreview()}
                loading={busy}
                disabled={!settings || readOnly}
              >
                生成核对结果
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => void refreshPreview()}
                  disabled={busy || readOnly}
                >
                  重新核对
                </Button>
                <Button
                  type="primary"
                  onClick={() => void apply()}
                  loading={busy}
                  disabled={!applyBody || stale || readOnly}
                >
                  确认处理 {applyBody?.decisions.length || 0} 行
                </Button>
              </>
            )}
          </Space>
        )
      }
    >
      {hidden ? (
        <p>金额与账单明细已隐藏。</p>
      ) : (
        <>
          <Steps
            size="small"
            current={step}
            items={[
              { title: "上传标准账单" },
              { title: "对应字段" },
              { title: "核对结果" },
            ]}
          />
          <p className="data-caption">
            标准 CSV / XLSX
            字段映射，不代表已适配机构原生格式。上传不会改余额；一致记录仅绑定证据，差异需展开复核。
          </p>
          {error && (
            <Alert
              type="error"
              showIcon
              className="form-alert"
              message={error}
              action={
                loading ? undefined : resumeFailed ? (
                  <Button size="small" onClick={() => void resume()}>
                    重试
                  </Button>
                ) : undefined
              }
            />
          )}
          <LoadState
            loading={loading || accountsState.loading}
            error={accountsState.error}
            retry={accountsState.retry}
          >
            <Form
              form={form}
              layout="vertical"
              initialValues={{
                account_id: initialBatch?.account_id,
                save_mapping: true,
              }}
              disabled={busy || readOnly}
              preserve
            >
              <div style={{ display: step < 2 ? undefined : "none" }}>
                <div className="fund-form-grid">
                  <Form.Item
                    name="account_id"
                    label="基金持仓账户"
                    rules={[{ required: true, message: "请选择基金持仓账户" }]}
                  >
                    <Select
                      options={holdingOptions}
                      showSearch
                      optionFilterProp="label"
                      onChange={() => {
                        form.setFieldValue("funding_account_id", undefined);
                        setPreview(null);
                      }}
                    />
                  </Form.Item>
                  {step === 1 && (
                    <Form.Item
                      name="instrument_id"
                      label="仅核对此基金（选填）"
                    >
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        placeholder="按文件中的基金代码识别"
                        options={instruments.map((i) => ({
                          value: i.id,
                          label: `${i.name} · ${i.code}`,
                        }))}
                      />
                    </Form.Item>
                  )}
                </div>
                {step === 0 && (
                  <label className="file-drop">
                    <FileUp size={24} />
                    <strong>{file?.name || "选择标准 CSV / XLSX"}</strong>
                    <span>保留实际扣款、确认份额、净值与费用等原始字段</span>
                    <input
                      type="file"
                      aria-label="选择基金交易账单"
                      accept=".csv,.xlsx"
                      disabled={busy}
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                    />
                  </label>
                )}
                {step === 1 && (
                  <>
                    <Form.Item
                      name="funding_account_id"
                      label="实际付款账户（需要区分来源时选择）"
                    >
                      <Select
                        allowClear
                        options={fundingOptions}
                        placeholder="不指定时由原记录核对"
                      />
                    </Form.Item>
                    <div className="fund-mapping-grid">
                      {fields.map((field) => (
                        <Form.Item
                          key={field.key}
                          name={["mapping", field.key]}
                          label={field.label || labels[field.key] || field.key}
                        >
                          <Select
                            allowClear
                            options={headers.map((header) => ({
                              value: header,
                              label: header,
                            }))}
                            placeholder="文件未提供 / 选择原列名"
                          />
                        </Form.Item>
                      ))}
                    </div>
                    <Form.Item name="save_mapping" valuePropName="checked">
                      <Checkbox>记住此账户的字段对应方式</Checkbox>
                    </Form.Item>
                    {!settings && (
                      <Button
                        onClick={() =>
                          setSettingsRevision((current) => current + 1)
                        }
                      >
                        重试读取字段
                      </Button>
                    )}
                  </>
                )}
              </div>
            </Form>
            {step === 2 && (
              <>
                <div className="fund-result-summary">
                  {Object.entries(statuses).map(([key, value]) => {
                    const count = rows.filter((r) => r.status === key).length;
                    return count ? (
                      <Tag key={key} color={value.color}>
                        {value.label} {count}
                      </Tag>
                    ) : null;
                  })}
                  <small>
                    已载入 {rows.length} / {preview.count ?? rows.length} 行
                  </small>
                  {preview.has_more && (
                    <Button
                      size="small"
                      loading={busy}
                      onClick={() => void loadMore()}
                    >
                      载入后续记录
                    </Button>
                  )}
                </div>
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={rows}
                  pagination={{ pageSize: 10, hideOnSinglePage: true }}
                  scroll={{ x: 780 }}
                  expandable={{ expandedRowRender: detail }}
                  columns={[
                    {
                      title: "行 / 基金",
                      width: 140,
                      render: (_, r) => (
                        <div className="cell-name">
                          <strong>第 {r.row_number} 行</strong>
                          <small>{r.normalized?.code || "基金待识别"}</small>
                        </div>
                      ),
                    },
                    {
                      title: "扣款 / 确认日",
                      width: 170,
                      render: (_, r) => (
                        <div className="cell-name">
                          <span>{r.normalized?.payment_date || "未提供"}</span>
                          <small>
                            {r.normalized?.confirmation_date || "确认日未提供"}
                          </small>
                        </div>
                      ),
                    },
                    {
                      title: "实际扣款",
                      render: (_, r) => (
                        <Money
                          value={r.normalized?.amount}
                          currency={r.normalized?.currency}
                        />
                      ),
                    },
                    {
                      title: "实际份额",
                      render: (_, r) => (
                        <Money value={r.normalized?.quantity} precision={6} />
                      ),
                    },
                    {
                      title: "核对结果",
                      render: (_, r) => (
                        <div className="cell-name">
                          <Tag color={statuses[r.status]?.color}>
                            {statuses[r.status]?.label || "待复核"}
                          </Tag>
                          {r.errors?.length ? (
                            <small>{issueText(r.errors[0])}</small>
                          ) : choices[r.id]?.action === "correct" ? (
                            <small>已选择更正</small>
                          ) : choices[r.id]?.action === "skip" ? (
                            <small>本次跳过</small>
                          ) : r.missing_fields?.length ? (
                            <small>仅核实已提供字段</small>
                          ) : null}
                        </div>
                      ),
                    },
                  ]}
                />
                <p className="data-caption">
                  完全一致的记录不会再次扣款。选择更正会调整对应资金或持仓并保留轨迹；未选择的差异行留待后续处理。
                </p>
                {decisionError && (
                  <p className="form-error" role="status">
                    {decisionError}
                  </p>
                )}
                {stale && <p role="status">账簿或预览已变化，请先重新核对。</p>}
              </>
            )}
          </LoadState>
        </>
      )}
    </Modal>
  );
}
