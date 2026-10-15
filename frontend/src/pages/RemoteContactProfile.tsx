import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { Plus, RefreshCw } from "lucide-react";
import {
  commandPending,
  remoteCommandStates,
  supportsRemoteCommand,
} from "../chat-remote-model";
import type {
  RemoteBasisFact,
  RemoteCommand,
  RemoteConversation,
  RemoteMemoryEntry,
  RemoteProfile,
  RemoteSnapshot,
} from "../chat-remote-model";

type Queue = (
  type: RemoteCommand["type"],
  payload: Record<string, unknown>,
) => Promise<RemoteCommand | null>;
const categories = [
  { value: "current_status", label: "目前状况" },
  { value: "interest", label: "爱好" },
  { value: "preference", label: "偏好" },
  { value: "fact", label: "基础信息" },
  { value: "boundary", label: "沟通边界" },
  { value: "plan", label: "计划" },
];
const kinds = [
  { value: "fact", label: "信息" },
  { value: "event", label: "事件" },
  { value: "preference", label: "偏好" },
  { value: "openTopic", label: "待续话题" },
];
const statusLabels = {
  pending: "待确认",
  approved: "已确认",
  rejected: "已忽略",
};

export default function RemoteContactProfile({
  conversation,
  snapshot,
  commands,
  disabled,
  busy,
  queue,
  onClose,
}: {
  conversation: RemoteConversation;
  snapshot: RemoteSnapshot;
  commands: RemoteCommand[];
  disabled: boolean;
  busy: boolean;
  queue: Queue;
  onClose: () => void;
}) {
  const { modal } = App.useApp();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [profile, setProfile] = useState<RemoteProfile | null>(null);
  const [mutationId, setMutationId] = useState<string | null>(null);
  const [basisEditor, setBasisEditor] = useState<
    RemoteBasisFact | "new" | null
  >(null);
  const [entryEditor, setEntryEditor] = useState<
    RemoteMemoryEntry | "new" | null
  >(null);
  const [editingSummary, setEditingSummary] = useState(false);
  const [basisForm] = Form.useForm();
  const [entryForm] = Form.useForm();
  const [summaryForm] = Form.useForm();
  const initialRequested = useRef(false);
  const refreshQueued = useRef<string | null>(null);
  const appliedRead = useRef<string | null>(null);
  const read = async () => {
    const command = await queue("conversation.profile.get", {
      id: conversation.id,
    });
    if (command) setRequestId(command.id);
    return command;
  };
  useEffect(() => {
    if (!initialRequested.current && !busy && !disabled) {
      initialRequested.current = true;
      void read();
    }
  });
  const request = commands.find((c) => c.id === requestId);
  const mutation = commands.find((c) => c.id === mutationId);
  useEffect(() => {
    if (
      request?.status === "succeeded" &&
      request.result.profile?.id === conversation.id &&
      appliedRead.current !== request.id
    ) {
      appliedRead.current = request.id;
      setProfile(request.result.profile);
    }
  }, [request, conversation.id]);
  useEffect(() => {
    if (
      mutation?.status === "succeeded" &&
      refreshQueued.current !== mutation.id &&
      !busy &&
      !disabled
    ) {
      refreshQueued.current = mutation.id;
      if (mutation.result.profile?.id === conversation.id) {
        setProfile(mutation.result.profile);
        setMutationId(null);
        return;
      }
      void read().then((command) => {
        if (!command) refreshQueued.current = null;
      });
    }
  });
  const pending = !!mutation && commandPending(mutation);
  const reading = !!request && commandPending(request);
  const blocked = disabled || busy || pending || reading;
  const supports = (type: RemoteCommand["type"]) =>
    supportsRemoteCommand(snapshot, type);
  const mutate = async (
    type: RemoteCommand["type"],
    payload: Record<string, unknown>,
    includeRevision = true,
  ) => {
    if (includeRevision && !profile) return null;
    const command = await queue(type, {
      id: conversation.id,
      ...(includeRevision ? { expectedRevision: profile!.revision } : {}),
      ...payload,
    });
    if (command) setMutationId(command.id);
    return command;
  };
  const confirmDelete = (
    title: string,
    type: RemoteCommand["type"],
    payload: Record<string, unknown>,
  ) =>
    modal.confirm({
      title,
      content: "这条内容会从这位联系人的本地资料中删除。",
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        await mutate(type, payload);
      },
    });
  const error = [mutation, request].find(
    (c) => c && ["failed", "expired", "cancelled"].includes(c.status),
  );
  return (
    <>
      <Modal
        open
        title={`对方档案与记忆 · ${conversation.name}`}
        onCancel={onClose}
        footer={null}
        width={760}
        destroyOnHidden
        className="chat-remote-profile-modal"
      >
        <p className="chat-remote-note">
          从 Mac
          按需读取这位联系人的档案和记忆。可以让模型整理，也可以修改补充；原始聊天、图片和凭据保留在
          Mac。
        </p>
        <Space wrap className="chat-remote-profile-toolbar">
          <Button
            icon={<RefreshCw size={15} />}
            disabled={blocked || !supports("conversation.profile.get")}
            onClick={() => void read()}
          >
            重新读取
          </Button>
          <Button
            disabled={blocked || !supports("conversation.basis.generate")}
            onClick={() =>
              void mutate("conversation.basis.generate", {}, false)
            }
          >
            模型整理档案
          </Button>
          <Button
            disabled={
              blocked ||
              !conversation.processing?.memoryEnabled ||
              !supports("conversation.memory.compress")
            }
            onClick={() =>
              void mutate("conversation.memory.compress", {}, false)
            }
          >
            模型压缩记忆
          </Button>
        </Space>
        {!conversation.processing?.memoryEnabled && (
          <p className="chat-remote-note">
            压缩记忆需先在这位联系人的会话设置中开启记忆功能。
          </p>
        )}
        {(pending || reading) && (
          <Alert
            type="info"
            showIcon
            message={
              remoteCommandStates[(pending ? mutation : request)!.status]
            }
            description="完成后会自动重新读取 Mac 保存的内容。"
          />
        )}
        {error && (
          <Alert
            type="warning"
            showIcon
            message={error.error || remoteCommandStates[error.status]}
            description="若本地资料已修改，请重新读取后再提交。"
          />
        )}
        {!profile ? (
          <div className="chat-empty">
            {reading || busy ? (
              <Spin />
            ) : (
              <Empty description="等待 Mac 返回档案与记忆" />
            )}
          </div>
        ) : (
          <>
            <div className="chat-remote-inline-heading">
              <h3>基础档案</h3>
              <Button
                icon={<Plus size={15} />}
                disabled={blocked || !supports("conversation.basis.add")}
                onClick={() => {
                  basisForm.resetFields();
                  basisForm.setFieldsValue({
                    category: "fact",
                    content: "",
                    sourceNote: "",
                  });
                  setBasisEditor("new");
                }}
              >
                补充档案
              </Button>
            </div>
            {!profile.basisFacts.length ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="尚无基础档案，可先让模型整理或手动补充"
              />
            ) : (
              <div className="chat-remote-profile-list">
                {profile.basisFacts.map((fact) => (
                  <div className="chat-remote-profile-item" key={fact.id}>
                    <Space wrap size={4}>
                      <Tag>
                        {
                          categories.find((c) => c.value === fact.category)
                            ?.label
                        }
                      </Tag>
                      <Tag>
                        {fact.origin === "model" ? "模型整理" : "个人维护"}
                      </Tag>
                    </Space>
                    <p>{fact.content}</p>
                    {fact.sourceNote && <small>{fact.sourceNote}</small>}
                    <Space wrap>
                      <Button
                        size="small"
                        disabled={
                          blocked || !supports("conversation.basis.patch")
                        }
                        onClick={() => {
                          basisForm.resetFields();
                          basisForm.setFieldsValue(fact);
                          setBasisEditor(fact);
                        }}
                      >
                        修改
                      </Button>
                      <Button
                        size="small"
                        danger
                        disabled={
                          blocked || !supports("conversation.basis.delete")
                        }
                        onClick={() =>
                          confirmDelete(
                            "删除这条档案？",
                            "conversation.basis.delete",
                            { factId: fact.id },
                          )
                        }
                      >
                        删除
                      </Button>
                    </Space>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-remote-inline-heading">
              <h3>记忆摘要与待续话题</h3>
              <Button
                disabled={blocked || !supports("conversation.memory.patch")}
                onClick={() => {
                  summaryForm.resetFields();
                  summaryForm.setFieldsValue({
                    summary: profile.memory?.summary ?? "",
                    openTopics: (profile.memory?.openTopics ?? []).join("\n"),
                  });
                  setEditingSummary(true);
                }}
              >
                修改摘要
              </Button>
            </div>
            <div className="chat-remote-profile-item">
              <p>{profile.memory?.summary || "尚无摘要"}</p>
              {(profile.memory?.openTopics ?? []).length > 0 && (
                <ul>
                  {profile.memory!.openTopics.map((topic, i) => (
                    <li key={i}>{topic}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="chat-remote-inline-heading">
              <h3>记忆条目</h3>
              <Button
                icon={<Plus size={15} />}
                disabled={blocked || !supports("conversation.memory.entry.add")}
                onClick={() => {
                  entryForm.resetFields();
                  entryForm.setFieldsValue({ kind: "fact", text: "" });
                  setEntryEditor("new");
                }}
              >
                补充记忆
              </Button>
            </div>
            {!profile.memory?.entries.length ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="尚无记忆条目"
              />
            ) : (
              <div className="chat-remote-profile-list">
                {profile.memory.entries.map((entry) => (
                  <div className="chat-remote-profile-item" key={entry.id}>
                    <Space wrap size={4}>
                      <Tag>
                        {kinds.find((k) => k.value === entry.kind)?.label}
                      </Tag>
                      <Tag
                        color={
                          entry.status === "approved" ? "green" : undefined
                        }
                      >
                        {statusLabels[entry.status]}
                      </Tag>
                      <Tag>
                        {entry.origin === "manual" ? "个人维护" : "模型整理"}
                      </Tag>
                    </Space>
                    <p>{entry.text}</p>
                    <Space wrap>
                      <Button
                        size="small"
                        disabled={
                          blocked ||
                          !supports("conversation.memory.entry.patch")
                        }
                        onClick={() => {
                          entryForm.resetFields();
                          entryForm.setFieldsValue(entry);
                          setEntryEditor(entry);
                        }}
                      >
                        修改
                      </Button>
                      {entry.status !== "approved" && (
                        <Button
                          size="small"
                          disabled={
                            blocked ||
                            !supports("conversation.memory.entry.patch")
                          }
                          onClick={() =>
                            void mutate("conversation.memory.entry.patch", {
                              entryId: entry.id,
                              status: "approved",
                            })
                          }
                        >
                          确认
                        </Button>
                      )}
                      {entry.status !== "rejected" && (
                        <Button
                          size="small"
                          disabled={
                            blocked ||
                            !supports("conversation.memory.entry.patch")
                          }
                          onClick={() =>
                            void mutate("conversation.memory.entry.patch", {
                              entryId: entry.id,
                              status: "rejected",
                            })
                          }
                        >
                          忽略
                        </Button>
                      )}
                      <Button
                        size="small"
                        danger
                        disabled={
                          blocked ||
                          !supports("conversation.memory.entry.delete")
                        }
                        onClick={() =>
                          confirmDelete(
                            "删除这条记忆？",
                            "conversation.memory.entry.delete",
                            { entryId: entry.id },
                          )
                        }
                      >
                        删除
                      </Button>
                    </Space>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={!!basisEditor}
        title={basisEditor === "new" ? "补充基础档案" : "修改基础档案"}
        onCancel={() => setBasisEditor(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={basisForm}
          layout="vertical"
          disabled={blocked}
          onFinish={async (values) => {
            const payload = {
              category: values.category,
              content: values.content,
              sourceNote: values.sourceNote ?? "",
            };
            if (
              await mutate(
                basisEditor === "new"
                  ? "conversation.basis.add"
                  : "conversation.basis.patch",
                {
                  ...payload,
                  ...(basisEditor && basisEditor !== "new"
                    ? { factId: basisEditor.id }
                    : {}),
                },
              )
            )
              setBasisEditor(null);
          }}
        >
          <Form.Item name="category" label="分类" rules={[{ required: true }]}>
            <Select options={categories} />
          </Form.Item>
          <Form.Item
            name="content"
            label="内容"
            rules={[{ required: true, whitespace: true }, { max: 1000 }]}
          >
            <Input.TextArea rows={4} maxLength={1000} />
          </Form.Item>
          <Form.Item name="sourceNote" label="补充说明" rules={[{ max: 500 }]}>
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
          <Button htmlType="submit" type="primary">
            提交到 Mac
          </Button>
        </Form>
      </Modal>
      <Modal
        open={!!entryEditor}
        title={entryEditor === "new" ? "补充记忆" : "修改记忆"}
        onCancel={() => setEntryEditor(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={entryForm}
          layout="vertical"
          disabled={blocked}
          onFinish={async (values) => {
            if (
              await mutate(
                entryEditor === "new"
                  ? "conversation.memory.entry.add"
                  : "conversation.memory.entry.patch",
                {
                  kind: values.kind,
                  text: values.text,
                  ...(entryEditor && entryEditor !== "new"
                    ? { entryId: entryEditor.id }
                    : {}),
                },
              )
            )
              setEntryEditor(null);
          }}
        >
          <Form.Item name="kind" label="分类" rules={[{ required: true }]}>
            <Select options={kinds} />
          </Form.Item>
          <Form.Item
            name="text"
            label="内容"
            rules={[{ required: true, whitespace: true }, { max: 600 }]}
          >
            <Input.TextArea rows={4} maxLength={600} />
          </Form.Item>
          <p className="chat-remote-note">
            个人补充或修改后的内容将作为个人维护记忆保存。
          </p>
          <Button htmlType="submit" type="primary">
            提交到 Mac
          </Button>
        </Form>
      </Modal>
      <Modal
        open={editingSummary}
        title="修改记忆摘要与话题"
        onCancel={() => setEditingSummary(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={summaryForm}
          layout="vertical"
          disabled={blocked}
          onFinish={async (values) => {
            if (
              await mutate("conversation.memory.patch", {
                summary: values.summary ?? "",
                openTopics: String(values.openTopics ?? "")
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            )
              setEditingSummary(false);
          }}
        >
          <Form.Item name="summary" label="摘要" rules={[{ max: 1600 }]}>
            <Input.TextArea rows={5} maxLength={1600} />
          </Form.Item>
          <Form.Item
            name="openTopics"
            label="待续话题（每行一条，最多 10 条）"
            rules={[
              {
                validator: async (_, value) => {
                  const topics = String(value ?? "")
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean);
                  if (topics.length > 10 || topics.some((x) => x.length > 200))
                    throw new Error("最多 10 条，每条不超过 200 字");
                },
              },
            ]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Button htmlType="submit" type="primary">
            提交到 Mac
          </Button>
        </Form>
      </Modal>
    </>
  );
}
