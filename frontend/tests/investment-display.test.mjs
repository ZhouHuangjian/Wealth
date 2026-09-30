import test from "node:test";
import assert from "node:assert/strict";
import { percentText, profitTone, monthBounds } from "../src/investment.ts";

test("return ratios display as percentages without losing financial precision", () => {
  assert.equal(percentText("0.1"), "+10.00%");
  assert.equal(percentText("-0.012345"), "−1.23%");
  assert.equal(percentText("0.099999"), "+10.00%");
  assert.equal(
    percentText("9007199254740993.00125"),
    "+900719925474099300.13%",
  );
  assert.equal(percentText("-0.000000001"), "0.00%");
  assert.equal(percentText(null), null);
  assert.equal(percentText("not-a-rate"), null);
  assert.equal(profitTone("0.000000000000"), "");
  assert.equal(profitTone(null), "");
  assert.equal(profitTone("-0.000000000001"), "profit-down");
});

test("profit calendar requests correct bounds across leap years", () => {
  assert.deepEqual(monthBounds("2024-02"), {
    start: "2024-02-01",
    end: "2024-02-29",
  });
  assert.deepEqual(monthBounds("2026-02"), {
    start: "2026-02-01",
    end: "2026-02-28",
  });
  assert.deepEqual(monthBounds("2026-12"), {
    start: "2026-12-01",
    end: "2026-12-31",
  });
});

import { transferLabel } from "../src/api.ts";
test("bank and futures cash movements receive unambiguous labels", () => {
  assert.equal(
    transferLabel({ id: "b", kind: "bank" }, { id: "f", kind: "futures" }),
    "银期转入",
  );
  assert.equal(
    transferLabel({ id: "f", kind: "futures" }, { id: "b", kind: "bank" }),
    "银期转出",
  );
  assert.equal(
    transferLabel({ id: "a", kind: "bank" }, { id: "b", kind: "bank" }),
    "同币种账户转账",
  );
  assert.equal(transferLabel(undefined, undefined), "同币种账户转账");
});

import { catalogMarket } from "../src/investment.ts";
test("mainland exchange selectors search the CN catalog without changing overseas markets", () => {
  for (const exchange of ["SHFE", "DCE", "CZCE", "CFFEX", "INE", "GFEX", "SGE"])
    assert.equal(catalogMarket(exchange), "CN");
  assert.equal(catalogMarket("US"), "US");
  assert.equal(catalogMarket("HK"), "HK");
  assert.equal(catalogMarket("CN"), "CN");
});

import { dividendConfirmation } from "../src/investment.ts";
test("switching dividend mode cannot post hidden cash amounts or tax as reinvestment", () => {
  const prior = {
    actual_confirmed: true,
    mode: "reinvest",
    economic_date: "2026-09-20",
    amount: "88.21",
    tax: "0.15",
    quantity: "80.135",
    price: "1.1008",
    fee: "0",
  };
  assert.deepEqual(dividendConfirmation(prior), {
    actual_confirmed: true,
    mode: "reinvest",
    economic_date: "2026-09-20",
    quantity: "80.135",
    price: "1.1008",
    fee: "0",
  });
  assert.deepEqual(
    dividendConfirmation({ ...prior, mode: "link", event_id: "existing" }),
    { actual_confirmed: true, event_id: "existing" },
  );
  assert.deepEqual(dividendConfirmation({ ...prior, mode: "cash" }), {
    actual_confirmed: true,
    mode: "cash",
    economic_date: "2026-09-20",
    amount: "88.21",
    fee: "0",
    tax: "0.15",
  });
});
