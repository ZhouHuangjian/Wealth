import test from "node:test";
import assert from "node:assert/strict";
import {
  credentialRequest,
  fundApplyRequest,
  fundMappingDefaults,
  fundPreviewRequest,
} from "../src/fund-reconciliation.ts";
import {
  marketTime,
  qualityPresentation,
  quoteDetails,
} from "../src/market-quality.ts";

const fields = [
  { key: "amount", label: "扣款金额", aliases: ["金额", "amount"] },
  { key: "fee", label: "费用", aliases: ["fee"] },
];
const exact = {
  id: "row1",
  row_number: 2,
  status: "exact_match",
  errors: [],
  candidates: [{ debit_event_id: "debit1", exact: true }],
};
const preview = {
  preview_version: 3,
  ledger_revision: 12,
  preview_hash: "snapshot-hash",
  rows: [exact],
};
test("saved mapping must still name a real header; ambiguous aliases are not guessed", () => {
  assert.deepEqual(
    fundMappingDefaults(["金额", "amount", "fee"], fields, {
      amount: "旧金额",
    }),
    { amount: undefined, fee: "fee" },
  );
  assert.equal(
    fundMappingDefaults(["金额", "amount"], fields, { amount: "amount" })
      .amount,
    "amount",
  );
});
test("preview whitelists fields and preserves unknown fee without creating zeros", () => {
  assert.deepEqual(
    fundPreviewRequest(
      {
        account_id: "a",
        mapping: { amount: "金额", fee: undefined, guessed: "secret" },
        save_mapping: true,
        quantity: "123",
      },
      fields,
      ["金额"],
    ),
    { account_id: "a", mapping: { amount: "金额" }, save_mapping: true },
  );
  assert.throws(
    () =>
      fundPreviewRequest(
        { account_id: "a", mapping: { amount: "missing" } },
        fields,
        ["金额"],
      ),
    /失效/,
  );
  assert.throws(
    () =>
      fundPreviewRequest(
        { account_id: "a", mapping: { amount: "金额", fee: "金额" } },
        fields,
        ["金额"],
      ),
    /同一文件列/,
  );
});
test("exact matches explicitly bind one source event and duplicate evidence never creates money", () => {
  const result = fundApplyRequest(
    {
      ...preview,
      rows: [
        exact,
        { id: "dup", status: "duplicate" },
        { id: "old", status: "applied" },
      ],
    },
    {},
  );
  assert.deepEqual(result, {
    preview_version: 3,
    ledger_revision: 12,
    preview_hash: "snapshot-hash",
    decisions: [
      { row_id: "row1", action: "link", debit_event_id: "debit1" },
      { row_id: "dup", action: "link" },
    ],
  });
});
test("ambiguous or different-day equal-amount records are not auto linked and unmatched cannot be created", () => {
  const review = {
    ...exact,
    id: "review",
    status: "review",
    normalized: { amount: "10", payment_date: "2026-09-21" },
    candidates: [
      { exact: true, debit_event_id: "other-date", payment_date: "2026-09-22" },
    ],
  };
  assert.throws(
    () => fundApplyRequest({ ...preview, rows: [review] }, {}),
    /没有可提交/,
  );
  assert.throws(
    () =>
      fundApplyRequest(
        { ...preview, rows: [{ ...review, status: "unmatched" }] },
        { review: { action: "link", debit_event_id: "other-date" } },
      ),
    /没有可核对/,
  );
});
test("safe correction requires server eligibility and explicit reason; wrong version cannot be supplied", () => {
  const row = {
    id: "review",
    row_number: 4,
    status: "review",
    candidates: [
      { exact: false, debit_event_id: "d", correction_allowed: true },
    ],
  };
  const choices = {
    review: {
      action: "correct",
      debit_event_id: "d",
      reason: " 机构确认单 ",
      amount: "99999",
      ledger_revision: 0,
    },
  };
  assert.deepEqual(
    fundApplyRequest({ ...preview, rows: [row] }, choices).decisions,
    [
      {
        row_id: "review",
        action: "correct",
        debit_event_id: "d",
        reason: "机构确认单",
      },
    ],
  );
  assert.throws(
    () =>
      fundApplyRequest(
        { ...preview, rows: [row] },
        { review: { ...choices.review, reason: " " } },
      ),
    /更正原因/,
  );
  assert.throws(
    () =>
      fundApplyRequest(
        {
          ...preview,
          rows: [
            {
              ...row,
              candidates: [
                {
                  ...row.candidates[0],
                  correction_allowed: false,
                  blocked_reason: "已有后续赎回",
                },
              ],
            },
          ],
        },
        choices,
      ),
    /已有后续赎回/,
  );
  assert.throws(
    () => fundApplyRequest({ ...preview, preview_hash: "" }, choices),
    /重新生成/,
  );
});
test("erroneous rows only allow skip, and differences cannot be labelled exact", () => {
  const row = { ...exact, errors: ["日期无效"] };
  assert.deepEqual(
    fundApplyRequest({ ...preview, rows: [row] }, { row1: { action: "skip" } })
      .decisions,
    [{ row_id: "row1", action: "skip" }],
  );
  assert.throws(
    () =>
      fundApplyRequest(
        {
          ...preview,
          rows: [
            {
              ...exact,
              status: "review",
              candidates: [{ debit_event_id: "d", exact: false }],
            },
          ],
        },
        { row1: { action: "link", debit_event_id: "d" } },
      ),
    /存在差异/,
  );
});
test("credential payload has only version and explicitly supplied token; removal carries no token", () => {
  const status = { version: 2, configured: true, token: "must-not-reuse" };
  assert.deepEqual(credentialRequest(status), { version: 2 });
  assert.deepEqual(credentialRequest(status, "new-valid-token"), {
    version: 2,
    token: "new-valid-token",
  });
  for (const token of ["", "short", "with space", "contains\nnewline"])
    assert.throws(() => credentialRequest(status, token));
  assert.throws(() => credentialRequest({ version: undefined }, "valid-token"));
});
test("conflicting quotes label retained safe price and keep isolation records separate", () => {
  const row = {
    price: "1.20",
    economic_date: "2026-09-22",
    retained_previous_quote: true,
    data_quality: {
      status: "conflict",
      compared_date: "2026-09-23",
      usable_for_accounting: false,
    },
    provider_observations: [{ price: "1.22" }],
    nav_quarantine: {
      "2026-09-23": { date: "2026-09-23", observations: [{ price: "1.23" }] },
    },
  };
  assert.match(qualityPresentation(row).message, /上次可用/);
  assert.equal(qualityPresentation(row).label, "净值有差异");
  assert.equal(quoteDetails(row).quarantined[0].quarantine_date, "2026-09-23");
  assert.equal(row.price, "1.20");
});
test("publication time never falls back to fetched time or NAV date", () => {
  assert.equal(marketTime(null), "来源未提供");
  assert.equal(marketTime("2026-09-23"), "2026-09-23");
  assert.equal(
    qualityPresentation({
      data_quality: { status: "single_source", usable_for_accounting: true },
    }).label,
    "单一来源",
  );
});

