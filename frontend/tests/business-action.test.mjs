import test from "node:test";
import assert from "node:assert/strict";
import {
  dcaNextAction,
  dcaCashReconciliationAction,
  dailyReturnNextAction,
  holdingForAction,
  holdingNextAction,
} from "../src/business-action.ts";

const plan = {
  id: "plan-one",
  account_id: "bank-one",
  instrument_id: "fund-one",
  automation: { holding_account_id: "holding-one" },
};
const url = (action) => new URL(action.to, "https://synthetic.invalid");

test("return gaps locate that product's market evidence rather than another holding", () => {
  const action = dailyReturnNextAction("space/one", {
    instrument_id: "fund?one",
    missing_reason_code: "no_estimate",
    to: "https://untrusted.invalid",
    amount: "123.45",
  });
  assert.equal(url(action).pathname, "/spaces/space%2Fone/analytics");
  assert.equal(url(action).searchParams.get("tab"), "settlement");
  assert.equal(url(action).searchParams.get("section"), "quotes");
  assert.equal(url(action).searchParams.get("instrument_id"), "fund?one");
  assert.ok(!action.to.includes("123.45"));
  assert.ok(!action.to.includes("untrusted"));
  assert.equal(dailyReturnNextAction("space", {}), null);
});

test("FX and product calendar gaps open their own correction destinations", () => {
  const fx = dailyReturnNextAction("space", {
    missing_reason_code: "fx_missing",
    instrument_id: "fund",
  });
  assert.equal(url(fx).pathname, "/spaces/space/manage");
  assert.equal(url(fx).searchParams.get("tab"), "fx");
  const calendar = dailyReturnNextAction("space", {
    missing_reason_code: "calendar_unverified",
    instrument_id: "fund",
  });
  assert.equal(url(calendar).searchParams.get("action"), "edit-product");
  assert.equal(url(calendar).searchParams.get("instrument_id"), "fund");
  const account = dailyReturnNextAction("space", { account_id: "institution" });
  assert.equal(url(account).searchParams.get("section"), "reconcile");
  assert.equal(url(account).searchParams.get("account_id"), "institution");
  const trade = dailyReturnNextAction("space", {
    account_id: "actual-account",
    instrument_id: "fund",
    missing_reason_code: "trade_date_unverified",
  });
  assert.equal(url(trade).searchParams.get("tab"), "investments");
  assert.equal(url(trade).searchParams.get("account_id"), "actual-account");
  const snapshot = dailyReturnNextAction("space", {
    account_id: "actual-account",
    instrument_id: "future",
    missing_reason_code: "account_snapshot_needed",
  });
  assert.equal(url(snapshot).searchParams.get("section"), "reconcile");
});

test("late NAV and confirmation keep automatic waiting without a manual task", () => {
  for (const status of [
    "waiting_nav",
    "waiting_confirmation",
    "scheduled",
    "recorded_estimate",
    "disabled",
    "paused",
    "excluded",
  ])
    assert.equal(dcaNextAction("space-one", { status }, plan), null);
});

test("cash shortage opens the exact plan funding setting while retaining debit reconciliation", () => {
  const action = dcaNextAction(
    "space-one",
    { automation: { status: "waiting_cash" } },
    plan,
  );
  assert.equal(action.kind, "plan");
  assert.equal(url(action).searchParams.get("plan_id"), "plan-one");
  assert.equal(url(action).searchParams.get("action"), "edit-plan");
  assert.equal(url(action).searchParams.get("focus"), "funding");
  assert.match(action.description, /明确选择来源账户及生效日期/);
  assert.ok(!url(action).searchParams.has("top_up_account_id"));
  assert.ok(!url(action).searchParams.has("top_up_start_date"));
  const reconcile = dcaCashReconciliationAction("space-one", {}, plan);
  assert.equal(reconcile.kind, "cash");
  assert.equal(url(reconcile).searchParams.get("account_id"), "bank-one");
  assert.equal(url(reconcile).searchParams.get("section"), "reconcile");
  assert.match(reconcile.description, /仅补录真实遗漏/);
});

