import test from "node:test";
import assert from "node:assert/strict";
import {
  holdingCorrectionPayload,
  holdingReconciliation,
  holdingReconciliationPayload,
  ordinaryHoldingPayload,
} from "../src/holding-reconciliation.ts";

const captured = {
  valuation_mode: "value",
  quantity: "337.67",
  cost: "345",
  current_value: "361.41",
  institution_profit: "-3.60",
  reference_nav: "1.0703",
};

test("reported profit conflict is explicit and never changes captured market value, cost or shares", () => {
  const input = Object.freeze({ ...captured });
  const result = holdingReconciliation(input);
  assert.equal(result.value, "361.41");
  assert.equal(result.cost, "345");
  assert.equal(result.profit, "16.41");
  assert.equal(result.nav_value, "361.408201");
  assert.deepEqual(
    result.conflicts.map((c) => [c.field, c.difference]),
    [["institution_profit", "20.01"]],
  );
  assert.throws(() => holdingReconciliationPayload(input), /20.01/);
  assert.equal(input.quantity, "337.67");
  assert.equal(input.cost, "345");
});

test("profit entry mode still detects a different NAV and quantity scope", () => {
  const input = {
    ...captured,
    valuation_mode: "profit",
    current_profit: "-3.60",
  };
  const result = holdingReconciliation(input);
  assert.equal(result.value, "341.4");
  assert.deepEqual(
    result.conflicts.map((c) => [c.field, c.difference]),
    [["reference_nav", "20.008201"]],
  );
  assert.throws(
    () =>
      holdingReconciliationPayload({ ...input, institution_profit: "16.41" }),
    /计算盈亏与机构显示收益/,
  );
});

test("two-cent tolerance is inclusive and uses precise decimals without rounding away a conflict", () => {
  const base = {
    valuation_mode: "value",
    cost: "10",
    quantity: "1",
    current_value: "10",
    institution_profit: "0.02",
    reference_nav: "10.02",
  };
  assert.equal(holdingReconciliation(base).conflicts.length, 0);
  assert.equal(
    holdingReconciliation({
      ...base,
      institution_profit: "0.020000000001",
      reference_nav: "10.020000000001",
    }).conflicts.length,
    2,
  );
});

test("optional zero reported profit remains an intentional observation, blank checks are omitted", () => {
  assert.deepEqual(
    holdingReconciliationPayload({
      valuation_mode: "value",
      cost: "10",
      current_value: "10",
      institution_profit: 0,
    }),
    { institution_profit: "0" },
  );
  assert.deepEqual(
    holdingReconciliationPayload({
      valuation_mode: "value",
      cost: "10",
      current_value: "10",
      institution_profit: "",
      reference_nav: null,
    }),
    {},
  );
  assert.throws(
    () =>
      holdingReconciliationPayload({
        valuation_mode: "value",
        reference_nav: "-1",
      }),
    /对应单位净值/,
  );
});

test("auto mode never posts hidden manual observations or stale valuation fields", () => {
  const result = ordinaryHoldingPayload({
    ...captured,
    valuation_mode: "auto",
    current_profit: "888",
    valuation_basis: "formal",
    valuation_date: "2026-09-23",
    funding_mode: "external",
    funding_account_id: "bank",
  });
  for (const name of [
    "institution_profit",
    "reference_nav",
    "current_profit",
    "current_value",
    "valuation_basis",
    "valuation_date",
    "funding_account_id",
  ])
    assert.equal(Object.hasOwn(result, name), false, name);
});

test("correction changes only the allowed original fields and does not reallocate cash", () => {
  const original = Object.freeze({
    account_id: "fund",
    instrument_id: "id",
    as_of: "2026-09-24",
    quantity: "10",
    cost: "100",
    current_value: "90",
    purchase_date: "2026-09-01",
    funding_mode: "allocate",
    funding_account_id: "bank",
    valuation_basis: "formal",
    valuation_date: "2026-09-23",
  });
  const result = holdingCorrectionPayload(
    original,
    {
      quantity: "9",
      cost: "95",
      purchase_date: "2026-09-02",
      reason: " Correct typo ",
      account_id: "other",
      as_of: "2026-09-25",
      current_value: "999",
      funding_mode: "external",
      funding_account_id: "otherbank",
      valuation_date: "2026-09-25",
      institution_profit: "-5",
    },
    42,
  );
  assert.equal(result.quantity, "9");
  assert.equal(result.cost, "95");
  assert.equal(result.purchase_date, "2026-09-02");
  for (const name of [
    "account_id",
    "instrument_id",
    "as_of",
    "current_value",
    "funding_mode",
    "funding_account_id",
    "valuation_basis",
    "valuation_date",
  ])
    assert.equal(result[name], original[name], name);
  assert.equal(result.reason, "Correct typo");
  assert.equal(result.expected_revision, 42);
  assert.equal(result.institution_profit, "-5");
  assert.equal(original.cost, "100");
});

test("pending creation requires an explicit choice and preserves reported facts instead of inventing a balance", () => {
  assert.throws(() => ordinaryHoldingPayload(captured), /20.01/);
  const result = ordinaryHoldingPayload({
    ...captured,
    confirm_unreconciled: true,
  });
  assert.equal(result.reconciliation_mode, "pending");
  assert.equal(result.confirm_unreconciled, true);
  assert.equal(result.current_value, "361.41");
  assert.equal(result.cost, "345");
  assert.equal(result.quantity, "337.67");
  assert.equal(result.institution_profit, "-3.60");
  assert.throws(
    () =>
      ordinaryHoldingPayload({
        ...captured,
        institution_profit: undefined,
        reference_nav: "1",
        confirm_unreconciled: true,
      }),
    /请填写机构显示/,
  );
});

test("hidden or obsolete pending flags cannot bypass strict corrections or label reconciled values as unresolved", () => {
  assert.throws(
    () =>
      holdingReconciliationPayload({ ...captured, confirm_unreconciled: true }),
    /20.01/,
  );
  const corrected = ordinaryHoldingPayload({
    ...captured,
    institution_profit: "16.41",
    confirm_unreconciled: true,
  });
  assert.equal(Object.hasOwn(corrected, "reconciliation_mode"), false);
  const automatic = ordinaryHoldingPayload({
    ...captured,
    valuation_mode: "auto",
    confirm_unreconciled: true,
  });
  assert.equal(Object.hasOwn(automatic, "confirm_unreconciled"), false);
});
