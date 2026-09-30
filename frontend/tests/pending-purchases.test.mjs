import test from "node:test";
import assert from "node:assert/strict";
import { pendingSummaryDisplay } from "../src/pending-purchases.ts";

test("pending summary uses the converted server amount and hides empty summaries", () => {
  assert.equal(pendingSummaryDisplay(null).visible, false);
  assert.equal(
    pendingSummaryDisplay({ count: 0, amount: "0.00" }).visible,
    false,
  );
  assert.deepEqual(pendingSummaryDisplay({ count: 2, amount: "25.30" }), {
    visible: true,
    amount: "25.30",
    note: "",
  });
});

test("missing FX keeps unknown amounts distinct from confirmed zero", () => {
  assert.deepEqual(
    pendingSummaryDisplay({ count: 1, amount: null, known_amount: "0.00" }),
    {
      visible: true,
      amount: undefined,
      note: "待折算",
    },
  );
  assert.deepEqual(
    pendingSummaryDisplay({ count: 2, amount: null, known_amount: "12.30" }),
    {
      visible: true,
      amount: "12.30",
      note: "已知部分",
    },
  );
  assert.deepEqual(
    pendingSummaryDisplay({ count: 1, amount: "0.00", known_amount: "0.00" }),
    {
      visible: true,
      amount: "0.00",
      note: "",
    },
  );
});
