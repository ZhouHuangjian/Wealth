import { useEffect, useState } from "react";
import {
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tooltip,
} from "antd";
import { Info, Minus, Plus, Repeat2 } from "lucide-react";
import type { Item } from "../api";
import { api, dateToday } from "../api";
import { useWorkspace } from "../state";
import { HelpText } from "../help";
import {
  dcaAutomationNotice,
  eligibleDcaHolding,
  eligibleDcaInstrument,
} from "../dca-automation";

export default function DcaAutomationFields({
  accounts,
  instruments,
  useDefaults = true,
}: {
  accounts: Item[];
  instruments: Item[];
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
  const knownInstrument = instruments.find((item) => item.id === instrumentId);
  const [resolvedInstrument, setResolvedInstrument] = useState<Item | null>(
    null,
  );
  const selectedInstrument =
    knownInstrument ||
    (resolvedInstrument?.id === instrumentId ? resolvedInstrument : undefined);
  useEffect(() => {
    if (!instrumentId || knownInstrument) return;
    let live = true;
    api<Item>(`/spaces/${space.id}/instruments/${instrumentId}`)
      .then((item) => {
        if (live) setResolvedInstrument(item);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [instrumentId, knownInstrument, space.id]);
  const supported =
    !selectedInstrument || eligibleDcaInstrument(selectedInstrument);
  useEffect(() => {
    if (!useDefaults || !selectedInstrument) return;
    const next = eligibleDcaInstrument(selectedInstrument);
    if (
      !form.isFieldTouched("automatic_enabled") &&
      form.getFieldValue("automatic_enabled") !== next
    )
      form.setFieldValue("automatic_enabled", next);
    else if (!next && form.getFieldValue("automatic_enabled") === true)
      form.setFieldValue("automatic_enabled", false);
  }, [selectedInstrument, useDefaults, form]);
  useEffect(() => {
    if (
      useDefaults &&
      planStart &&
      !form.isFieldTouched("automatic_start_date")
    )
      form.setFieldValue("automatic_start_date", planStart);
  }, [planStart, useDefaults, form]);
  useEffect(() => {
    if (
      enabled &&
      holdingId &&
      ((fundingMode === "untracked" && fundingId !== holdingId) || !fundingId)
    )
      form.setFieldValue("account_id", holdingId);
  }, [enabled, fundingMode, holdingId, fundingId, form]);
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
          const defaults = {
            account_id: d.cash_account_id || holdingId,
            automatic_funding_source: d.funding_source,
            automatic_fee_mode: d.fee_mode,
            automatic_fee_amount: d.fee_value,
          };
          for (const [name, value] of Object.entries(defaults))
            form.setFieldValue(name, value);
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
      const eligible = accounts.filter((account) =>
        eligibleDcaHolding(account, currency),
      );
      const next =
        funding && eligibleDcaHolding(funding, currency)
          ? funding.id
          : eligible.length === 1
            ? eligible[0].id
            : undefined;
      if (holdingId !== next) form.setFieldValue("target_account_id", next);
    }
  }, [enabled, fundingId, holdingId, currency, accounts, form]);
  return (
    <div className="dca-automation-fields">
      <div className="dca-automation-heading">
        <Repeat2 size={17} aria-hidden="true" />
        <div>
          <strong>自动记账</strong>
          <small>
            {enabled
              ? "按计划记入扣款，正式净值公布后自动计算份额"
              : supported
                ? "关闭后仅保留计划提醒"
                : "此产品按实际成交记账"}
          </small>
        </div>
        <Tooltip title={dcaAutomationNotice}>
          <button
            className="holdings-info"
            type="button"
            aria-label="自动记账说明"
          >
            <Info size={15} />
          </button>
        </Tooltip>
        <Form.Item
          name="automatic_enabled"
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch
            aria-label="按计划自动记账"
            disabled={!supported}
            checkedChildren="开启"
            unCheckedChildren="关闭"
          />
        </Form.Item>
      </div>
      <div hidden={!enabled}>
        <div className="form-grid dca-account-fields">
          <Form.Item
            name="target_account_id"
            label="持仓账户"
            rules={
              enabled ? [{ required: true, message: "请选择持仓账户" }] : []
            }
            tooltip="定投份额记入此基金或券商账户。"
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择持仓账户"
              options={accounts
                .filter((account) => eligibleDcaHolding(account, currency))
                .map((account) => ({
                  value: account.id,
                  label: account.name + " · " + account.currency,
                }))}
            />
          </Form.Item>
          <Form.Item name="automatic_funding_source" label="资金来源">
            <Select
              options={[
                { value: "account", label: "从账簿内账户扣款" },
                { value: "untracked", label: "账外资金（不扣本账簿账户）" },
              ]}
              onChange={(value) => {
                if (value === "untracked" && holdingId)
                  form.setFieldValue("account_id", holdingId);
              }}
            />
          </Form.Item>
        </div>
      </div>
      {!enabled || fundingMode !== "untracked" ? (
        <Form.Item
          name="account_id"
          label={enabled ? "扣款账户" : "计划关联账户"}
          rules={[{ required: true, message: "请选择账户" }]}
          tooltip={
            enabled
              ? "每期从此账户的可用资金中记账扣除，可与持仓账户相同。"
              : "该计划关联的资金或投资账户。"
          }
        >
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="选择账户"
            options={accounts
              .filter(
                (account) =>
                  !account.archived &&
                  !account.deleted_at &&
                  account.currency === currency &&
                  (!enabled ||
                    (account.valuation_mode !== "snapshot" &&
                      [
                        "bank",
                        "cash",
                        "wallet",
                        "fund",
                        "broker",
                        "securities",
                      ].includes(account.kind))),
              )
              .map((account) => ({
                value: account.id,
                label: account.name + " · " + account.currency,
              }))}
          />
        </Form.Item>
      ) : (
        <Form.Item name="account_id" hidden>
          <Input />
        </Form.Item>
      )}
      <div hidden={!enabled}>
        <div className="form-grid">
          <Form.Item
            name="automatic_fee_mode"
            label="申购费用"
            tooltip="只需设置一次，之后每期使用同一规则计算。费用未知时可先记扣款。"
          >
            <Select
              options={[
                { value: "unknown", label: "暂不确定 · 稍后设置一次" },
                { value: "zero", label: "确认无申购费" },
                { value: "rate", label: "按折扣后费率" },
                { value: "fixed", label: "每期固定费用" },
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
                enabled ? [{ required: true, message: "请填写申购费用" }] : []
              }
            >
              <InputNumber
                stringMode
                min="0"
                style={{ width: "100%" }}
                placeholder={
                  feeMode === "rate" ? "例如 0.12" : "从每期金额中扣除"
                }
              />
            </Form.Item>
          )}
        </div>
        {(feeMode === "unknown" || !feeMode) && (
          <p className="dca-setting-note">
            费用规则补全后，份额会自动计算，无需逐期确认。
          </p>
        )}
        <Collapse
          ghost
          items={[
            {
              key: "settings",
              forceRender: true,
              label: `生效日 ${start || "待选择"} · 排除日期与暂停`,
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
                  </div>
                  <p className="muted" style={{ fontSize: 12 }}>
                    {start && start < dateToday()
                      ? `包含 ${start} 起已到期的计划；按基金可申购日自动处理。`
                      : "按基金可申购日自动处理；生效日期之前不补记。"}
                  </p>
                  <Form.Item
                    name="automatic_excluded_dates"
                    label="排除日期"
                    extra="扣款失败或不想补录的计划日期，每行一个。已记账的期次需单独撤销。"
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
