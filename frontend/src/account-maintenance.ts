/** Financial dates must come from the opening record, never from a UI fallback. */
export function accountOpeningRequest(
  metadata: Record<string, any>,
  values: Record<string, any>,
) {
  if (metadata.editable !== true || metadata.available !== true)
    throw new Error(metadata.reason || "该账户目前不能修改期初日期");
  if (
    metadata.version == null ||
    metadata.data_revision == null ||
    !metadata.opening_date
  )
    throw new Error("期初记录不完整，请重新读取");
  const value = values.opening_date;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("请填写有效的期初日期");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error("请填写有效的期初日期");
  if (
    (metadata.min_date && value < metadata.min_date) ||
    (metadata.max_date && value > metadata.max_date)
  )
    throw new Error("新日期超出可修改范围，请核对已存在的资金或持仓记录");
  const reason = String(values.reason || "").trim();
  if (!reason) throw new Error("请简要说明修改原因");
  if (reason.length > 500) throw new Error("修改原因请控制在 500 字以内");
  return {
    version: metadata.version,
    expected_revision: metadata.data_revision,
    opening_date: value,
    reason,
  };
}

export function lifecycleRequest(
  preview: Record<string, any>,
  restore = false,
) {
  if (preview.object?.version == null || preview.data_revision == null)
    throw new Error("记录版本不完整，请重新读取");
  if (
    restore
      ? preview.deleted !== true || preview.can_restore !== true
      : preview.can_delete !== true || preview.deleted === true
  )
    throw new Error(
      restore
        ? "当前记录不能恢复，请重新读取或核对关联内容"
        : "当前记录不能删除，请先处理关联内容",
    );
  return {
    version: preview.object.version,
    expected_revision: preview.data_revision,
    confirm: true,
  };
}

/** Keep deletion explanations readable; identifiers and internal kinds are not display names. */
export function lifecycleBlockerText(blocker: Record<string, any>) {
  const items = Array.isArray(blocker.items) ? blocker.items : [];
  const internalNames = new Set([
    "account",
    "accounts",
    "instrument",
    "instruments",
    "resource",
    "resources",
    "plan",
    "plans",
    "dca",
    "occurrence",
    "occurrences",
    "event",
    "events",
    "opening",
    "income",
    "expense",
    "transfer",
    "refund",
    "buy",
    "sell",
    "settlement",
    "dividend",
    "reinvest",
    "split",
    "snapshot",
    "snapshots",
    "reservation",
    "reservations",
    "reconciliation",
    "reconciliations",
    "alert",
    "alerts",
    "rule",
    "rules",
    "loan",
    "repayment",
    "budget",
    "goal",
  ]);
  const names = [
    ...new Set<string>(
      items
        .map((item: any) =>
          typeof item.name === "string" ? item.name.trim() : "",
        )
        .filter(
          (name: string, index: number) =>
            name &&
            name !== String(items[index].id || "") &&
            !/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i.test(
              name,
            ) &&
            !/^[a-f\d]{32}$/i.test(name) &&
            !/^[a-z][a-z\d]*(?:[_:.][a-z\d]+)+$/.test(name) &&
            !internalNames.has(name.toLowerCase()),
        ),
    ),
  ]
    .slice(0, 3)
    .map((name) =>
      Array.from(name).length > 40
        ? Array.from(name).slice(0, 40).join("") + "…"
        : name,
    );
  const message = String(blocker.message || "有关联记录")
    .trim()
    .replace(/[。；;：:.!！?？\s]+$/, "");
  const count =
    Number.isSafeInteger(blocker.count) && blocker.count >= 0
      ? blocker.count
      : items.length;
  return `${message}${names.length ? `：${names.join("、")}` : ""}（共${count}条关联记录）。`;
}
