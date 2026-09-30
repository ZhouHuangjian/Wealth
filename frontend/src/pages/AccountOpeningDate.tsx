import { Alert, Form, Input } from "antd";
import { api } from "../api";
import type { Item } from "../api";
import { Money } from "../components";
import { accountOpeningRequest } from "../account-maintenance";
import { HelpText } from "../help";

/** Read the actual financial opening before allowing a combined account edit. */
export async function loadAccountForEdit(spaceId: string, account: Item) {
  const current = await api<Item>(`/spaces/${spaceId}/accounts/${account.id}`);
  const opening = await api<Record<string, any>>(
    `/spaces/${spaceId}/accounts/${account.id}/opening-date`,
  );
  if (String(current.version) !== String(opening.version))
    throw new Error("账户刚刚发生变化，请重新读取后编辑");
  return {
    ...current,
    opening_date: opening.opening_date || undefined,
    reason: "",
    _opening: opening,
  };
}

export function prepareAccountEdit(values: Record<string, any>, account: Item) {
  const { opening_date, reason, ...profile } = values;
  const metadata = account._opening;
  if (!metadata || metadata.version == null || metadata.data_revision == null)
    throw new Error("期初记录未读取完整，请关闭后重新编辑账户");
  if (opening_date === (metadata.opening_date || undefined)) return profile;
  return {
    ...profile,
    ...accountOpeningRequest(metadata, { opening_date, reason }),
  };
}

/** A financial date field inside the ordinary account edit form. */
export default function AccountOpeningDate({ account }: { account: Item }) {
  const metadata = account._opening;
  const current = Form.useWatch("opening_date");
  const changed = metadata?.editable && current !== metadata.opening_date;
  return (
    <>
      <div className="form-grid">
        <Form.Item
          name="opening_date"
          label={<HelpText text="期初日期" />}
          rules={
            metadata?.editable
              ? [{ required: true, message: "请选择期初日期" }]
              : []
          }
          extra={
            metadata?.editable
              ? `最晚可改至 ${metadata.max_date}${metadata.min_date ? `，最早为 ${metadata.min_date}` : ""}；已有资金、持仓或权益记录会限制可选日期。`
              : metadata?.reason || "没有可更正的账户期初记录"
          }
        >
          <Input
            type="date"
            disabled={!metadata?.editable}
            min={metadata?.min_date || undefined}
            max={metadata?.max_date || undefined}
          />
        </Form.Item>
        <Form.Item
          label={metadata?.kind === "snapshot" ? "原期初权益" : "原期初金额"}
        >
          {metadata?.available ? (
            <Money
              value={metadata.amount}
              currency={metadata.currency || account.currency}
            />
          ) : (
            "未录入账户期初"
          )}
        </Form.Item>
      </div>
      {changed && (
        <>
          <Alert
            className="form-alert"
            type="info"
            showIcon
            message="保存时同步调整期初金额的生效日期并重新计算资产，金额保持不变，原记录和修改原因会保留。"
          />
          <Form.Item
            name="reason"
            label="期初日期修改原因"
            preserve={false}
            rules={[
              {
                required: true,
                whitespace: true,
                message: "请简要说明修改原因",
              },
            ]}
          >
            <Input.TextArea
              rows={2}
              maxLength={500}
              placeholder="例如：开户时将金额对应日期填错"
            />
          </Form.Item>
        </>
      )}
    </>
  );
}
