import test from "node:test";
import assert from "node:assert/strict";
import { dailyReturnDisplay } from "../src/daily-return.ts";
import {
  latestFundUpdateDisplay,
  latestFundUpdateRows,
} from "../src/fund-updates.ts";

const pending = {
  account_id: "account-one",
  instrument_id: "fund-one",
  currency: "CNY",
  status: "estimated",
  amount: "-0.480000",
  base_amount: "-0.480000",
  base_nav: "1.7251",
  base_nav_date: "2026-10-09",
  quote_price: "1.7203",
  quoted_at: "2026-10-13T05:04:00+08:00",
  source: "新浪财经·基金参考估值",
  window_label: "2026-10-09 净值后至来源报价时刻",
  quantity_source: "recorded",
};

test("latest updates retain their own interval and exact amount without altering today's total", () => {
  const data = {
    status: "partial",
    amount: null,
    known_amount: "2.00",
    known_count: 1,
    total_count: 3,
    latest_fund_updates: {
      currency: "CNY",
      known_amount: "9999.99",
      items: [pending],
    },
  };
  const before = structuredClone(data);
  const view = latestFundUpdateDisplay(
    latestFundUpdateRows(data.latest_fund_updates)[0],
  );
  assert.equal(view.amount, "-0.480000");
  assert.equal(view.label, "待公布区间估算");
  assert.equal(view.baseNavDate, "2026-10-09");
  assert.equal(view.navDate, null);
  assert.equal(view.quotedAt, "2026-10-13T05:04:00+08:00");
  assert.equal(view.window, pending.window_label);
  assert.equal(dailyReturnDisplay(data).amount, "2.00");
  assert.deepEqual(data, before);
});

test("new formal result replaces displayed input without carrying or adding the prior estimate", () => {
  const formal = {
    ...pending,
    status: "formal",
    amount: "1.02",
    nav_date: "2026-10-12",
    quote_price: "1.7353",
    quoted_at: "2026-10-13T18:00:00+08:00",
    window_label: "2026-10-12 正式净值收益",
    quantity_source: "automatic_estimate",
  };
  assert.equal(latestFundUpdateDisplay(pending).amount, "-0.480000");
  const rows = latestFundUpdateRows({ items: [formal] });
  assert.equal(rows.length, 1);
  const view = latestFundUpdateDisplay(rows[0]);
  assert.equal(view.amount, "1.02");
  assert.equal(view.navDate, "2026-10-12");
  assert.equal(view.label, "正式净值 · 推算份额");
  assert.equal(view.estimated, false);
  assert.ok(!view.label.includes("机构确认"));
});

test("missing and unavailable updates never reuse a base-currency total or a stale amount", () => {
  for (const change of [
    { status: "unavailable" },
    { status: "future-unknown" },
    { amount: null },
    { amount: "NaN" },
  ])
    assert.equal(
      latestFundUpdateDisplay({ ...pending, ...change }).amount,
      null,
    );
  assert.equal(
    latestFundUpdateDisplay({ ...pending, amount: "0" }).amount,
    "0",
  );
  const native = latestFundUpdateDisplay({
    ...pending,
    currency: "USD",
    base_amount: null,
    status: "unavailable",
    native_status: "estimated",
    native_message: "按区间有效份额推算",
    message: "缺少可用折算汇率；原币收益保留",
    missing_reason_code: "fx_missing",
  });
  assert.equal(native.currency, "USD");
  assert.equal(native.amount, pending.amount);
  assert.equal(native.label, "待公布区间估算");
  assert.match(native.message, /按区间有效份额推算.*缺少可用折算汇率/);
  assert.deepEqual(latestFundUpdateRows(null), []);
  assert.deepEqual(latestFundUpdateRows({ items: "bad" }), []);
  assert.deepEqual(
    latestFundUpdateRows({ items: [null, false, [], pending] }),
    [pending],
  );
});

test("missing dates never become today or the source's publication day", () => {
  const view = latestFundUpdateDisplay({
    status: "formal",
    amount: "0",
    quoted_at: pending.quoted_at,
  });
  assert.equal(view.navDate, null);
  assert.equal(view.baseNavDate, null);
  assert.equal(view.window, "覆盖区间待核实");
  assert.equal(view.quotePrice, null);
});

test("optional calculation details preserve exact shares and never borrow the old fetch for a new formal NAV", () => {
  const input = {
    ...pending,
    quantity: "100.123456789012345678",
    fetched_at: "2026-10-13T06:00:00+08:00",
  };
  const view = latestFundUpdateDisplay(input);
  assert.equal(view.quantity, input.quantity);
  assert.equal(view.quantitySourceLabel, "已记录");
  assert.equal(view.fetchedAt, input.fetched_at);
  assert.equal(view.quotedAt, pending.quoted_at);
  assert.equal(
    latestFundUpdateDisplay({ ...input, quantity_source: "automatic_estimate" })
      .quantitySourceLabel,
    "系统推算",
  );
  assert.equal(latestFundUpdateDisplay(pending).quantity, null);
  assert.equal(latestFundUpdateDisplay(pending).fetchedAt, null);
  const formal = latestFundUpdateDisplay({
    ...input,
    status: "formal",
    nav_date: "2026-10-12",
    quoted_at: "2026-10-13T18:00:00+08:00",
    formal_updated_at: "2026-10-13T18:01:00+08:00",
  });
  assert.equal(formal.fetchedAt, null);
  assert.equal(formal.recordedAt, "2026-10-13T18:01:00+08:00");
});
