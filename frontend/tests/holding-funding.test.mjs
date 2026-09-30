import test from "node:test";
import assert from "node:assert/strict";
import { holdingFundingPreview } from "../src/holding-funding.ts";

test("institution allocation preserves current market value, not historic cost", () => {
  assert.deepEqual(
    holdingFundingPreview({
      mode: "profit",
      cost: "80",
      profit: "1.82",
      available: "100",
    }),
    {
      required: "81.82",
      used: "81.82",
      shortfall: "0",
      remaining: "18.18",
    },
  );
});
test("only shortfall is assigned to the selected source without binary rounding", () => {
  assert.deepEqual(
    holdingFundingPreview({
      mode: "value",
      currentValue: "0.3",
      available: "0.1",
    }),
    {
      required: "0.3",
      used: "0.1",
      shortfall: "0.2",
      remaining: "0",
    },
  );
});
test("loss and large high precision values retain decimal accuracy", () => {
  assert.equal(
    holdingFundingPreview({
      mode: "profit",
      cost: "100",
      profit: "-20",
      available: "80",
    }).shortfall,
    "0",
  );
  assert.equal(
    holdingFundingPreview({
      mode: "value",
      currentValue: "9007199254740993.123456789012",
      available: "9007199254740992.123456789011",
    }).shortfall,
    "1.000000000001",
  );
});
test("unknown or impossible values never produce a zero balance claim", () => {
  for (const input of [
    { mode: "value", currentValue: "2" },
    { mode: "value", currentValue: "-1", available: "10" },
    { mode: "value", currentValue: "2", available: "-1" },
    { mode: "profit", cost: "10", profit: "-11", available: "10" },
    { mode: "profit", cost: "10", profit: "", available: "10" },
  ])
    assert.equal(holdingFundingPreview(input), null);
});
