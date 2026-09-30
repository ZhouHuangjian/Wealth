import { helpColumns } from "../help";
import { NavigationTabs } from "../navigation";
import { useState } from "react";
import { Alert, App, Button, Modal, Space, Table, Tabs } from "antd";
import { EntityManager, LoadState, PageTitle, Status } from "../components";
import { api, listOf } from "../api";
import type { Item } from "../api";
import { useResource, useWorkspace } from "../state";
export default function Notebook() {
  const { hidden } = useWorkspace();
  const instruments = useResource("instruments"),
    events = useResource("events"),
    goals = useResource("goals");
  const [tab, setTab] = useState("all");
  const [selected, setSelected] = useState<Item | null>(null);
  return (
    <>
      <PageTitle eyebrow="NOTES & REFLECTION" title="投资手札" />
      <NavigationTabs
        group="notebook"
        routeParam="tab"
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "all", label: "全部手札" },
          { key: "pre_trade", label: "交易前计划" },
          { key: "review", label: "交易后复盘" },
          { key: "journal", label: "心得与假设" },
        ]}
      />
      <EntityManager
        resource="notes"
        title="手札"
        extraActions={(r) => (
          <Button type="link" size="small" onClick={() => setSelected(r)}>
            版本 / 附件
          </Button>
        )}
        kindFilter={tab === "all" ? undefined : tab}
        fields={[
          {
            name: "title",
            label: "标题",
            required: true,
            span: 2,
            placeholder: "这次记录关注什么？",
          },
          {
            name: "kind",
            label: "记录模板",
            type: "select",
            required: true,
            initial: "journal",
            options: [
              { label: "交易前计划", value: "pre_trade" },
              { label: "交易后复盘", value: "review" },
              { label: "心得 / 假设", value: "journal" },
            ],
          },
          {
            name: "status",
            label: "状态",
            type: "select",
            required: true,
            initial: "draft",
            options: [
              { label: "草稿", value: "draft" },
              { label: "发布", value: "published" },
              { label: "归档", value: "archived" },
            ],
          },
          {
            name: "instrument_id",
            label: "关联资产",
            type: "select",
            options: listOf<Item>(instruments.data).map((i) => ({
              label: `${i.name} · ${i.code}`,
              value: i.id,
            })),
          },
          {
            name: "event_id",
            label: "关联真实事项",
            type: "select",
            options: listOf<Item>(events.data).map((e) => ({
              label: `${e.economic_date} · ${e.description || e.id.slice(0, 8)}`,
              value: e.id,
            })),
          },
          {
            name: "goal_id",
            label: "关联目标",
            type: "select",
            options: listOf<Item>(goals.data).map((g) => ({
              label: g.name,
              value: g.id,
            })),
          },
          {
            name: "tags",
            label: "标签",
            placeholder: "使用逗号分隔，如红利、长期、待验证",
          },
          {
            name: "body",
            label: "原始判断与记录",
            type: "textarea",
            required: true,
            span: 2,
            placeholder:
              "依据是什么？什么情况使判断失效？资金和风险安排是什么？\n复盘时记录实际发生的事情、反例，以及下一次需要验证的问题。",
          },
        ]}
        columns={[
          {
            title: "标题",
            dataIndex: "title",
            render: (v, r) => (
              <div className="cell-name">
                <strong>{v}</strong>
                <small>
                  {hidden
                    ? "内容已隐藏"
                    : Array.isArray(r.tags)
                      ? r.tags.join(" · ")
                      : r.tags}
                </small>
              </div>
            ),
          },
          {
            title: "类型",
            dataIndex: "kind",
            render: (v) =>
              ({
                pre_trade: "交易前计划",
                review: "交易后复盘",
                journal: "心得 / 假设",
              })[v as string] || v,
          },
          {
            title: "状态",
            dataIndex: "status",
            render: (v) => <Status value={v} />,
          },
          { title: "修订", dataIndex: "version", render: (v) => `v${v || 1}` },
          {
            title: "创建时间",
            dataIndex: "created_at",
            render: (v) => v?.slice(0, 16).replace("T", " "),
          },
        ]}
      >
        <Alert
          type="info"
          showIcon
          message="手札共享范围与当前空间一致。个人内容请保存在私人空间。"
        />
      </EntityManager>
      {selected && (
        <NoteEvidence note={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function NoteEvidence({ note, onClose }: { note: Item; onClose: () => void }) {
  const { space, hidden, reload } = useWorkspace();
  const { message } = App.useApp();
  const versions = useResource(`notes/${note.id}/versions`),
    attachments = useResource(`notes/${note.id}/attachments`);
  const [uploading, setUploading] = useState(false);
  return (
    <Modal title={note.title} open onCancel={onClose} footer={null} width={760}>
      {hidden ? (
        <Alert showIcon message="金额遮挡开启，笔记与附件内容暂不展示。" />
      ) : (
        <>
          <p className="muted">
            原始记录与每次修订均保留；关联事项不会因清仓而删除。
          </p>
          <NavigationTabs
            group="notebook.details"
            routeParam={false}
            items={[
              {
                key: "versions",
                label: "历史版本",
                children: (
                  <LoadState {...versions}>
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={false}
                      dataSource={listOf<Item>(versions.data)}
                      columns={helpColumns<Item>([
                        { title: "版本", dataIndex: "version", width: 70 },
                        {
                          title: "记录时间",
                          dataIndex: "created_at",
                          width: 150,
                          render: (v) => v?.slice(0, 19).replace("T", " "),
                        },
                        {
                          title: "当时内容",
                          render: (_, r) => (
                            <div className="note-version">
                              <strong>{r.data?.title || r.title}</strong>
                              <p>{r.data?.body || r.body}</p>
                            </div>
                          ),
                        },
                      ])}
                    />
                  </LoadState>
                ),
              },
              {
                key: "attachments",
                label: "图片凭证",
                children: (
                  <>
                    <Alert
                      className="form-alert"
                      type="info"
                      showIcon
                      message="支持 JPG、PNG、WebP 图片，单个不超过 5 MB；附件共享范围与笔记一致。"
                    />
                    {space.role !== "viewer" && (
                      <label className="file-drop">
                        <strong>
                          {uploading ? "正在保存图片…" : "选择图片附件"}
                        </strong>
                        <input
                          aria-label="上传笔记图片"
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          disabled={uploading}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            setUploading(true);
                            try {
                              const body = new FormData();
                              body.append("file", file);
                              await api(
                                `/spaces/${space.id}/notes/${note.id}/attachments`,
                                { method: "POST", body },
                              );
                              message.success("附件已保存");
                              attachments.retry();
                              reload();
                            } catch (err) {
                              message.error((err as Error).message);
                            } finally {
                              setUploading(false);
                            }
                          }}
                        />
                      </label>
                    )}
                    <LoadState {...attachments}>
                      <div className="note-attachments">
                        {listOf<Item>(attachments.data).map((a) => (
                          <a
                            key={a.id}
                            href={`/api/v1/spaces/${space.id}/notes/${note.id}/attachments/${a.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <img
                              src={`/api/v1/spaces/${space.id}/notes/${note.id}/attachments/${a.id}`}
                              alt={a.filename || "笔记附件"}
                              loading="lazy"
                            />
                            <span>{a.filename}</span>
                          </a>
                        ))}
                      </div>
                      {listOf<Item>(attachments.data).length === 0 && (
                        <p className="muted">此笔记尚无图片附件。</p>
                      )}
                    </LoadState>
                  </>
                ),
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