test("retained quote explains unavailable sources and date regression without claiming a conflict", () => {
  const retained = {
    retained_previous_quote: true,
    economic_date: "2026-10-05",
  };
  const unavailable = qualityPresentation({
    ...retained,
    data_quality: { status: "unavailable", usable_for_accounting: false },
  });
  assert.match(unavailable.message, /未获得可用净值/);
  assert.doesNotMatch(unavailable.message, /冲突/);
  const regression = qualityPresentation({
    ...retained,
    data_quality: {
      status: "single_source",
      compared_date: "2026-10-04",
      usable_for_accounting: true,
    },
  });
  assert.match(regression.message, /日期较早/);
  assert.doesNotMatch(regression.message, /冲突/);
});

test("partial institution facts require explicit server permission and user choice; never auto confirm missing shares", () => {
  const partial = {
    id: "partial",
    row_number: 2,
    status: "review",
    missing_fields: ["quantity", "nav", "fee"],
    normalized: { amount: "10", quantity: null, nav: null, fee: null },
    candidates: [
      {
        debit_event_id: "paid",
        exact: false,
        link_allowed: true,
        differences: [],
      },
    ],
  };
  assert.throws(
    () => fundApplyRequest({ ...preview, rows: [partial] }, {}),
    /没有可提交/,
  );
  const chosen = { partial: { action: "link", debit_event_id: "paid" } };
  assert.deepEqual(
    fundApplyRequest({ ...preview, rows: [partial] }, chosen).decisions,
    [{ row_id: "partial", action: "link", debit_event_id: "paid" }],
  );
  for (const link_allowed of [false, undefined, "true"])
    assert.throws(
      () =>
        fundApplyRequest(
          {
            ...preview,
            rows: [
              {
                ...partial,
                candidates: [{ ...partial.candidates[0], link_allowed }],
              },
            ],
          },
          chosen,
        ),
      /存在差异/,
    );
  assert.equal(partial.normalized.quantity, null);
});
