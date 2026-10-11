import test from "node:test";
import assert from "node:assert/strict";
import {
  newestFirst,
  newestYearsFirst,
  shiftBusinessDay,
} from "../src/date-ordering.ts";

test("later years and dates lead, while source arrays keep calculation chronology", () => {
  const rows = [
    { id: "old", date: "2026-12-31" },
    { id: "new", date: "2027-01-01" },
  ];
  assert.deepEqual(
    newestFirst(rows).map((row) => row.id),
    ["new", "old"],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["old", "new"],
  );
  assert.deepEqual(newestYearsFirst([2025, 2027, 2026]), [2027, 2026, 2025]);
});

test("unknown dates trail known dates, with business-date fallback and stable equal-date order", () => {
  const rows = [
    { id: "blank", due_date: "" },
    { id: "same-first", due_date: "2027-01-01" },
    { id: "unknown", due_date: null },
    { id: "fallback", economic_date: "2026-12-31" },
    { id: "same-second", due_date: "2027-01-01" },
    { id: "invalid", due_date: "2027-02-30" },
  ];
  assert.deepEqual(
    newestFirst(rows, ["due_date", "economic_date"]).map((row) => row.id),
    ["same-first", "same-second", "fallback", "blank", "unknown", "invalid"],
  );
});

test("month and year buckets compare as ISO business dates", () => {
  assert.deepEqual(newestFirst([{ date: "2026" }, { date: "2027" }]), [
    { date: "2027" },
    { date: "2026" },
  ]);
  assert.deepEqual(newestFirst([{ date: "2026-12" }, { date: "2027-01" }]), [
    { date: "2027-01" },
    { date: "2026-12" },
  ]);
});

test("recent range arithmetic preserves day labels across month/year boundaries", () => {
  assert.equal(shiftBusinessDay("2027-01-01", -29), "2026-12-03");
  assert.equal(shiftBusinessDay("2026-12-31", 30), "2027-01-30");
  assert.equal(shiftBusinessDay("2028-03-01", -1), "2028-02-29");
});
