export const investmentKinds: Record<string, string> = {
  fund: "基金",
  stock: "股票",
  etf: "ETF",
  future: "期货",
  option: "期权",
  gold: "黄金",
  index: "指数",
};
export const compatibleAccountKinds: Record<string, string[]> = {
  fund: ["fund", "broker", "bank", "wallet"],
  stock: ["broker"],
  etf: ["broker"],
  future: ["futures"],
  option: ["futures", "broker"],
  gold: ["bank", "broker", "fund", "wallet", "other"],
};
export function percentText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
  const padded = fraction.padEnd(5, "0");
  const hundredths =
    BigInt(whole) * 10000n +
    BigInt(padded.slice(0, 4)) +
    (Number(padded[4]) >= 5 ? 1n : 0n);
  return `${negative && hundredths !== 0n ? "−" : hundredths !== 0n ? "+" : ""}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}%`;
}
export function profitTone(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    !/^[+-]?\d+(\.\d+)?$/.test(String(value))
  )
    return "";
  if (/^[+-]?0+(\.0+)?$/.test(String(value))) return "";
  return String(value).startsWith("-") ? "profit-down" : "profit-up";
}
export function monthBounds(month: string): { start: string; end: string } {
  const [year, number] = month.split("-").map(Number);
  return {
    start: `${month}-01`,
    end: `${month}-${new Date(year, number, 0).getDate()}`,
  };
}

/** The public catalog groups mainland exchanges under CN; product specifications retain the exchange. */
export function catalogMarket(market: string): string {
  return ["SHFE", "CFFEX", "DCE", "CZCE", "INE", "GFEX", "SGE"].includes(
    market.toUpperCase(),
  )
    ? "CN"
    : market.toUpperCase();
}

/** Ignore retained AntD fields from a different dividend mode. */
export function dividendConfirmation(values: Record<string, any>) {
  const result: Record<string, any> = {
    actual_confirmed: values.actual_confirmed,
  };
  const keys =
    values.mode === "link"
      ? ["event_id"]
      : values.mode === "cash"
        ? ["mode", "economic_date", "amount", "fee", "tax"]
        : ["mode", "economic_date", "quantity", "price", "fee"];
  for (const key of keys)
    if (values[key] !== undefined) result[key] = values[key];
  return result;
}
