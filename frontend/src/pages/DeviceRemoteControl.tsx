import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
} from "antd";
import { Plus, RefreshCw, Settings2 } from "lucide-react";
import { api, ApiError } from "../api";
import {
  changedRemoteSettings,
  commandPending,
  remoteCommandLabels,
  remoteCommandStates,
  remoteConnectionState,
  remoteResponseMatches,
} from "../chat-remote-model";
import type {
  RemoteCommand,
  RemoteConversation,
  RemoteSettings,
  RemoteSnapshot,
  RemoteStatus,
} from "../chat-remote-model";
import type { ChatDevice } from "../chat-device-model";

function time(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚未上报";
}
type QueueCommand = (
  type: RemoteCommand["type"],
  payload: Record<string, unknown>,
) => Promise<RemoteCommand | null>;

function SettingsForm({
  snapshot,
  disabled,
  queue,
}: {
  snapshot: RemoteSnapshot;
  disabled: boolean;
  queue: QueueCommand;
}) {
  const [form] = Form.useForm<RemoteSettings>();
  const baseline = useRef(snapshot.settings);
  const dirty = useRef(false);
  const { message } = App.useApp();
  useEffect(() => {
    if (!dirty.current) {
      form.setFieldsValue(snapshot.settings);
      baseline.current = snapshot.settings;
    }
  }, [snapshot.settings, form]);
  return (
    <Form
      form={form}
      layout="vertical"
      disabled={disabled}
      initialValues={snapshot.settings}
      onValuesChange={() => {
        dirty.current = true;
      }}
      onFinish={async (values) => {
        const patch = changedRemoteSettings(baseline.current, values);
        if (!Object.keys(patch).length) {
          message.info("配置没有变化");
          return;
        }
        if (await queue("settings.patch", patch)) {
          dirty.current = false;
          form.setFieldsValue(snapshot.settings);
          baseline.current = snapshot.settings;
        }
      }}
    >
      <p className="chat-remote-note">
        这里显示 Mac
        最近上报的配置。提交后以执行记录和更新后的配置为准。自动回复只生成草稿。
      </p>
      <div className="chat-remote-form-grid">
        <Form.Item
          name="autoReplyEnabled"
          label="收到消息自动生成草稿"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="syncDraftsEnabled"
          label="同步草稿到云端"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="provider"
          label="回复模型来源"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: "codex", label: "Codex" },
              { value: "ollama", label: "Ollama" },
              { value: "compatible", label: "兼容 AI 接口" },
              { value: "demo", label: "演示模式" },
            ]}
          />
        </Form.Item>
        <Form.Item name="modelName" label="模型名称" rules={[{ max: 200 }]}>
          <Input maxLength={200} placeholder="使用本地已配置的模型" />
        </Form.Item>
        <Form.Item
          name="replyDelaySeconds"
          label="生成前等待（秒）"
          rules={[{ required: true }]}
        >
          <InputNumber min={1} max={300} precision={0} />
        </Form.Item>
        <Form.Item
          name="cooldownSeconds"
          label="连续生成间隔（秒）"
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={3600} precision={0} />
        </Form.Item>
        <Form.Item
          name="dailyLimit"
          label="每日自动回复上限"
          rules={[{ required: true }]}
        >
          <InputNumber min={1} max={200} precision={0} />
        </Form.Item>
        <Form.Item
          name="quietHoursEnabled"
          label="启用免打扰时段"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="quietStart"
          label="免打扰开始"
          rules={[
            { required: true },
            {
              pattern: /^([01]\d|2[0-3]):[0-5]\d$/,
              message: "请输入 HH:mm，例如 23:00",
            },
          ]}
        >
          <Input type="time" />
        </Form.Item>
        <Form.Item
          name="quietEnd"
          label="免打扰结束"
          rules={[
            { required: true },
            {
              pattern: /^([01]\d|2[0-3]):[0-5]\d$/,
              message: "请输入 HH:mm，例如 08:00",
            },
          ]}
        >
          <Input type="time" />
        </Form.Item>
      </div>
      <p className="chat-remote-note">
        模型服务地址和凭据沿用 Mac 本地配置。切换模型来源前，需在 Mac
        完成对应服务的配置。
      </p>
      <Button type="primary" htmlType="submit">
        提交配置更改
      </Button>
    </Form>
  );
}

