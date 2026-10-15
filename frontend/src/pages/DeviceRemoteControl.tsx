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
  changedRemoteConversation,
  supportsRemoteCommand,
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
import {
  RemoteModelChoiceField,
  RemoteReplyModelsField,
  RemoteModelCatalogProvider,
  RemoteModelNameField,
} from "./RemoteModelFields";
import RemoteContactProfile from "./RemoteContactProfile";

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
  const selectedProvider = Form.useWatch("provider", form);
  const selectedPreset = Form.useWatch("modelPreset", form);
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
        if (
          await queue("settings.patch", {
            ...patch,
            ...(snapshot.version === 2
              ? { expectedRevision: baseline.current.revision }
              : {}),
          })
        ) {
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
            onChange={(value) => {
              if (value !== selectedProvider)
                form.setFieldValue("modelName", "");
              if (value !== "compatible")
                form.setFieldValue("modelPreset", "custom");
            }}
            options={[
              { value: "codex", label: "Codex" },
              { value: "ollama", label: "Ollama" },
              { value: "compatible", label: "兼容 AI 接口" },
              { value: "demo", label: "演示模式" },
            ]}
          />
        </Form.Item>
        {snapshot.version === 2 && selectedProvider === "compatible" && (
          <Form.Item name="modelPreset" label="回复接口类型">
            <Select
              onChange={(value) => {
                if (value === "qwen" && !form.getFieldValue("modelName"))
                  form.setFieldValue("modelName", "qwen3.8-flash");
              }}
              options={[
                { value: "custom", label: "本地已配置的接口" },
                { value: "qwen", label: "阿里千问" },
              ]}
            />
          </Form.Item>
        )}
        <Form.Item name="modelName" label="模型名称" rules={[{ max: 200 }]}>
          {snapshot.version === 2 ? (
            <RemoteModelNameField
              provider={
                selectedProvider === "compatible" && selectedPreset === "qwen"
                  ? "qwen"
                  : (selectedProvider ?? snapshot.settings.provider)
              }
              label="模型名称"
            />
          ) : (
            <Input maxLength={200} placeholder="使用本地已配置的模型" />
          )}
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
      {snapshot.version === 2 && (
        <>
          <h3>回复比较模型</h3>
          <Form.Item name="replyModels">
            <RemoteReplyModelsField disabled={disabled} />
          </Form.Item>
          <h3>独立模型配置</h3>
          {(
            [
              { key: "vision", name: "图片识别" },
              { key: "audio", name: "语音转写" },
              { key: "analysis", name: "意图与好感度分析" },
              { key: "memory", name: "档案与记忆整理" },
            ] as const
          ).map((kind) => (
            <div className="chat-remote-model-section" key={kind.key}>
              <h4>{kind.name}</h4>
              {kind.key === "audio" && (
                <p className="chat-remote-note">
                  Codex 当前接入支持文字和图片，不能直接转写语音。
                </p>
              )}
              <div className="chat-remote-form-grid">
                <Form.Item
                  name={[kind.key, "provider"]}
                  label={`${kind.name}来源`}
                >
                  <Select
                    onChange={(provider) =>
                      form.setFieldValue(
                        [kind.key, "modelName"],
                        provider === "qwen"
                          ? kind.key === "audio"
                            ? "qwen3.8-omni-flash"
                            : "qwen3.8-flash"
                          : "",
                      )
                    }
                    options={[
                      { value: "disabled", label: "关闭此模型服务" },
                      { value: "qwen", label: "阿里千问" },
                      { value: "compatible", label: "兼容 AI 接口" },
                      ...(kind.key === "audio"
                        ? []
                        : [{ value: "codex", label: "Codex" }]),
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(before, after) =>
                    before[kind.key]?.provider !== after[kind.key]?.provider
                  }
                >
                  {() => (
                    <Form.Item
                      name={[kind.key, "modelName"]}
                      label={`${kind.name}模型名称`}
                      rules={[{ max: 200 }]}
                    >
                      <RemoteModelNameField
                        provider={
                          form.getFieldValue([kind.key, "provider"]) ??
                          "disabled"
                        }
                        role={kind.key}
                        label={`${kind.name}模型名称`}
                      />
                    </Form.Item>
                  )}
                </Form.Item>
                {kind.key !== "audio" && (
                  <Form.Item
                    name={[kind.key, "thinkingEnabled"]}
                    label="启用思考模式"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                )}
              </div>
            </div>
          ))}
        </>
      )}
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
  initialProfileId,
}: {
  userId: string;
  device: ChatDevice;
  onClose: () => void;
  onPrivateError: () => void;
  onAccessError: (error: unknown) => void;
  initialProfileId?: string;
}) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searchId, setSearchId] = useState<string | null>(null);
  const [editing, setEditing] = useState<RemoteConversation | null>(null);
  const [profileConversationId, setProfileConversationId] = useState<
    string | null
  >(null);
  const [conversationForm] = Form.useForm();
  const epoch = useRef(0),
    revision = useRef(0),
    reading = useRef(false),
    posting = useRef(false);
  const callbacks = useRef({ onClose, onPrivateError, onAccessError });
  const openedInitialProfile = useRef(false);
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
      setProfileConversationId(null);
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
        setProfileConversationId(null);
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
      if (
        !openedInitialProfile.current &&
        initialProfileId &&
        result.snapshot?.conversations.some(
          (person) => person.id === initialProfileId,
        ) &&
        supportsRemoteCommand(result.snapshot, "conversation.profile.get")
      ) {
        setProfileConversationId(initialProfileId);
        openedInitialProfile.current = true;
      }
      setError("");
    } catch (e) {
      handleError(e, current);
    } finally {
      if (current === epoch.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [device.id, accept, handleError, initialProfileId]);
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
  const profileConversation = conversations.find(
    (c) => c.id === profileConversationId,
  );
  const extended = snapshot?.version === 2;
  const watchedProcessing = Form.useWatch("processing", conversationForm);
  const pendingConversation = (id: string) =>
    commands.some((c) => c.payload.id === id && commandPending(c));
  const settingsPending = commands.some(
    (c) => c.type === "settings.patch" && commandPending(c),
  );
  const changesPending = (id: string) =>
    commands.some(
      (c) =>
        c.payload.id === id &&
        c.type !== "conversation.profile.get" &&
        commandPending(c),
    );

  return (
    <RemoteModelCatalogProvider
      models={snapshot?.capabilities.codexModels ?? []}
    >
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
            {snapshot?.version === 1 && (
              <Alert
                type="info"
                showIcon
                className="form-alert"
                message="更新 Mac 相知后可远程设置分析、模型、档案与记忆"
                description="当前版本继续支持采集和基础草稿设置。"
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
                        {available &&
                          !snapshot?.capabilities.wechatAvailable && (
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
                                search.error ||
                                remoteCommandStates[search.status]
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
                                <div className="chat-remote-contact-name">
                                  <strong>{conversation.name}</strong>
                                  {conversation.processing?.affinityEnabled &&
                                    typeof conversation.affinity ===
                                      "number" && (
                                      <Tag
                                        color="blue"
                                        title="好感度估计，属于模型估计"
                                      >
                                        {conversation.affinity}%
                                      </Tag>
                                    )}
                                </div>
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
                              <Space
                                wrap
                                className="chat-remote-contact-actions"
                              >
                                {extended &&
                                  supportsRemoteCommand(
                                    snapshot,
                                    "conversation.profile.get",
                                  ) && (
                                    <Button
                                      disabled={
                                        !available ||
                                        busy ||
                                        pendingConversation(conversation.id)
                                      }
                                      onClick={() =>
                                        setProfileConversationId(
                                          conversation.id,
                                        )
                                      }
                                    >
                                      档案与记忆
                                    </Button>
                                  )}
                                <Button
                                  icon={<Settings2 size={15} />}
                                  disabled={
                                    !available ||
                                    busy ||
                                    changesPending(conversation.id)
                                  }
                                  onClick={() => {
                                    conversationForm.resetFields();
                                    conversationForm.setFieldsValue({
                                      ...conversation,
                                      processing: {
                                        autoRecognizeImages: false,
                                        autoTranscribeVoice: false,
                                        intentEnabled: false,
                                        affinityEnabled: false,
                                        memoryEnabled: false,
                                        autoAnalyzeMessages: false,
                                        autoCompressMemory: false,
                                        replyModels: null,
                                        analysisModel: null,
                                        memoryModel: null,
                                        ...conversation.processing,
                                      },
                                    });
                                    setEditing(conversation);
                                  }}
                                >
                                  会话设置
                                </Button>
                              </Space>
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
                    <div
                      className="chat-remote-command-list"
                      aria-live="polite"
                    >
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
          width={700}
        >
          <Form
            form={conversationForm}
            layout="vertical"
            disabled={busy || !available}
            onValuesChange={(changed) => {
              if (!changed.processing) return;
              const processing = conversationForm.getFieldValue("processing");
              if (!processing?.intentEnabled && !processing?.affinityEnabled)
                conversationForm.setFieldValue(
                  ["processing", "autoAnalyzeMessages"],
                  false,
                );
              if (!processing?.memoryEnabled)
                conversationForm.setFieldValue(
                  ["processing", "autoCompressMemory"],
                  false,
                );
            }}
            onFinish={async (values) => {
              if (!editing) return;
              const payload = changedRemoteConversation(editing, values);
              if (Object.keys(payload).length === 1) {
                setEditing(null);
                return;
              }
              if (
                await queue("conversation.patch", {
                  ...payload,
                  ...(extended ? { expectedRevision: editing.revision } : {}),
                })
              )
                setEditing(null);
            }}
          >
            <Form.Item
              name="name"
              label="显示名称"
              rules={[{ required: true, whitespace: true }, { max: 80 }]}
            >
              <Input maxLength={80} />
            </Form.Item>
            <Form.Item
              name="note"
              label="关系与沟通备注"
              rules={[{ max: 2000 }]}
            >
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
            {extended && (
              <>
                <h3>这位联系人的信息处理</h3>
                <div className="chat-remote-form-grid">
                  {(
                    [
                      {
                        key: "autoRecognizeImages",
                        name: "自动识别此人的图片",
                      },
                      {
                        key: "autoTranscribeVoice",
                        name: "自动转写此人的语音",
                      },
                      { key: "intentEnabled", name: "意图分析" },
                      { key: "affinityEnabled", name: "好感度估计" },
                      { key: "memoryEnabled", name: "记忆功能" },
                    ] as const
                  ).map((field) => (
                    <Form.Item
                      key={field.key}
                      name={["processing", field.key]}
                      label={field.name}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                  ))}
                  <Form.Item
                    name={["processing", "autoAnalyzeMessages"]}
                    label="新消息自动分析"
                    valuePropName="checked"
                  >
                    <Switch
                      disabled={
                        busy ||
                        !available ||
                        (!watchedProcessing?.intentEnabled &&
                          !watchedProcessing?.affinityEnabled)
                      }
                    />
                  </Form.Item>
                  <Form.Item
                    name={["processing", "autoCompressMemory"]}
                    label="自动压缩记忆"
                    valuePropName="checked"
                  >
                    <Switch
                      disabled={
                        busy || !available || !watchedProcessing?.memoryEnabled
                      }
                    />
                  </Form.Item>
                </div>
                <p className="chat-remote-note">
                  好感度显示在姓名旁；意图名称和百分比显示在“会话动态”的对应消息下方。
                </p>
                <Form.Item
                  name={["processing", "analysisModel"]}
                  label="此人的分析模型"
                >
                  <RemoteModelChoiceField />
                </Form.Item>
                <Form.Item
                  name={["processing", "memoryModel"]}
                  label="此人的档案与记忆模型"
                >
                  <RemoteModelChoiceField role="memory" />
                </Form.Item>
                <Form.Item
                  name={["processing", "replyModels"]}
                  label="此人的回复比较模型"
                >
                  <RemoteReplyModelsField allowInherit />
                </Form.Item>
              </>
            )}
            <p className="chat-remote-note">
              自动生成还需在“本地配置”开启全局自动草稿；不会代发微信。
            </p>
            <Button type="primary" htmlType="submit" loading={busy}>
              提交会话更改
            </Button>
          </Form>
        </Modal>
        {profileConversation && snapshot && (
          <RemoteContactProfile
            key={profileConversation.id}
            conversation={profileConversation}
            snapshot={snapshot}
            commands={commands}
            disabled={!available}
            busy={busy}
            queue={queue}
            onClose={() => setProfileConversationId(null)}
          />
        )}
      </Drawer>
    </RemoteModelCatalogProvider>
  );
}
