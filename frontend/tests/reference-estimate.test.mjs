import test from "node:test";
import assert from "node:assert/strict";
import {
  estimatePresentation,
  referenceEstimatePresentation,
} from "../src/market-quality.ts";

const row = {
  code: "017641",
  currency: "CNY",
  price: "1.7251",
  economic_date: "2026-10-09",
  reference_estimate: {
    kind: "reference_estimate",
    status: "reference_only",
    data_state: "delayed",
    code: "017641",
    currency: "CNY",
    source: "新浪财经·基金参考估值",
    price: "1.7203",
    economic_date: null,
    published_at: "2026-10-13T05:04:00+08:00",
    fetched_at: "2026-10-13T10:41:22+00:00",
    base_nav: "1.7251",
    base_nav_date: "2026-10-09",
    source_change_percent: "-0.278800",
    observation_window_start: "2026-10-12T21:30:00+08:00",
    observation_window_end: "2026-10-13T05:04:00+08:00",
    usable_for_accounting: false,
    usable_for_daily_return: false,
  },
};

test("overnight reference retains source price, baseline and timestamps without replacing an estimate", () => {
  const before = structuredClone(row);
  const view = referenceEstimatePresentation(row);
  assert.equal(view.price, "1.7203");
  assert.equal(view.baseNav, "1.7251");
  assert.equal(view.baseNavDate, "2026-10-09");
  assert.equal(view.changePercent, "-0.278800");
  assert.equal(view.publishedAt, "2026-10-13T05:04:00+08:00");
  assert.equal(view.fetchedAt, "2026-10-13T10:41:22+00:00");
  assert.equal(view.windowStart, "2026-10-12T21:30:00+08:00");
  assert.equal(view.windowEnd, view.publishedAt);
  assert.match(view.label, /历史 \/ 延迟/);
  assert.match(view.message, /不直接计入今日收益或资产估价/);
  assert.equal(estimatePresentation(row).label, "暂无盘中估值");
  assert.deepEqual(row, before);
});

test("reference never borrows another product, currency or accounting identity", () => {
  assert.equal(referenceEstimatePresentation({}), null);
  for (const change of [
    { code: "000001" },
    { currency: "USD" },
    { economic_date: "2026-10-13" },
    { kind: "estimate" },
    { status: "ok" },
    { usable_for_daily_return: true },
    { usable_for_accounting: true },
    { price: "0.0000" },
    { price: "NaN" },
  ])
    assert.equal(
      referenceEstimatePresentation({
        ...row,
        reference_estimate: { ...row.reference_estimate, ...change },
      }),
      null,
    );
});

test("missing source metadata stays missing and zero percent is not lost", () => {
  const view = referenceEstimatePresentation({
    ...row,
    published_at: "2026-10-13T11:00:00+08:00",
    fetched_at: "2026-10-13T11:01:00+08:00",
    reference_estimate: {
      ...row.reference_estimate,
      data_state: "reference_only",
      published_at: null,
      fetched_at: null,
      base_nav: null,
      base_nav_date: null,
      source_change_percent: "0",
    },
  });
  assert.equal(view.label, "来源参考");
  assert.equal(view.publishedAt, null);
  assert.equal(view.fetchedAt, null);
  assert.equal(view.baseNav, null);
  assert.equal(view.baseNavDate, null);
  assert.equal(view.changePercent, "0");
});
