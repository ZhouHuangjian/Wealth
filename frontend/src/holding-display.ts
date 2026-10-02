/** Display-only preferences and exact decimal summaries. Never changes recorded holdings. */
export type HoldingRow = Record<string, any>;
export const holdingColumnDefinitions = [
  { key: "product", label: "产品 / 账户", width: 240, required: true },
  { key: "value", label: "最新持仓价值", width: 150 },
  { key: "pending", label: "买入待确认", width: 150 },
  { key: "profit", label: "持有收益 / 毛浮盈", width: 150 },
  { key: "daily", label: "今日估算收益", width: 160 },
  { key: "latest", label: "最近净值收益", width: 190 },
  { key: "kind", label: "类型", width: 80 },
  { key: "cost", label: "数量 / 成本", width: 150 },
  { key: "estimate", label: "盘中估值 / 结算参考", width: 170 },
  { key: "purchase", label: "买入 / 开仓日期", width: 125 },
  { key: "tags", label: "投资标签", width: 130 },
  { key: "status", label: "数据状态", width: 160 },
  { key: "actions", label: "操作", width: 180, required: true },
] as const;
export type HoldingColumnKey = (typeof holdingColumnDefinitions)[number]["key"];
export const holdingSortOptions = [
  { value: "default", label: "原始顺序" },
  { value: "name", label: "产品名称" },
  { value: "account", label: "持有账户" },
  { value: "value_desc", label: "市值由高到低（同币种）" },
  { value: "pending_desc", label: "待确认金额由高到低（同币种）" },
  { value: "profit_desc", label: "持有收益由高到低（同币种）" },
  { value: "daily_desc", label: "今日收益由高到低（同币种）" },
  { value: "rate_desc", label: "持有收益率由高到低" },
] as const;
export type HoldingDisplayPreferences = {
  version: 1;
  order: HoldingColumnKey[];
  hidden: HoldingColumnKey[];
  fixed: Partial<Record<HoldingColumnKey, "left" | "right">>;
  pinned: string[];
  sort: (typeof holdingSortOptions)[number]["value"];
};
export function defaultHoldingDisplay(): HoldingDisplayPreferences {
  return {
    version: 1,
    order: holdingColumnDefinitions.map((c) => c.key),
    hidden: [
      "pending",
      "latest",
      "kind",
      "cost",
      "estimate",
      "purchase",
      "status",
      "tags",
    ],
    fixed: { product: "left", actions: "right" },
    pinned: [],
    sort: "default",
  };
}
export function holdingPreferenceKey(
  userId: unknown,
  spaceId: unknown,
): string | null {
  const valid = (v: unknown) =>
    (typeof v === "string" && v.trim().length > 0) ||
    (typeof v === "number" && Number.isSafeInteger(v) && v > 0);
  return valid(userId) && valid(spaceId)
    ? `wealth:holdings-display:v1:${encodeURIComponent(String(userId))}:${encodeURIComponent(String(spaceId))}`
    : null;
}
export function normalizeHoldingDisplay(raw: any): HoldingDisplayPreferences {
  const defaults = defaultHoldingDisplay();
  if (!raw || raw.version !== 1) return defaults;
  const keys = new Set<string>(defaults.order);
  const selected = (values: unknown) =>
    Array.isArray(values)
      ? ([
          ...new Set(
            values.filter((v) => typeof v === "string" && keys.has(v)),
          ),
        ] as HoldingColumnKey[])
      : [];
  const required = new Set(
    holdingColumnDefinitions
      .filter((c) => "required" in c && c.required)
      .map((c) => c.key),
  );
  const order = selected(raw.order);
  const hidden = Array.isArray(raw.hidden)
    ? selected(raw.hidden).filter((k) => !required.has(k))
    : defaults.hidden;
  // Newly introduced optional columns must not widen a user's saved layout.
  if (!order.includes("pending") && !hidden.includes("pending"))
    hidden.push("pending");
  return {
    version: 1,
    order: [...order, ...defaults.order.filter((k) => !order.includes(k))],
    hidden,
    fixed:
      raw.fixed && typeof raw.fixed === "object"
        ? Object.fromEntries(
            defaults.order
              .filter((k) => ["left", "right"].includes(raw.fixed[k]))
              .map((k) => [k, raw.fixed[k]]),
          )
        : defaults.fixed,
    pinned: Array.isArray(raw.pinned)
      ? ([
          ...new Set(
            raw.pinned.filter(
              (v: unknown): v is string =>
                typeof v === "string" && v.length <= 200,
            ),
          ),
        ].slice(0, 500) as string[])
      : [],
    sort: holdingSortOptions.some((s) => s.value === raw.sort)
      ? raw.sort
      : defaults.sort,
  };
}
export function configuredHoldingColumns(
  preferences: HoldingDisplayPreferences,
) {
  const prefs = normalizeHoldingDisplay(preferences);
  const visible = prefs.order.filter((key) => !prefs.hidden.includes(key));
  return [
    ...visible.filter((k) => prefs.fixed[k] === "left"),
    ...visible.filter((k) => !prefs.fixed[k]),
    ...visible.filter((k) => prefs.fixed[k] === "right"),
  ].map((key) => ({
    ...holdingColumnDefinitions.find((c) => c.key === key)!,
    fixed: prefs.fixed[key],
  }));
}
export function holdingRowKey(row: HoldingRow): string {
  return row.is_reference_position
    ? `reference-${row.id}`
    : `${row.account_id}-${row.instrument_id}`;
}
export function holdingLabels(row: HoldingRow): string[] {
  return [
    ...new Set(
      (Array.isArray(row.labels)
        ? row.labels
        : Array.isArray(row.tags)
          ? row.tags
          : []
      )
        .map((tag: any) => (typeof tag === "string" ? tag : tag?.name))
        .filter(
          (v: unknown): v is string => typeof v === "string" && !!v.trim(),
        ),
    ),
  ] as string[];
}
export function holdingMatches(row: HoldingRow, query: string, kind = "") {
  if (
    kind &&
    row.kind !== kind &&
    !({ future: ["futures"], option: ["options"] } as Record<string, string[]>)[
      kind
    ]?.includes(row.kind)
  )
    return false;
  const haystack = [
    row.name,
    row.instrument_name,
    row.code,
    row.instrument_code,
    row.account_name,
    ...(row.account_names || []),
    ...holdingLabels(row),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token));
}
const SCALE = 10n ** 36n;
function decimal(value: unknown): bigint | null {
  const text = String(value ?? "").trim();
  if (!/^[+-]?\d+(\.\d{1,36})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
  return (
    (BigInt(whole) * SCALE + BigInt(fraction.padEnd(36, "0"))) *
    (text.startsWith("-") ? -1n : 1n)
  );
}
function amount(value: bigint): string {
  const abs = value < 0n ? -value : value;
  const fraction = (abs % SCALE)
    .toString()
    .padStart(36, "0")
    .replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${abs / SCALE}${fraction ? "." + fraction : ""}`;
}
export function holdingMarketValue(row: HoldingRow) {
  if (row.pending_only === true) return null;
  return row.is_reference_position
    ? row.current_value
    : (row.manual_value ?? row.market_value ?? row.value);
}
export function holdingPendingAmount(row: HoldingRow): string | null {
  const pending = row.pending_purchases;
  const value = decimal(pending?.amount);
  return !row.is_reference_position &&
    (row.contributes !== false || row.pending_only === true) &&
    pending?.added_to_net_assets === false &&
    pending.currency === row.currency &&
    value !== null &&
    value >= 0n
    ? amount(value)
    : null;
}
export function hasPendingPurchases(row: HoldingRow): boolean {
  const value = decimal(holdingPendingAmount(row));
  return value !== null && value > 0n;
}
export function pendingPurchaseItems(items: unknown): HoldingRow[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const id = String(item.debit_event_id || item.id || "");
    const remaining = decimal(item.amount);
    if (
      !id ||
      seen.has(id) ||
      remaining === null ||
      remaining <= 0n ||
      !/^[A-Z]{3}$/.test(item.currency || "")
    )
      return false;
    seen.add(id);
    return true;
  });
}
function reliable(row: HoldingRow) {
  return (
    row.status !== "needs_reconciliation" && row.scope_unconfirmed !== true
  );
}
export function holdingDailyAmount(row: HoldingRow, asOf: string) {
  const daily = row.daily_return;
  return reliable(row) &&
    row.pending_only !== true &&
    !row.is_reference_position &&
    row.contributes !== false &&
    daily?.date === asOf &&
    ["estimated", "confirmed"].includes(daily?.status) &&
    daily.currency === row.currency &&
    decimal(daily.amount) !== null
    ? daily.amount
    : null;
}
export function sortHoldings(
  rows: HoldingRow[],
  preferences: HoldingDisplayPreferences,
  asOf: string,
) {
  const prefs = normalizeHoldingDisplay(preferences);
  const pins = new Map(prefs.pinned.map((key, index) => [key, index]));
  const key = prefs.sort;
  const numeric = (row: HoldingRow) =>
    decimal(
      key === "pending_desc"
        ? holdingPendingAmount(row)
        : !reliable(row) || row.pending_only === true
          ? null
          : key === "value_desc"
            ? holdingMarketValue(row)
            : key === "daily_desc"
              ? holdingDailyAmount(row, asOf)
              : key === "rate_desc"
                ? row.is_reference_position
                  ? null
                  : row.profit_rate
                : row.is_reference_position
                  ? row.reference_profit
                  : row.profit,
    );
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const pa = pins.get(holdingRowKey(a.row)),
        pb = pins.get(holdingRowKey(b.row));
      if (pa !== undefined || pb !== undefined)
        return (
          (pa ?? Number.MAX_SAFE_INTEGER) - (pb ?? Number.MAX_SAFE_INTEGER)
        );
      if (key === "default") return a.index - b.index;
      if (key === "name" || key === "account")
        return (
          String(
            key === "name"
              ? a.row.instrument_name || a.row.name || ""
              : a.row.account_name || "",
          ).localeCompare(
            String(
              key === "name"
                ? b.row.instrument_name || b.row.name || ""
                : b.row.account_name || "",
            ),
            "zh-CN",
          ) || a.index - b.index
        );
      // Currency amounts are comparable only within the same denomination.
      if (key !== "rate_desc" && a.row.currency !== b.row.currency)
        return String(a.row.currency || "~").localeCompare(
          String(b.row.currency || "~"),
        );
      const av = numeric(a.row),
        bv = numeric(b.row);
      if (av === null || bv === null)
        return av === bv ? a.index - b.index : av === null ? 1 : -1;
      return av === bv ? a.index - b.index : av > bv ? -1 : 1;
    })
    .map(({ row }) => row);
}
export function summarizeHoldings(rows: HoldingRow[], asOf: string) {
  const referenceCount = rows.filter(
    (r) =>
      r.is_reference_position ||
      (r.contributes === false && r.pending_only !== true),
  ).length;
  const ordinary = rows.filter(
    (r) =>
      !r.is_reference_position &&
      (r.contributes !== false || r.pending_only === true),
  );
  const unknownCurrencyCount = ordinary.filter(
    (r) => !/^[A-Z]{3}$/.test(r.currency || ""),
  ).length;
  const currencies = [
    ...new Set(
      ordinary.map((r) => r.currency).filter((c) => /^[A-Z]{3}$/.test(c || "")),
    ),
  ].sort() as string[];
  return {
    referenceCount,
    unknownCurrencyCount,
    groups: currencies.map((currency) => {
      const items = ordinary.filter((r) => r.currency === currency);
      const confirmed = items.filter((row) => row.pending_only !== true);
      const sum = (
        read: (row: HoldingRow) => unknown,
        source = confirmed,
        requireReliable = true,
      ) => {
        const values = source.map((row) =>
          !requireReliable || reliable(row) ? decimal(read(row)) : null,
        );
        const known = values.filter((v): v is bigint => v !== null);
        return {
          amount: known.length
            ? amount(known.reduce((a, b) => a + b, 0n))
            : null,
          known: known.length,
          total: source.length,
          complete: known.length === source.length,
        };
      };
      return {
        currency,
        count: items.length,
        confirmedCount: confirmed.length,
        pendingOnlyCount: items.length - confirmed.length,
        value: sum(holdingMarketValue),
        pending: sum(holdingPendingAmount, items, false),
        pendingItems: pendingPurchaseItems(
          items.flatMap((row) =>
            holdingPendingAmount(row) !== null
              ? row.pending_purchases.items || []
              : [],
          ),
        ),
        profit: sum((r) => r.profit),
        daily: sum((r) => holdingDailyAmount(r, asOf)),
      };
    }),
  };
}
