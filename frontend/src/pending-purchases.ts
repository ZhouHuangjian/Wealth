type PendingSummary = {
  count?: number;
  amount?: string | number | null;
  known_amount?: string | number | null;
};

/** Display the server's aggregate; missing currency conversion must never look like zero. */
export function pendingSummaryDisplay(summary?: PendingSummary | null) {
  const visible =
    Number.isInteger(summary?.count) && Number(summary?.count) > 0;
  if (!visible) return { visible: false, amount: undefined, note: "" };
  if (summary?.amount != null)
    return { visible: true, amount: summary.amount, note: "" };
  const known = summary?.known_amount;
  const hasKnown =
    known != null && Number.isFinite(Number(known)) && Number(known) > 0;
  return {
    visible: true,
    amount: hasKnown ? known : undefined,
    note: hasKnown ? "已知部分" : "待折算",
  };
}
