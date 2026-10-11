import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { initializeMountedEntityForm } from "../src/entity-form.ts";

const require = createRequire(import.meta.url);
const { FormStore } = require("rc-field-form/lib/useForm");
const { HOOK_MARK } = require("rc-field-form/lib/FieldContext");
function mountedForm(defaults) {
  const form = new FormStore(() => {}).getForm();
  const hooks = form.getInternalHooks(HOOK_MARK);
  hooks.setInitialValues(defaults, true);
  return { form, hooks };
}

test("account, currency, date and check scope survive actual form-store destroy replay", () => {
  const defaults = {
    account_id: "bank-one",
    currency: "CNY",
    as_of: "2026-10-09",
    kind: "balance",
  };
  const { form, hooks } = mountedForm(defaults);
  hooks.destroyForm(true);
  hooks.setInitialValues(defaults, false);
  assert.deepEqual(form.getFieldsValue(true), {}); // The installed library's replay gap.
  initializeMountedEntityForm(form);
  assert.deepEqual(form.getFieldsValue(true), defaults);
});

test("closing and reopening another entity clears old identity and draft values", () => {
  const first = { id: "old", account_id: "bank-one", currency: "CNY" };
  const next = { id: "next", account_id: "bank-two", currency: "USD" };
  const { form, hooks } = mountedForm(first);
  initializeMountedEntityForm(form);
  form.setFieldsValue({ reason: "unsaved", amount: "30" });
  hooks.destroyForm(true);
  hooks.setInitialValues(next, true);
  initializeMountedEntityForm(form);
  assert.deepEqual(form.getFieldsValue(true), next);
  assert.equal(form.getFieldValue("reason"), undefined);
});

test("asynchronously refreshed options/default props do not overwrite a user's draft", () => {
  const { form, hooks } = mountedForm({ account_id: "bank-one", amount: "0" });
  initializeMountedEntityForm(form);
  form.setFieldsValue({
    account_id: "bank-two",
    amount: "123.45",
    reason: "receipt",
  });
  hooks.setInitialValues({ account_id: "bank-three", amount: "999" }, false);
  assert.deepEqual(form.getFieldsValue(true), {
    account_id: "bank-two",
    amount: "123.45",
    reason: "receipt",
  });
});
