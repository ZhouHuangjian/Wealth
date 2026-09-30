import test from "node:test";
import assert from "node:assert/strict";
import {
  accountOpeningRequest,
  lifecycleRequest,
  lifecycleBlockerText,
} from "../src/account-maintenance.ts";

const opening = {
  available: true,
  editable: true,
  version: 3,
  data_revision: 17,
  opening_date: "2026-09-20",
  max_date: "2026-09-23",
  amount: "1000",
};
test("opening correction uses fetched versions and sends only the new date and reason, never a replacement balance", () => {
  assert.deepEqual(
    accountOpeningRequest(opening, {
      opening_date: "2026-08-01",
      reason: " 核对开户日期 ",
      opening_balance: "2000",
      amount: "2000",
      version: 1,
      expected_revision: 0,
    }),
    {
      version: 3,
      expected_revision: 17,
      opening_date: "2026-08-01",
      reason: "核对开户日期",
    },
  );
  assert.equal(opening.opening_date, "2026-09-20");
});
test("missing original opening metadata cannot silently fall back to today's date", () => {
  for (const metadata of [
    { ...opening, opening_date: null },
    { ...opening, data_revision: undefined },
    { ...opening, version: undefined },
  ])
    assert.throws(
      () =>
        accountOpeningRequest(metadata, {
          opening_date: "2026-09-21",
          reason: "修正",
        }),
      /不完整/,
    );
  assert.throws(
    () =>
      accountOpeningRequest(
        { ...opening, editable: false, reason: "后续资金记录不允许调整" },
        { opening_date: "2026-09-21", reason: "修正" },
      ),
    /后续资金记录/,
  );
});
test("opening correction rejects impossible dates, dependency limits and missing reasons", () => {
  for (const opening_date of ["2026-02-30", "2026-9-20", "", undefined])
    assert.throws(
      () => accountOpeningRequest(opening, { opening_date, reason: "修正" }),
      /有效的期初日期/,
    );
  assert.throws(
    () =>
      accountOpeningRequest(opening, {
        opening_date: "2026-09-24",
        reason: "修正",
      }),
    /可修改范围/,
  );
  assert.throws(
    () =>
      accountOpeningRequest(
        { ...opening, min_date: "2026-09-01" },
        { opening_date: "2026-08-31", reason: "修正" },
      ),
    /可修改范围/,
  );
  assert.throws(
    () =>
      accountOpeningRequest(opening, {
        opening_date: "2026-09-21",
        reason: "  ",
      }),
    /修改原因/,
  );
});
test("delete and restore use independent current previews and refuse blocked or incomplete lifecycle records", () => {
  const preview = {
    object: { version: 4 },
    data_revision: 20,
    can_delete: true,
    deleted: false,
  };
  assert.deepEqual(lifecycleRequest(preview), {
    version: 4,
    expected_revision: 20,
    confirm: true,
  });
  assert.throws(
    () => lifecycleRequest({ ...preview, can_delete: false }),
    /不能删除/,
  );
  assert.throws(
    () => lifecycleRequest({ ...preview, deleted: true }),
    /不能删除/,
  );
  assert.throws(
    () => lifecycleRequest({ ...preview, data_revision: undefined }),
    /不完整/,
  );
  assert.throws(() => lifecycleRequest(preview, true), /不能恢复/);
  assert.deepEqual(
    lifecycleRequest(
      { ...preview, deleted: true, can_delete: false, can_restore: true },
      true,
    ),
    { version: 4, expected_revision: 20, confirm: true },
  );
  assert.throws(
    () =>
      lifecycleRequest({ ...preview, deleted: true, can_restore: false }, true),
    /不能恢复/,
  );
});
test("deletion blockers hide UUIDs and internal kinds, deduplicate names, and cap them at three", () => {
  const text = lifecycleBlockerText({
    message: "计划期次仍引用此档案。",
    count: 27,
    items: [
      { id: "a", name: "51eb92cc-4d23-4d25-a220-885ec26a9956" },
      { name: "dca_history_import" },
      { name: "plan" },
      { name: "fund_confirm" },
      { name: "纳指定投" },
      { name: "纳指定投" },
      { name: "银行补款" },
      { name: "AAPL" },
      { name: "第四个名称" },
    ],
  });
  assert.equal(
    text,
    "计划期次仍引用此档案：纳指定投、银行补款、AAPL（共27条关联记录）。",
  );
  assert.equal(text.includes("。："), false);
});
test("identifier-only blockers stay short and readable, using the server count rather than truncated item counts", () => {
  assert.equal(
    lifecycleBlockerText({
      message: "仍有关联记录。：",
      count: 200,
      items: [{ id: "abc", name: "abc" }, { name: "option_position" }],
    }),
    "仍有关联记录（共200条关联记录）。",
  );
  assert.equal(
    lifecycleBlockerText({
      message: "有关联。",
      items: [{ name: "成长组合" }],
    }),
    "有关联：成长组合（共1条关联记录）。",
  );
});
