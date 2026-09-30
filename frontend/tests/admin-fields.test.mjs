import test from "node:test";
import assert from "node:assert/strict";
import { editableValues, fieldLabel, numeric } from "../src/adminData.ts";

test("administrator sees unfamiliar entered fields without exposing system identity", () => {
  const values = editableValues({
    name: "测试",
    custom_reference: "经核对",
    quantity: "2.5",
    id: "internal",
    tenant_id: "foreign",
    version: 3,
    token_hash: "secret",
    storage_key: "private",
    _private: true,
    operation_id: "operation",
  });
  assert.deepEqual(values, {
    name: "测试",
    custom_reference: "经核对",
    quantity: "2.5",
  });
  assert.equal(fieldLabel("custom_reference"), "补充字段 · custom_reference");
});

test("holding evidence numbers remain exact numeric inputs", () => {
  for (const key of [
    "institution_profit",
    "reference_nav",
    "quantity",
    "current_value",
  ])
    assert.equal(numeric.has(key), true);
});
