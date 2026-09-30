import test from "node:test";
import assert from "node:assert/strict";
import {
  dcaExcludedDates,
  dcaHistoryRefreshRequest,
  dcaInitialRange,
  dcaPlanContext,
  dcaPreviewMetric,
  dcaPreviewCoverage,
  dcaPreviewRequest,
  toggleDcaExcludedDate,
} from "../src/dca-preview.ts";
import { positiveDecimalInput } from "../src/positive-input.ts";

const base = {
  start: "2026-08-24",
  end: "2026-09-24",
  fee_mode: "unknown",
  excluded_dates_text: "",
  pause_ranges: [],
};
test("coverage separates known invested amounts from missing NAV and forecast pending without double counting", () => {
  const data = {
    items: [
      {
        selected: true,
        is_scheduled: true,
        amount: "80",
        estimated_quantity: "80",
        theoretical_quantity: "80",
        pending_forecast: false,
      },
      {
        selected: true,
        is_scheduled: true,
        amount: "20",
        estimated_quantity: null,
        theoretical_quantity: null,
        pending_forecast: true,
      },
      { selected: true, is_scheduled: null, amount: null },
      {
        selected: false,
        is_scheduled: true,
        amount: "10",
        estimated_quantity: "10",
      },
    ],
  };
  assert.deepEqual(dcaPreviewCoverage(data, false), {
    selected_count: 2,
    known_count: 1,
    known_amount: "80",
    unknown_count: 1,
    unknown_amount: "20",
    pending_amount: "20",
    pending_count: 1,
    unknown_calendar_count: 1,
  });
  const theoretical = dcaPreviewCoverage(
    {
      items: [
        {
          selected: true,
          is_scheduled: true,
          amount: "9007199254740993.12",
          theoretical_quantity: "1",
          estimated_quantity: null,
        },
      ],
    },
    true,
  );
  assert.equal(theoretical.known_amount, "9007199254740993.12");
  assert.equal(theoretical.known_count, 1);
});
test("product-only DCA entry never queries an undefined account and uses its unique associated account", () => {
  const context = dcaPlanContext({
    id: "fund-017641",
    kind: "fund",
    account_ids: ["fund-account"],
  });
  const query = new URLSearchParams({ kind: "dca", ...context.queryParams });
  assert.equal(query.toString(), "kind=dca&instrument_id=fund-017641");
  assert.equal(context.defaultAccountId, "fund-account");
  assert.equal(context.instrumentId, "fund-017641");
  assert.equal(query.has("account_id"), false);
  assert.equal(
    dcaPlanContext({
      id: "fund-017641",
      specification: { account_ids: ["fund-account"] },
    }).defaultAccountId,
    "fund-account",
  );
});
test("multiple product accounts require a choice while holding context keeps its actual account filter", () => {
  assert.equal(
    dcaPlanContext({ id: "fund", account_ids: ["first", "second"] })
      .defaultAccountId,
    undefined,
  );
  assert.equal(
    dcaPlanContext({
      id: "fund",
      account_ids: ["first"],
      specification: { account_ids: ["second"] },
    }).defaultAccountId,
    undefined,
  );
  const held = dcaPlanContext({
    id: "holding-row",
    instrument_id: "fund",
    account_id: "actual",
    account_ids: ["first", "second"],
  });
  assert.deepEqual(held.queryParams, {
    instrument_id: "fund",
    holding_account_id: "actual",
  });
  assert.equal(held.defaultAccountId, "actual");
  assert.deepEqual(
    dcaPlanContext({
      id: "fund",
      account_id: undefined,
      account_ids: [null, undefined, ""],
    }).queryParams,
    { instrument_id: "fund" },
  );
  assert.equal(dcaPlanContext().queryParams, undefined);
});
test("historical refresh requests only the selected plan product and validated start date", () => {
  assert.deepEqual(
    dcaHistoryRefreshRequest(
      { instrument_id: "fund-017641" },
      { ...base, instrument_id: "other-product" },
      "2026-09-27",
    ),
    { instrument_ids: ["fund-017641"], history: true, start: "2026-08-24" },
  );
  for (const start of [
    "",
    undefined,
    "2026-09-28",
    "2026-02-30",
    "2026-13-01",
    "2026-2-03",
  ]) {
    assert.throws(
      () =>
        dcaHistoryRefreshRequest(
          { instrument_id: "fund-017641" },
          { start },
          "2026-09-27",
        ),
      /历史开始日期/,
    );
  }
  assert.throws(
    () => dcaHistoryRefreshRequest({}, base, "2026-09-27"),
    /关联投资产品/,
  );
});
test("initial preview respects a plan that ended before today without extending into future dates", () => {
  assert.deepEqual(
    dcaInitialRange(
      { start_date: "2026-08-24", end_date: "2026-09-24" },
      "2026-09-27",
    ),
    { start: "2026-08-24", end: "2026-09-24" },
  );
  assert.deepEqual(
    dcaInitialRange(
      { start_date: "2026-08-24", end_date: "2026-10-24" },
      "2026-09-27",
    ),
    { start: "2026-08-24", end: "2026-09-27" },
  );
  assert.deepEqual(
    dcaInitialRange({ start_date: "2026-08-24" }, "2026-09-27"),
    { start: "2026-08-24", end: "2026-09-27" },
  );
});
test("DCA preview sends one complete date range, not invented ledger or holding fields", () => {
  const request = dcaPreviewRequest({
    ...base,
    quantity: "1",
    cost: "10",
    account_id: "tampered",
    confirmed: true,
  });
  assert.deepEqual(request, {
    start: "2026-08-24",
    end: "2026-09-24",
    as_of: "2026-09-24",
    excluded_dates: [],
    pause_ranges: [],
    fee_mode: "unknown",
  });
});
test("unknown and explicit zero fee modes omit preserved fixed fees; fixed zero remains explicit", () => {
  for (const fee_mode of ["unknown", "zero"]) {
    assert.equal(
      Object.hasOwn(
        dcaPreviewRequest({ ...base, fee_mode, fee_amount: "9" }),
        "fee_amount",
      ),
      false,
    );
  }
  assert.equal(
    dcaPreviewRequest({ ...base, fee_mode: "fixed", fee_amount: 0 }).fee_amount,
    "0",
  );
  assert.throws(
    () => dcaPreviewRequest({ ...base, fee_mode: "fixed", fee_amount: "-1" }),
    /固定费用/,
  );
});
test("daily exclusions and pauses serialize without manufacturing successful trades", () => {
  const request = dcaPreviewRequest({
    ...base,
    excluded_dates_text: "2026-09-23，2026-09-24\n2026-09-23",
    pause_ranges: [
      { start: "2026-09-01", end: "2026-09-03", amount: "999" },
      {},
    ],
  });
  assert.deepEqual(request.excluded_dates, ["2026-09-23", "2026-09-24"]);
  assert.deepEqual(request.pause_ranges, [
    { start: "2026-09-01", end: "2026-09-03" },
  ]);
  assert.throws(
    () =>
      dcaPreviewRequest({ ...base, pause_ranges: [{ start: "2026-09-01" }] }),
    /暂停区间/,
  );
  assert.throws(
    () => dcaPreviewRequest({ ...base, excluded_dates_text: "9月24日" }),
    /排除日期/,
  );
  assert.throws(
    () => dcaPreviewRequest({ ...base, start: "2026-09-25" }),
    /起止日期/,
  );
});
test("row exclusions toggle exact dates and retain other exclusions", () => {
  assert.equal(
    toggleDcaExcludedDate("2026-09-21,2026-09-24", "2026-09-24"),
    "2026-09-21",
  );
  assert.equal(
    toggleDcaExcludedDate("2026-09-21", "2026-09-24"),
    "2026-09-21, 2026-09-24",
  );
  assert.deepEqual(dcaExcludedDates("2026-09-21，2026-09-21\n2026-09-24"), [
    "2026-09-21",
    "2026-09-24",
  ]);
});
test("known partial estimates remain labelled partial while complete zero remains meaningful", () => {
  assert.deepEqual(
    dcaPreviewMetric(
      { estimated_profit: null, known_profit: "1.23" },
      "estimated_profit",
      "known_profit",
    ),
    { value: "1.23", partial: true },
  );
  assert.deepEqual(
    dcaPreviewMetric(
      { estimated_profit: "0", known_profit: "1.23" },
      "estimated_profit",
      "known_profit",
    ),
    { value: "0", partial: false },
  );
  assert.deepEqual(
    dcaPreviewMetric(
      { estimated_profit: null, known_profit: null },
      "estimated_profit",
      "known_profit",
    ),
    { value: null, partial: false },
  );
});
test("positive decimal validation never converts zero or missing quantity into a tiny holding", () => {
  for (const value of [
    0,
    "0",
    "0.00000000",
    "",
    undefined,
    null,
    "-1",
    "NaN",
    "Infinity",
    "1e-8",
  ]) {
    assert.equal(positiveDecimalInput(value), false, String(value));
  }
  assert.equal(positiveDecimalInput("0.00000001"), true);
  assert.equal(positiveDecimalInput("0.000000000000000001"), true);
  assert.equal(positiveDecimalInput("0.0000000000000000001"), false);
  const captured = Object.freeze({ quantity: "0" });
  assert.equal(positiveDecimalInput(captured.quantity), false);
  assert.equal(captured.quantity, "0");
});
