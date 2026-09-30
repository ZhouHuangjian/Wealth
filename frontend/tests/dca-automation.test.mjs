import test from "node:test";
import assert from "node:assert/strict";
import {
  dcaAutomationConfiguration,
  dcaAutomationInitial,
  dcaAutomationNotice,
  dcaAutomationRunRequest,
  dcaAutomationStatusLabel,
  dcaAutomationSummary,
  dcaPlanPayload,
  eligibleDcaHolding,
  validDcaDate,
} from "../src/dca-automation.ts";

const plan = {
  id: "plan-one",
  version: 4,
  name: "指数定投",
  kind: "dca",
  start_date: "2026-05-06",
  amount: "100.00",
  account_id: "bank-one",
  instrument_id: "fund-one",
  currency: "CNY",
  frequency: "daily",
  status: "active",
};
const form = {
  ...plan,
  automatic_enabled: true,
  automatic_start_date: "2026-09-28",
  target_account_id: "holding-one",
  automatic_fee_mode: "unknown",
};

test("explicit untracked DCA and rate retain exact decimal settings", () => {
  const actual = dcaAutomationConfiguration({
    ...form,
    automatic_funding_source: "untracked",
    automatic_fee_mode: "rate",
    automatic_fee_amount: "0.123456",
  });
  assert.equal(actual.funding_source, "untracked");
  assert.equal(actual.fee_mode, "rate");
  assert.equal(actual.fee_amount, "0.123456");
  assert.throws(() =>
    dcaAutomationConfiguration({
      ...form,
      automatic_fee_mode: "rate",
      automatic_fee_amount: "100.000001",
    }),
  );
});

test("reopening a saved plan preserves rate and funding without enabling a disabled plan", () => {
  const initial = dcaAutomationInitial(
    {
      ...plan,
      automation: {
        enabled: false,
        funding_source: "untracked",
        fee_mode: "rate",
        fee_amount: "0.12",
      },
    },
    "2026-09-30",
  );
  assert.equal(initial.automatic_enabled, false);
  assert.equal(initial.automatic_funding_source, "untracked");
  assert.equal(initial.automatic_fee_amount, "0.12");
});

test("new or disabled automation begins today, never silently from an old plan start", () => {
  assert.equal(
    dcaAutomationInitial(plan, "2026-09-28").automatic_start_date,
    "2026-09-28",
  );
  assert.equal(
    dcaAutomationInitial(plan, "2026-09-28").automatic_enabled,
    false,
  );
  const disabled = {
    ...plan,
    automation: { enabled: false, start_date: "2026-05-06" },
  };
  assert.equal(
    dcaAutomationInitial(disabled, "2026-09-28").automatic_start_date,
    "2026-09-28",
  );
  const future = { ...plan, start_date: "2026-10-08" };
  assert.equal(
    dcaAutomationInitial(future, "2026-09-28").automatic_start_date,
    "2026-10-08",
  );
  assert.throws(() => dcaAutomationInitial(plan, "2026-02-30"));
});

test("an enabled saved configuration retains its actual start, fees and exclusions", () => {
  const saved = {
    ...plan,
    automation: {
      enabled: true,
      start_date: "2026-06-01",
      holding_account_id: "other",
      fee_mode: "fixed",
      fee_amount: "0.03",
      excluded_dates: ["2026-06-02"],
      pause_ranges: [{ start: "2026-07-01", end: "2026-07-02" }],
    },
  };
  const initial = dcaAutomationInitial(saved, "2026-09-28");
  assert.equal(initial.automatic_start_date, "2026-06-01");
  assert.equal(initial.target_account_id, "other");
  assert.deepEqual(
    dcaAutomationConfiguration({ ...saved, ...initial }),
    saved.automation,
  );
  initial.automatic_pause_ranges[0].end = "2026-08-01";
  assert.equal(saved.automation.pause_ranges[0].end, "2026-07-02");
});