test("homepage shortage projection navigates without selecting or enabling funding", () => {
  const row = {
    id: "period-old",
    plan_id: "plan?correct",
    account_id: "debit-correct",
    instrument_id: "fund-correct",
    due_date: "2026-10-08",
    automation: { status: "waiting_cash" },
  };
  const before = structuredClone(row);
  const action = dcaNextAction("space/one", row);
  assert.equal(url(action).pathname, "/spaces/space%2Fone/assets");
  assert.equal(url(action).searchParams.get("plan_id"), "plan?correct");
  assert.equal(url(action).searchParams.get("instrument_id"), "fund-correct");
  assert.deepEqual(row, before);
  assert.ok(!action.to.includes("2026-10-08"));
  const fallback = dcaNextAction("space-one", {
    status: "waiting_cash",
    account_id: "debit-correct",
  });
  assert.equal(url(fallback).searchParams.get("account_id"), "debit-correct");
  assert.equal(dcaNextAction("space-one", { status: "waiting_cash" }), null);
  assert.equal(dcaCashReconciliationAction("space-one", {}), null);
});

test("an invalid backup account opens its plan settings instead of nonexistent transactions", () => {
  for (const row of [
    { status: "needs_review", reason_code: "dca_top_up_account_invalid" },
    {
      automation: { status: "needs_review", message: "请核对" },
      details: { automation: { reason_code: "dca_top_up_account_invalid" } },
    },
  ]) {
    const action = dcaNextAction("space-one", row, plan);
    assert.equal(action.kind, "plan");
    assert.equal(url(action).searchParams.get("plan_id"), plan.id);
    assert.equal(url(action).searchParams.get("action"), "edit-plan");
    assert.equal(url(action).searchParams.get("focus"), "funding");
    assert.ok(!url(action).searchParams.has("event_id"));
    assert.match(action.description, /尚未转入或扣款/);
  }
  assert.equal(
    dcaNextAction("space", {
      status: "needs_review",
      reason_code: "dca_top_up_account_invalid",
    }),
    null,
  );
  const unrelated = dcaNextAction(
    "space",
    {
      status: "needs_review",
      reason_code: "invalid",
      debit_event_id: "existing",
    },
    plan,
  );
  assert.equal(unrelated.kind, "transaction");
  assert.equal(url(unrelated).searchParams.get("event_id"), "existing");
});

test("fee and missing automation configuration open the precise plan", () => {
  for (const status of ["waiting_fee", "configuration_required"]) {
    const action = dcaNextAction("space-one", { status }, plan);
    assert.equal(action.kind, "plan");
    assert.equal(url(action).searchParams.get("plan_id"), "plan-one");
    assert.equal(url(action).searchParams.get("action"), "edit-plan");
  }
});

test("a retained NAV conflict routes to that product's quality evidence", () => {
  const row = {
    automation: { status: "needs_review", message: "存在记录差异，请核对" },
    details: { automation: { message: "正式净值来源存在差异，等待核对" } },
  };
  const action = dcaNextAction("space-one", row, plan);
  assert.equal(action.kind, "market");
  assert.equal(url(action).searchParams.get("instrument_id"), "fund-one");
  assert.equal(url(action).searchParams.get("section"), "quotes");
});

test("a paid period on an unverified open day points to product rules", () => {
  const action = dcaNextAction(
    "space-one",
    {
      status: "needs_review",
      message: "已有扣款但该申购日并非已核实开放日，请核对",
    },
    plan,
  );
  assert.equal(action.kind, "product");
  assert.equal(url(action).searchParams.get("action"), "edit-product");
});

test("same-day debit ambiguity opens matching, never adds another debit", () => {
  const action = dcaNextAction(
    "space-one",
    {
      id: "occurrence-one",
      status: "needs_review",
      message: "同日已有相同基金金额的扣款，请先关联待办，避免重复",
    },
    plan,
  );
  assert.equal(action.kind, "match");
  assert.equal(url(action).searchParams.get("occurrence_id"), "occurrence-one");
  assert.match(action.description, /机构订单/);
});

