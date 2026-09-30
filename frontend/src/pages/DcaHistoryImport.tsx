import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from "antd";
import { api, ApiError, dateToday, listOf, send } from "../api";
import type { Item } from "../api";
import { Money } from "../components";
import { HelpText } from "../help";
import { useResource, useWorkspace } from "../state";
import {
  dcaCommitRequest,
  dcaConfirmFromPreview,
  dcaDraftIssue,
  dcaImportDrafts,
  dcaImportRequest,
  dcaLoadExisting,
  dcaQuantityDraft,
  dcaRoundingTotal,
  dcaWithRounding,
} from "../dca-import";
import type { DcaImportDraft } from "../dca-import";

const fundKinds = ["bank", "cash", "wallet", "fund", "broker", "securities"];
export default function DcaHistoryImport({
  plan,
  preview,
  onClose,
  onDone,
  onRecordHolding,
  onCommittingChange,
}: {
  plan: Item;
  preview: any;
  onClose: () => void;
  onDone: () => void;
  onRecordHolding: () => void;
  onCommittingChange: (value: boolean) => void;
}) {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const { message } = App.useApp();
  const accountState = useResource("accounts", "?limit=200"),
    instrumentState = useResource("instruments", "?limit=200");
  const [rows, setRows] = useState<DcaImportDraft[]>(() =>
      dcaImportDrafts(preview, plan, dateToday()),
    ),
    [holdingAccount, setHoldingAccount] = useState(""),
    [fundingAccount, setFundingAccount] = useState(plan.account_id || ""),
    [existing, setExisting] = useState<Record<string, any>>({}),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [validation, setValidation] = useState<any>(null),
    [validatedBody, setValidatedBody] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [committing, setCommitting] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]),
    [retry, setRetry] = useState(0),
    [batchFee, setBatchFee] = useState<string>("");
  const sequence = useRef(0),
    live = useRef(true),
    lock = useRef(false),
    defaultApplied = useRef(false);
  const accounts = listOf<Item>(accountState.data).filter(
    (account) =>
      !account.archived &&
      account.currency === plan.currency &&
      account.valuation_mode !== "snapshot" &&
      fundKinds.includes(account.kind),
  );
  const accountOptions = accounts.map((account) => ({
    value: account.id,
    label: account.name + " · " + account.currency,
  }));
  const previewRow = (day: string) =>
    preview.items?.find((item: any) => item.date === day) || {};
  useEffect(() => {
    live.current = true;
    void api("/spaces/" + space.id + "/plans/" + plan.id + "/history-import")
      .then((result) => {
        if (!live.current) return;
        const records = Object.fromEntries(
          listOf<any>(result).map((item) => [item.scheduled_date, item]),
        );
        setExisting(records);
        setRows((current) =>
          current.map((row) =>
            records[row.scheduled_date]
              ? dcaLoadExisting(row, records[row.scheduled_date])
              : row,
          ),
        );
        const ids = [
          ...new Set(
            Object.values(records).map((item: any) => item.holding_account_id),
          ),
        ].filter(Boolean);
        if (ids.length === 1) {
          defaultApplied.current = true;
          setHoldingAccount(String(ids[0]));
        }
      })
      .catch((e) => {
        if (live.current) setLoadError((e as Error).message);
      })
      .finally(() => {
        if (live.current) setLoading(false);
      });
    return () => {
      live.current = false;
      sequence.current++;
    };
  }, [space.id, plan.id]);
  useEffect(() => {
    if (
      loading ||
      defaultApplied.current ||
      !accountState.data ||
      !instrumentState.data
    )
      return;
    defaultApplied.current = true;
    const instrument = listOf<Item>(instrumentState.data).find(
      (item) => item.id === plan.instrument_id,
    );
    const related = [
      ...new Set([
        ...(instrument?.account_ids || []),
        ...(instrument?.specification?.account_ids || []),
      ]),
    ].filter((id) => accounts.some((a) => a.id === id));
    const institution = accounts.find(
      (a) =>
        a.id === plan.account_id &&
        ["fund", "broker", "securities"].includes(a.kind),
    );
    setHoldingAccount(
      related.length === 1 ? related[0] : institution?.id || "",
    );
  }, [loading, accountState.data, instrumentState.data]);
  useEffect(() => {
    if (
      hidden ||
      loading ||
      loadError ||
      accountState.error ||
      instrumentState.error ||
      committing
    )
      return;
    const current = ++sequence.current;
    setValidation(null);
    setValidatedBody(null);
    setConfirmed(false);
    setError("");
    setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const body = dcaImportRequest(holdingAccount, rows, dateToday());
        const result = await send(
          "/spaces/" +
            space.id +
            "/plans/" +
            plan.id +
            "/history-import/validate",
          body,
        );
        if (live.current && current === sequence.current) {
          setValidation(result);
          setValidatedBody(body);
        }
      } catch (e) {
        if (live.current && current === sequence.current)
          setError((e as Error).message);
      } finally {
        if (live.current && current === sequence.current) setBusy(false);
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      sequence.current++;
    };
  }, [
    rows,
    holdingAccount,
    loading,
    loadError,
    accountState.error,
    instrumentState.error,
    retry,
    hidden,
  ]);
  function update(day: string, patch: Partial<DcaImportDraft>) {
    setConfirmed(false);
    setValidation(null);
    setRows((current) =>
      current.map((row) =>
        row.scheduled_date === day
          ? dcaWithRounding({ ...row, ...patch })
          : row,
      ),
    );
  }
  async function commit() {
    if (lock.current) return;
    lock.current = true;
    setCommitting(true);
    onCommittingChange(true);
    setError("");
    try {
      if (validatedBody?.holding_account_id !== holdingAccount)
        throw new Error("持仓账户已改变，请等待重新检查");
      await send(
        "/spaces/" + space.id + "/plans/" + plan.id + "/history-import/commit",
        dcaCommitRequest(validatedBody, validation, rows, confirmed),
      );
      message.success("补录已保存，资产和持仓已更新");
      reload();
      onDone();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        setValidation(null);
        setConfirmed(false);
      }
    } finally {
      lock.current = false;
      setCommitting(false);
      onCommittingChange(false);
    }
  }
  const localIssues = rows.filter((row) => dcaDraftIssue(row, dateToday()));
  const backendErrors = [
    ...(validation?.blockers || []),
    ...(validation?.rows || []).flatMap((row: any) =>
      (row.errors || []).map((item: any) => ({
        ...item,
        message: row.scheduled_date + "：" + item.message,
      })),
    ),
  ];
  const problems = [
    loadError || accountState.error || instrumentState.error || error,
    ...backendErrors.map((item: any) => item.message),
  ].filter(Boolean);
  const activeRows = rows.filter((row) => !row.excluded);
  const existingPending = rows.some(
    (row) =>
      !row.excluded &&
      existing[row.scheduled_date]?.status === "debited" &&
      row.status === "debited",
  );
  function fields(row: DcaImportDraft) {
    const saved = existing[row.scheduled_date],
      locked = saved?.status === "confirmed";
    const number = (
      field: "amount" | "fee" | "quantity" | "nav",
      label: string,
      disabled = false,
    ) => (
      <label>
        <span>{label}</span>
        <InputNumber
          stringMode
          changeOnBlur={false}
          controls={false}
          aria-label={row.scheduled_date + " " + label}
          value={row[field]}
          disabled={committing || disabled}
          style={{ width: "100%" }}
          onChange={(value) =>
            update(row.scheduled_date, {
              [field]: value == null ? "" : String(value),
            })
          }
        />
      </label>
    );
    return (
      <div>
        <div className="dca-row-fields">
          <label>
            <span>扣款日期</span>
            <Input
              type="date"
              max={dateToday()}
              value={row.debit_date}
              disabled={committing || !!saved}
              onChange={(e) =>
                update(row.scheduled_date, { debit_date: e.target.value })
              }
            />
          </label>
          <label>
            <span>本期付款账户</span>
            <Select
              value={row.funding_account_id || undefined}
              options={accountOptions}
              disabled={committing || !!saved}
              style={{ width: "100%" }}
              onChange={(value) =>
                update(row.scheduled_date, { funding_account_id: value })
              }
            />
          </label>
          {number("amount", "扣款金额", !!saved)}
          <label>
            <span>本期状态</span>
            <Select
              value={row.status || undefined}
              placeholder="选择确认状态"
              disabled={committing || locked}
              style={{ width: "100%" }}
              options={[
                { value: "confirmed", label: "按预览确认份额" },
                { value: "debited", label: "已扣款，仍在途" },
              ]}
              onChange={(status) => {
                if (status === "confirmed") {
                  const prepared = dcaConfirmFromPreview(
                    row,
                    previewRow(row.scheduled_date),
                    dateToday(),
                  );
                  update(row.scheduled_date, {
                    ...prepared,
                    status: "confirmed",
                  });
                } else update(row.scheduled_date, { status });
              }}
            />
          </label>
          {row.status === "confirmed" && (
            <>
              <label>
                <span>确认日期</span>
                <Input
                  type="date"
                  max={dateToday()}
                  value={row.confirmation_date}
                  disabled={committing || locked}
                  onChange={(e) =>
                    update(row.scheduled_date, {
                      confirmation_date: e.target.value,
                    })
                  }
                />
              </label>
              {number("fee", "费用", locked)}
              {number("quantity", "确认份额", locked)}
              {number("nav", "确认净值", locked)}
            </>
          )}
        </div>
        <div className="dca-toolbar">
          <span className="data-caption">
            {row.entry_basis === "preview_confirmed"
              ? "按预览补录，未标记为机构原始确认"
              : "来自已保存的机构记录"}
            {row.status === "confirmed" && (
              <>
                {" "}
                · <HelpText text="份额取整尾差" />{" "}
                <Money
                  value={row.rounding_adjustment}
                  currency={plan.currency}
                />
              </>
            )}
          </span>
          <Button
            type="link"
            disabled={committing}
            onClick={() =>
              update(row.scheduled_date, { excluded: !row.excluded })
            }
          >
            {row.excluded ? "恢复本期补录" : "本次不补录此期"}
          </Button>
          {saved && (
            <Button
              type="link"
              disabled={committing}
              onClick={() => {
                setConfirmed(false);
                setRows((current) =>
                  current.map((item) =>
                    item.scheduled_date === row.scheduled_date
                      ? dcaLoadExisting(item, saved)
                      : item,
                  ),
                );
              }}
            >
              恢复已保存内容
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="dca-step-content">
      {hidden ? (
        <Alert
          type="info"
          message="金额已隐藏，显示后才能继续补录"
          action={
            <Button onClick={() => requestReveal(() => {})}>显示金额</Button>
          }
        />
      ) : (
        <>
          <div className="dca-row-fields dca-row-fields--pair">
            <label>
              <span>付款账户</span>
              <Select
                value={fundingAccount || undefined}
                placeholder="选择付款账户"
                options={accountOptions}
                loading={accountState.loading}
                disabled={loading || committing}
                style={{ width: "100%" }}
                onChange={(value) => {
                  setFundingAccount(value);
                  setRows((current) =>
                    current.map((row) =>
                      existing[row.scheduled_date]
                        ? row
                        : { ...row, funding_account_id: value },
                    ),
                  );
                }}
              />
            </label>
            <label>
              <span>持仓账户</span>
              <Select
                value={holdingAccount || undefined}
                placeholder="选择持有基金的账户"
                options={accountOptions}
                loading={accountState.loading}
                disabled={
                  loading || committing || Object.keys(existing).length > 0
                }
                style={{ width: "100%" }}
                onChange={(value) => {
                  defaultApplied.current = true;
                  setHoldingAccount(value);
                }}
              />
            </label>
          </div>
          <Alert
            className="dca-status"
            showIcon
            type={problems.length || localIssues.length ? "warning" : "info"}
            message={
              loading
                ? "正在读取已有记录"
                : busy
                  ? "正在检查资金与持仓变化"
                  : problems[0] ||
                    "按预览补录 " + activeRows.length + " 期，可展开修改"
            }
            description={
              <>
                {problems.length > 1 && (
                  <span>
                    另有 {problems.length - 1} 项需处理，可查看下方检查详情。
                  </span>
                )}
                {localIssues.length > 0 && (
                  <span>
                    {" "}
                    {localIssues.length}{" "}
                    期数据需补全；可展开修改，或明确记为在途 / 排除。
                  </span>
                )}
                {!problems.length && !localIssues.length && (
                  <span>
                    截至 {preview.as_of || preview.end} 的预览已填好；新增份额按
                    2 位取整。已有在途保持原状态。
                  </span>
                )}
              </>
            }
          />
          {loading ? (
            <Spin />
          ) : (
            <>
              {existingPending && (
                <div className="dca-toolbar">
                  <span className="data-caption">
                    已有扣款仍在途，不会自动改为确认。
                  </span>
                  <Button
                    disabled={committing}
                    onClick={() =>
                      setRows((current) =>
                        current.map((row) =>
                          !row.excluded &&
                          existing[row.scheduled_date]?.status === "debited" &&
                          row.status === "debited"
                            ? dcaConfirmFromPreview(
                                row,
                                previewRow(row.scheduled_date),
                                dateToday(),
                              )
                            : row,
                        ),
                      )
                    }
                  >
                    已有在途按参考日期确认
                  </Button>
                </div>
              )}
              <Table<DcaImportDraft>
                size="small"
                rowKey="scheduled_date"
                dataSource={rows}
                pagination={{ pageSize: 10, showSizeChanger: true }}
                scroll={{ x: 720 }}
                expandable={{
                  showExpandColumn: false,
                  expandedRowKeys: expanded,
                  expandedRowRender: fields,
                }}
                columns={[
                  {
                    title: "计划日期",
                    dataIndex: "scheduled_date",
                    width: 125,
                  },
                  {
                    title: "扣款",
                    width: 105,
                    render: (_, row) => (
                      <Money value={row.amount} precision={2} />
                    ),
                  },
                  {
                    title: "份额",
                    width: 110,
                    render: (_, row) =>
                      row.status === "confirmed" ? (
                        <Money value={row.quantity} precision={2} />
                      ) : (
                        "—"
                      ),
                  },
                  {
                    title: "状态",
                    width: 180,
                    render: (_, row) => {
                      const issue = dcaDraftIssue(row, dateToday());
                      return (
                        <div className="cell-name">
                          <Tag color={issue ? "gold" : undefined}>
                            {row.excluded
                              ? "已排除"
                              : existing[row.scheduled_date]?.status ===
                                  "confirmed"
                                ? "已保存，不重复入账"
                                : issue
                                  ? "待补全"
                                  : row.status === "confirmed"
                                    ? "待补录份额"
                                    : "扣款在途"}
                          </Tag>
                          {issue && <small>{issue}</small>}
                        </div>
                      );
                    },
                  },
                  {
                    title: "确认日期",
                    width: 125,
                    render: (_, row) =>
                      row.status === "confirmed"
                        ? row.confirmation_date || "待补全"
                        : "—",
                  },
                  {
                    title: "操作",
                    width: 75,
                    render: (_, row) => (
                      <Button
                        type="link"
                        size="small"
                        onClick={() =>
                          setExpanded((current) =>
                            current.includes(row.scheduled_date)
                              ? current.filter(
                                  (day) => day !== row.scheduled_date,
                                )
                              : [...current, row.scheduled_date],
                          )
                        }
                      >
                        {expanded.includes(row.scheduled_date)
                          ? "收起"
                          : "修改"}
                      </Button>
                    ),
                  },
                ]}
              />
            </>
          )}
          {validation?.ready && (
            <div className="dca-summary-grid dca-summary-grid--pair">
              <div className="dca-summary-card">
                <span>新增扣款</span>
                <strong>
                  <Money
                    value={validation.summary.debit_amount}
                    currency={plan.currency}
                    precision={2}
                  />
                </strong>
                <small>{validation.summary.new_debits} 期</small>
              </div>
              <div className="dca-summary-card">
                <span>转入持仓成本</span>
                <strong>
                  <Money
                    value={validation.summary.confirmed_amount}
                    currency={plan.currency}
                    precision={2}
                  />
                </strong>
                <small>
                  {validation.summary.new_confirmations} 期，已保存{" "}
                  {validation.summary.skipped} 期跳过
                </small>
              </div>
            </div>
          )}
          <Collapse
            ghost
            items={[
              {
                key: "batch",
                label: "批量补全费用",
                children: (
                  <div className="dca-toolbar">
                    <InputNumber
                      stringMode
                      changeOnBlur={false}
                      controls={false}
                      aria-label="每期费用"
                      placeholder="每期费用，免费填 0"
                      value={batchFee}
                      disabled={committing}
                      onChange={(value) =>
                        setBatchFee(value == null ? "" : String(value))
                      }
                    />
                    <Button
                      disabled={
                        committing || !/^\d+(\.\d{1,12})?$/.test(batchFee)
                      }
                      onClick={() =>
                        setRows((current) =>
                          current.map((row) =>
                            row.excluded ||
                            existing[row.scheduled_date]?.status === "confirmed"
                              ? row
                              : dcaWithRounding({
                                  ...row,
                                  fee: batchFee,
                                  quantity: dcaQuantityDraft(
                                    row.amount,
                                    batchFee,
                                    row.nav ||
                                      previewRow(row.scheduled_date).nav ||
                                      "",
                                  ),
                                  nav:
                                    row.nav ||
                                    previewRow(row.scheduled_date).nav ||
                                    "",
                                }),
                          ),
                        )
                      }
                    >
                      应用到未保存期次
                    </Button>
                    <span className="data-caption">
                      按本期金额和净值重算 2 位份额；在途状态保持不变。
                    </span>
                  </div>
                ),
              },
              ...(problems.length > 1
                ? [
                    {
                      key: "problems",
                      label: "检查详情（" + problems.length + "项）",
                      children: (
                        <div>
                          {problems.map((item, index) => (
                            <p key={index}>{item}</p>
                          ))}
                        </div>
                      ),
                    },
                  ]
                : []),
              {
                key: "effects",
                label: "账户变化与补录说明",
                children: (
                  <>
                    {validation?.account_effects?.length > 0 && (
                      <Table<any>
                        size="small"
                        rowKey="account_id"
                        pagination={false}
                        dataSource={validation.account_effects}
                        columns={[
                          { title: "账户", dataIndex: "name" },
                          {
                            title: "资金",
                            render: (_, row) => (
                              <Money
                                value={row.cash_change}
                                precision={2}
                                sign
                              />
                            ),
                          },
                          {
                            title: "在途",
                            render: (_, row) => (
                              <Money
                                value={row.transit_change}
                                precision={2}
                                sign
                              />
                            ),
                          },
                          {
                            title: "持仓成本",
                            render: (_, row) => (
                              <Money
                                value={row.investment_cost_change}
                                precision={2}
                                sign
                              />
                            ),
                          },
                        ]}
                      />
                    )}
                    <p className="data-caption">
                      按预览补录会保存来源标记，不代表机构已核验。这里只更新账簿，不发起银行扣款；费用未知不会按
                      0 处理，小额取整尾差单独保存。
                    </p>
                    <p className="data-caption">
                      历史早于账户期初，或已经包含在已有持仓中时，应按当前机构数据录入已有持仓，避免重复扣减今日余额。
                    </p>
                    <Button
                      type="link"
                      disabled={committing}
                      onClick={onRecordHolding}
                    >
                      转去录入已有持仓
                    </Button>
                    {(validation?.warnings || []).map(
                      (warning: any, index: number) => (
                        <p className="data-caption" key={index}>
                          {typeof warning === "string"
                            ? warning
                            : warning.message}
                        </p>
                      ),
                    )}
                  </>
                ),
              },
            ]}
          />
          {validation?.ready && (
            <p className="data-caption">
              本次新增确认的份额取整尾差合计{" "}
              <Money
                value={dcaRoundingTotal(
                  rows.filter(
                    (row) =>
                      existing[row.scheduled_date]?.status !== "confirmed",
                  ),
                )}
                currency={plan.currency}
              />
              ，随本次补录单独保存。
            </p>
          )}
          <Checkbox
            checked={confirmed}
            disabled={committing || loading || busy || !validation?.ready}
            onChange={(e) => setConfirmed(e.target.checked)}
          >
            按以上预览补录，已核对扣款与确认状态
          </Checkbox>
        </>
      )}
      <div className="dca-footer">
        <Button disabled={committing} onClick={onClose}>
          返回预览
        </Button>
        {(error || backendErrors.length > 0) && (
          <Button
            disabled={committing || loading || hidden}
            onClick={() => setRetry((value) => value + 1)}
          >
            重新检查
          </Button>
        )}
        <Button
          type="primary"
          loading={committing || busy}
          disabled={
            hidden ||
            !confirmed ||
            !validation?.ready ||
            loading ||
            space.role === "viewer"
          }
          onClick={commit}
        >
          确认补录并更新持仓
        </Button>
      </div>
    </div>
  );
}
