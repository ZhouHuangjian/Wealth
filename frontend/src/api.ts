export type Item = { id: string; version?: number; [key: string]: any };
export class ApiError extends Error {
  status: number;
  fields: Record<string, any>;
  constructor(
    message: string,
    status: number,
    fields: Record<string, any> = {},
  ) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}
let csrf = "";
const pending = new Map<string, string>();
async function operationKey(path: string, body: string) {
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(path + body),
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const storageKey = `wealth:pending:${hash}`;
  let key = pending.get(storageKey) || sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
    pending.set(storageKey, key);
  }
  return { key, storageKey };
}
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method || "GET";
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let operation: { key: string; storageKey: string } | undefined;
  if (method !== "GET") {
    headers.set("X-CSRFToken", csrf);
    if (!headers.has("Idempotency-Key")) {
      operation = await operationKey(
        path,
        typeof options.body === "string" ? options.body : crypto.randomUUID(),
      );
      headers.set("Idempotency-Key", operation.key);
    }
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  const contentType = response.headers.get("Content-Type") || "";
  const result = contentType.includes("json")
    ? await response.json()
    : { message: await response.text() };
  if (
    operation &&
    (response.ok || (response.status >= 400 && response.status < 500))
  ) {
    sessionStorage.removeItem(operation.storageKey);
    pending.delete(operation.storageKey);
  }
  if (!response.ok)
    throw new ApiError(
      result.message || result.detail || `请求未成功 (${response.status})`,
      response.status,
      result.fields,
    );
  return result as T;
}
export const send = <T = any>(
  path: string,
  body: unknown = {},
  method = "POST",
) => api<T>(path, { method, body: JSON.stringify(body) });
export function listOf<T = Item>(response: any): T[] {
  return Array.isArray(response)
    ? response
    : response?.items || response?.results || [];
}
export function dateToday() {
  return new Date().toLocaleDateString("sv-SE");
}
export function dateTimeNowLocal() {
  return new Date().toLocaleString("sv-SE").replace(" ", "T").slice(0, 16);
}
export const currencyOptions = ["CNY", "HKD", "USD"].map((value) => ({
  label: value,
  value,
}));
export const kinds: Record<string, string> = {
  opening: "补录期初持仓",
  income: "收入",
  expense: "消费支出",
  transfer: "同币种账户转账",
  refund: "退款",
  fx: "实际换汇",
  fund_debit: "基金申购扣款",
  fund_funding: "补充申购扣款账户",
  fund_confirm: "基金份额确认",
  fund_redeem: "基金赎回确认",
  fund_refund: "基金未确认款退款",
  settlement: "实际交收 / 到账",
  buy: "记录买入",
  sell: "记录卖出",
  dividend: "现金分红",
  reinvest: "红利再投",
  split: "份额拆分",
  position_transfer: "持仓转移",
  repayment: "实际还款",
  repayment_allocate: "补充还款拆分",
  property_purchase: "购房落地",
};
export const accountKinds: Record<string, string> = {
  bank: "银行账户",
  cash: "现金",
  wallet: "支付钱包",
  fund: "基金渠道",
  broker: "证券账户",
  futures: "期货账户",
  credit_card: "信用卡",
  loan: "贷款",
  receivable: "借出款",
  property: "房产",
  other: "其他资产",
};
export const states: Record<string, string> = {
  active: "启用",
  draft: "草稿",
  pending: "待核对",
  scheduled: "待执行",
  matched: "已核对一致",
  mismatch: "存在差异",
  in_progress: "核对未完成",
  synthetic_verified: "通用格式合成验证",
  needs_review: "待处理行级问题",
  ready: "可提交",
  official: "正式数据",
  complete_official: "完整正式",
  partial_official: "部分正式",
  released: "已解除",
  consumed: "已支付",
  confirmed: "已确认",
  completed: "已完成",
  paused: "已暂停",
  cancelled: "已取消",
  reversed: "已冲正",
  committed: "已入账",
  partially_committed: "部分已确认 · 可续办",
  previewed: "已预览",
  uploaded: "已上传",
  partial: "部分完整",
  complete: "完整",
  unknown: "未知",
  missing: "缺失",
  stale: "已过期",
  published: "已发布",
  archived: "已归档",
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
  due: "待执行",
  skipped: "已跳过",
  planned: "计划适配",
  supported: "通用格式可用",
};

export function transferLabel(from?: Item, to?: Item) {
  if (from?.kind === "bank" && ["future", "futures"].includes(to?.kind))
    return "银期转入";
  if (["future", "futures"].includes(from?.kind) && to?.kind === "bank")
    return "银期转出";
  return "同币种账户转账";
}
