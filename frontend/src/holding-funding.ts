/** Preview only; the server rechecks balances and dates atomically on save. */
const scale = 10n ** 12n;
function amount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+(\.\d{1,12})?$/.test(value))
    return null;
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const unsigned = BigInt(whole) * scale + BigInt(fraction.padEnd(12, "0"));
  return value.startsWith("-") ? -unsigned : unsigned;
}
function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % scale)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${absolute / scale}${fraction ? `.${fraction}` : ""}`;
}
export function holdingFundingPreview(input: {
  mode: string;
  currentValue?: unknown;
  cost?: unknown;
  profit?: unknown;
  available?: unknown;
}) {
  const balance = amount(input.available);
  const cost = amount(input.cost),
    profit = amount(input.profit);
  const value =
    input.mode === "profit"
      ? cost !== null && profit !== null
        ? cost + profit
        : null
      : amount(input.currentValue);
  if (value === null || value < 0n || balance === null || balance < 0n)
    return null;
  const used = value < balance ? value : balance;
  return {
    required: decimal(value),
    used: decimal(used),
    shortfall: decimal(value - used),
    remaining: decimal(balance - used),
  };
}
