import test from "node:test";
import assert from "node:assert/strict";
import { dailyReturnDisplay, returnDateDisplay } from "../src/daily-return.ts";

test("QDII return date stays on the NAV day, separate from publication and fetch", () => {
  const result = returnDateDisplay({
    return_date: "2026-09-28",
    nav_date: "2026-09-28",
    date: "2026-09-29",
    published_at: "2026-09-29T10:00:00Z",
    observed_at: "2026-09-30T02:00:00Z",
  });
  assert.equal(result.returnDate, "2026-09-28");
  assert.equal(result.navDate, "2026-09-28");
  assert.match(result.publishedAt, /2026\/09\/29 18:00/);
  assert.match(result.observedAt, /2026\/09\/30 10:00/);
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
  assert.equal(
    returnDateDisplay({ published_at: "2026-09-28T10:00:00" }).publishedAt,
    null,
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
  assert.equal(value.coverage, "1 / 3 项有当日收益数据");
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
