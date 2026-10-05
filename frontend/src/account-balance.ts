type AccountBalance = {
  [key: string]: unknown;
  balance?: string | number | null;
  balance_basis?: string;
  balance_label?: string;
  balance_as_of?: string | null;
  balance_status?: string;
  balance_message?: string;
};

export function accountBalanceCaption(account: AccountBalance) {
  const label = account.balance_label || "账面金额";
  const date = account.balance_as_of
    ? `${account.balance_basis === "ledger" ? "截至" : "基准"} ${account.balance_as_of}`
    : "";
  const state =
    account.balance_status === "partial"
      ? "待核对"
      : account.balance_status === "missing"
        ? "待补全"
        : "";
  return [label, date, state].filter(Boolean).join(" · ");
}
