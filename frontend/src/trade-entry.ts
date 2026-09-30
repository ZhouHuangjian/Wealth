/** Exact decimal preview; calculation inputs and stored shares remain unrounded. */
export function tradeAmountPreview(
  side: string,
  quantity: unknown,
  price: unknown,
  fee: unknown = "0",
  tax: unknown = "0",
): string | null {
  const units = (value: unknown, precision: number) => {
    const match = String(value ?? "").match(/^(\d+)(?:\.(\d+))?$/);
    if (!match || (match[2]?.length || 0) > precision) return null;
    return BigInt(match[1] + (match[2] || "").padEnd(precision, "0"));
  };
  const q = units(quantity, 18),
    p = units(price, 18),
    f = units(fee || "0", 2),
    t = units(tax || "0", 2);
  if (
    q === null ||
    p === null ||
    f === null ||
    t === null ||
    !["buy", "sell"].includes(side)
  )
    return null;
  const divisor = 10n ** 34n;
  const gross = (q * p + divisor / 2n) / divisor;
  const cents = side === "buy" ? gross + f + t : gross - f - t;
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}
