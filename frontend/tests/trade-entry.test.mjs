import test from "node:test";
import assert from "node:assert/strict";
import { tradeAmountPreview } from "../src/trade-entry.ts";

test("buy and sell preview use fees in opposite directions", () => {
  assert.equal(tradeAmountPreview("buy", "10", "2", "1"), "21.00");
  assert.equal(tradeAmountPreview("sell", "4", "3", "1"), "11.00");
});
test("shares and unit NAV are retained before rounding the cash amount", () => {
  assert.equal(tradeAmountPreview("buy", "5.56", "1.7987"), "10.00");
  assert.equal(
    tradeAmountPreview("buy", "9007199254740993", "1"),
    "9007199254740993.00",
  );
  assert.equal(tradeAmountPreview("buy", "1", "9.995"), "10.00");
});
test("missing or invalid trade data does not show a zero-cost trade", () => {
  assert.equal(tradeAmountPreview("buy", undefined, "2"), null);
  assert.equal(tradeAmountPreview("buy", "abc", "2"), null);
  assert.equal(tradeAmountPreview("buy", "1", "2", "0.001"), null);
});
