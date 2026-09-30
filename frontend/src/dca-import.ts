import { formatDecimal } from "./format.ts";
export type DcaImportDraft = {
  scheduled_date: string;
  debit_date: string;
  amount: string;
  funding_account_id: string;
  status: "" | "debited" | "confirmed";
  confirmation_date: string;
  quantity: string;
  nav: string;
  fee: string;
  rounding_adjustment: string;
  entry_basis: "preview_confirmed" | "institution";
  excluded?: boolean;
};
const text = (value: unknown) => (value == null ? "" : String(value));
function date(value: unknown, today: string): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value &&
    value <= today
  );
}
function decimal(
  value: unknown,
  positive = false,
  signed = false,
  places = 12,
) {
  const raw = text(value);
  return (
    new RegExp(
      "^" + (signed ? "-?" : "") + "\\d+(\\.\\d{1," + places + "})?$",
    ).test(raw) &&
    (!positive || /[1-9]/.test(raw))
  );
}
function scaled(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}
/** Match ledger 12-place rounding without IEEE-754; the server still enforces adjustment limits. */
export function dcaRoundingAdjustment(
  row: Partial<DcaImportDraft>,
): string | null {
  if (
    !decimal(row.amount, true) ||
    !decimal(row.quantity, true, false, 18) ||
    !decimal(row.nav, true, false, 18) ||
    !decimal(row.fee)
  )
    return null;
  const calculated =
    scaled(row.quantity!) * scaled(row.nav!) + scaled(row.fee!) * 10n ** 18n;
  const unit = 10n ** 24n;
  const quotient = calculated / unit,
    remainder = calculated % unit;
  const total =
    quotient +
    (remainder > unit / 2n || (remainder === unit / 2n && quotient % 2n !== 0n)
      ? 1n
      : 0n);
  const difference = scaled(row.amount!) / 10n ** 6n - total;
  const absolute = difference < 0n ? -difference : difference;
  const fraction = (absolute % 10n ** 12n)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return (
    (difference < 0n ? "-" : "") +
    String(absolute / 10n ** 12n) +
    (fraction ? "." + fraction : "")
  );
}
export function dcaWithRounding(row: DcaImportDraft): DcaImportDraft {
  return { ...row, rounding_adjustment: dcaRoundingAdjustment(row) ?? "0" };
}
export function dcaQuantityDraft(
  amount: string,
  fee: string,
  nav: string,
): string {
  if (!decimal(amount, true) || !decimal(fee) || !decimal(nav, true, false, 18))
    return "";
  const net = scaled(amount) - scaled(fee),
    price = scaled(nav);
  if (net <= 0n) return "";
  const hundredths = (net * 100n * 2n + price) / (price * 2n);
  return (
    String(hundredths / 100n) +
    "." +
    (hundredths % 100n).toString().padStart(2, "0")
  );
}
export function dcaRoundingTotal(rows: DcaImportDraft[]): string {
  const unit = 10n ** 12n;
  const total = rows
    .filter((row) => !row.excluded && row.status === "confirmed")
    .reduce((sum, row) => {
      if (!decimal(row.rounding_adjustment, false, true)) return sum;
      const negative = row.rounding_adjustment.startsWith("-"),
        [whole, fraction = ""] = row.rounding_adjustment
          .replace(/^-/, "")
          .split(".");
      const amount = BigInt(whole) * unit + BigInt(fraction.padEnd(12, "0"));
      return sum + (negative ? -amount : amount);
    }, 0n);
  const absolute = total < 0n ? -total : total,
    fraction = (absolute % unit)
      .toString()
      .padStart(12, "0")
      .replace(/0+$/, "");
  return (
    (total < 0n ? "-" : "") +
    String(absolute / unit) +
    (fraction ? "." + fraction : "")
  );
}
export function dcaEstimateDraft(row: Record<string, any>, precision = 2) {
  // Unknown fee means a before-fee theoretical quantity cannot become a confirmed quantity.
  const quantity = formatDecimal(
    row.estimated_quantity,
    false,
    precision,
  )?.replaceAll(",", "");
  return {
    quantity: quantity || "",
    nav: decimal(row.nav, true, false, 18) ? text(row.nav) : "",
    fee: decimal(row.fee) ? text(row.fee) : "",
  };
}
export function dcaImportDrafts(
  preview: Record<string, any>,
  plan: Record<string, any>,
  today: string,
): DcaImportDraft[] {
  return (preview.items || [])
    .filter((row: any) => row.selected === true)
    .map((row: any) => {
      const scheduled = row.is_scheduled === true;
      const knownDate =
        scheduled && date(row.expected_confirmation_date, today);
      return dcaWithRounding({
        scheduled_date: row.date,
        debit_date: scheduled ? row.date : "",
        amount: scheduled ? text(row.amount ?? plan.amount) : "",
        funding_account_id: text(plan.account_id),
        status:
          row.pending_forecast === true ||
          (row.expected_confirmation_date &&
            row.expected_confirmation_date > today)
            ? "debited"
            : knownDate
              ? "confirmed"
              : "",
        confirmation_date: knownDate ? row.expected_confirmation_date : "",
        ...dcaEstimateDraft(row),
        rounding_adjustment: "0",
        entry_basis: "preview_confirmed",
      });
    });
}
export function dcaDraftIssue(
  row: DcaImportDraft,
  today: string,
): string | null {
  if (row.excluded) return null;
  if (!date(row.scheduled_date, today)) return "计划日期待核实";
  if (!date(row.debit_date, today)) return "扣款日期待核实";
  if (!row.funding_account_id) return "选择付款账户";
  if (!decimal(row.amount, true)) return "扣款金额待补全";
  if (!["debited", "confirmed"].includes(row.status)) return "确认状态待选择";
  if (row.status === "confirmed") {
    if (
      !date(row.confirmation_date, today) ||
      row.confirmation_date < row.debit_date
    )
      return "确认日期待核实";
    if (!decimal(row.fee)) return "费用未知，请填写或明确记为在途";
    if (!decimal(row.nav, true, false, 18))
      return "缺净值，请补充或明确记为在途";
    if (!decimal(row.quantity, true, false, 18)) return "份额待补全";
    if (!decimal(row.rounding_adjustment, false, true)) return "尾差金额无效";
  }
  return null;
}
export function dcaImportRequest(
  holdingAccountId: string,
  drafts: DcaImportDraft[],
  today: string,
) {
  if (!holdingAccountId) throw new Error("请选择持仓账户");
  const selected = drafts.filter((row) => !row.excluded);
  if (!selected.length) throw new Error("没有纳入补录的期次");
  const seen = new Set<string>();
  const rows = selected.map((row) => {
    const issue = dcaDraftIssue(row, today);
    if (issue) throw new Error(row.scheduled_date + "：" + issue);
    if (seen.has(row.scheduled_date)) throw new Error("计划日期重复");
    seen.add(row.scheduled_date);
    return {
      scheduled_date: row.scheduled_date,
      debit_date: row.debit_date,
      amount: row.amount,
      funding_account_id: row.funding_account_id,
      status: row.status,
      entry_basis: row.entry_basis,
      ...(row.status === "confirmed"
        ? {
            confirmation_date: row.confirmation_date,
            quantity: row.quantity,
            nav: row.nav,
            fee: row.fee,
            rounding_adjustment: row.rounding_adjustment,
            // Validation is read-only; the overall commit confirmation covers this displayed adjustment.
            rounding_confirmed: true,
          }
        : {}),
    };
  });
  return { holding_account_id: holdingAccountId, rows };
}
export function dcaCommitRequest(
  body: ReturnType<typeof dcaImportRequest>,
  validation: Record<string, any>,
  drafts: DcaImportDraft[],
  confirmed: boolean,
) {
  if (!validation?.ready) throw new Error("请先解决检查发现的问题");
  if (
    !validation.validation_digest ||
    validation.data_revision == null ||
    validation.plan_version == null
  )
    throw new Error("核对结果不完整，请重新检查");
  if (!confirmed)
    throw new Error("请确认按以上预览补录，并已核对扣款与确认状态");
  if (
    JSON.stringify(
      dcaImportRequest(body.holding_account_id, drafts, "9999-12-31"),
    ) !== JSON.stringify(body)
  )
    throw new Error("预览已改变，请等待重新检查");
  return {
    ...body,
    expected_revision: validation.data_revision,
    expected_plan_version: validation.plan_version,
    validation_digest: validation.validation_digest,
    confirm_actual_records: true,
    confirm_preview_entries: true,
  };
}
/** Saved facts take priority; a recorded debit stays in transit until an explicit action. */
export function dcaLoadExisting(
  draft: DcaImportDraft,
  existing: Record<string, any>,
): DcaImportDraft {
  const confirmed = existing.status === "confirmed";
  return {
    ...draft,
    debit_date: text(existing.debit_date),
    amount: text(existing.amount),
    funding_account_id: text(existing.funding_account_id),
    status: confirmed ? "confirmed" : "debited",
    confirmation_date: confirmed ? text(existing.confirmation_date) : "",
    quantity: confirmed ? text(existing.quantity) : "",
    nav: confirmed ? text(existing.nav) : "",
    fee: confirmed ? text(existing.fee) : "",
    rounding_adjustment: confirmed
      ? text(existing.rounding_adjustment ?? "0")
      : "0",
    entry_basis:
      existing.entry_basis === "preview_confirmed"
        ? "preview_confirmed"
        : "institution",
  };
}
/** Explicitly promote a saved pending debit without changing its debit facts. */
export function dcaConfirmFromPreview(
  draft: DcaImportDraft,
  previewRow: Record<string, any>,
  today: string,
): DcaImportDraft {
  const known = date(previewRow.expected_confirmation_date, today),
    estimate = dcaEstimateDraft(previewRow);
  const nav = draft.nav || estimate.nav,
    fee = draft.fee || estimate.fee;
  return dcaWithRounding({
    ...draft,
    nav,
    fee,
    quantity: draft.quantity || dcaQuantityDraft(draft.amount, fee, nav),
    status: known ? "confirmed" : "",
    confirmation_date: known ? previewRow.expected_confirmation_date : "",
    entry_basis: "preview_confirmed",
  });
}
