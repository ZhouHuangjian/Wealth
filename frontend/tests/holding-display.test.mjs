import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredHoldingColumns,
  defaultHoldingDisplay,
  holdingDailyAmount,
  holdingMarketValue,
  holdingPendingAmount,
  hasPendingPurchases,
  pendingPurchaseItems,
  holdingLabels,
  holdingMatches,
  holdingPreferenceKey,
  holdingRowKey,
  normalizeHoldingDisplay,
  sortHoldings,
  summarizeHoldings,
} from "../src/holding-display.ts";

const asOf = "2026-09-28";
const holding = (id, overrides = {}) => ({
  account_id: "bank",
  instrument_id: id,
  name: `基金${id}`,
  currency: "CNY",
  kind: "fund",
  market_value: "100",
  profit: "10",
  profit_rate: "0.1",
  daily_return: {
    date: asOf,
    currency: "CNY",
    amount: "2",
    status: "estimated",
  },
  ...overrides,
});

test("holding display settings are separately keyed by real user and workspace, without anonymous fallback", () => {
  assert.notEqual(
    holdingPreferenceKey(1, "space"),
    holdingPreferenceKey(2, "space"),
  );
  assert.notEqual(
    holdingPreferenceKey(1, "space"),
    holdingPreferenceKey(1, "other"),
  );
  assert.notEqual(
    holdingPreferenceKey("a:b", "c"),
    holdingPreferenceKey("a", "b:c"),
  );
  for (const invalid of [undefined, null, "", 0, {}, false]) {
    assert.equal(holdingPreferenceKey(invalid, "space"), null);
    assert.equal(holdingPreferenceKey(1, invalid), null);
  }
});

test("default columns are compact and versioned preferences preserve required actions while discarding unknown keys", () => {
  const defaults = defaultHoldingDisplay();
  assert.deepEqual(
    configuredHoldingColumns(defaults).map((c) => c.key),
    ["product", "value", "profit", "daily", "actions"],
  );
  assert.ok(
    configuredHoldingColumns(defaults).reduce((sum, c) => sum + c.width, 0) <
      1000,
  );
  const invalid = {
    version: 1,
    order: ["daily", "unknown", "daily"],
    hidden: ["actions", "product", "value", "unknown"],
    fixed: { daily: "right", unknown: "left", value: "bad" },
    pinned: ["bank-x", "bank-x", 1],
    sort: "bad",
  };
  const value = normalizeHoldingDisplay(invalid);
  assert.equal(new Set(value.order).size, defaults.order.length);
  assert.deepEqual(value.hidden, ["value", "pending"]);
  assert.deepEqual(value.fixed, { daily: "right" });
  assert.deepEqual(value.pinned, ["bank-x"]);
  assert.equal(value.sort, "default");
  assert.deepEqual(normalizeHoldingDisplay({ version: 99 }), defaults);
  assert.deepEqual(normalizeHoldingDisplay(null), defaults);
});

test("column order honors separate left/right fixed regions and allows hidden columns to return", () => {
  const prefs = defaultHoldingDisplay();
  prefs.order = [
    "daily",
    "actions",
    "value",
    ...prefs.order.filter((k) => !["daily", "actions", "value"].includes(k)),
  ];
  prefs.fixed = { daily: "left", actions: "right" };
  prefs.hidden = prefs.hidden.filter((k) => k !== "cost");
  const columns = configuredHoldingColumns(prefs);
  assert.equal(columns[0].key, "daily");
  assert.equal(columns.at(-1).key, "actions");
  assert.ok(columns.some((c) => c.key === "cost"));
});

test("search covers names, codes, accounts and labels with multiple words and derivative kind aliases", () => {
  const row = holding("a", {
    name: "华夏基金",
    code: "ABC001",
    account_name: "日常账户",
    labels: [
      { id: "t", name: "红利低波" },
      { id: "t2", name: "红利低波" },
    ],
  });
  assert.deepEqual(holdingLabels(row), ["红利低波"]);
  assert.equal(holdingMatches(row, "  abc001 红利低波 ", "fund"), true);
  assert.equal(holdingMatches(row, "日常账户"), true);
  assert.equal(holdingMatches(row, "华夏"), true);
  assert.equal(holdingMatches(row, "红利低波", "stock"), false);
  assert.equal(holdingMatches({ ...row, kind: "options" }, "", "option"), true);
  assert.equal(holdingMatches(row, "不存在"), false);
});

