import assert from "node:assert/strict";
import test from "node:test";
import { accountBalanceCaption } from "../src/account-balance.ts";

test("institution amount uses its actual equity baseline date", () => {
  assert.equal(
    accountBalanceCaption({
      balance: "12345.67",
      balance_basis: "institution_settlement",
      balance_label: "机构总权益",
      balance_as_of: "2026-09-28",
      balance_status: "complete",
    }),
    "机构总权益 · 基准 2026-09-28",
  );
});

test("an explicit zero remains a known amount; missing equity stays distinct", () => {
  assert.equal(
    accountBalanceCaption({
      balance: "0",
      balance_label: "机构总权益",
      balance_status: "complete",
    }),
    "机构总权益",
  );
  assert.equal(
    accountBalanceCaption({
      balance: null,
      balance_label: "机构总权益",
      balance_status: "missing",
    }),
    "机构总权益 · 待补全",
  );
});

test("partial cash evidence is not labelled total equity", () => {
  assert.equal(
    accountBalanceCaption({
      balance: "500",
      balance_basis: "recorded_cash",
      balance_label: "已记录资金",
      balance_status: "partial",
    }),
    "已记录资金 · 待核对",
  );
});

test("ledger caption keeps its book amount and never embeds private amounts", () => {
  const caption = accountBalanceCaption({
    balance: "987654.32",
    balance_basis: "ledger",
    balance_as_of: "2026-10-04",
    balance_status: "complete",
  });
  assert.equal(caption, "账面金额 · 截至 2026-10-04");
  assert.ok(!caption.includes("987654"));
});