export default function DeviceRemoteControl({
  userId,
  device,
  onClose,
  onPrivateError,
  onAccessError,
}: {
  userId: string;
  device: ChatDevice;
  onClose: () => void;
  onPrivateError: () => void;
  onAccessError: (error: unknown) => void;
}) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searchId, setSearchId] = useState<string | null>(null);
  const [editing, setEditing] = useState<RemoteConversation | null>(null);
  const [conversationForm] = Form.useForm();
  const epoch = useRef(0),
    revision = useRef(0),
    reading = useRef(false),
    posting = useRef(false);
  const callbacks = useRef({ onClose, onPrivateError, onAccessError });
  callbacks.current = { onClose, onPrivateError, onAccessError };
  const accept = useCallback(
    (
      result: { user_id: string | number; device_id?: string },
      current: number,
    ) => {
      if (current !== epoch.current) return false;
      if (remoteResponseMatches(result, userId, device.id)) return true;
      setStatus(null);
      setSearchId(null);
      setEditing(null);
      callbacks.current.onPrivateError();
      return false;
    },
    [userId, device.id],
  );
  const handleError = useCallback(
    (e: unknown, current: number) => {
      if (current !== epoch.current) return;
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        setStatus(null);
        setSearchId(null);
        setEditing(null);
        callbacks.current.onAccessError(e);
        callbacks.current.onClose();
        return;
      }
      if (e instanceof ApiError && [404, 410].includes(e.status)) {
        callbacks.current.onClose();
        message.info("设备已删除或不可用");
        return;
      }
      setError((e as Error).message);
    },
    [message],
  );
  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const current = epoch.current,
      requestedRevision = revision.current;
    try {
      const result = await api<RemoteStatus>(
        `/chat/devices/${encodeURIComponent(device.id)}/remote`,
      );
      if (!accept(result, current) || requestedRevision !== revision.current)
        return;
      setStatus(result);
      setError("");
    } catch (e) {
      handleError(e, current);
    } finally {
      if (current === epoch.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [device.id, accept, handleError]);
  useEffect(() => {
    epoch.current++;
    reading.current = false;
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 5000);
    return () => {
      epoch.current++;
      reading.current = false;
      window.clearInterval(timer);
    };
  }, [read]);

  const queue: QueueCommand = async (type, payload) => {
    if (posting.current) return null;
    posting.current = true;
    setBusy(true);
    setError("");
    const current = epoch.current;
    try {
      const result = await api<{
        user_id: string | number;
        command: RemoteCommand;
      }>(`/chat/devices/${encodeURIComponent(device.id)}/commands`, {
        method: "POST",
        body: JSON.stringify({ type, payload }),
        headers: { "X-Chat-User-Id": userId },
      });
      if (!accept(result, current)) return null;
      revision.current++;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              commands: [
                result.command,
                ...previous.commands.filter((c) => c.id !== result.command.id),
              ].slice(0, 100),
            }
          : previous,
      );
      message.success(
        type === "contacts.search"
          ? "搜索请求已提交，等待 Mac 返回联系人"
          : "已提交，等待 Mac 执行",
      );
      return result.command;
    } catch (e) {
      handleError(e, current);
      return null;
    } finally {
      if (current === epoch.current) {
        posting.current = false;
        setBusy(false);
      }
    }
  };

  const snapshot = status?.snapshot;
  const connection = status ? remoteConnectionState(status) : "unconfigured";
  const available = !!snapshot?.remoteEnabled;
  const commands = status?.commands || [];
  const search = commands.find((c) => c.id === searchId);
  const searchPending = !!search && commandPending(search);
  const searchContacts =
    search?.status === "succeeded" ? search.result.contacts || [] : [];
  const conversations = snapshot?.conversations || [];
  const settingsPending = commands.some(
    (c) => c.type === "settings.patch" && commandPending(c),
  );
  const changesPending = (id: string) =>
    commands.some(
      (c) =>
        c.type === "conversation.patch" &&
        c.payload.id === id &&
        commandPending(c),
    );

  return (
    <Drawer
      open
      title={`远程管理 · ${device.name}`}
      onClose={onClose}
      width={820}
      destroyOnHidden
      className="chat-remote-drawer"
      extra={
        <Button
          aria-label="刷新设备远程状态"
          icon={<RefreshCw size={16} />}
          loading={loading}
          onClick={() => void read()}
        >
          刷新
        </Button>
      }
    >
      {error && (
        <Alert type="error" showIcon message={error} className="form-alert" />
      )}
      {!status && loading ? (
        <div className="chat-empty">
          <Spin />
        </div>
      ) : status ? (
        <>
          <div className="chat-remote-status">
            <Tag color={connection === "online" ? "green" : "gold"}>
              {connection === "online"
                ? "Mac 最近在线"
                : connection === "offline"
                  ? "等待 Mac 上线"
                  : connection === "disabled"
                    ? "远程管理已关闭"
                    : "等待 Mac 开启远程管理"}
            </Tag>
            <span>最近上报：{time(status.last_poll_at)}</span>
          </div>
          {!available ? (
            <Alert
              type="info"
              showIcon
              className="form-alert"
              message="先在 Mac 相知中开启远程管理"
              description="在 Mac 的同步设置中验证设备连接并开启“允许网页远程管理”，保持相知运行；此处会自动更新。"
            />
          ) : (
            <Alert
              type={connection === "online" ? "info" : "warning"}
              showIcon
              className="form-alert"
              message={
                connection === "online"
                  ? "操作由这台 Mac 接收并执行"
                  : "Mac 未上报最新状态，操作将排队等待"
              }
              description="Mac 相知需保持运行并允许远程管理。请求在 15 分钟后过期；“已提交”表示等待执行，请查看下方执行记录。"
            />
          )}
          <Tabs
            items={[
              {
                key: "conversations",
                label: `聊天人员（${conversations.length}）`,
                children: (
                  <>
                    <div className="chat-remote-search">
                      <h3>添加聊天人员</h3>
                      <Input.Search
                        aria-label="搜索 Mac 微信联系人"
                        placeholder="输入微信备注名或昵称"
                        value={query}
                        maxLength={100}
                        onChange={(event) => setQuery(event.target.value)}
                        loading={searchPending}
                        disabled={
                          !available ||
                          !snapshot?.capabilities.wechatAvailable ||
                          busy ||
                          searchPending
                        }
                        enterButton="在 Mac 搜索"
                        onSearch={async () => {
                          if (!query.trim()) {
                            message.info("请输入备注名或昵称");
                            return;
                          }
                          setSearchId(null);
                          const command = await queue("contacts.search", {
                            query: query.trim(),
                            limit: 20,
                          });
                          if (command) setSearchId(command.id);
                        }}
                      />
                      {available && !snapshot?.capabilities.wechatAvailable && (
                        <p className="chat-remote-note">
                          Mac 尚未检测到微信读取工具，请先在本地完成配置。
                        </p>
                      )}
                      {searchPending && (
                        <p className="chat-remote-note" role="status">
                          {remoteCommandStates[search!.status]}
                          ，搜索结果会自动显示。
                        </p>
                      )}
                      {search &&
                        ["failed", "expired", "cancelled"].includes(
                          search.status,
                        ) && (
                          <Alert
                            type="warning"
                            showIcon
                            message={
                              search.error || remoteCommandStates[search.status]
                            }
                          />
                        )}
                      {search?.status === "succeeded" &&
                        !searchContacts.length && (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="没有找到联系人，请换一个备注名或昵称"
                          />
                        )}
                      <div className="chat-remote-contact-list">
                        {searchContacts.map((contact) => {
                          const added = conversations.some(
                            (c) => c.externalId === contact.externalId,
                          );
                          const pending = commands.some(
                            (c) =>
                              c.type === "conversation.add" &&
                              c.payload.externalId === contact.externalId &&
                              commandPending(c),
                          );
                          return (
                            <div
                              className="chat-remote-contact"
                              key={contact.externalId}
                            >
                              <div>
                                <strong>
                                  {contact.name || contact.externalId}
                                </strong>
                                <small>{contact.externalId}</small>
                              </div>
                              <Button
                                icon={<Plus size={15} />}
                                disabled={
                                  !available || busy || added || pending
                                }
                                onClick={() =>
                                  void queue("conversation.add", contact)
                                }
                              >
                                {added
                                  ? "已添加"
                                  : pending
                                    ? "等待添加"
                                    : "添加"}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                      {search?.status === "succeeded" &&
                        search.result.hasMore && (
                          <p className="chat-remote-note">
                            还有更多匹配结果，请输入更准确的名称。
                          </p>
                        )}
                      <p className="chat-remote-note">
                        新添加的会话默认暂停采集。在会话设置中开启采集后，接收新增消息；开启会话和全局自动草稿后生成回复。
                      </p>
                    </div>
                    <h3>已配置会话</h3>
                    {!conversations.length ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="这台 Mac 尚未上报聊天人员"
                      />
                    ) : (
                      <div className="chat-remote-contact-list">
                        {conversations.map((conversation) => (
                          <div
                            className="chat-remote-contact"
                            key={conversation.id}
                          >
                            <div>
                              <strong>{conversation.name}</strong>
                              <small>
                                {conversation.note || conversation.externalId}
                              </small>
                              <Space wrap size={4}>
                                <Tag
                                  color={
                                    conversation.enabled ? "green" : undefined
                                  }
                                >
                                  {conversation.enabled
                                    ? "采集已开启"
                                    : "采集暂停"}
                                </Tag>
                                <Tag>
                                  {conversation.autoReplyEnabled
                                    ? "会话自动草稿开启"
                                    : "会话自动草稿关闭"}
                                </Tag>
                                {changesPending(conversation.id) && (
                                  <Tag color="gold">等待更新</Tag>
                                )}
                              </Space>
                            </div>
                            <Button
                              icon={<Settings2 size={15} />}
                              disabled={
                                !available ||
                                busy ||
                                changesPending(conversation.id)
                              }
                              onClick={() => {
                                conversationForm.setFieldsValue(conversation);
                                setEditing(conversation);
                              }}
                            >
                              会话设置
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: "settings",
                label: "本地配置",
                children: snapshot ? (
                  <SettingsForm
                    snapshot={snapshot}
                    disabled={!available || busy || settingsPending}
                    queue={queue}
                  />
                ) : (
                  <Empty description="等待 Mac 上报配置" />
                ),
              },
              {
                key: "commands",
                label: `执行记录${commands.some(commandPending) ? " · 有待处理" : ""}`,
                children: !commands.length ? (
                  <Empty description="暂无远程操作" />
                ) : (
                  <div className="chat-remote-command-list" aria-live="polite">
                    {commands.map((command) => (
                      <div className="chat-remote-command" key={command.id}>
                        <div>
                          <strong>{remoteCommandLabels[command.type]}</strong>
                          <Tag
                            color={
                              command.status === "succeeded"
                                ? "green"
                                : command.status === "failed" ||
                                    command.status === "expired"
                                  ? "red"
                                  : commandPending(command)
                                    ? "gold"
                                    : undefined
                            }
                          >
                            {remoteCommandStates[command.status]}
                          </Tag>
                        </div>
                        <p>
                          提交于 {time(command.created_at)}
                          {commandPending(command)
                            ? ` · 到期 ${time(command.expires_at)}`
                            : command.completed_at
                              ? ` · 完成于 ${time(command.completed_at)}`
                              : ""}
                        </p>
                        {command.error && (
                          <p className="chat-remote-command-error">
                            {command.error}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </>
      ) : (
        !error && <Empty description="暂时无法获取设备状态" />
      )}
      <Modal
        title={`会话设置 · ${editing?.name || ""}`}
        open={!!editing}
        footer={null}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form
          form={conversationForm}
          layout="vertical"
          disabled={busy || !available}
          onFinish={async (values) => {
            if (!editing) return;
            const payload: Record<string, unknown> = { id: editing.id };
            for (const key of [
              "name",
              "note",
              "enabled",
              "autoReplyEnabled",
            ] as const) {
              const value =
                key === "name" ? String(values[key]).trim() : values[key];
              if (value !== editing[key]) payload[key] = value;
            }
            if (Object.keys(payload).length === 1) {
              setEditing(null);
              return;
            }
            if (await queue("conversation.patch", payload)) setEditing(null);
          }}
        >
          <Form.Item
            name="name"
            label="显示名称"
            rules={[{ required: true, whitespace: true }, { max: 80 }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="note" label="关系与沟通备注" rules={[{ max: 2000 }]}>
            <Input.TextArea
              maxLength={2000}
              rows={3}
              placeholder="例如：朋友，平时聊天比较随意"
            />
          </Form.Item>
          <Form.Item
            name="enabled"
            label="采集这位联系人的新增消息"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="autoReplyEnabled"
            label="为这个会话自动生成回复草稿"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <p className="chat-remote-note">
            自动生成还需在“本地配置”开启全局自动草稿；不会代发微信。
          </p>
          <Button type="primary" htmlType="submit" loading={busy}>
            提交会话更改
          </Button>
        </Form>
      </Modal>
    </Drawer>
  );
}
