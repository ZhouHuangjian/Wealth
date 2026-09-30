import test from "node:test";
import assert from "node:assert/strict";
import {
  productIdentityKey,
  specificationForIdentity,
  clearAutomaticSpecification,
  resolutionInput,
  resolutionStillCurrent,
  manualIdentityFields,
} from "../src/product-metadata.ts";

const optionSpecification = {
  metadata_identity: { code: "m2701-P-3300", kind: "option" },
  exchange: "DCE",
  calendar_id: "CN_FUTURES",
  quote_unit: "元/吨",
  contract_multiplier: "10",
  product_prefix: "m",
  option_type: "put",
  is_derivative: true,
  settlement_rule: { status: "not_applicable" },
};

test("replacing an option with an ordinary fund drops the previous exchange, calendar and contract units", () => {
  const next = specificationForIdentity(optionSpecification, {
    code: "110022",
    kind: "fund",
  });
  assert.deepEqual(next, {});
  assert.equal(optionSpecification.exchange, "DCE");
});

test("changing only a fund code drops inherited QDII confirmation rules", () => {
  const next = specificationForIdentity(
    {
      metadata_identity: { code: "270042", kind: "fund" },
      is_qdii: true,
      settlement_rule: { confirmation_days: 2 },
      calendar_id: "CN_EXCHANGE",
    },
    { code: "110022", kind: "fund" },
  );
  assert.deepEqual(next, {});
});

test("explicit manual rules and user labels survive replacing an automatic identity", () => {
  const original = {
    ...optionSpecification,
    metadata_overrides: { calendar_id: "HKEX", confirmation_days: 3 },
    strategy: "长期",
    allocation_tag_id: "tag-1",
    watchlisted: false,
  };
  const next = clearAutomaticSpecification(original);
  assert.deepEqual(next, {
    metadata_overrides: { calendar_id: "HKEX", confirmation_days: 3 },
    strategy: "长期",
    allocation_tag_id: "tag-1",
    watchlisted: false,
  });
  next.metadata_overrides.confirmation_days = 1;
  assert.equal(original.metadata_overrides.confirmation_days, 3);
});

test("freshly selected catalog metadata is retained even when the previous form held another identity", () => {
  const fresh = {
    metadata_identity: { code: "110022", kind: "fund" },
    fund_type: "股票型",
    calendar_id: "CN_EXCHANGE",
  };
  assert.deepEqual(
    specificationForIdentity(
      fresh,
      { code: "110022", kind: "fund" },
      "option|M2701-P-3300",
    ),
    fresh,
  );
  assert.equal(
    productIdentityKey({ code: " m2701-p-3300 ", kind: "OPTION" }),
    "option|M2701-P-3300",
  );
});

test("legacy specifications without identity tracking are cleared on a form identity change", () => {
  assert.deepEqual(
    specificationForIdentity(
      { exchange: "DCE", calendar_id: "CN_FUTURES", quote_unit: "元/吨" },
      { code: "110022", kind: "fund" },
      "option|M2701-P-3300",
    ),
    {},
  );
});

test("a delayed product resolution cannot replace a newer code, classification or manual rule", () => {
  const form = {
    code: "m2701-P-3300",
    name: "豆粕沽3300",
    kind: "option",
    market: "DCE",
    currency: "CNY",
  };
  const request = resolutionInput(form);
  assert.equal(resolutionStillCurrent(request, form), true);
  assert.equal(
    resolutionStillCurrent(request, { ...form, code: "110022", kind: "fund" }),
    false,
  );
  assert.equal(
    resolutionStillCurrent(request, { ...form, kind: "fund" }),
    false,
  );
  assert.equal(
    resolutionStillCurrent(request, { ...form, confirmation_days_override: 2 }),
    false,
  );
  assert.equal(
    resolutionStillCurrent(request, { ...form, identity_manual: true }),
    false,
  );
  assert.equal(
    resolutionStillCurrent(request, { ...form, market: "CN" }),
    true,
  );
});

test("editing a product restores currency-only and exchange-only manual overrides", () => {
  assert.equal(
    manualIdentityFields({ metadata_overrides: { currency: "USD" } })
      .identity_manual,
    true,
  );
  assert.deepEqual(
    manualIdentityFields({
      metadata_overrides: {
        exchange: "DCE",
        confirmation_days: null,
        calendar_id: "CN_FUTURES",
        cutoff_time: "14:30",
      },
    }),
    {
      identity_manual: true,
      subscription_calendar: undefined,
      exchange_override: "DCE",
      confirmation_no_forecast: true,
      confirmation_days_override: null,
      calendar_override: "CN_FUTURES",
      cutoff_override: "14:30",
    },
  );
  assert.equal(
    manualIdentityFields(optionSpecification).identity_manual,
    false,
  );
});