test("unknown costs remain unknown and stale fixed fees do not become fees under zero or unknown", () => {
  for (const mode of ["unknown", "zero"]) {
    const actual = dcaAutomationConfiguration({
      ...form,
      automatic_fee_mode: mode,
      automatic_fee_amount: "99",
    });
    assert.equal(actual.fee_mode, mode);
    assert.equal("fee_amount" in actual, false);
  }
  assert.equal(dcaAutomationConfiguration(form).fee_mode, "unknown");
  assert.throws(
    () =>
      dcaAutomationConfiguration({ ...form, automatic_fee_mode: "invalid" }),
    /费用规则/,
  );
});

test("fixed fee uses exact decimals and must be less than installment, with at most 2 decimal places", () => {
  const huge = {
    ...form,
    amount: "9007199254740993.12",
    automatic_fee_mode: "fixed",
    automatic_fee_amount: "9007199254740993.11",
  };
  assert.equal(
    dcaAutomationConfiguration(huge).fee_amount,
    "9007199254740993.11",
  );
  for (const fee of ["100", "100.01", "-1", "1e2", "0.001", ""]) {
    assert.throws(() =>
      dcaAutomationConfiguration({
        ...form,
        automatic_fee_mode: "fixed",
        automatic_fee_amount: fee,
      }),
    );
  }
  assert.equal(
    dcaAutomationConfiguration({
      ...form,
      automatic_fee_mode: "fixed",
      automatic_fee_amount: "0.00",
    }).fee_amount,
    "0.00",
  );
  assert.throws(
    () => dcaAutomationConfiguration({ ...form, amount: "0" }),
    /大于零/,
  );
});

test("excluded failed dates normalize unique days and pause intervals remain exact", () => {
  const actual = dcaAutomationConfiguration({
    ...form,
    automatic_excluded_dates: "2026-09-29，2026-09-28\n2026-09-29;2026-10-02",
    automatic_pause_ranges: [
      { start: "2026-10-08", end: "2026-10-08", internal: "ignored" },
    ],
  });
  assert.deepEqual(actual.excluded_dates, [
    "2026-09-28",
    "2026-09-29",
    "2026-10-02",
  ]);
  assert.deepEqual(actual.pause_ranges, [
    { start: "2026-10-08", end: "2026-10-08" },
  ]);
  for (const bad of [
    "2026-02-30",
    "2026-9-28",
    "2026-09-28T12:00:00Z",
    "something",
  ]) {
    assert.equal(validDcaDate(bad), false);
    assert.throws(() =>
      dcaAutomationConfiguration({ ...form, automatic_excluded_dates: bad }),
    );
  }
  assert.equal(validDcaDate("2028-02-29"), true);
  assert.throws(() =>
    dcaAutomationConfiguration({
      ...form,
      automatic_pause_ranges: [{ start: "2026-10-09", end: "2026-10-08" }],
    }),
  );
  assert.throws(() =>
    dcaAutomationConfiguration({ ...form, automatic_pause_ranges: [{}] }),
  );
  assert.throws(() =>
    dcaAutomationConfiguration({
      ...form,
      automatic_excluded_dates: Array(1098).fill("2026-09-28").join("\n"),
    }),
  );
  assert.throws(() =>
    dcaAutomationConfiguration({
      ...form,
      automatic_pause_ranges: Array(101).fill({
        start: "2026-09-28",
        end: "2026-09-28",
      }),
    }),
  );
});

test("enabling requires explicit valid start and holding account, without defaulting to historical cash", () => {
  for (const change of [
    { automatic_start_date: "" },
    { automatic_start_date: "2026-01-01" },
    { target_account_id: "" },
  ])
    assert.throws(() => dcaAutomationConfiguration({ ...form, ...change }));
  assert.equal(
    dcaAutomationConfiguration({
      ...form,
      automatic_start_date: plan.start_date,
    }).start_date,
    plan.start_date,
  );
});

