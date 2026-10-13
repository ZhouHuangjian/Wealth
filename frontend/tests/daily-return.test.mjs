import test from "node:test";
import assert from "node:assert/strict";
import {
  dailyReturnDisplay,
  dailyReturnItemLabel,
  dailyReturnIssues,
  returnDateDisplay,
} from "../src/daily-return.ts";
import { estimatePresentation } from "../src/market-quality.ts";

test("QDII return date stays on the NAV day, separate from publication and fetch", () => {
  const result = returnDateDisplay({
    return_date: "2026-09-28",
    nav_date: "2026-09-28",
    date: "2026-09-29",
    published_at: "2026-09-29T10:00:00Z",
    observed_at: "2026-09-30T02:00:00Z",
    fetched_at: "2026-09-30T01:59:00Z",
  });
  assert.equal(result.returnDate, "2026-09-28");
  assert.equal(result.navDate, "2026-09-28");
  assert.match(result.publishedAt, /2026\/09\/29 18:00/);
  assert.match(result.observedAt, /2026\/09\/30 10:00/);
  assert.match(result.fetchedAt, /2026\/09\/30 09:59/);
  assert.equal(
    returnDateDisplay({ observed_at: "2026-09-30 02:00:00+00:00" }).observedAt,
    result.observedAt,
  );
});

test("unknown provider publication does not become local fetch time", () => {
  const result = returnDateDisplay({
    date: "2026-09-28",
    price_date: "2026-09-28",
    observed_at: "2026-09-29T02:00:00Z",
  });
  assert.equal(result.returnDate, "2026-09-28");
  assert.equal(result.publishedAt, null);
  assert.equal(result.fetchedAt, null);
  assert.equal(
    returnDateDisplay({ published_at: "2026-09-28T10:00:00" }).publishedAt,
    null,
  );
});

test("formal NAV and inferred shares are distinct from an institution-confirmed trade", () => {
  const data = {
    status: "estimated",
    observation_kind: "formal",
    quantity_source: "automatic_estimate",
  };
  assert.equal(dailyReturnItemLabel(data), "正式价格 · 含推算份额");
  assert.equal(
    dailyReturnItemLabel({
      ...data,
      status: "unavailable",
      native_status: "estimated",
      missing_reason_code: "fx_missing",
    }),
    "正式价格 · 含推算份额（原币，待折算）",
  );
  assert.equal(
    dailyReturnItemLabel({
      status: "confirmed",
      observation_kind: "formal",
      quantity_source: "recorded",
    }),
    "正式价格计算",
  );
  assert.equal(
    dailyReturnItemLabel({ status: "unavailable", observation_kind: "formal" }),
    "待更新",
  );
});

test("daily return never shows missing or no-position amounts as zero", () => {
  for (const status of ["unavailable", "no_position"]) {
    const value = dailyReturnDisplay({
      status,
      known_amount: "0",
      amount: null,
      known_count: 0,
      total_count: 3,
    });
    assert.equal(value.amount, null);
    assert.equal(value.rate, null);
  }
});

test("a partial daily return labels known money and suppresses a full portfolio rate", () => {
  const value = dailyReturnDisplay({
    status: "partial",
    amount: null,
    known_amount: "12.345",
    return_rate: "0.02",
    known_count: 1,
    total_count: 3,
  });
  assert.equal(value.amount, "12.345");
  assert.equal(value.partial, true);
  assert.equal(value.rate, null);
  assert.equal(value.coverage, "1 / 3 项可计算（按条目数）");
});

test("partial known zero remains visibly partial and gaps retain distinct reasons", () => {
  const data = {
    status: "partial",
    amount: null,
    known_amount: "0",
    known_count: 1,
    total_count: 4,
    items: [
      { status: "estimated", base_amount: "0" },
      { status: "unavailable", missing_reason_code: "no_estimate" },
      { status: "unavailable", missing_reason_code: "no_estimate" },
      { status: "unavailable", missing_reason_code: "quote_delayed" },
    ],
  };
  const view = dailyReturnDisplay(data);
  assert.equal(view.amount, "0");
  assert.equal(view.partial, true);
  assert.equal(view.label, "部分可计算");
  assert.equal(view.rate, null);
  assert.deepEqual(dailyReturnIssues(data), [
    { label: "暂无盘中估值", count: 2 },
    { label: "报价已延迟", count: 1 },
  ]);
  assert.deepEqual(
    dailyReturnIssues({
      items: [{ status: "unavailable", message: "custom" }],
    }),
    [{ label: "行情或计算依据待补全", count: 1 }],
  );
});

test("formal NAV availability does not hide a missing or delayed intraday quote", () => {
  const formal = {
    status: "ok",
    price: "1.23",
    data_quality: { status: "consistent" },
  };
  assert.equal(estimatePresentation(formal).label, "暂无盘中估值");
  const delayed = estimatePresentation({
    ...formal,
    estimate: {
      status: "ok",
      price: "1.25",
      data_state: "delayed",
      published_at: "2026-10-12T11:30:00+08:00",
    },
  });
  assert.equal(delayed.warning, true);
  assert.equal(delayed.label, "历史 / 延迟报价");
  assert.equal(
    estimatePresentation({
      ...formal,
      estimate: { status: "ok", price: "1.25", data_state: "latest_available" },
    }).label,
    "估值依据待核实",
  );
});

test("a confirmed zero return remains a real zero, while invalid values stay missing", () => {
  assert.equal(
    dailyReturnDisplay({
      status: "confirmed",
      amount: "0.000000",
      return_rate: "0",
      known_count: 1,
      total_count: 1,
    }).amount,
    "0.000000",
  );
  assert.equal(
    dailyReturnDisplay({ status: "confirmed", amount: "NaN" }).amount,
    null,
  );
  assert.equal(
    dailyReturnDisplay({ status: "confirmed", amount: "0", return_rate: "0" })
      .rate,
    "0.00%",
  );
});
