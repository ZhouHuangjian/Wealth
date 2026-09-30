import test from "node:test";
import assert from "node:assert/strict";
import { api, send, setCsrf, ApiError } from "../src/api.ts";
import { formatDecimal } from "../src/format.ts";
const memory = new Map();
globalThis.sessionStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("financial display retains values beyond Number precision and source fraction", () => {
  assert.equal(
    formatDecimal("9007199254740993.123456789123"),
    "9,007,199,254,740,993.123456789123",
  );
  assert.equal(formatDecimal("1000.500000000000"), "1,000.50");
  assert.equal(formatDecimal("-520.00"), "−520.00");
  assert.equal(formatDecimal("0.000000000000", true), "0.00");
  assert.equal(formatDecimal("-0.00", true), "0.00");
  assert.equal(formatDecimal(null), null);
  assert.equal(formatDecimal("NaN"), null);
});

test("display precision bounds repeating market metrics without rounding source amounts", () => {
  const source = "0.75621294" + "1234567890".repeat(16);
  assert.equal(formatDecimal(source, false, 2), "0.76");
  assert.equal(formatDecimal(source, false, 4), "0.7562");
  assert.equal(formatDecimal("999.995", false, 2), "1,000.00");
  assert.equal(formatDecimal("-0.0001", true, 2), "0.00");
  assert.equal(formatDecimal("-1.235", true, 2), "−1.24");
  assert.equal(
    formatDecimal("9007199254740993.125", false, 2),
    "9,007,199,254,740,993.13",
  );
  assert.equal(formatDecimal(source), source.replace(/0+$/, ""));
  assert.equal(formatDecimal(null, false, 2), null);
});

test("an uncertain financial command retries with the same key, then a new action receives a new key", async () => {
  const keys = [];
  let attempts = 0;
  globalThis.fetch = async (_url, options) => {
    keys.push(options.headers.get("Idempotency-Key"));
    if (++attempts === 1) throw new TypeError("network interrupted");
    return json({ id: "event-a" });
  };
  const body = { kind: "expense", amount: "9007199254740993.000000000001" };
  await assert.rejects(send("/spaces/space-a/events", body));
  await send("/spaces/space-a/events", body);
  assert.equal(keys[0], keys[1]);
  await send("/spaces/space-a/events", body);
  assert.notEqual(keys[1], keys[2]);
  assert.equal(memory.size, 0);
});

test("space identity is part of command identity and amounts stay strings", async () => {
  const captured = [];
  setCsrf("csrf-test-token");
  globalThis.fetch = async (url, options) => {
    captured.push({ url, ...options });
    return json({ ok: true });
  };
  await send("/spaces/a/events", { amount: "0.123456789123" });
  await send("/spaces/b/events", { amount: "0.123456789123" });
  assert.notEqual(
    captured[0].headers.get("Idempotency-Key"),
    captured[1].headers.get("Idempotency-Key"),
  );
  assert.equal(captured[0].headers.get("X-CSRFToken"), "csrf-test-token");
  assert.equal(captured[0].credentials, "include");
  assert.equal(JSON.parse(captured[0].body).amount, "0.123456789123");
});

test("server version conflicts remain actionable errors, never empty success", async () => {
  globalThis.fetch = async () =>
    json(
      {
        code: "stale_preview",
        message: "预览已过期，请重新预览",
        fields: { version: "stale" },
      },
      409,
    );
  await assert.rejects(
    send("/spaces/a/imports/one/commit", { preview_version: 3 }),
    (e) =>
      e instanceof ApiError &&
      e.status === 409 &&
      e.message.includes("预览已过期") &&
      e.fields.version === "stale",
  );
});

test("multipart uploads leave content-type boundary to browser", async () => {
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = options;
    return json({ id: "batch" });
  };
  const body = new FormData();
  body.append("file", new Blob(["date,amount\n2026-09-25,20"]), "sample.csv");
  await api("/spaces/a/imports", { method: "POST", body });
  assert.equal(captured.headers.has("Content-Type"), false);
  assert.equal(captured.body, body);
});

test("two decimal display never turns a rounding residue into a visible loss", () => {
  assert.equal(formatDecimal("0.00000001", false, 2), "0.00");
  assert.equal(formatDecimal("-0.00000001", true, 2), "0.00");
  assert.equal(formatDecimal("337.670000000000", false, 2), "337.67");
  assert.equal(formatDecimal("10", false, 2), "10.00");
});
