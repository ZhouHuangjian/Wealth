import test from "node:test";
import assert from "node:assert/strict";
import {
  hasOptionValue,
  holdingDisplayRows,
  optionHoldingPreview,
  optionPositionForProduct,
  optionPositionPayload,
} from "../src/option-holding.ts";

const position = {
  side: "long",
  quantity: "2",
  contract_multiplier: "10",
  opening_price: "12.34",
  current_value: "300",
  purchase_date: "2026-09-21",
  as_of: "2026-09-23",
};

test("option creation includes a single nested payload only while explicitly enabled", () => {
  const values = {
    kind: "option",
    with_holding: true,
    account_id: "futures",
    option_position: position,
  };
  assert.deepEqual(optionPositionForProduct(values), {
    account_id: "futures",
    ...position,
  });
  for (const kind of ["fund", "stock", "future", "gold"]) {
    assert.equal(optionPositionForProduct({ ...values, kind }), undefined);
  }
  for (const with_holding of [false, undefined, null]) {
    assert.equal(
      optionPositionForProduct({ ...values, with_holding }),
      undefined,
    );
  }
});

test("zero settlement and its actual date survive serialization without replacing market value", () => {
  const input = {
    ...position,
    settlement_price: 0,
    settlement_date: "2026-09-22",
    cost: "999",
  };
  const result = optionPositionPayload(input, "futures");
  assert.equal(result.settlement_price, "0");
  assert.equal(result.settlement_date, "2026-09-22");
  assert.equal(result.current_value, "300");
  assert.equal(result.as_of, "2026-09-23");
  assert.equal(Object.hasOwn(result, "cost"), false);
  assert.equal(input.settlement_price, 0);
  assert.equal(hasOptionValue("0"), true);
});

test("clearing optional settlement drops a preserved date on create and explicitly clears it on edit", () => {
  for (const settlement_price of [undefined, null, "", "  "]) {
    const input = {
      ...position,
      settlement_price,
      settlement_date: "2026-09-22",
    };
    const create = optionPositionPayload(input, "futures");
    assert.equal(Object.hasOwn(create, "settlement_price"), false);
    assert.equal(Object.hasOwn(create, "settlement_date"), false);
    const update = optionPositionPayload(input, "futures", true);
    assert.equal(update.settlement_price, null);
    assert.equal(update.settlement_date, null);
  }
  assert.throws(
    () =>
      optionPositionPayload({ ...position, settlement_price: "0" }, "futures"),
    /结算日期/,
  );
});

test("gross reference profit respects long or short direction and never implies a return rate", () => {
  assert.deepEqual(optionHoldingPreview(position), {
    opening_premium: "246.8",
    reference_profit: "53.2",
  });
  assert.deepEqual(optionHoldingPreview({ ...position, side: "short" }), {
    opening_premium: "246.8",
    reference_profit: "-53.2",
  });
  assert.deepEqual(
    optionHoldingPreview({
      ...position,
      opening_price: "0",
      current_value: "0",
    }),
    { opening_premium: "0", reference_profit: "0" },
  );
  assert.equal(
    optionPositionPayload(
      { ...position, opening_price: 0, current_value: 0 },
      "futures",
    ).current_value,
    "0",
  );
});

test("contract units must be supplied and fractional lots or negative values are rejected", () => {
  for (const changes of [
    { quantity: "1.5" },
    { quantity: "0" },
    { quantity: "-1" },
    { contract_multiplier: undefined },
    { contract_multiplier: "0" },
    { contract_multiplier: "-10" },
    { current_value: "-1" },
    { opening_price: "-1" },
    { side: "put" },
  ]) {
    assert.equal(optionHoldingPreview({ ...position, ...changes }), null);
    assert.throws(() =>
      optionPositionPayload({ ...position, ...changes }, "futures"),
    );
  }
});

test("large prices and decimal multipliers use decimal precision for the preview", () => {
  assert.deepEqual(
    optionHoldingPreview({
      ...position,
      opening_price: "9007199254740993.123456789012",
      quantity: "1",
      contract_multiplier: "1",
      current_value: "9007199254740994.123456789013",
    }),
    {
      opening_premium: "9007199254740993.123456789012",
      reference_profit: "1.000000000001",
    },
  );
  assert.deepEqual(
    optionHoldingPreview({
      ...position,
      opening_price: "0.1",
      quantity: "3",
      contract_multiplier: "0.2",
      current_value: "0.1",
    }),
    { opening_premium: "0.06", reference_profit: "0.04" },
  );
});

test("merging reference rows for display preserves the separate accounting collection", () => {
  const ordinary = Object.freeze({ id: "stock", market_value: "100" });
  const reference = Object.freeze({
    id: "option",
    market_value: "300",
    contributes: false,
  });
  const source = Object.freeze({
    items: Object.freeze([ordinary]),
    reference_items: Object.freeze([reference]),
  });
  const displayed = holdingDisplayRows(source);
  assert.deepEqual(displayed, [ordinary, reference]);
  assert.deepEqual(source.items, [ordinary]);
  assert.equal(displayed[1].contributes, false);
  assert.deepEqual(holdingDisplayRows(undefined), []);
  assert.deepEqual(holdingDisplayRows([ordinary]), [ordinary]);
});
