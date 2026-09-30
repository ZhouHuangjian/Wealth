import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import type { FormInstance } from "antd";
import { api, dateToday } from "../api";
import {
  productIdentityKey,
  specificationForIdentity,
  resolutionInput,
  resolutionStillCurrent,
} from "../product-metadata";
import { investmentKinds, catalogMarket } from "../investment";
import { useDebounced, useWorkspace } from "../state";
const calendarOptions = [
  { value: "CN_EXCHANGE", label: "境内证券 / 基金交易日" },
  { value: "CN_FUTURES", label: "境内期货交易日" },
  { value: "HKEX", label: "香港交易日" },
  { value: "US_EQUITIES", label: "美国证券交易日" },
];
export default function ProductIdentity({
  form,
  disabled = false,
  onPendingChange,
}: {
  form: FormInstance;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { space } = useWorkspace();
  const code = Form.useWatch("code", form),
    name = Form.useWatch("name", form),
    kind = Form.useWatch("kind", form),
    market = Form.useWatch("market", form),
    currency = Form.useWatch("currency", form);
  const subscriptionCalendar = Form.useWatch("subscription_calendar", {
    form,
    preserve: true,
  });
  const manual = Form.useWatch("identity_manual", { form, preserve: true });
  const noForecast = Form.useWatch("confirmation_no_forecast", {
    form,
    preserve: true,
  });
  const exchange = Form.useWatch("exchange_override", { form, preserve: true });
  const days = Form.useWatch("confirmation_days_override", {
      form,
      preserve: true,
    }),
    calendar = Form.useWatch("calendar_override", { form, preserve: true }),
    cutoff = Form.useWatch("cutoff_override", { form, preserve: true });
  const [resolved, setResolved] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dateBusy, setDateBusy] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [applicationDate, setApplicationDate] = useState(dateToday()),
    [applicationTime, setApplicationTime] = useState("14:00");
  const input = resolutionInput({
    code,
    name,
    kind,
    market,
    currency,
    identity_manual: manual,
    confirmation_days_override: days,
    calendar_override: calendar,
    cutoff_override: cutoff,
    exchange_override: exchange,
    confirmation_no_forecast: noForecast,
    subscription_calendar: subscriptionCalendar,
  });
  const settled = useDebounced(input, 500);
  const sequence = useRef(0),
    previewSequence = useRef(0);
  const previousIdentity = useRef<string | undefined>(undefined);
  useEffect(() => {
    sequence.current++;
    previewSequence.current++;
    setResolved(null);
    setPreview(null);
    setDateBusy(false);
    setBusy(!!String(code || "").trim());
    const current = {
      code: form.getFieldValue("code"),
      kind: form.getFieldValue("kind"),
    };
    const key = productIdentityKey(current);
    const specification = form.getFieldValue("specification") || {};
    const next = specificationForIdentity(
      specification,
      current,
      previousIdentity.current,
    );
    if (previousIdentity.current && previousIdentity.current !== key)
      form.setFieldValue("specification", next);
    previousIdentity.current = key;
  }, [input]);
  useEffect(() => {
    onPendingChange?.(busy);
  }, [busy, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  useEffect(() => {
    const token = ++sequence.current;
    const values = JSON.parse(settled);
    if (!resolutionStillCurrent(settled, form.getFieldsValue(true))) return;
    if (!String(values.code || "").trim()) {
      setResolved(null);
      setPreview(null);
      setError("");
      setBusy(false);
      return;
    }
    let active = true;
    setBusy(true);
    setError("");
    setPreview(null);
    const specification = specificationForIdentity(
      form.getFieldValue("specification") || {},
      values,
      previousIdentity.current,
    );
    const overrides: Record<string, any> = {
      ...specification.metadata_overrides,
    };
    if (values.manual === false)
      for (const key of ["kind", "market", "currency", "exchange"])
        delete overrides[key];
    if (values.manual)
      Object.assign(overrides, {
        kind: values.kind,
        market: catalogMarket(values.market || "CN"),
        currency: values.currency,
        ...(catalogMarket(values.market || "CN") !== values.market
          ? { exchange: values.market }
          : {}),
      });
    if (values.exchange) overrides.exchange = values.exchange;
    else if (!values.manual) delete overrides.exchange;
    if (values.noForecast) overrides.confirmation_days = null;
    else if (values.days != null && values.days !== "")
      overrides.confirmation_days = Number(values.days);
    else delete overrides.confirmation_days;
    if (values.calendar) overrides.calendar_id = values.calendar;
    else delete overrides.calendar_id;
    if (values.cutoff) overrides.cutoff_time = values.cutoff;
    else delete overrides.cutoff_time;
    specification.metadata_overrides = overrides;
    specification.subscription_calendar = values.subscriptionCalendar || "auto";
    api(`/spaces/${space.id}/market/resolve`, {
      method: "POST",
      body: JSON.stringify({
        code: values.code,
        name: values.name,
        kind: values.kind,
        ...(disabled
          ? {
              market: form.getFieldValue("market"),
              currency: form.getFieldValue("currency"),
            }
          : {}),
        specification,
        overrides,
      }),
    })
      .then((r) => {
        if (
          !active ||
          token !== sequence.current ||
          !resolutionStillCurrent(settled, form.getFieldsValue(true))
        )
          return;
        setResolved(r);
        if (!disabled && !["unknown", "ambiguous"].includes(r.status)) {
          const changes: Record<string, any> = {
            specification: {
              ...r.specification,
              metadata_identity: { code: r.code, kind: r.kind },
            },
          };
          for (const field of ["code", "kind", "market", "currency"] as const)
            if (r[field] && r[field] !== form.getFieldValue(field))
              changes[field] = r[field];
          if (changes.kind || changes.currency) changes.account_id = undefined;
          if (!form.getFieldValue("name") && r.name && r.name !== r.code)
            changes.name = r.name;
          previousIdentity.current = productIdentityKey({
            code: changes.code || form.getFieldValue("code"),
            kind: changes.kind || form.getFieldValue("kind"),
          });
          form.setFieldsValue(changes);
        }
      })
      .catch((e) => {
        if (
          active &&
          token === sequence.current &&
          resolutionStillCurrent(settled, form.getFieldsValue(true))
        )
          setError(e.message);
      })
      .finally(() => {
        if (
          active &&
          token === sequence.current &&
          resolutionStillCurrent(settled, form.getFieldsValue(true))
        )
          setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [settled, space.id, disabled]);
  async function calculate() {
    const token = ++previewSequence.current;
    const snapshot = resolutionInput(form.getFieldsValue(true));
    setDateBusy(true);
    setError("");
    try {
      const instrument = {
        code: form.getFieldValue("code"),
        name: form.getFieldValue("name"),
        kind: form.getFieldValue("kind"),
        market: form.getFieldValue("market"),
        currency: form.getFieldValue("currency"),
        specification:
          resolved?.specification || form.getFieldValue("specification") || {},
      };
      const result = await api(`/spaces/${space.id}/market/trade-dates`, {
        method: "POST",
        body: JSON.stringify({
          instrument,
          ...(applicationTime
            ? { application_at: `${applicationDate}T${applicationTime}:00` }
            : { application_date: applicationDate }),
        }),
      });
      if (
        token === previewSequence.current &&
        resolutionStillCurrent(snapshot, form.getFieldsValue(true))
      )
        setPreview(result);
    } catch (e) {
      if (token === previewSequence.current) setError((e as Error).message);
    } finally {
      if (token === previewSequence.current) setDateBusy(false);
    }
  }
  if (!code) return null;
  return (
    <section className="identity-preview">
      <div className="identity-facts">
        <strong>产品识别</strong>
        {busy && <Spin size="small" />}
        {resolved && (
          <>
            <Tag>
              {resolved.status === "manual"
                ? "手工覆盖"
                : resolved.status === "identified"
                  ? "已识别"
                  : resolved.status === "inferred"
                    ? "按代码推断"
                    : "待核对"}
            </Tag>
            <span>
              {investmentKinds[resolved.kind] || resolved.kind} ·{" "}
              {resolved.market || "待识别市场"} ·{" "}
              {resolved.exchange || "待核对交易所"} ·{" "}
              {resolved.currency || "待核对币种"}
            </span>
          </>
        )}
      </div>
      {error && (
        <Alert type="warning" showIcon message={error} className="form-alert" />
      )}
      {resolved && (
        <>
          <p className="data-caption">
            {resolved.calendar?.id} · 已核实日历：
            {(resolved.calendar?.coverage_years || []).join("、") || "暂无覆盖"}
          </p>
          {resolved.warnings?.length > 0 && (
            <Alert
              type="info"
              className="form-alert"
              message={resolved.warnings.join("；")}
            />
          )}
        </>
      )}
      {!disabled && (
        <Form.Item name="identity_manual" valuePropName="checked">
          <Checkbox>使用手工选择的产品类型、市场与币种</Checkbox>
        </Form.Item>
      )}
      {!disabled && manual && (
        <Form.Item name="exchange_override" label="人工交易所（选填）">
          <Input placeholder="例如 SSE、SZSE、DCE、HKEX、NASDAQ" />
        </Form.Item>
      )}
      {["fund", "etf"].includes(kind) && (
        <>
          <div className="identity-facts">
            <strong>确认规则</strong>
            <Tag>
              {resolved?.settlement_rule?.status === "manual"
                ? "手工规则"
                : "建议 / 估计"}
            </Tag>
            <span>{resolved?.settlement_rule?.label || "待识别"}</span>
          </div>
          <p className="data-caption">
            确认天数按交易日计算，以基金公告和机构确认为准；下面只预览日期，不生成买卖或资金记录。
          </p>
          {kind === "fund" && (
            <Form.Item
              name="subscription_calendar"
              label="申购开放日"
              extra={
                resolved?.subscription_rule?.label
                  ? `${resolved.subscription_rule.label} · 休市日自动跳过定投计划与历史估算，临时暂停仍可手动排除。`
                  : undefined
              }
            >
              <Select
                disabled={disabled}
                placeholder="自动识别"
                options={[
                  { value: "auto", label: "自动识别" },
                  { value: "domestic", label: "仅按境内基金交易日" },
                  { value: "cn_us", label: "境内与美国同时开放" },
                  { value: "cn_hk", label: "境内与香港同时开放" },
                ]}
              />
            </Form.Item>
          )}
          {!disabled && (
            <Form.Item name="confirmation_no_forecast" valuePropName="checked">
              <Checkbox>不自动估计确认日期</Checkbox>
            </Form.Item>
          )}
          {!disabled && (
            <div className="form-grid">
              <Form.Item
                name="confirmation_days_override"
                label="人工确认天数（选填）"
              >
                <InputNumber
                  min={0}
                  max={30}
                  disabled={!!noForecast}
                  precision={0}
                  placeholder="使用识别建议"
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item name="calendar_override" label="确认日历（选填）">
                <Select
                  allowClear
                  placeholder="使用识别日历"
                  options={calendarOptions}
                />
              </Form.Item>
              <Form.Item name="cutoff_override" label="申请截止时间（选填）">
                <Input type="time" />
              </Form.Item>
            </div>
          )}
          <Space wrap>
            <Input
              type="date"
              aria-label="基金申请日期"
              value={applicationDate}
              onChange={(e) => {
                previewSequence.current++;
                setDateBusy(false);
                setApplicationDate(e.target.value);
                setPreview(null);
              }}
            />
            <Input
              type="time"
              aria-label="基金申请时间"
              value={applicationTime}
              onChange={(e) => {
                previewSequence.current++;
                setDateBusy(false);
                setApplicationTime(e.target.value);
                setPreview(null);
              }}
            />
            <Button
              loading={dateBusy}
              disabled={!applicationDate || busy || !resolved}
              onClick={calculate}
            >
              预览交易日与确认日
            </Button>
          </Space>
          {resolved?.calendar?.timezone && (
            <small className="data-caption">
              申请时间按 {resolved.calendar.timezone} 解释
            </small>
          )}
          {preview && (
            <>
              <div className="trade-date-result">
                <div>
                  <small>归属交易日</small>
                  <strong>{preview.trade_date || "暂不可估计"}</strong>
                </div>
                <div>
                  <small>预计确认日</small>
                  <strong>
                    {preview.expected_confirmation_date ||
                      "不适用 / 暂不可估计"}
                  </strong>
                </div>
              </div>
              {preview.warnings?.length > 0 && (
                <Alert
                  className="form-alert"
                  type={preview.status === "unavailable" ? "warning" : "info"}
                  message={preview.warnings.join("；")}
                />
              )}
            </>
          )}
        </>
      )}
      {resolved?.sources?.length > 0 && (
        <details className="identity-sources">
          <summary>识别与规则依据</summary>
          <ul>
            {resolved.sources.map((source: any, i: number) => (
              <li key={i}>
                {typeof source === "string" && source.startsWith("https://") ? (
                  <a href={source} target="_blank" rel="noreferrer">
                    {source}
                  </a>
                ) : typeof source === "string" ? (
                  source
                ) : (
                  JSON.stringify(source)
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
