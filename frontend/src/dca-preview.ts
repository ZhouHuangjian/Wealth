function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
/** Product-only context has no holding account; never serialize its missing value. */
export function dcaPlanContext(context?: Record<string, any>) {
  const id = (value: unknown) =>
    typeof value === "string" &&
    value.trim() &&
    !["undefined", "null"].includes(value.trim())
      ? value.trim()
      : undefined;
  const instrumentId = id(context?.instrument_id) || id(context?.id);
  const holdingAccountId = id(context?.account_id);
  const related = [
    ...new Set(
      [
        ...(Array.isArray(context?.account_ids) ? context.account_ids : []),
        ...(Array.isArray(context?.specification?.account_ids)
          ? context.specification.account_ids
          : []),
      ]
        .map(id)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  const queryParams: Record<string, string> = {};
  if (instrumentId) queryParams.instrument_id = instrumentId;
  // The bank funding a plan may differ from the account that receives its units.
  if (holdingAccountId) queryParams.holding_account_id = holdingAccountId;
  return {
    queryParams: context ? queryParams : undefined,
    instrumentId,
    defaultAccountId:
      holdingAccountId || (related.length === 1 ? related[0] : undefined),
  };
}
export function dcaInitialRange(plan: Record<string, any>, today: string) {
  return {
    start: plan.start_date || today,
    end: plan.end_date && plan.end_date < today ? plan.end_date : today,
  };
}
export function dcaHistoryRefreshRequest(
  plan: Record<string, any>,
  values: Record<string, any>,
  today: string,
) {
  if (typeof plan.instrument_id !== "string" || !plan.instrument_id.trim())
    throw new Error("计划尚未关联投资产品，请先完善计划");
  if (!validDate(values.start) || values.start > today)
    throw new Error("请填写有效的历史开始日期，不能晚于今天");
  return {
    instrument_ids: [plan.instrument_id],
    history: true,
    start: values.start,
  };
}
export function dcaPreviewRequest(values: Record<string, any>) {
  const excluded = String(values.excluded_dates_text || "")
    .split(/[\s,，;；]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (excluded.some((value) => !validDate(value)))
    throw new Error("排除日期请按 YYYY-MM-DD 填写，多日用换行或逗号分隔");
  if (
    !validDate(values.start) ||
    !validDate(values.end) ||
    values.start > values.end
  )
    throw new Error("填写有效起止日期，结束日期不能早于开始日期");
  const ranges = (values.pause_ranges || [])
    .filter((row: any) => row?.start || row?.end)
    .map((row: any) => {
      if (!validDate(row.start) || !validDate(row.end) || row.start > row.end)
        throw new Error("暂停区间须填写完整有效的起止日期");
      return { start: row.start, end: row.end };
    });
  if (!["unknown", "zero", "fixed"].includes(values.fee_mode))
    throw new Error("选择费用假设");
  if (
    values.fee_mode === "fixed" &&
    !/^\d+(\.\d{1,12})?$/.test(String(values.fee_amount ?? ""))
  )
    throw new Error("填写非负的每期固定费用，最多12位小数");
  return {
    start: values.start,
    end: values.end,
    as_of: values.as_of || values.end,
    excluded_dates: [...new Set(excluded)],
    pause_ranges: ranges,
    fee_mode: values.fee_mode,
    ...(values.fee_mode === "fixed"
      ? { fee_amount: String(values.fee_amount) }
      : {}),
  };
}
/** Never promote a partial sum to a complete amount. */
export function dcaPreviewMetric(
  summary: Record<string, any>,
  total: string,
  known: string,
) {
  return {
    value: summary?.[total] ?? summary?.[known] ?? null,
    partial: summary?.[total] == null && summary?.[known] != null,
  };
}
export function dcaExcludedDates(text: unknown): string[] {
  return [
    ...new Set(
      String(text || "")
        .split(/[\s,，;；]+/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}
export function toggleDcaExcludedDate(text: unknown, date: string): string {
  const dates = new Set(dcaExcludedDates(text));
  if (dates.has(date)) dates.delete(date);
  else dates.add(date);
  return [...dates].sort().join(", ");
}

/** Coverage is independent of forecast confirmation: known pending units remain estimates. */
export function dcaPreviewCoverage(
  data: Record<string, any>,
  theoretical: boolean,
) {
  const scale = 10n ** 12n;
  const selected = (data.items || []).filter(
    (row: any) => row.selected === true && row.is_scheduled === true,
  );
  const known = selected.filter(
    (row: any) =>
      (theoretical ? row.theoretical_quantity : row.estimated_quantity) != null,
  );
  function sum(rows: any[]) {
    const total = rows.reduce((value: bigint, row: any) => {
      const raw = String(row.amount ?? "");
      if (!/^\d+(\.\d{1,12})?$/.test(raw)) return value;
      const [whole, fraction = ""] = raw.split(".");
      return value + BigInt(whole) * scale + BigInt(fraction.padEnd(12, "0"));
    }, 0n);
    const fraction = (total % scale)
      .toString()
      .padStart(12, "0")
      .replace(/0+$/, "");
    return String(total / scale) + (fraction ? "." + fraction : "");
  }
  return {
    selected_count: selected.length,
    known_count: known.length,
    known_amount: sum(known),
    unknown_count: selected.length - known.length,
    unknown_amount: sum(selected.filter((row: any) => !known.includes(row))),
    pending_amount: sum(
      selected.filter((row: any) => row.pending_forecast === true),
    ),
    pending_count: selected.filter((row: any) => row.pending_forecast === true)
      .length,
    unknown_calendar_count: (data.items || []).filter(
      (row: any) => row.selected === true && row.is_scheduled == null,
    ).length,
  };
}
