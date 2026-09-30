import { helpColumns } from "../help";
import { NavigationTabs } from "../navigation";
import Dividends from "./Dividends";
import { FundOrders } from "./FundBuy";
import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Table,
  Tabs,
  Tag,
} from "antd";
import { Download, FileUp, Plus, Check, ArrowRight } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  Blank,
  EntityManager,
  Fields,
  LoadState,
  Money,
  PageTitle,
  Panel,
  ResourceTable,
  Status,
} from "../components";
import {
  api,
  currencyOptions,
  dateToday,
  kinds,
  listOf,
  send,
  transferLabel,
} from "../api";
import type { Item } from "../api";
import { useDebounced, useResource, useWorkspace } from "../state";
export default function Cashbook() {
  const accountState = useResource("accounts");
  return (
    <>
      <PageTitle eyebrow="CASHBOOK & EVIDENCE" title="收支账本" />
      <NavigationTabs
        group="cashbook"
        routeParam="tab"
        items={[
          { key: "events", label: "全部流水", children: <EventList /> },
          {
            key: "investments",
            label: "投资交易",
            children: (
              <>
                <FundOrders />
                <EventList investmentOnly />
              </>
            ),
          },
          { key: "dividends", label: "基金分红", children: <Dividends /> },
          { key: "imports", label: "账单中心", children: <Imports /> },
          {
            key: "budgets",
            label: "月度预算",
            children: (
              <EntityManager
                resource="budgets"
                title="分类预算"
                fields={[
                  {
                    name: "account_id",
                    label: "预算账户",
                    type: "select",
                    required: true,
                    options: listOf<Item>(accountState.data).map((a) => ({
                      label: a.name,
                      value: a.id,
                    })),
                  },
                  { name: "category", label: "消费分类", required: true },
                  {
                    name: "month",
                    label: "预算月份",
                    required: true,
                    initial: dateToday().slice(0, 7),
                    placeholder: "YYYY-MM",
                  },
                  {
                    name: "amount",
                    label: "预算金额",
                    type: "number",
                    required: true,
                  },
                  {
                    name: "currency",
                    label: "币种",
                    type: "select",
                    required: true,
                    initial: "CNY",
                    options: currencyOptions,
                  },
                ]}
                columns={[
                  { title: "月份", dataIndex: "month" },
                  { title: "分类", dataIndex: "category" },
                  {
                    title: "预算",
                    render: (_, r) => (
                      <Money value={r.amount} currency={r.currency} />
                    ),
                  },
                  {
                    title: "已发生消费",
                    render: (_, r) => (
                      <Money value={r.actual} currency={r.currency} />
                    ),
                  },
                  {
                    title: "剩余",
                    render: (_, r) => (
                      <Money value={r.remaining} currency={r.currency} />
                    ),
                  },
                ]}
              />
            ),
          },
          { key: "reconcile", label: "对账", children: <Reconciliation /> },
          { key: "todos", label: "待办", children: <Todos /> },
        ]}
      />
    </>
  );
}
function EventList({ investmentOnly = false }: { investmentOnly?: boolean }) {
  const accountsState = useResource("accounts", "?limit=200");
  const { showDetail, hidden, space, openEvent, requestReveal } =
    useWorkspace();
  const [search, setSearch] = useState(""),
    [kind, setKind] = useState<string>(),
    [currency, setCurrency] = useState<string>(),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(12);
  const query = useDebounced(search);
  useEffect(() => setPage(1), [query, kind, currency, start, end]);
  const params = new URLSearchParams({
    offset: String((page - 1) * pageSize),
    limit: String(pageSize),
    q: query,
    ...(kind
      ? { kind }
      : investmentOnly
        ? {
            kind: "opening,buy,sell,fund_debit,fund_confirm,fund_redeem,fund_refund,settlement,dividend,reinvest,split,position_transfer",
          }
        : {}),
    ...(currency ? { currency } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  });
  const state = useResource("events", `?${params}`);
  const rows = listOf<Item>(state.data);
  return (
    <Panel
      title={investmentOnly ? "投资交易" : "收支流水"}
      subtitle="转账、投资本金与还款本金不计为日常消费。"
    >
      <div className="table-toolbar">
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索说明、分类或记录 ID"
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            style={{ width: 145 }}
            placeholder="全部业务"
            allowClear
            options={Object.entries(kinds).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={setKind}
          />
          <Select
            style={{ width: 120 }}
            placeholder="全部币种"
            allowClear
            options={currencyOptions}
            onChange={setCurrency}
          />
          <Input
            type="date"
            aria-label="流水开始日期"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={{ width: 142 }}
          />
          <span className="muted">至</span>
          <Input
            type="date"
            aria-label="流水结束日期"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={{ width: 142 }}
          />
        </Space>
        <span className="muted">
          本页 {rows.length} 条 / 共 {state.data?.count ?? rows.length} 条事项
        </span>
      </div>
      <LoadState {...state}>
        <Table
          rowKey="id"
          dataSource={rows}
          size="middle"
          pagination={{
            current: page,
            pageSize,
            total: state.data?.count ?? rows.length,
            showSizeChanger: true,
            onChange: (next, size) => {
              setPage(next);
              setPageSize(size);
            },
          }}
          scroll={{ x: 880 }}
          columns={helpColumns<Item>([
            { title: "经济日期", dataIndex: "economic_date", width: 118 },
            {
              title: "业务",
              dataIndex: "kind",
              width: 130,
              render: (v, r) =>
                v === "transfer"
                  ? transferLabel(
                      listOf<Item>(accountsState.data).find(
                        (a) => a.id === (r.account_id || r.payload?.account_id),
                      ),
                      listOf<Item>(accountsState.data).find(
                        (a) =>
                          a.id ===
                          (r.target_account_id || r.payload?.target_account_id),
                      ),
                    )
                  : kinds[v] || v,
            },
            {
              title: "说明 / 分类",
              render: (_, r) => (
                <div className="cell-name">
                  <strong>
                    {hidden ? "内容已隐藏" : r.description || "未填写说明"}
                  </strong>
                  <small>{r.category || "未分类"}</small>
                </div>
              ),
            },
            {
              title: "金额",
              width: 155,
              render: (_, r) => (
                <Money value={r.amount} currency={r.currency} />
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 105,
              render: (v, r) =>
                r.reversed ? (
                  <Status value="reversed" />
                ) : r.payload?.automatic_estimate ? (
                  <Tag color="gold">推算待核实</Tag>
                ) : r.kind === "fund_debit" && r.next_stage ? (
                  <Tag>已扣款，待份额</Tag>
                ) : (
                  <Status value={v || "confirmed"} />
                ),
            },
            {
              title: "来源与分录",
              width: 180,
              render: (_, r) => (
                <Space size={0}>
                  {!r.reversed &&
                    space.role !== "viewer" &&
                    ["expense", "income", "transfer"].includes(r.kind) && (
                      <Button
                        type="link"
                        size="small"
                        onClick={() =>
                          requestReveal(() =>
                            openEvent({
                              ...r.payload,
                              id: "",
                              kind: r.kind,
                              economic_date: r.economic_date,
                              category: r.category,
                              description: r.description,
                              _editing_event_id: r.id,
                            }),
                          )
                        }
                      >
                        修改
                      </Button>
                    )}
                  {r.next_stage && space.role !== "viewer" && (
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        requestReveal(() =>
                          openEvent({
                            id: "",
                            ...r.next_stage,
                            related_event_id: r.id,
                            currency: r.currency,
                            economic_date: dateToday(),
                          }),
                        )
                      }
                    >
                      {r.next_stage.kind === "fund_confirm"
                        ? "确认份额"
                        : "记录交收"}
                    </Button>
                  )}
                  <Button
                    type="link"
                    size="small"
                    onClick={() => showDetail(r)}
                  >
                    查看详情
                  </Button>
                </Space>
              ),
            },
          ])}
          locale={{
            emptyText: (
              <Blank
                title="还没有记账事项"
                description="手动记录或导入账单后，统一在这里核对。"
              />
            ),
          }}
        />
      </LoadState>
    </Panel>
  );
}
function Imports() {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const { message, modal } = App.useApp();
  const state = useResource("imports"),
    accountsState = useResource("accounts"),
    adapterState = useResource("adapters");
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [batch, setBatch] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [selected, setSelected] = useState<React.Key[]>([]),
    [links, setLinks] = useState<Record<string, string>>({}),
    [mappingDefaults, setMappingDefaults] = useState<any>({});
  const [importParams] = useSearchParams();
  useEffect(() => {
    if (importParams.get("upload") && space.role !== "viewer")
      requestReveal(() => setOpen(true));
  }, [importParams.get("upload")]);
  const [uploadForm] = Form.useForm(),
    [mappingForm] = Form.useForm();
  const accounts = listOf<Item>(accountsState.data).map((a) => ({
    label: `${a.name} · ${a.currency}`,
    value: a.id,
  }));
  const sources = [
    { value: "generic", label: "通用 CSV / Excel 映射" },
    { value: "miaomiao", label: "喵喵记账 · 待样本验证" },
    { value: "alipay", label: "支付宝 · 待样本验证" },
    { value: "wechat", label: "微信 · 待样本验证" },
    { value: "guangfa_funds", label: "广发基金 · 待样本验证" },
    { value: "efunds", label: "易方达基金 · 待样本验证" },
    { value: "guangfa_futures", label: "广发期货 · 待样本验证" },
    { value: "yinhe_futures", label: "银河期货 · 待样本验证" },
  ];
  async function upload(values: any) {
    if (!file) {
      setError("请选择账单文件");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("source", values.source);
      body.append("account_id", values.account_id);
      const result = await api(`/spaces/${space.id}/imports`, {
        method: "POST",
        body,
      });
      if (result.status === "committed") {
        message.info("同一文件已入账，没有重复记账。可在批次列表查看来源。");
        setOpen(false);
        reload();
        return;
      }
      setBatch(result);
      const headers = result.diagnostics?.headers || result.columns || [];
      const aliases: Record<string, string[]> = {
        date: ["economic_date", "date", "交易时间", "交易日期", "时间", "日期"],
        amount: ["amount", "金额", "金额(元)", "金额（元）", "交易金额"],
        currency: ["currency", "币种"],
        description: [
          "description",
          "备注",
          "商品",
          "商品名称",
          "交易对方",
          "摘要",
        ],
        external_id: [
          "external_id",
          "source_record_id",
          "交易单号",
          "订单号",
          "流水号",
        ],
        type: ["kind", "type", "收支", "收/支", "类型", "交易类型"],
      };
      setMappingDefaults({
        ...Object.fromEntries(
          Object.entries(aliases).map(([k, opts]) => [
            k,
            opts.find((v) => headers.includes(v)) || "",
          ]),
        ),
        default_kind: "expense",
        account_id: values.account_id,
      });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function makePreview(values: any) {
    setMappingDefaults(values);
    setBusy(true);
    setError("");
    try {
      const { default_kind, account_id, ...mapping } = values;
      const result = await send(
        `/spaces/${space.id}/imports/${batch.id}/preview`,
        { mapping, default_kind, account_id },
      );
      setPreview(result);
      setSelected(
        (result.rows || [])
          .filter((r: any) => !r.errors?.length && !r.committed)
          .map((r: any) => r.id),
      );
      setLinks({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    modal.confirm({
      title: `确认提交选定的 ${selected.length} 行？`,
      content: `本次选定 ${selected.length} / ${preview.row_count ?? preview.rows.length} 行。只有这些行会确认，重复记录仅关联证据；未选行仍需另行处理。整个选定集合原子提交，提交后请核对账户余额。`,
      okText: "确认入账",
      cancelText: "返回预览",
      onOk: async () => {
        setBusy(true);
        try {
          await send(`/spaces/${space.id}/imports/${batch.id}/commit`, {
            preview_version: preview.version ?? preview.preview_version,
            ledger_revision: preview.ledger_revision,
            row_ids: selected,
            links: Object.fromEntries(
              Object.entries(links).filter(
                ([id, value]) =>
                  selected.includes(id) && value && value !== "__distinct__",
              ),
            ),
            distinct_rows: Object.entries(links)
              .filter(
                ([id, value]) =>
                  selected.includes(id) && value === "__distinct__",
              )
              .map(([id]) => id),
          });
          message.success("选定记录已提交");
          setOpen(false);
          reload();
        } catch (e) {
          setError((e as Error).message);
          throw e;
        } finally {
          setBusy(false);
        }
      },
    });
  }
  return (
    <>
      <Panel
        title="账单中心"
        subtitle="上传 → 映射 → 预览 → 确认 → 核对，上传文件不会改变余额。"
      >
        <LoadState {...state}>
          <Table
            rowKey="id"
            dataSource={listOf<Item>(state.data)}
            size="middle"
            scroll={{ x: 700 }}
            columns={helpColumns<Item>([
              {
                title: "文件",
                dataIndex: "filename",
                render: (v, r) =>
                  v || r.original_filename || r.name || "账单文件",
              },
              {
                title: "来源",
                dataIndex: "source",
                render: (v) => sources.find((s) => s.value === v)?.label || v,
              },
              {
                title: "导入时间",
                dataIndex: "created_at",
                render: (v) => v?.slice(0, 16).replace("T", " "),
              },
              {
                title: "状态",
                dataIndex: "status",
                render: (v) => <Status value={v} />,
              },
              {
                title: "操作",
                render: (_, r) => (
                  <Space>
                    {space.role === "owner" && (
                      <a
                        href={`/api/v1/spaces/${space.id}/imports/${r.id}/file`}
                        download
                        aria-label="下载原始文件"
                      >
                        <Download size={16} />
                      </a>
                    )}
                    {r.status !== "committed" && space.role !== "viewer" && (
                      <Button
                        size="small"
                        type="link"
                        onClick={() =>
                          requestReveal(() => {
                            setBatch(r);
                            setPreview(null);
                            setOpen(true);
                            setMappingDefaults({
                              account_id: r.account_id,
                              date: "date",
                              amount: "amount",
                              currency: "currency",
                              description: "description",
                              external_id: "external_id",
                              type: "type",
                              default_kind: "expense",
                            });
                          })
                        }
                      >
                        继续预览
                      </Button>
                    )}
                    {["committed", "partially_committed"].includes(r.status) &&
                      space.role !== "viewer" && (
                        <Button
                          danger
                          type="link"
                          size="small"
                          onClick={() => {
                            let reason = "";
                            modal.confirm({
                              title: "冲正 / 解绑本批次",
                              content: (
                                <>
                                  <p>
                                    仍被其他批次支持的事项应保留。系统将按证据依赖处理；请先核对需要撤回的批次。
                                  </p>
                                  <Input.TextArea
                                    placeholder="填写原因"
                                    onChange={(e) => (reason = e.target.value)}
                                  />
                                </>
                              ),
                              okText: "确认处理",
                              onOk: async () => {
                                if (!reason.trim()) {
                                  message.error("请填写原因");
                                  return Promise.reject();
                                }
                                await send(
                                  `/spaces/${space.id}/imports/${r.id}/reverse`,
                                  { reason },
                                );
                                reload();
                              },
                            });
                          }}
                        >
                          冲正
                        </Button>
                      )}
                  </Space>
                ),
              },
            ])}
            locale={{
              emptyText: (
                <Blank
                  title="还没有导入账单"
                  description="从现有软件或机构导出文件，按真实字段映射后再入账。"
                />
              ),
            }}
          />
        </LoadState>
      </Panel>
      <Panel
        title="来源适配状态"
        subtitle="通用字段映射不等于已经完成机构格式认证。"
      >
        {adapterState.error && (
          <Alert
            type="error"
            className="form-alert"
            showIcon
            message={`来源状态读取失败：${adapterState.error}`}
          />
        )}
        <div className="adapter-grid">
          {(listOf<Item>(adapterState.data).length
            ? listOf<Item>(adapterState.data)
            : sources.map((s) => ({
                id: s.value,
                name: s.label,
                status: "planned",
              }))
          ).map((a: any) => (
            <div className="adapter-card" key={a.id || a.source}>
              <span>{a.name || a.source}</span>
              <Status value={a.status || "planned"} />
              <small>
                {a.format ||
                  a.limitations ||
                  a.notes ||
                  "具体格式、业务范围及对账需样本验证"}
              </small>
            </div>
          ))}
        </div>
      </Panel>
      <Modal
        title="导入账单"
        open={open}
        width={1080}
        footer={null}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Steps
          size="small"
          current={preview ? 2 : batch ? 1 : 0}
          items={[
            { title: "上传文件" },
            { title: "字段映射" },
            { title: "预览并确认" },
          ]}
        />
        {error && (
          <Alert className="form-alert" type="error" showIcon message={error} />
        )}
        <div className="import-step" data-dirty={!!batch}>
          {!batch ? (
            <Form
              form={uploadForm}
              name="import-upload"
              clearOnDestroy
              layout="vertical"
              initialValues={{ source: "generic" }}
              onFinish={upload}
            >
              <Fields
                fields={[
                  {
                    name: "source",
                    label: "账单来源",
                    type: "select",
                    options: sources,
                    required: true,
                  },
                  {
                    name: "account_id",
                    label: "入账账户",
                    type: "select",
                    options: accounts,
                    required: true,
                  },
                ]}
              />
              <label className="file-drop">
                <FileUp size={28} />
                <strong>
                  {file ? file.name : "选择 CSV、XLSX 或机构支持格式"}
                </strong>
                <span>文件仅归属当前空间，上传不会直接入账</span>
                <input
                  type="file"
                  aria-label="选择账单文件"
                  accept=".csv,.xlsx,.xls,.txt"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
              <Button type="primary" htmlType="submit" loading={busy}>
                上传并读取字段
              </Button>
            </Form>
          ) : !preview ? (
            <>
              <Alert
                className="form-alert"
                type="info"
                showIcon
                message={`文件：${batch.filename || batch.original_filename || file?.name || batch.id}`}
                description={
                  (batch.diagnostics?.headers || batch.columns)?.length
                    ? `可用列：${(batch.diagnostics?.headers || batch.columns).join("、")}`
                    : "请按文件表头填写列名。不支持或缺失的字段会在预览中标明，不能静默补值。"
                }
              />
              <Form
                form={mappingForm}
                name="import-mapping"
                clearOnDestroy
                initialValues={mappingDefaults}
                layout="vertical"
                onFinish={makePreview}
              >
                <Fields
                  fields={[
                    {
                      name: "account_id",
                      label: "入账账户",
                      type: "select",
                      required: true,
                      options: accounts,
                    },
                    {
                      name: "default_kind",
                      label: "未提供类型时的明确映射",
                      type: "select",
                      required: true,
                      options: Object.entries(kinds).map(([value, label]) => ({
                        value,
                        label,
                      })),
                    },
                    ...[
                      "date",
                      "amount",
                      "currency",
                      "description",
                      "external_id",
                      "type",
                    ].map((name) => ({
                      name,
                      label: (
                        {
                          date: "日期列",
                          amount: "金额列",
                          currency: "币种列",
                          description: "说明列",
                          external_id: "机构记录 ID 列",
                          type: "业务类型列",
                        } as any
                      )[name],
                      required: ["date", "amount"].includes(name),
                      placeholder: "输入原文件列名",
                    })),
                  ]}
                />
                <Button type="primary" htmlType="submit" loading={busy}>
                  生成规范化预览
                </Button>
              </Form>
            </>
          ) : (
            <>
              <div className="table-toolbar">
                <span>
                  已载入 {preview.rows?.length || 0} /{" "}
                  {preview.row_count ?? preview.rows?.length ?? 0} 行 · 已选择{" "}
                  {selected.length} 行
                </span>
                <Space wrap>
                  <Button onClick={() => setPreview(null)}>返回修改映射</Button>
                  {preview.row_count > preview.rows.length && (
                    <Button
                      loading={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const full = await api(
                            `/spaces/${space.id}/imports/${batch.id}?limit=10000`,
                          );
                          setPreview(full);
                          setSelected(
                            (full.rows || [])
                              .filter(
                                (r: any) => !r.errors?.length && !r.committed,
                              )
                              .map((r: any) => r.id),
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      载入全部行后核对
                    </Button>
                  )}
                  <Button
                    icon={<Download size={14} />}
                    onClick={() => {
                      const rows = [
                        ["原始行号", "说明", "错误"],
                        ...(preview.rows || [])
                          .filter((r: any) => r.errors?.length)
                          .map((r: any) => [
                            r.row_number,
                            r.normalized?.description || "",
                            r.errors.join("；"),
                          ]),
                      ];
                      const csv =
                        "\uFEFF" +
                        rows
                          .map((r) =>
                            r
                              .map((v: any) => {
                                let x = String(v);
                                if (/^[=+@-]/.test(x)) x = "'" + x;
                                return '"' + x.replaceAll('"', '""') + '"';
                              })
                              .join(","),
                          )
                          .join("\r\n");
                      const url = URL.createObjectURL(
                        new Blob([csv], { type: "text/csv;charset=utf-8" }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "账单错误行.csv";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    导出错误行
                  </Button>
                </Space>
              </div>
              <Alert
                className="form-alert"
                showIcon
                message="尚未入账：检查错误、重复与跨来源匹配后再确认。"
                type="info"
              />
              <Table
                rowKey="id"
                size="small"
                scroll={{ x: 800 }}
                pagination={{ pageSize: 8 }}
                rowSelection={{
                  selectedRowKeys: selected,
                  onChange: setSelected,
                  getCheckboxProps: (r: any) => ({
                    disabled:
                      r.committed || (!!r.errors?.length && !links[r.id]),
                  }),
                }}
                dataSource={preview.rows || []}
                columns={helpColumns<Item>([
                  { title: "原行号", dataIndex: "row_number", width: 75 },
                  {
                    title: "日期",
                    render: (_, r: any) =>
                      r.normalized?.economic_date ||
                      r.normalized?.date ||
                      "缺失",
                  },
                  {
                    title: "说明",
                    render: (_, r: any) =>
                      hidden ? "内容已隐藏" : r.normalized?.description || "—",
                  },
                  {
                    title: "金额",
                    render: (_, r: any) =>
                      hidden
                        ? "••••••"
                        : `${r.normalized?.currency || ""} ${r.normalized?.amount ?? "缺失"}`,
                  },
                  {
                    title: "校验",
                    render: (_, r: any) =>
                      r.committed ? (
                        <Tag color="green">已确认，不重复提交</Tag>
                      ) : r.errors?.length ? (
                        <span className="negative">{r.errors.join("；")}</span>
                      ) : r.duplicate ? (
                        <Tag>已存在 · 仅关联证据</Tag>
                      ) : r.automatic_match ? (
                        <Tag color="orange">已有自动补录，请核对关联</Tag>
                      ) : (
                        <Tag color="green">可确认</Tag>
                      ),
                  },
                  {
                    title: "关联已有事项",
                    render: (_, r: any) =>
                      r.candidates?.length ? (
                        <Select
                          style={{ width: 190 }}
                          allowClear
                          placeholder="确认是否同一事项"
                          options={[
                            ...r.candidates.map((c: any) => ({
                              value: c.event_id || c.id,
                              label: hidden
                                ? "内容已隐藏"
                                : c.description || c.event_id || c.id,
                            })),
                            ...(r.automatic_match
                              ? [
                                  {
                                    value: "__distinct__",
                                    label: "已核对：这是另一笔独立交易",
                                  },
                                ]
                              : []),
                          ]}
                          onChange={(v) =>
                            setLinks((old) => ({ ...old, [r.id]: v }))
                          }
                        />
                      ) : (
                        <span className="muted">无匹配候选</span>
                      ),
                  },
                ])}
              />
              <Button
                type="primary"
                icon={<Check size={16} />}
                disabled={
                  !selected.length || preview.row_count > preview.rows.length
                }
                loading={busy}
                onClick={commit}
              >
                确认选定记录
              </Button>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
function Reconciliation() {
  const accounts = useResource("accounts");
  const opts = listOf<Item>(accounts.data).map((a) => ({
    label: a.name,
    value: a.id,
  }));
  return (
    <EntityManager
      resource="reconciliations"
      title="账户核对"
      allowEdit={false}
      fields={[
        {
          name: "account_id",
          label: "账户",
          type: "select",
          required: true,
          options: opts,
        },
        {
          name: "currency",
          label: "币种",
          type: "select",
          required: true,
          initial: "CNY",
          options: currencyOptions,
        },
        {
          name: "as_of",
          label: "核对日期",
          type: "date",
          required: true,
          initial: dateToday(),
        },
        {
          name: "kind",
          label: "核对内容",
          type: "select",
          required: true,
          initial: "balance",
          options: [
            { label: "现金余额", value: "balance" },
            { label: "机构权益", value: "equity" },
            { label: "负债本金", value: "liability" },
          ],
        },
        {
          name: "institution_value",
          label: "凭证金额",
          type: "number",
          required: true,
        },
        {
          name: "reason",
          label: "来源与说明",
          type: "textarea",
          required: true,
          span: 2,
        },
      ]}
      columns={[
        {
          title: "账户",
          dataIndex: "account_id",
          render: (v) => opts.find((a) => a.value === v)?.label || v,
        },
        { title: "日期", dataIndex: "as_of" },
        {
          title: "凭证金额",
          render: (_, r) => (
            <Money value={r.institution_value} currency={r.currency} />
          ),
        },
        {
          title: "系统金额",
          render: (_, r) => (
            <Money value={r.system_value} currency={r.currency} />
          ),
        },
        {
          title: "差异",
          render: (_, r) => (
            <Money value={r.difference} currency={r.currency} />
          ),
        },
        {
          title: "状态",
          dataIndex: "status",
          render: (v) => <Status value={v} />,
        },
      ]}
    />
  );
}
export function Todos() {
  const { hidden } = useWorkspace();
  return (
    <>
      <FundOrders pending />
      <Occurrences />
      <ResourceTable
        resource="todos"
        title="数据核对待办"
        description="差异与异常来源保留，不进行无依据调平。"
        columns={[
          { title: "事项", render: (_, r) => r.title || r.name || r.kind },
          {
            title: "日期",
            render: (_, r) => r.due_date || r.economic_date || "待确认",
          },
          {
            title: "说明",
            render: (_, r) =>
              hidden ? "内容已隐藏" : r.description || r.reason,
          },
          {
            title: "状态",
            dataIndex: "status",
            render: (v) => <Status value={v || "pending"} />,
          },
        ]}
      />
    </>
  );
}
export function Occurrences({
  resource = "occurrences",
}: {
  resource?: string;
}) {
  const { space, reload, openEvent, requestReveal } = useWorkspace();
  const state = useResource(resource),
    eventState = useResource("events", "?limit=1000"),
    planState = useResource("plans", "?limit=1000"),
    loanState = useResource("loans", "?limit=1000"),
    instrumentState = useResource("instruments", "?limit=1000");
  const { modal, message } = App.useApp();
  const [selected, setSelected] = useState<Item | null>(null),
    [eventId, setEventId] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const plans = [
    ...listOf<Item>(planState.data),
    ...listOf<Item>(loanState.data),
  ];
  const allEvents = listOf<Item>(eventState.data).filter(
    (e) => !e.reversed && e.kind !== "reversal",
  );
  return (
    <>
      <Panel
        title={
          resource === "installments"
            ? "逐期还款与实际匹配"
            : "计划期次与到期待办"
        }
        subtitle="到期不会自动扣款。选择已核实的真实事项进行关联；可直接记录实际发生的收支，凭证选填。"
      >
        <LoadState {...state}>
          <Table
            rowKey="id"
            size="small"
            scroll={{ x: 800 }}
            dataSource={listOf<Item>(state.data)}
            columns={helpColumns<Item>([
              { title: "计划", dataIndex: "name" },
              { title: "期次", dataIndex: "sequence", width: 60 },
              { title: "预定日期", dataIndex: "due_date" },
              {
                title: "计划金额",
                render: (_, r) => (
                  <Money value={r.amount} currency={r.currency} />
                ),
              },
              ...(resource === "installments"
                ? [
                    {
                      title: "本金",
                      render: (_: any, r: Item) => (
                        <Money value={r.details?.principal} />
                      ),
                    },
                    {
                      title: "利息",
                      render: (_: any, r: Item) => (
                        <Money value={r.details?.interest} />
                      ),
                    },
                  ]
                : []),
              {
                title: "状态",
                dataIndex: "status",
                render: (v, r) => (
                  <span title={r.subscription_day?.reason}>
                    <Status value={v} />
                    {r.auto_skip && <small>休市</small>}
                  </span>
                ),
                filters: [
                  { text: "待处理", value: "pending" },
                  { text: "未到期", value: "scheduled" },
                  { text: "已完成", value: "confirmed" },
                  { text: "已跳过", value: "skipped" },
                ],
                onFilter: (value, r) => r.status === value,
              },
              {
                title: "处理",
                fixed: "right",
                render: (_, r) =>
                  r.event_id ? (
                    <Tag color="green">已关联实账</Tag>
                  ) : space.role !== "viewer" &&
                    !["skipped", "cancelled"].includes(r.status) ? (
                    <Space>
                      <Button
                        size="small"
                        type="link"
                        onClick={() =>
                          requestReveal(() => {
                            setSelected(r);
                            setEventId(undefined);
                            setError("");
                          })
                        }
                      >
                        匹配实账
                      </Button>
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          const p = plans.find((p) => p.id === r.plan_id);
                          const product = listOf<Item>(
                            instrumentState.data,
                          ).find(
                            (i) =>
                              i.id === (r.instrument_id || p?.instrument_id),
                          );
                          openEvent({
                            id: "",
                            occurrence_id: r.id,
                            instrument_id: r.instrument_id || p?.instrument_id,
                            kind:
                              r.plan_kind === "loans"
                                ? "repayment"
                                : (r.operation_kind || p?.kind) === "dca"
                                  ? product?.kind === "fund"
                                    ? "fund_debit"
                                    : "buy"
                                  : p?.kind || "expense",
                            account_id: r.account_id || p?.account_id,
                            target_account_id:
                              r.liability_account_id || p?.liability_account_id,
                            currency: r.currency,
                            amount: r.amount,
                            economic_date:
                              r.due_date <= dateToday()
                                ? r.due_date
                                : dateToday(),
                            description: r.name,
                          });
                        }}
                      >
                        记一笔并完成
                      </Button>
                      {r.status !== "skipped" && (
                        <Button
                          size="small"
                          type="link"
                          onClick={() =>
                            modal.confirm({
                              title: "跳过这一期计划？",
                              content: "只调整本期计划状态，不改变实际账目。",
                              okText: "跳过本期",
                              onOk: async () => {
                                try {
                                  await send(
                                    `/spaces/${space.id}/occurrences/${r.id}`,
                                    { status: "skipped", version: r.version },
                                    "PATCH",
                                  );
                                  reload();
                                } catch (e) {
                                  message.error((e as Error).message);
                                  throw e;
                                }
                              },
                            })
                          }
                        >
                          跳过
                        </Button>
                      )}
                    </Space>
                  ) : null,
              },
            ])}
            pagination={{ pageSize: 10 }}
            locale={{
              emptyText: (
                <Blank
                  title="暂无计划期次"
                  description="建立定投、周期收支或贷款后可生成待处理安排。"
                />
              ),
            }}
          />
        </LoadState>
      </Panel>
      <Modal
        title="匹配已核实的真实事项"
        open={!!selected}
        onCancel={() => setSelected(null)}
        okText="确认关联"
        cancelText="取消"
        confirmLoading={busy}
        onOk={async () => {
          if (!eventId) {
            setError("请选择真实事项");
            return;
          }
          setBusy(true);
          try {
            await send(
              `/spaces/${space.id}/occurrences/${selected?.id}/confirm`,
              { event_id: eventId },
            );
            message.success("期次已关联真实事项，不重复入账");
            setSelected(null);
            reload();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          当前期次：{selected?.name} · {selected?.due_date}
        </p>
        <Alert
          className="form-alert"
          type="info"
          showIcon
          message="只建立关联，不再次扣除现金。服务端会检查账户、币种、金额与事实类型。"
        />
        <Select
          style={{ width: "100%" }}
          showSearch
          optionFilterProp="label"
          value={eventId}
          onChange={setEventId}
          placeholder="选择现有真实事项"
          options={allEvents.map((e) => ({
            value: e.id,
            label: `${e.economic_date} · ${kinds[e.kind] || e.kind} · ${e.description || e.id.slice(0, 8)}`,
          }))}
        />
        {error && (
          <Alert className="form-alert" type="error" showIcon message={error} />
        )}
      </Modal>
    </>
  );
}