test("pins are stable per account-product or reference row and stay above the selected sort", () => {
  const a = holding("a", { name: "A" }),
    b = holding("b", { name: "B" }),
    c = holding("a", { account_id: "other", name: "C" });
  const reference = holding("a", { id: "r", is_reference_position: true });
  assert.notEqual(holdingRowKey(a), holdingRowKey(c));
  assert.notEqual(holdingRowKey(a), holdingRowKey(reference));
  const prefs = {
    ...defaultHoldingDisplay(),
    sort: "name",
    pinned: [holdingRowKey(c), holdingRowKey(b)],
  };
  assert.deepEqual(sortHoldings([a, b, c], prefs, asOf), [c, b, a]);
  assert.deepEqual(
    [a, b, c].map((r) => r.name),
    ["A", "B", "C"],
  );
});

test("monetary sorting never compares HKD to CNY and uses exact decimal precision with unknowns last", () => {
  const high = holding("a", {
    market_value: "9007199254740993.000000000000000001",
  });
  const low = holding("b", {
    market_value: "9007199254740993.000000000000000000",
  });
  const missing = holding("c", { market_value: null });
  const hkd = holding("d", {
    currency: "HKD",
    market_value: "99999999999999999999",
  });
  const prefs = { ...defaultHoldingDisplay(), sort: "value_desc" };
  assert.deepEqual(sortHoldings([low, missing, hkd, high], prefs, asOf), [
    high,
    low,
    missing,
    hkd,
  ]);
});

test("top overview stays in separate currencies, excludes references and scope-unconfirmed amounts", () => {
  const rows = [
    holding("a"),
    holding("b", {
      currency: "USD",
      market_value: "80",
      profit: "3",
      daily_return: {
        date: asOf,
        currency: "USD",
        amount: "1",
        status: "confirmed",
      },
    }),
    holding("c", {
      status: "needs_reconciliation",
      market_value: "99999",
      profit: "9000",
    }),
    holding("d", { is_reference_position: true, market_value: "10000" }),
    holding("e", { contributes: false, market_value: "20000" }),
    holding("f", { currency: null }),
  ];
  const summary = summarizeHoldings(rows, asOf);
  assert.equal(summary.referenceCount, 2);
  assert.equal(summary.unknownCurrencyCount, 1);
  assert.deepEqual(
    summary.groups.map((g) => g.currency),
    ["CNY", "USD"],
  );
  assert.deepEqual(summary.groups[0].value, {
    amount: "100",
    known: 1,
    total: 2,
    complete: false,
  });
  assert.deepEqual(summary.groups[0].profit, {
    amount: "10",
    known: 1,
    total: 2,
    complete: false,
  });
  assert.equal(summary.groups[1].value.amount, "80");
});

test("missing values are never fabricated as zero while recorded zero is retained", () => {
  const unknown = summarizeHoldings(
    [holding("a", { market_value: null, profit: null, daily_return: null })],
    asOf,
  ).groups[0];
  assert.equal(unknown.value.amount, null);
  assert.equal(unknown.profit.amount, null);
  assert.equal(unknown.daily.amount, null);
  const zero = summarizeHoldings(
    [
      holding("a", {
        market_value: "0",
        profit: "0",
        daily_return: {
          date: asOf,
          currency: "CNY",
          amount: "0",
          status: "confirmed",
        },
      }),
    ],
    asOf,
  ).groups[0];
  assert.equal(zero.value.amount, "0");
  assert.equal(zero.daily.amount, "0");
  assert.equal(zero.daily.complete, true);
});

test("daily estimates require today's explicit amount and never use cumulative profit or stale/foreign currency data", () => {
  const row = holding("a", { estimate_profit: "800", profit: "900" });
  assert.equal(holdingDailyAmount(row, asOf), "2");
  for (const change of [
    { date: "2026-09-25" },
    { currency: "USD" },
    { status: "unavailable" },
    { amount: null },
  ])
    assert.equal(
      holdingDailyAmount(
        { ...row, daily_return: { ...row.daily_return, ...change } },
        asOf,
      ),
      null,
    );
  assert.equal(
    holdingDailyAmount({ ...row, daily_return: undefined }, asOf),
    null,
  );
  assert.equal(holdingDailyAmount({ ...row, contributes: false }, asOf), null);
});