test("share differences preserve the holding account in actual bill checking", () => {
  const action = dcaNextAction(
    "space-one",
    { status: "needs_review", message: "份额舍入差异超出可自动处理范围" },
    plan,
  );
  assert.equal(action.kind, "statement");
  assert.equal(url(action).searchParams.get("account_id"), "holding-one");
  assert.equal(url(action).searchParams.get("action"), "fund-check");
});

test("reversed or changed old facts point to the original event", () => {
  const action = dcaNextAction(
    "space-one",
    {
      status: "needs_review",
      message: "该期记录已冲正，不会自动重新扣款或确认",
      debit_event_id: "debit-one",
    },
    plan,
  );
  assert.equal(action.kind, "transaction");
  assert.equal(url(action).searchParams.get("event_id"), "debit-one");
  assert.match(action.description, /不再次生成扣款/);
});

test("holding checking retains both identities and does not select another holding", () => {
  const rows = [
    { id: "first", account_id: "a", instrument_id: "i" },
    { id: "second", account_id: "b", instrument_id: "i" },
  ];
  assert.equal(holdingForAction(rows, "b", "i"), rows[1]);
  assert.equal(holdingForAction(rows, "elsewhere", "i"), undefined);
  assert.equal(holdingForAction(rows, "a", null), undefined);
  const action = holdingNextAction("space-one", {
    ...rows[1],
    reconciliation_eligibility: { eligible: true },
  });
  assert.equal(url(action).searchParams.get("account_id"), "b");
  assert.equal(url(action).searchParams.get("instrument_id"), "i");
  assert.equal(url(action).searchParams.get("action"), "check-holding");
});

test("a daily-return reconciliation payload locates the original holding without holdings-only eligibility", () => {
  // The home/calendar return API supplies reconciliation evidence, while the
  // destination holdings API supplies current reconciliation_eligibility.
  const row = {
    account_id: "holding-account",
    instrument_id: "fund-one",
    kind: "fund",
    date: "2026-10-12",
    amount: null,
    status: "unavailable",
    missing_reason_code: "holding_reconciliation",
    message: "原持仓金额、成本或收益范围待核对，暂不确认该日收益",
    reconciliation: { status: "unresolved", opening_event_id: "opening-one" },
  };
  const original = structuredClone(row);
  const action = dailyReturnNextAction("space-one", row);
  assert.equal(action.kind, "holding");
  assert.equal(url(action).pathname, "/spaces/space-one/assets");
  assert.equal(url(action).searchParams.get("tab"), "holdings");
  assert.equal(url(action).searchParams.get("action"), "check-holding");
  assert.equal(url(action).searchParams.get("account_id"), "holding-account");
  assert.equal(url(action).searchParams.get("instrument_id"), "fund-one");
  assert.equal(url(action).searchParams.has("opening_event_id"), false);
  assert.deepEqual(row, original);
});

test("holding without an eligible opening asks for actual transaction evidence", () => {
  const action = holdingNextAction("space-one", {
    account_id: "account-one",
    instrument_id: "fund-one",
    kind: "fund",
    reconciliation_eligibility: { eligible: false, reason: "需先核对定投记录" },
  });
  assert.equal(action.kind, "statement");
  assert.equal(url(action).searchParams.get("tab"), "imports");
  assert.match(action.description, /需先核对定投记录/);
});

test("links encode identities and contain no amounts or statement contents", () => {
  const action = dcaNextAction(
    "space/one",
    { status: "waiting_fee", amount: "123.45", message: "private fact" },
    { ...plan, id: "plan?one" },
  );
  assert.equal(url(action).pathname, "/spaces/space%2Fone/assets");
  assert.equal(url(action).searchParams.get("plan_id"), "plan?one");
  assert.ok(!action.to.includes("123.45"));
  assert.ok(!action.to.includes("private fact"));
});
