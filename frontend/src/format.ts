/** Display decimal strings without converting authoritative amounts to IEEE-754. */
export function formatDecimal(
  value: string | number | null | undefined,
  sign = false,
  precision?: number,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  let input = String(value);
  if (!/^[+-]?\d+(\.\d+)?$/.test(input)) return null;
  if (precision !== undefined) {
    if (!Number.isInteger(precision) || precision < 0 || precision > 12)
      return null;
    const [integer, decimals = ""] = input.replace(/^[-+]/, "").split(".");
    const scale = 10n ** BigInt(precision);
    const padded = decimals.padEnd(precision + 1, "0");
    const rounded =
      BigInt(integer) * scale +
      BigInt(padded.slice(0, precision) || "0") +
      (Number(padded[precision]) >= 5 ? 1n : 0n);
    input = `${input.startsWith("-") && rounded !== 0n ? "-" : ""}${rounded / scale}${precision ? `.${String(rounded % scale).padStart(precision, "0")}` : ""}`;
  }
  const isZero = /^[+-]?0+(\.0+)?$/.test(input);
  const negative = input.startsWith("-") && !isZero;
  const [whole, rawFraction] = input.replace(/^[-+]/, "").split(".");
  const fraction =
    rawFraction === undefined
      ? undefined
      : rawFraction.replace(/0+$/, "").padEnd(2, "0");
  return (
    (negative ? "−" : sign && !isZero ? "+" : "") +
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction === undefined ? "" : `.${fraction}`)
  );
}
