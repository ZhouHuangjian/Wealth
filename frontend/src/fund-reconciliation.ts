type RecordValue = Record<string, any>;

export function fundCandidateLinkable(candidate?: RecordValue | null) {
  return (
    candidate?.link_allowed === true ||
    (candidate?.link_allowed === undefined && candidate?.exact === true)
  );
}

export function fundMappingDefaults(
  headers: string[],
  fields: RecordValue[],
  saved: Record<string, string> = {},
) {
  return Object.fromEntries(
    fields.map((field) => {
      const aliases = [field.key, field.label, ...(field.aliases || [])];
      const candidates = headers.filter((header) =>
        aliases.some(
          (alias) =>
            String(alias).trim().toLowerCase() === header.trim().toLowerCase(),
        ),
      );
      return [
        field.key,
        headers.includes(saved[field.key])
          ? saved[field.key]
          : candidates.length === 1
            ? candidates[0]
            : undefined,
      ];
    }),
  );
}

export function fundPreviewRequest(
  values: RecordValue,
  fields: RecordValue[],
  headers: string[],
) {
  if (!values.account_id) throw new Error("请选择基金持仓账户");
  const mapping: Record<string, string> = {};
  for (const field of fields) {
    const column = values.mapping?.[field.key];
    if (!column) continue;
    if (!headers.includes(column))
      throw new Error("字段映射已失效，请重新选择原文件列名");
    if (Object.values(mapping).includes(column))
      throw new Error("同一文件列不能同时对应多个字段");
    mapping[field.key] = column;
  }
  return {
    account_id: values.account_id,
    ...(values.instrument_id ? { instrument_id: values.instrument_id } : {}),
    ...(values.funding_account_id
      ? { funding_account_id: values.funding_account_id }
      : {}),
    mapping,
    save_mapping: values.save_mapping === true,
  };
}

export function fundApplyRequest(
  preview: RecordValue,
  choices: Record<string, RecordValue>,
) {
  if (
    !Number.isInteger(preview.preview_version) ||
    !Number.isInteger(preview.ledger_revision) ||
    !preview.preview_hash
  )
    throw new Error("请重新生成核对结果后再提交");
  const decisions: RecordValue[] = [];
  for (const row of preview.rows || []) {
    if (row.status === "applied") continue;
    const choice = choices[row.id];
    if (choice?.action === "skip") {
      decisions.push({ row_id: row.id, action: "skip" });
      continue;
    }
    if (row.errors?.length) {
      if (choice?.action)
        throw new Error(`第 ${row.row_number} 行仍有错误，请先处理`);
      continue;
    }
    if (row.status === "duplicate" && !choice?.action) {
      decisions.push({ row_id: row.id, action: "link" });
      continue;
    }
    const exact = (row.candidates || []).filter(
      (candidate: RecordValue) =>
        candidate.exact === true && fundCandidateLinkable(candidate),
    );
    if (row.status === "exact_match" && exact.length === 1 && !choice?.action) {
      decisions.push({
        row_id: row.id,
        action: "link",
        debit_event_id: exact[0].debit_event_id,
      });
      continue;
    }
    if (!choice?.action) continue;
    const candidate = (row.candidates || []).find(
      (candidate: RecordValue) =>
        candidate.debit_event_id === choice.debit_event_id,
    );
    if (!candidate || row.status === "unmatched")
      throw new Error(`第 ${row.row_number} 行没有可核对的原记录`);
    if (choice.action === "link" && !fundCandidateLinkable(candidate))
      throw new Error(`第 ${row.row_number} 行存在差异，不能直接标记一致`);
    if (choice.action === "correct") {
      if (candidate.correction_allowed !== true)
        throw new Error(candidate.blocked_reason || "此记录不能安全更正");
      if (!choice.reason?.trim())
        throw new Error(`请填写第 ${row.row_number} 行的更正原因`);
    } else if (choice.action !== "link") throw new Error("不支持的核对操作");
    decisions.push({
      row_id: row.id,
      action: choice.action,
      debit_event_id: candidate.debit_event_id,
      ...(choice.action === "correct" ? { reason: choice.reason.trim() } : {}),
    });
  }
  if (!decisions.length)
    throw new Error("没有可提交的匹配结果，请先处理差异或记录原交易");
  return {
    preview_version: preview.preview_version,
    ledger_revision: preview.ledger_revision,
    preview_hash: preview.preview_hash,
    decisions,
  };
}

export function credentialRequest(credential: RecordValue, token?: string) {
  if (!Number.isInteger(credential?.version) || credential.version < 0)
    throw new Error("请重新读取密钥状态");
  if (token === undefined) return { version: credential.version };
  if (
    token.length < 8 ||
    token.length > 4096 ||
    /\s|[\u0000-\u001f]/.test(token)
  )
    throw new Error("请填写 8–4096 个非空白字符的有效访问密钥");
  return { version: credential.version, token };
}
