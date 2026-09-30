import { useEffect } from "react";
import {
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
} from "antd";
import { Minus, Plus } from "lucide-react";
import type { Item } from "../api";
import { api, dateToday } from "../api";
import { useWorkspace } from "../state";
import { Fields } from "../components";
import { HelpText } from "../help";
import {
  dcaAutomationNotice,
  dcaHoldingKinds,
  eligibleDcaHolding,
} from "../dca-automation";

export default function DcaAutomationFields({
  accounts,
  useDefaults = true,
}: {
  accounts: Item[];
  useDefaults?: boolean;
}) {
  const form = Form.useFormInstance();
  const { space } = useWorkspace();
  const enabled = Form.useWatch("automatic_enabled", form) === true;
  const feeMode = Form.useWatch("automatic_fee_mode", form);
  const currency = Form.useWatch("currency", form) || "CNY";
  const fundingId = Form.useWatch("account_id", form);
  const holdingId = Form.useWatch("target_account_id", form);
  const start = Form.useWatch("automatic_start_date", form);
  const planStart = Form.useWatch("start_date", form);
  const instrumentId = Form.useWatch("instrument_id", form);
  const fundingMode = Form.useWatch("automatic_funding_source", form);
  useEffect(() => {
    if (
      !useDefaults ||
      !instrumentId ||
      !holdingId ||
      form.isFieldTouched("automatic_fee_mode")
    )
      return;
    let live = true;
    api(
      `/spaces/${space.id}/fund-orders/defaults?${new URLSearchParams({ instrument_id: instrumentId, account_id: holdingId })}`,
    )
      .then((d) => {
        if (
          live &&
          d.version > 0 &&
          !form.isFieldsTouched([
            "automatic_fee_mode",
            "account_id",
            "automatic_funding_source",
          ])
        ) {
          form.setFieldsValue({
            account_id: d.cash_account_id || holdingId,
            automatic_funding_source: d.funding_source,
            automatic_fee_mode: d.fee_mode,
            automatic_fee_amount: d.fee_value,
          });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [instrumentId, holdingId, space.id, useDefaults]);
  useEffect(() => {
    if (!enabled) return;
    const selected = accounts.find((account) => account.id === holdingId);
    if (!holdingId || (selected && !eligibleDcaHolding(selected, currency))) {
      const funding = accounts.find((account) => account.id === fundingId);
      const next =
        funding && eligibleDcaHolding(funding, currency)
          ? funding.id
          : undefined;
      if (holdingId !== next) form.setFieldValue("target_account_id", next);
    }
  }, [enabled, fundingId, holdingId, currency, accounts, form]);
  return (
    <div className="dca-automation-fields">
      <Form.Item
        name="automatic_enabled"
        label={<HelpText text="按计划自动补录" />}
        tooltip="当前支持按正式单位净值申购的场外基金；场内 ETF、股票、期货期权和货币基金请记录实际成交。"
        valuePropName="checked"
        style={{ marginBottom: 8 }}
      >
        <Switch checkedChildren="开启" unCheckedChildren="关闭" />
      </Form.Item>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        {dcaAutomationNotice}
      </p>
      <div hidden={!enabled}>
        <Form.Item name="automatic_funding_source" label="自动补录的资金来源">
          <Select
            options={[
              { value: "account", label: "按上方资金账户扣款" },
              { value: "untracked", label: "账外资金（不扣本账簿账户）" },
            ]}
            onChange={(value) => {
              if (value === "untracked" && holdingId)
                form.setFieldValue("account_id", holdingId);
            }}
          />
        </Form.Item>
        {fundingMode === "untracked" && (
          <p className="muted">
            资金账户与持仓账户应选同一机构；每期记为账外追加本金，不扣减其现金。
          </p>
        )}
        <Fields
          fields={[
            {
              name: "target_account_id",
              label: "持仓账户",
              type: "select",
              required: enabled,
              options: accounts
                .filter((account) => eligibleDcaHolding(account, currency))
                .map((account) => ({
                  value: account.id,
                  label: account.name + " · " + account.currency,
                })),
              referenceKinds: dcaHoldingKinds,
              referenceCurrency: currency,
              help: "份额记入这个基金或券商账户。上方资金账户用于记录扣款；两者可以不同。",
              span: 2,
            },
          ]}
        />
        <Collapse
          ghost
          items={[
            {
              key: "settings",
              forceRender: true,
              label: `补录设置 · ${start || "请选择生效日期"}起 · ${feeMode === "unknown" || !feeMode ? "费用待设置" : feeMode === "zero" ? "已确认零费用" : feeMode === "rate" ? "按申购费率" : "每期固定费用"}`,
              children: (
                <>
                  <div className="form-grid">
                    <Form.Item
                      name="automatic_start_date"
                      label={<HelpText text="自动补录生效日期" />}
                      rules={
                        enabled
                          ? [{ required: true, message: "请选择生效日期" }]
                          : []
                      }
                    >
                      <Input type="date" min={planStart} />
                    </Form.Item>
                    <Form.Item name="automatic_fee_mode" label="费用规则">
                      <Select
                        options={[
                          { value: "unknown", label: "暂不确定" },
                          { value: "zero", label: "已确认零费用" },
                          { value: "fixed", label: "每期固定费用" },
                          { value: "rate", label: "申购费率（%）" },
                        ]}
                      />
                    </Form.Item>
                    {["fixed", "rate"].includes(feeMode) && (
                      <Form.Item
                        name="automatic_fee_amount"
                        label={
                          feeMode === "rate"
                            ? "折扣后申购费率（%）"
                            : `每期手续费（${currency}）`
                        }
                        rules={
                          enabled
                            ? [{ required: true, message: "请填写每期手续费" }]
                            : []
                        }
                      >
                        <InputNumber
                          stringMode
                          style={{ width: "100%" }}
                          placeholder="从每期计划金额中扣除"
                        />
                      </Form.Item>
                    )}
                  </div>
                  <p className="muted" style={{ fontSize: 12 }}>
                    {feeMode === "unknown" || !feeMode
                      ? "费用未知时先补记扣款，份额等待费用设置；不会按零费用计算。"
                      : "份额按每期计划金额扣除费用后除以正式净值推算。"}
                    {start && start < dateToday()
                      ? "已选择过去日期，将检查并补录该日起的到期计划。"
                      : "生效日期之前的历史不会自动补录。"}
                  </p>
                  <Form.Item
                    name="automatic_excluded_dates"
                    label="排除日期"
                    extra="失败或不想补录的计划日期，每行一个。已有扣款的期次会提示核对，不会自动撤销。"
                  >
                    <Input.TextArea
                      rows={2}
                      placeholder={"2026-10-08\n2026-10-15"}
                    />
                  </Form.Item>
                  <Form.List name="automatic_pause_ranges">
                    {(ranges, { add, remove }) => (
                      <>
                        {ranges.map((range) => (
                          <Space key={range.key} align="baseline" wrap>
                            <Form.Item
                              name={[range.name, "start"]}
                              label="暂停开始日"
                            >
                              <Input type="date" />
                            </Form.Item>
                            <Form.Item
                              name={[range.name, "end"]}
                              label="暂停结束日"
                            >
                              <Input type="date" />
                            </Form.Item>
                            <Button
                              type="text"
                              icon={<Minus size={14} />}
                              aria-label="移除暂停区间"
                              onClick={() => remove(range.name)}
                            />
                          </Space>
                        ))}
                        <Button
                          type="link"
                          size="small"
                          icon={<Plus size={14} />}
                          onClick={() => add({})}
                          disabled={ranges.length >= 100}
                        >
                          添加暂停区间
                        </Button>
                      </>
                    )}
                  </Form.List>
                </>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