test("summary decimal addition is exact across large totals and 36-place valuation products", () => {
  const summary = summarizeHoldings(
    [
      holding("a", {
        market_value: "9007199254740993.100000000000000000000000000000000001",
        profit: "-0.1",
      }),
      holding("b", {
        market_value: "0.200000000000000000000000000000000001",
        profit: "0.2",
      }),
    ],
    asOf,
  ).groups[0];
  assert.equal(
    summary.value.amount,
    "9007199254740993.300000000000000000000000000000000002",
  );
  assert.equal(summary.profit.amount, "0.1");
});

test("filtering recomputes the overview and deleted pins never create ghost rows or totals", () => {
  const first = holding("a", {
    account_name: "日常",
    labels: [{ name: "红利低波" }],
  });
  const second = holding("b", { account_name: "长期", market_value: "300" });
  const prefs = { ...defaultHoldingDisplay(), pinned: [holdingRowKey(first)] };
  const filtered = [first, second].filter((row) =>
    holdingMatches(row, "红利低波"),
  );
  assert.equal(summarizeHoldings(filtered, asOf).groups[0].value.amount, "100");
  const afterDelete = sortHoldings([second], prefs, asOf);
  assert.deepEqual(afterDelete, [second]);
  assert.equal(
    summarizeHoldings(afterDelete, asOf).groups[0].value.amount,
    "300",
  );
  assert.deepEqual(summarizeHoldings([], asOf).groups, []);
});

const pending = (amount, items = [], currency = "CNY") => ({
  amount,
  known_amount: amount,
  currency,
  count: items.length,
  items,
  completeness: "complete",
  included_in_assets: true,
  added_to_net_assets: false,
});
const debit = (id, amount, changes = {}) => ({
  id,
  debit_event_id: id,
  amount,
  currency: "CNY",
  instrument_id: "a",
  source_account_id: "bank",
  holding_account_id: "fund-channel",
  automatic_estimate: true,
  ...changes,
});

test("remaining debits stay separate from confirmed value and do not become profit or quantities", () => {
  const confirmed = holding("a", {
    pending_purchases: pending("25", [debit("one", "25")]),
  });
  const only = holding("b", {
    pending_only: true,
    contributes: false,
    market_value: null,
    profit: null,
    daily_return: null,
    pending_purchases: pending("75", [
      debit("two", "75", { instrument_id: "b" }),
    ]),
  });
  const summary = summarizeHoldings([confirmed, only], asOf);
  assert.equal(summary.referenceCount, 0);
  const group = summary.groups[0];
  assert.equal(group.count, 2);
  assert.equal(group.confirmedCount, 1);
  assert.equal(group.pendingOnlyCount, 1);
  assert.deepEqual(group.value, {
    amount: "100",
    known: 1,
    total: 1,
    complete: true,
  });
  assert.deepEqual(group.pending, {
    amount: "100",
    known: 2,
    total: 2,
    complete: true,
  });
  assert.equal(group.profit.amount, "10");
  assert.equal(group.daily.amount, "2");
  assert.equal(group.daily.total, 1);
  assert.equal(holdingMarketValue(only), null);
  assert.equal(
    holdingDailyAmount({ ...only, daily_return: confirmed.daily_return }, asOf),
    null,
  );
});

test("a pending-only product is visible without inventing zero holdings or missing daily-return data", () => {
  const only = holding("a", {
    pending_only: true,
    contributes: false,
    pending_purchases: pending("50", [debit("one", "50")]),
  });
  const group = summarizeHoldings([only], asOf).groups[0];
  for (const key of ["value", "profit", "daily"])
    assert.deepEqual(group[key], {
      amount: null,
      known: 0,
      total: 0,
      complete: true,
    });
  assert.equal(group.pending.amount, "50");
  assert.equal(holdingMarketValue(only), null);
  assert.equal(hasPendingPurchases(only), true);
  assert.equal(
    holdingRowKey(only),
    holdingRowKey({ ...only, pending_only: false, contributes: true }),
  );
});

