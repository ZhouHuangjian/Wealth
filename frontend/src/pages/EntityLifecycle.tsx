import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Modal,
  Spin,
  Table,
} from "antd";
import { api, ApiError, accountKinds, listOf, send } from "../api";
import type { Item } from "../api";
import { Money, LoadState } from "../components";
import { investmentKinds } from "../investment";
import {
  lifecycleBlockerText as blockerText,
  lifecycleRequest,
} from "../account-maintenance";
import { useResource, useWorkspace } from "../state";

type Resource = "accounts" | "instruments";
const label = (resource: Resource) =>
  resource === "accounts" ? "账户" : "投资产品";

export function EntityDeleteDialog({
  resource,
  item,
  onClose,
}: {
  resource: Resource;
  item: Item;
  onClose: () => void;
}) {
  const { space, reload, hidden, requestReveal } = useWorkspace();
  const { message } = App.useApp();
  const [preview, setPreview] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const warnings = [
    ...new Set<string>(
      (preview?.impact?.warnings || [])
        .map((warning: any) =>
          typeof warning === "string" ? warning : warning.message,
        )
        .filter(
          (warning: any) =>
            typeof warning === "string" &&
            !(
              resource === "accounts" &&
              warning.startsWith("删除后各项资产统计将不再包含该账户")
            ),
        ),
    ),
  ];
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setPreview(null);
    void api(`/spaces/${space.id}/${resource}/${item.id}/deletion`)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [space.id, resource, item.id, attempt]);
  return (
    <Modal
      open
      width={580}
      title={`删除${label(resource)} · ${item.name}`}
      onCancel={() => !lock.current && onClose()}
      maskClosable={!busy}
      keyboard={!busy}
      closable={!busy}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            danger
            type="primary"
            loading={busy}
            disabled={
              hidden ||
              loading ||
              preview?.can_delete !== true ||
              preview?.deleted === true ||
              space.role === "viewer"
            }
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              setBusy(true);
              setError("");
              try {
                await send(
                  `/spaces/${space.id}/${resource}/${item.id}`,
                  lifecycleRequest(preview),
                  "DELETE",
                );
                message.success(`${label(resource)}已删除，可在“已删除”中恢复`);
                reload();
                onClose();
              } catch (e) {
                setError((e as Error).message);
                if (e instanceof ApiError && [409, 412].includes(e.status))
                  setPreview(e.fields.preview || null);
              } finally {
                lock.current = false;
                setBusy(false);
              }
            }}
          >
            确认删除
          </Button>
        </>
      }
    >
      {hidden ? (
        <Alert
          type="info"
          message="显示金额后可核对删除影响"
          action={
            <Button onClick={() => requestReveal(() => {})}>显示金额</Button>
          }
        />
      ) : loading ? (
        <Spin />
      ) : (
        <>
          {error && (
            <Alert
              type="error"
              showIcon
              message={error}
              action={
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  重新读取
                </Button>
              }
            />
          )}
          {preview && (
            <>
              <p>
                删除<strong>“{preview.object?.name || item.name}”</strong>
                后，将从列表和资产汇总中移除；可在“已删除”中恢复。
              </p>
              {(preview.blockers || []).length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message="暂不能删除"
                  description={
                    <div>
                      {preview.blockers.map((blocker: any, index: number) => (
                        <p key={index}>{blockerText(blocker)}</p>
                      ))}
                    </div>
                  }
                />
              ) : preview.deleted ? (
                <Alert type="info" message="该记录已删除，请从“已删除”中恢复" />
              ) : (
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    ...(resource === "accounts"
                      ? [
                          {
                            key: "removed",
                            label: "移除的账户计值",
                            children: (
                              <Money
                                value={preview.impact?.removed_value}
                                currency={
                                  preview.impact?.currency || item.currency
                                }
                              />
                            ),
                          },
                          {
                            key: "change",
                            label: "净资产变化",
                            children: (
                              <Money
                                value={preview.impact?.net_asset_change}
                                currency={
                                  preview.impact?.currency || item.currency
                                }
                                sign
                              />
                            ),
                          },
                        ]
                      : []),
                    ...(preview.impact?.valuation_date
                      ? [
                          {
                            key: "date",
                            label: "金额数据日期",
                            children: preview.impact.valuation_date,
                          },
                        ]
                      : []),
                  ]}
                />
              )}
              {warnings.length > 0 && (
                <div className="data-caption">
                  {warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                </div>
              )}
              {preview.deleted !== true &&
                preview.can_delete !== true &&
                !(preview.blockers || []).length && (
                  <Alert
                    type="warning"
                    message="当前记录不符合删除条件，请重新读取后核对"
                  />
                )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export function DeletedEntities({
  resource,
  onClose,
}: {
  resource: Resource;
  onClose: () => void;
}) {
  const { space, reload, hidden } = useWorkspace(),
    { message } = App.useApp();
  const state = useResource(resource, "?status=deleted&limit=200");
  const [restoring, setRestoring] = useState(""),
    [error, setError] = useState("");
  const lock = useRef(false);
  return (
    <Drawer
      open
      width={720}
      title={`已删除的${label(resource)}`}
      onClose={() => !lock.current && onClose()}
      closable={!restoring}
      maskClosable={!restoring}
    >
      {error && (
        <Alert
          type="error"
          showIcon
          message={hidden ? "恢复未完成，请显示内容后查看原因" : error}
        />
      )}
      <p className="data-caption">
        恢复后使用原期初金额及原记录，不会重新产生一笔收入或持仓。
      </p>
      <LoadState {...state}>
        <Table<Item>
          size="small"
          rowKey="id"
          dataSource={listOf<Item>(state.data)}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 520 }}
          columns={[
            { title: label(resource), dataIndex: "name" },
            {
              title: "类型",
              render: (_, row) =>
                (resource === "accounts" ? accountKinds : investmentKinds)[
                  row.kind
                ] || row.kind,
            },
            { title: "币种", dataIndex: "currency" },
            {
              title: "操作",
              width: 95,
              render: (_, row) =>
                space.role !== "viewer" && (
                  <Button
                    type="link"
                    loading={restoring === row.id}
                    disabled={!!restoring && restoring !== row.id}
                    onClick={async () => {
                      if (lock.current) return;
                      lock.current = true;
                      setRestoring(row.id);
                      setError("");
                      try {
                        const preview = await api(
                          `/spaces/${space.id}/${resource}/${row.id}/deletion`,
                        );
                        if (preview.can_restore !== true)
                          throw new Error(
                            (preview.restore_blockers || preview.blockers || [])
                              .map(blockerText)
                              .join("；") || "当前记录不能恢复",
                          );
                        const result = await send(
                          `/spaces/${space.id}/${resource}/${row.id}/restore`,
                          lifecycleRequest(preview, true),
                        );
                        message.success(
                          `${label(resource)}已恢复${result.item?.archived ? "，保留原归档状态" : ""}`,
                        );
                        reload();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        lock.current = false;
                        setRestoring("");
                      }
                    }}
                  >
                    恢复
                  </Button>
                ),
            },
          ]}
        />
      </LoadState>
    </Drawer>
  );
}
