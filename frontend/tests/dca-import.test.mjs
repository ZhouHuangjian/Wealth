import test from "node:test";
import assert from "node:assert/strict";
import {
  dcaCommitRequest,
  dcaConfirmFromPreview,
  dcaDraftIssue,
  dcaEstimateDraft,
  dcaImportDrafts,
  dcaImportRequest,
  dcaLoadExisting,
  dcaQuantityDraft,
  dcaRoundingAdjustment,
  dcaRoundingTotal,
} from "../src/dca-import.ts";
const today = "2026-09-28";
const item = {
  date: "2026-09-21",
  selected: true,
  is_scheduled: true,
  amount: "10",
  estimated_quantity: "9.123456789123456",
  theoretical_quantity: "9.2222",
  expected_confirmation_date: "2026-09-23",
  pending_forecast: false,
  nav: "1.096",
  fee: "0",
};
const preview = {
  items: [
    item,
    { date: "2026-09-22", selected: false, is_scheduled: true, amount: "10" },
  ],
};
const plan = { account_id: "bank", amount: "10" };
const draft = () => dcaImportDrafts(preview, plan, today)[0];
const validation = {
  ready: true,
  data_revision: 42,
  plan_version: 2,
  validation_digest: "digest-from-server",
};

test("selected preview rows prefill known data, preserve provenance, and remain drafts until one explicit confirmation", () => {
  const rows = dcaImportDrafts(preview, plan, today);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].debit_date, item.date);
  assert.equal(rows[0].confirmation_date, "2026-09-23");
  assert.equal(rows[0].status, "confirmed");
  assert.equal(rows[0].quantity, "9.12");
  assert.equal(rows[0].nav, "1.096");
  assert.equal(rows[0].fee, "0");
  assert.equal(rows[0].entry_basis, "preview_confirmed");
  assert.equal(rows[0].rounding_adjustment, "0.00448");
  const body = dcaImportRequest("fund", rows, today);
  assert.throws(
    () => dcaCommitRequest(body, validation, rows, false),
    /请确认/,
  );
  assert.equal(
    dcaCommitRequest(body, validation, rows, true).confirm_preview_entries,
    true,
  );
  assert.equal("actual_verified" in body.rows[0], false);
});
test("unknown fee never becomes zero or turns before-fee theoretical units into actual units", () => {
  const row = dcaImportDrafts(
    { items: [{ ...item, fee: null, estimated_quantity: null }] },
    plan,
    today,
  )[0];
  assert.equal(row.fee, "");
  assert.equal(row.quantity, "");
  assert.match(dcaDraftIssue(row, today), /费用未知/);
  assert.throws(() => dcaImportRequest("fund", [row], today), /费用未知/);
  assert.equal(
    dcaEstimateDraft({
      theoretical_quantity: "10.123",
      estimated_quantity: null,
      fee: null,
    }).quantity,
    "",
  );
});
test("missing NAV or calendar details remain visible and unknown instead of silently disappearing or guessing", () => {
  const rows = dcaImportDrafts(
    {
      items: [
        { ...item, nav: null, estimated_quantity: null },
        {
          ...item,
          date: "2026-09-22",
          is_scheduled: null,
          amount: null,
          expected_confirmation_date: null,
        },
      ],
    },
    plan,
    today,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].nav, "");
  assert.match(dcaDraftIssue(rows[0], today), /缺净值/);
  assert.equal(rows[1].amount, "");
  assert.equal(rows[1].debit_date, "");
  assert.equal(rows[1].status, "");
});
test("forecast pending remains in transit even if today is later than the chosen historical cutoff", () => {
  const row = dcaImportDrafts(
    { items: [{ ...item, pending_forecast: true }] },
    plan,
    today,
  )[0];
  assert.equal(row.status, "debited");
  const body = dcaImportRequest("fund", [row], today);
  assert.equal("quantity" in body.rows[0], false);
  assert.equal("confirmation_date" in body.rows[0], false);
  const explicitlyConfirmed = dcaConfirmFromPreview(row, item, today);
  assert.equal(explicitlyConfirmed.status, "confirmed");
  assert.equal(explicitlyConfirmed.entry_basis, "preview_confirmed");
  const future = dcaImportDrafts(
    {
      items: [
        {
          ...item,
          expected_confirmation_date: "2026-09-30",
          pending_forecast: false,
        },
      ],
    },
    plan,
    today,
  )[0];
  assert.equal(future.status, "debited");
  assert.equal(future.confirmation_date, "");
});
test("saved facts override preview estimates and a prior pending debit requires explicit confirmation", () => {
  const existing = {
    status: "debited",
    amount: "12",
    funding_account_id: "saved-bank",
    debit_date: "2026-09-22",
  };
  const row = dcaLoadExisting(draft(), existing);
  assert.equal(row.status, "debited");
  assert.equal(row.amount, "12");
  assert.equal(row.funding_account_id, "saved-bank");
  assert.equal(row.quantity, "");
  assert.equal(row.confirmation_date, "");
  assert.equal(row.entry_basis, "institution");
  const promoted = dcaConfirmFromPreview(row, item, today);
  assert.equal(promoted.amount, "12");
  assert.equal(promoted.funding_account_id, "saved-bank");
  assert.equal(promoted.quantity, "10.95");
  const confirmed = dcaLoadExisting(draft(), {
    ...existing,
    status: "confirmed",
    quantity: "10",
    nav: "1.2",
    fee: "0",
    confirmation_date: "2026-09-23",
    entry_basis: "preview_confirmed",
    rounding_adjustment: "0",
  });
  assert.equal(confirmed.quantity, "10");
  assert.equal(confirmed.entry_basis, "preview_confirmed");
});
test("explicit exclusions remain in the draft list but are omitted from the committed batch", () => {
  const row = draft();
  const excluded = {
    ...row,
    scheduled_date: "2026-09-22",
    amount: "",
    status: "",
    excluded: true,
  };
  assert.equal(dcaDraftIssue(excluded, today), null);
  assert.equal(dcaImportRequest("fund", [row, excluded], today).rows.length, 1);
  assert.throws(
    () => dcaImportRequest("fund", [{ ...row, excluded: true }], today),
    /没有纳入/,
  );
});
test("only one overall confirmation is needed but server readiness, versions and unchanged data remain required", () => {
  const row = draft(),
    body = dcaImportRequest("fund", [row], today);
  assert.throws(
    () => dcaCommitRequest(body, { ...validation, ready: false }, [row], true),
    /检查发现/,
  );
  assert.throws(
    () =>
      dcaCommitRequest(
        body,
        { ...validation, validation_digest: "" },
        [row],
        true,
      ),
    /不完整/,
  );
  assert.throws(
    () => dcaCommitRequest(body, validation, [{ ...row, amount: "20" }], true),
    /预览已改变/,
  );
  const payload = dcaCommitRequest(body, validation, [row], true);
  assert.equal(payload.expected_revision, 42);
  assert.equal(payload.expected_plan_version, 2);
  assert.equal(payload.confirm_actual_records, true);
  assert.equal(payload.confirm_preview_entries, true);
  assert.equal(payload.rows[0].entry_basis, "preview_confirmed");
  assert.equal(payload.rows[0].rounding_confirmed, true);
});
test("rounding adjustments match ledger half-even ties at 12 places without floating point", () => {
  assert.equal(
    dcaRoundingAdjustment({
      amount: "2",
      quantity: "1",
      nav: "1.0000000000005",
      fee: "0",
    }),
    "1",
  );
  assert.equal(
    dcaRoundingAdjustment({
      amount: "2",
      quantity: "1",
      nav: "1.0000000000015",
      fee: "0",
    }),
    "0.999999999998",
  );
  assert.equal(
    dcaRoundingAdjustment({
      amount: "10",
      quantity: "9.12",
      nav: "1.096",
      fee: "0",
    }),
    "0.00448",
  );
  assert.equal(
    dcaRoundingAdjustment({
      amount: "9007199254740993.1",
      quantity: "9007199254740993",
      nav: "1",
      fee: "0",
    }),
    "0.1",
  );
  assert.equal(
    dcaRoundingAdjustment({ amount: "1", quantity: "1", nav: "1", fee: "" }),
    null,
  );
});
test("batch fee recalculation makes two-place draft quantities and summed adjustments preserve signs exactly", () => {
  assert.equal(dcaQuantityDraft("10", "0", "1.096"), "9.12");
  assert.equal(dcaQuantityDraft("10", "0.1", "1.096"), "9.03");
  assert.equal(dcaQuantityDraft("1", "", "1"), "");
  assert.equal(dcaQuantityDraft("1", "1", "1"), "");
  assert.equal(
    dcaQuantityDraft("9007199254740993.125", "0", "1"),
    "9007199254740993.13",
  );
  assert.equal(
    dcaRoundingTotal([
      { ...draft(), rounding_adjustment: "0.00448" },
      { ...draft(), rounding_adjustment: "-0.00447" },
      { ...draft(), excluded: true, rounding_adjustment: "1" },
    ]),
    "0.00001",
  );
});
test("invalid real dates, amounts and duplicated installments are blocked", () => {
  assert.throws(
    () =>
      dcaImportRequest(
        "fund",
        [{ ...draft(), confirmation_date: "2026-09-30" }],
        today,
      ),
    /确认日期/,
  );
  assert.throws(
    () =>
      dcaImportRequest(
        "fund",
        [{ ...draft(), debit_date: "2026-02-30" }],
        today,
      ),
    /扣款日期/,
  );
  assert.throws(
    () => dcaImportRequest("fund", [{ ...draft(), quantity: "0" }], today),
    /份额待补全/,
  );
  assert.throws(
    () => dcaImportRequest("fund", [draft(), draft()], today),
    /重复/,
  );
});
