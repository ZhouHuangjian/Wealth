import { Alert, Checkbox, Form, InputNumber } from "antd";
import { Money } from "../components";
import {
  holdingReconciliation,
  holdingReconciliationPayload,
} from "../holding-reconciliation";

export function HoldingReconciliation({
  currency,
  allowPending = false,
}: {
  currency: string;
  allowPending?: boolean;
}) {
  const form = Form.useFormInstance();
  const values = Form.useWatch((values) => values, form) || {};
  const check = holdingReconciliation(values);
  const pending =
    allowPending &&
    values.confirm_unreconciled === true &&
    !!check?.conflicts.length;
  if (!["value", "profit"].includes(values.valuation_mode)) return null;
  return (
    <div className="wizard-section">
      <h3>录入前核对</h3>
      <p className="data-caption">
        以下项目选填，用于核对同一天、同一份持仓的数据。机构页面的总资产可能包含申购在途；“可用份额”也不等于“已确认持有份额”。
      </p>
      <div className="form-grid">
        <Form.Item
          name="institution_profit"
          label="机构显示的持仓收益（核对用）"
          extra="盈利填正数、亏损填负数；不用于反推成本或自动拆分申购款。"
          dependencies={[
            "cost",
            "quantity",
            "valuation_mode",
            "current_value",
            "current_profit",
            "confirm_unreconciled",
            "reference_nav",
          ]}
          rules={[
            {
              validator: async () => {
                holdingReconciliationPayload(
                  form.getFieldsValue(true),
                  allowPending,
                );
              },
            },
          ]}
        >
          <InputNumber
            stringMode
            addonAfter={currency}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          name="reference_nav"
          label="对应单位净值（核对用）"
          extra="按上述持仓数量与市值对应的数据日填写，最多 12 位小数。"
          dependencies={[
            "cost",
            "quantity",
            "valuation_mode",
            "current_value",
            "current_profit",
            "confirm_unreconciled",
          ]}
          rules={[
            {
              validator: async () => {
                holdingReconciliationPayload(
                  form.getFieldsValue(true),
                  allowPending,
                );
              },
            },
          ]}
        >
          <InputNumber
            stringMode
            changeOnBlur={false}
            style={{ width: "100%" }}
          />
        </Form.Item>
      </div>
      <Alert
        type={pending ? "warning" : check?.conflicts.length ? "error" : "info"}
        showIcon
        message="本次录入金额预览"
        description={
          check ? (
            <>
              <div>
                计入的持仓市值 <Money value={check.value} currency={currency} />{" "}
                · 成本 <Money value={check.cost} currency={currency} /> ·
                {pending ? "计算差额（待核对）" : "计算盈亏"}{" "}
                <Money value={check.profit} currency={currency} sign />
              </div>
              {check.nav_value !== null && (
                <div>
                  份额 × 核对净值{" "}
                  <Money value={check.nav_value} currency={currency} />
                </div>
              )}
              {check.conflicts.map((conflict) => (
                <p key={conflict.field}>{conflict.message}</p>
              ))}
            </>
          ) : (
            "填写当前持仓成本和市值或收益后显示；核对差额超过 0.02 时须先更正数据，才能提交。"
          )
        }
      />
      {allowPending && !!check?.conflicts.length && (
        <Form.Item
          name="confirm_unreconciled"
          valuePropName="checked"
          extra="勾选后仍按上面的市值登记资产，但持有收益显示为待核对，机构收益单独保存。不会自动拆分申购款、倒推成本或改变份额；后续可用原始记录继续核对。"
        >
          <Checkbox>数据范围暂时不明确，先按上述原值保存并标记待核对</Checkbox>
        </Form.Item>
      )}
    </div>
  );
}
