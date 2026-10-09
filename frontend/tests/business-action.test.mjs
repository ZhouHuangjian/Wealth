import test from "node:test";
import assert from "node:assert/strict";
import {
  dcaNextAction,
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

test("cash shortage points to the actual debit account rather than a fund bill", () => {
  const action = dcaNextAction(
    "space-one",
    { automation: { status: "waiting_cash" } },
    plan,
  );
  assert.equal(action.kind, "cash");
  assert.equal(url(action).searchParams.get("account_id"), "bank-one");
  assert.equal(url(action).searchParams.get("section"), "reconcile");
  assert.match(action.description, /不自动向其他账户补款/);
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