test("unpaid schedules, zero, negative and cross-currency pending values never masquerade as recorded assets", () => {
  const unpaid = holding("a", {
    plan_amount: "200",
    pending_amount: "200",
    automation: { status: "waiting_cash" },
  });
  assert.equal(holdingPendingAmount(unpaid), null);
  assert.equal(hasPendingPurchases(unpaid), false);
  assert.equal(
    hasPendingPurchases(holding("a", { pending_purchases: pending("0") })),
    false,
  );
  for (const value of ["-1", null, "NaN"])
    assert.equal(
      holdingPendingAmount(holding("a", { pending_purchases: pending(value) })),
      null,
    );
  assert.equal(
    holdingPendingAmount(
      holding("a", { pending_purchases: pending("3", [], "USD") }),
    ),
    null,
  );
  assert.equal(
    holdingPendingAmount(
      holding("a", {
        is_reference_position: true,
        pending_purchases: pending("3"),
      }),
    ),
    null,
  );
  // Institution-snapshot coverage can be unknown; recorded remaining transit is still shown separately.
  assert.equal(
    holdingPendingAmount(
      holding("a", {
        pending_purchases: { ...pending("3"), included_in_assets: null },
      }),
    ),
    "3",
  );
});

test("partial confirmation displays only the projected remainder, deduplicates details and preserves source facts", () => {
  const one = debit("one", "20", {
    original_amount: "100",
    confirmed_amount: "80",
    scheduled_date: "2026-09-25",
  });
  const list = pendingPurchaseItems([
    one,
    { ...one },
    debit("zero", "0"),
    debit("negative", "-2"),
    debit("unknown", null),
    debit("foreign", "4", { currency: "USD" }),
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].amount, "20");
  assert.equal(list[0].automatic_estimate, true);
  assert.equal(list[0].scheduled_date, "2026-09-25");
  assert.deepEqual(pendingPurchaseItems(undefined), []);
  const row = holding("a", { pending_purchases: pending("20", [one]) });
  assert.equal(summarizeHoldings([row], asOf).groups[0].pending.amount, "20");
});

test("pending sums and sorting are exact by currency and react to filtering and settlement", () => {
  const first = holding("a", {
    labels: ["红利低波"],
    pending_purchases: pending("9007199254740993.01", [
      debit("one", "9007199254740993.01"),
    ]),
  });
  const second = holding("b", {
    pending_only: true,
    contributes: false,
    pending_purchases: pending("0.09", [debit("two", "0.09")]),
  });
  const usd = holding("c", {
    currency: "USD",
    pending_purchases: pending(
      "99999999999999999",
      [debit("three", "99999999999999999", { currency: "USD" })],
      "USD",
    ),
  });
  const groups = summarizeHoldings([first, second, usd], asOf).groups;
  assert.deepEqual(
    groups.map((group) => group.currency),
    ["CNY", "USD"],
  );
  assert.equal(groups[0].pending.amount, "9007199254740993.1");
  assert.equal(groups[1].pending.amount, "99999999999999999");
  assert.deepEqual(
    sortHoldings(
      [usd, second, first],
      { ...defaultHoldingDisplay(), sort: "pending_desc" },
      asOf,
    ),
    [first, second, usd],
  );
  assert.equal(
    summarizeHoldings(
      [first, second].filter((row) => holdingMatches(row, "红利低波")),
      asOf,
    ).groups[0].pending.amount,
    "9007199254740993.01",
  );
  const settled = {
    ...second,
    pending_only: false,
    contributes: true,
    pending_purchases: pending("0"),
  };
  assert.equal(hasPendingPurchases(settled), false);
  assert.equal(holdingRowKey(settled), holdingRowKey(second));
});

test("legacy column preferences keep the new pending column hidden until explicitly enabled", () => {
  const defaults = defaultHoldingDisplay();
  const old = {
    ...defaults,
    order: defaults.order.filter((key) => key !== "pending"),
    hidden: defaults.hidden.filter((key) => key !== "pending"),
    pinned: ["bank-a"],
    sort: "name",
  };
  const migrated = normalizeHoldingDisplay(old);
  assert.ok(migrated.order.includes("pending"));
  assert.ok(migrated.hidden.includes("pending"));
  assert.deepEqual(migrated.pinned, ["bank-a"]);
  assert.equal(migrated.sort, "name");
  assert.ok(
    configuredHoldingColumns({
      ...migrated,
      hidden: migrated.hidden.filter((key) => key !== "pending"),
    }).some((column) => column.key === "pending"),
  );
});