test("turning off never validates hidden drafts, preserves saved exclusions and does not copy backend identity fields", () => {
  const previous = {
    enabled: true,
    start_date: "2026-08-01",
    fee_mode: "fixed",
    fee_amount: "0.01",
    excluded_dates: ["2026-08-06"],
    automatic_internal: "secret",
  };
  const disabled = dcaAutomationConfiguration(
    {
      ...form,
      automatic_enabled: false,
      automatic_start_date: "not-a-date",
      automatic_fee_amount: "bad",
    },
    previous,
  );
  assert.deepEqual(disabled, {
    enabled: false,
    start_date: "2026-08-01",
    fee_mode: "fixed",
    fee_amount: "0.01",
    excluded_dates: ["2026-08-06"],
  });
  assert.deepEqual(dcaAutomationConfiguration({ automatic_enabled: "true" }), {
    enabled: false,
  });
});

test("one versioned plan payload includes automation but never copied identity or draft UI fields", () => {
  const actual = dcaPlanPayload(
    {
      ...form,
      tenant_id: "another-space",
      version: 88,
      created_by_id: "other",
    },
    plan,
  );
  assert.equal(actual.version, 4);
  assert.equal(actual.account_id, "bank-one");
  assert.equal(actual.automation.holding_account_id, "holding-one");
  for (const key of [
    "id",
    "tenant_id",
    "created_by_id",
    "target_account_id",
    "automatic_enabled",
  ])
    assert.equal(key in actual, false);
  assert.equal("version" in dcaPlanPayload(form), false);
  assert.deepEqual(dcaAutomationRunRequest(plan), { expected_plan_version: 4 });
  for (const version of [
    undefined,
    0,
    -1,
    1.5,
    "4",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => dcaAutomationRunRequest({ ...plan, version }));
});

test("only detailed same-currency active fund or broker accounts carry automatic holdings", () => {
  const account = {
    id: "holding",
    kind: "fund",
    currency: "CNY",
    valuation_mode: "detailed",
  };
  assert.equal(eligibleDcaHolding(account, "CNY"), true);
  for (const kind of ["bank", "cash", "wallet", "futures", "loan"])
    assert.equal(eligibleDcaHolding({ ...account, kind }, "CNY"), false);
  for (const change of [
    { archived: true },
    { deleted_at: "2026-09-28" },
    { currency: "USD" },
    { valuation_mode: "snapshot" },
  ])
    assert.equal(eligibleDcaHolding({ ...account, ...change }, "CNY"), false);
});

test("human statuses distinguish automatic estimates, existing facts and missing inputs", () => {
  assert.match(dcaAutomationStatusLabel("recorded_estimate"), /自动推算/);
  assert.equal(dcaAutomationStatusLabel("already_recorded"), "已有记录");
  assert.equal(dcaAutomationStatusLabel("waiting_cash"), "资金不足");
  assert.equal(dcaAutomationStatusLabel("waiting_nav"), "等待正式净值");
  assert.equal(dcaAutomationStatusLabel("waiting_fee"), "等待费用设置");
  assert.equal(dcaAutomationStatusLabel("external_future_state"), "状态待核实");
  assert.equal(
    dcaAutomationSummary({
      enabled: true,
      summary: { recorded_estimate: 100, waiting_nav: 2, needs_review: 1 },
    }),
    "需要核对 1 期 · 等待正式净值 2 期",
  );
  assert.equal(
    dcaAutomationSummary({
      enabled: true,
      summary: { recorded_estimate: "20", waiting_cash: -1 },
    }),
    "暂无到期待办",
  );
  assert.equal(
    dcaAutomationSummary({ enabled: false, summary: {} }),
    "自动补录已关闭",
  );
  assert.equal(dcaAutomationSummary(null), "状态待读取");
  assert.equal(
    dcaAutomationSummary({
      enabled: true,
      has_more: true,
      summary: { recorded_estimate: 500 },
    }),
    "近 500 期：已自动推算入账 500 期",
  );
  assert.match(dcaAutomationNotice, /不向银行或基金平台发起扣款/);
  assert.match(dcaAutomationNotice, /自动推算标记/);
});
