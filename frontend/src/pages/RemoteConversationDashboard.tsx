import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import {
  BookOpen,
  Copy,
  Heart,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { api, ApiError } from "../api";
import type { ChatDevice } from "../chat-device-model";
import { deviceConnectionState } from "../chat-device-model";
import {
  commandPending,
  remoteCommandLabels,
  remoteCommandStates,
  remoteConnectionState,
  remoteResponseMatches,
  supportsRemoteCommand,
} from "../chat-remote-model";
import type { RemoteCommand, RemoteStatus } from "../chat-remote-model";
import {
  currentDraftsAreStale,
  currentIntentLabels,
  currentKindLabels,
  reconcileCurrentStatus,
} from "../chat-current-model";

import { useChatHistory } from "../use-chat-history";
import {
  historyCurrent,
  historyPeople,
  historyReadLabel,
} from "../chat-history-model";

function time(value: string | null | undefined) {
  if (!value) return "尚未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { hour12: false });
}
const basisLabels = {
  current_status: "近况",
  interest: "爱好",
  preference: "偏好",
  fact: "基本信息",
  boundary: "相处边界",
  plan: "计划",
};

export default function RemoteConversationDashboard({
  userId,
  devices,
  onConfigure,
  onPrivateError,
  onAccessError,
}: {
  userId: string;
  devices: ChatDevice[];
  onConfigure: (deviceId: string, conversationId?: string) => void;
  onPrivateError: () => void;
  onAccessError: (error: unknown) => void;
}) {
  const { message } = App.useApp();
  const usable = devices.filter(
    (device) => deviceConnectionState(device) !== "revoked",
  );
  const [deviceId, setDeviceId] = useState<string | undefined>(usable[0]?.id);
  const [conversationId, setConversationId] = useState<string>();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replyIntents, setReplyIntents] = useState<Record<string, string>>({});
  const epoch = useRef(0),
    reading = useRef(false),
    posting = useRef(false),
    mutation = useRef(0);
  const callbacks = useRef({ onPrivateError, onAccessError });
  const feed = useRef<HTMLElement>(null),
    feedAtBottom = useRef(true),
    lastFeedPerson = useRef("");
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  callbacks.current = { onPrivateError, onAccessError };
  useEffect(() => {
    if (!usable.some((device) => device.id === deviceId)) {
      setStatus(null);
      setConversationId(undefined);
      setDeviceId(usable[0]?.id);
    }
  }, [devices, deviceId]);
  const accept = useCallback(
    (
      result: { user_id: string | number; device_id?: string },
      current: number,
    ) => {
      if (current !== epoch.current || !deviceId) return false;
      if (remoteResponseMatches(result, userId, deviceId)) return true;
      setStatus(null);
      setConversationId(undefined);
      callbacks.current.onPrivateError();
      return false;
    },
    [deviceId, userId],
  );
  const handleError = useCallback((reason: unknown, current: number) => {
    if (current !== epoch.current) return;
    if (
      reason instanceof ApiError &&
      [401, 403, 404, 410].includes(reason.status)
    ) {
      setStatus(null);
      setConversationId(undefined);
      if ([401, 403].includes(reason.status))
        callbacks.current.onAccessError(reason);
    }
    setError((reason as Error).message);
  }, []);
  const read = useCallback(async () => {
    if (!deviceId || reading.current) return;
    reading.current = true;
    const current = epoch.current,
      revision = mutation.current;
    try {
      const result = await api<RemoteStatus>(
        `/chat/devices/${encodeURIComponent(deviceId)}/remote`,
      );
      if (!accept(result, current) || revision !== mutation.current) return;
      setStatus((previous) => reconcileCurrentStatus(previous, result));
      setError("");
    } catch (reason) {
      handleError(reason, current);
    } finally {
      if (current === epoch.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [deviceId, accept, handleError]);
  useEffect(() => {
    epoch.current++;
    reading.current = false;
    posting.current = false;
    setStatus(null);
    setConversationId(undefined);
    setLoading(!!deviceId);
    setError("");
    setBusy(false);
    setReplyIntents({});
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 5000);
    const visibility = () => {
      if (document.visibilityState !== "visible") {
        epoch.current++;
        reading.current = false;
        posting.current = false;
        setBusy(false);
        setStatus(null);
      } else void read();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      epoch.current++;
      reading.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [read, deviceId]);
  const queue = async (
    type: RemoteCommand["type"],
    payload: Record<string, unknown>,
  ) => {
    if (!deviceId || posting.current) return;
    posting.current = true;
    setBusy(true);
    const current = epoch.current;
    try {
      const result = await api<{
        user_id: string | number;
        command: RemoteCommand;
      }>(`/chat/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: "POST",
        body: JSON.stringify({ type, payload }),
        headers: { "X-Chat-User-Id": userId },
      });
      if (!accept(result, current)) return;
      mutation.current++;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              commands: [
                result.command,
                ...previous.commands.filter(
                  (item) => item.id !== result.command.id,
                ),
              ].slice(0, 100),
            }
          : previous,
      );
      message.success("已提交，等待 Mac 执行");
    } catch (reason) {
      handleError(reason, current);
    } finally {
      if (current === epoch.current) {
        posting.current = false;
        setBusy(false);
      }
    }
  };
  const selectedStatus =
    status &&
    deviceId &&
    usable.some((device) => device.id === deviceId) &&
    remoteResponseMatches(status, userId, deviceId)
      ? status
      : null;
  const snapshot = selectedStatus?.snapshot;
  const archive = useChatHistory({
    userId,
    deviceId,
    conversationId,
    enabled: !!snapshot?.remoteEnabled,
    onPrivateError,
    onAccessError,
  });
  const archiveReady =
    archive.directory.mode === "ready" ||
    (archive.directory.mode === "error" &&
      !!archive.directory.progress?.streamId);
  const people = !snapshot?.remoteEnabled
    ? []
    : archiveReady
      ? historyPeople(archive.directory.contacts, snapshot.conversations)
      : snapshot.conversations;
  const person = people.find((item) => item.id === conversationId);
  const current = historyCurrent(selectedStatus, person, archive.page);
  const historyContact = archive.directory.contacts.find(
    (item) => item.id === person?.id,
  );
  const canConfigurePerson =
    !!person && !!snapshot?.conversations.some((item) => item.id === person.id);
  const personIds = people.map((item) => item.id).join(":");
  useEffect(() => {
    if (!snapshot?.remoteEnabled) {
      setConversationId(undefined);
      return;
    }
    // An archive directory is authoritative, including its deletion tombstones.
    if (archive.directory.mode === "loading" && conversationId) return;
    if (!people.some((item) => item.id === conversationId))
      setConversationId(people[0]?.id);
  }, [
    personIds,
    archive.directory.mode,
    snapshot?.remoteEnabled,
    conversationId,
  ]);
  const connection = selectedStatus
    ? remoteConnectionState(selectedStatus)
    : "unconfigured";
  const online = connection === "online";
  const supported = (type: RemoteCommand["type"]) =>
    supportsRemoteCommand(snapshot, type);
  const pending = (type: RemoteCommand["type"], messageId?: string) =>
    status?.commands.some(
      (command) =>
        command.type === type &&
        command.payload.id === conversationId &&
        (!messageId || command.payload.messageId === messageId) &&
        commandPending(command),
    );
  const latest = current?.messages.at(-1);
  useEffect(() => {
    if (olderScroll.current && feed.current) {
      feed.current.scrollTop =
        olderScroll.current.top +
        feed.current.scrollHeight -
        olderScroll.current.height;
      olderScroll.current = null;
    } else if (person?.id !== lastFeedPerson.current || feedAtBottom.current) {
      if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
      feedAtBottom.current = true;
    }
    lastFeedPerson.current = person?.id ?? "";
  }, [person?.id, current?.syncedAt, current?.messages]);
  const latestOperation = status?.commands.find(
    (command) =>
      [
        "conversation.refresh",
        "conversation.message.analyze",
        "conversation.drafts.generate",
        "conversation.message.recognize",
      ].includes(command.type) && command.payload.id === conversationId,
  );
  const operationDisabled = busy || !online || !person;
  const profile = current?.profile;
  const actions = (type: RemoteCommand["type"], messageId?: string) => {
    if (!person) return;
    const target = messageId
      ? current?.messages.find((item) => item.id === messageId)
      : undefined;
    if (messageId && !target) return;
    void queue(type, {
      id: person.id,
      ...(target
        ? { messageId: target.id, expectedMessageRevision: target.revision }
        : {}),
      ...(type === "conversation.drafts.generate" &&
      replyIntents[person.id]?.trim()
        ? { intent: replyIntents[person.id].trim() }
        : {}),
    });
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success("回复已复制");
    } catch {
      message.error("复制失败，请长按或选中文字手动复制");
    }
  };
  return (
    <section className="chat-current" aria-label="会话动态">
      <div className="chat-current-toolbar">
        <Select
          aria-label="选择 Mac 设备"
          value={deviceId}
          placeholder="选择 Mac 设备"
          onChange={(id) => {
            setStatus(null);
            setConversationId(undefined);
            setDeviceId(id);
          }}
          options={usable.map((device) => ({
            value: device.id,
            label: device.name,
          }))}
        />
        <Select
          aria-label="选择当前会话"
          value={snapshot?.remoteEnabled ? conversationId : undefined}
          placeholder="选择联系人"
          onChange={setConversationId}
          showSearch
          optionFilterProp="label"
          options={people.map((item) => ({
            value: item.id,
            label: `${item.name}${item.processing?.affinityEnabled && item.affinity !== null && item.affinity !== undefined ? ` · ${item.affinity}%` : ""}`,
          }))}
        />
        <Button
          icon={<RefreshCw size={15} />}
          loading={loading}
          disabled={!deviceId || busy}
          onClick={() => {
            void read();
            archive.refresh();
          }}
        >
          刷新网页
        </Button>
        {deviceId && (
          <Button
            icon={<Settings2 size={15} />}
            onClick={() => onConfigure(deviceId)}
          >
            配置与档案
          </Button>
        )}
      </div>
      {(error || archive.error) && (
        <Alert
          className="form-alert"
          type="error"
          showIcon
          message={error || archive.error}
        />
      )}
      {!usable.length ? (
        <div className="chat-empty">
          <Empty description="先绑定一台 Mac，在电脑上开启会话动态同步" />
        </div>
      ) : loading && !status ? (
        <div className="chat-empty">
          <Spin />
        </div>
      ) : !snapshot ? (
        <div className="chat-empty">
          <Empty description="等待 Mac 上报会话动态" />
          <p>在 Mac 设置中导入连接配置并开启远程管理。</p>
        </div>
      ) : (
        <>
          <div className="chat-current-status">
            <Tag color={online ? "green" : "default"}>
              {online
                ? "Mac 在线"
                : connection === "disabled"
                  ? "远程管理已关闭"
                  : "Mac 离线"}
            </Tag>
            <span>
              会话同步于{" "}
              {time(current?.syncedAt ?? snapshot.currentView?.syncedAt)}
            </span>
            <span>网页每 5 秒检查更新</span>
          </div>
          {snapshot.remoteEnabled && (
            <p className="chat-current-note">
              {archiveReady
                ? `已归档 ${archive.directory.progress?.totalConversations ?? 0} 位联系人、${archive.directory.progress?.totalMessages ?? 0} 条消息。已读取的完整历史会逐批上传，可查看更早消息。`
                : archive.directory.mode === "legacy"
                  ? "服务器尚未支持完整历史，当前仅展示旧版近况；更新服务器和 Mac 后可完整归档。"
                  : "等待 Mac 上传完整历史，当前先展示已同步的近况。"}
              {archiveReady &&
                archive.directory.progress?.phase === "backfill" &&
                " 历史仍在补齐，当前数量会继续增加。"}
              {archiveReady &&
                (archive.directory.progress?.expectedMessages ?? 0) >
                  (archive.directory.progress?.totalMessages ?? 0) &&
                ` 正在同步本机已读取的 ${archive.directory.progress?.expectedMessages} 条记录。`}
            </p>
          )}
          {connection === "disabled" && (
            <Alert
              className="form-alert"
              type="info"
              showIcon
              message="远程管理已关闭，会话内容已隐藏"
              description="在 Mac 相知中重新开启远程管理后才会继续同步。设备配置入口仍可使用。"
            />
          )}
          {connection === "offline" && !!snapshot.currentView && (
            <Alert
              className="form-alert"
              type="warning"
              showIcon
              message="当前显示最近同步的信息"
              description="Mac 恢复运行并连接后才会更新；远程操作暂不可用。"
            />
          )}
          {snapshot.remoteEnabled && !supported("conversation.refresh") && (
            <Alert
              className="form-alert"
              type="info"
              showIcon
              message="更新 Mac 相知后可查看会话动态"
              description="当前 Mac 版本仍可通过“配置与档案”管理已支持的设置。更新后可同步完整消息历史、逐条分析和回复草稿。"
            />
          )}
          {!snapshot.currentView && !archiveReady ? (
            <div className="chat-empty">
              <Empty
                description={
                  connection === "disabled"
                    ? "会话动态已隐藏"
                    : "尚未同步会话动态"
                }
              />
              <p>
                保持 Mac
                运行并开启同步后，可在这里查看完整消息历史、逐条分析、回复草稿、对方档案和记忆。
              </p>
            </div>
          ) : !person ? (
            <div className="chat-empty">
              <Empty description="请先添加并选择微信联系人" />
            </div>
          ) : (
            <>
              <div className="chat-current-person">
                <div>
                  <h2>
                    {person.name}
                    {person.processing?.affinityEnabled &&
                      person.affinity !== null &&
                      person.affinity !== undefined && (
                        <span
                          className="chat-current-affinity"
                          title="根据互动估计"
                        >
                          <Heart size={13} />
                          {person.affinity}%
                        </span>
                      )}
                  </h2>
                  <p>
                    {person.enabled ? "持续读取已开启" : "持续读取已暂停"} ·{" "}
                    {person.autoReplyEnabled
                      ? snapshot.settings.autoReplyEnabled
                        ? "自动草稿已开启"
                        : "自动草稿等待全局开启"
                      : "自动草稿已关闭"}
                    {current?.wechat &&
                      ` · 最近读取 ${time(current.wechat.lastCheckedAt)}`}
                  </p>
                  {archiveReady && (
                    <p>{historyReadLabel(historyContact?.history)}</p>
                  )}
                </div>
                <Space wrap>
                  {supported("conversation.refresh") && (
                    <Button
                      icon={<RefreshCw size={14} />}
                      disabled={
                        operationDisabled || !!pending("conversation.refresh")
                      }
                      onClick={() => actions("conversation.refresh")}
                    >
                      继续读取消息
                    </Button>
                  )}
                  {supported("conversation.drafts.generate") && (
                    <Button
                      type="primary"
                      icon={<Sparkles size={14} />}
                      disabled={
                        operationDisabled ||
                        latest?.role !== "peer" ||
                        !!pending("conversation.drafts.generate")
                      }
                      onClick={() =>
                        latest &&
                        actions("conversation.drafts.generate", latest.id)
                      }
                    >
                      生成回复草稿
                    </Button>
                  )}
                </Space>
              </div>
              {latestOperation && (
                <p className="chat-current-operation" role="status">
                  {remoteCommandLabels[latestOperation.type]}：
                  {remoteCommandStates[latestOperation.status]}
                  {latestOperation.error && ` · ${latestOperation.error}`}
                </p>
              )}
              {!current ? (
                <div className="chat-empty">
                  <Empty description="这位联系人的会话动态尚未同步" />
                </div>
              ) : (
                <div className="chat-current-grid">
                  <section
                    className="chat-current-feed paper-panel"
                    aria-label={`${person.name}的聊天记录`}
                    ref={feed}
                    onScroll={(event) => {
                      const element = event.currentTarget;
                      feedAtBottom.current =
                        element.scrollHeight -
                          element.scrollTop -
                          element.clientHeight <
                        80;
                    }}
                  >
                    <h3>
                      聊天记录
                      <span>
                        {archive.page
                          ? `已展开 ${current.messages.length} / ${archive.page.total} 条`
                          : `${current.messages.length} 条`}
                      </span>
                    </h3>
                    <p className="chat-current-note">
                      {archive.page
                        ? "分页仅影响网页展示；分析会读取本机可用的全部历史，长对话按段整理并保存在本地。"
                        : "完整历史尚未归档，当前显示最近同步的近况。"}
                    </p>
                    {archive.notice && (
                      <p className="chat-current-note" role="status">
                        {archive.notice}
                      </p>
                    )}
                    {archive.page?.next_cursor && (
                      <Button
                        block
                        loading={archive.loadingOlder}
                        onClick={() => {
                          if (feed.current) {
                            olderScroll.current = {
                              height: feed.current.scrollHeight,
                              top: feed.current.scrollTop,
                            };
                            feedAtBottom.current = false;
                          }
                          void archive.loadOlder();
                        }}
                      >
                        查看更早消息
                      </Button>
                    )}
                    {archive.loading && !archive.page && <Spin size="small" />}
                    {archive.page &&
                      !archive.page.next_cursor &&
                      current.messages.length > 0 && (
                        <p className="chat-current-note">
                          已到服务器已保存历史的开头
                        </p>
                      )}
                    {current.truncated && (
                      <p className="chat-current-note">
                        显示最近同步的部分消息，较早记录保留在 Mac。
                      </p>
                    )}
                    {!current.messages.length && (
                      <Empty description="等待读取消息" />
                    )}
                    {current.messages.map((item) => (
                      <article
                        key={item.id}
                        className={`chat-current-message ${item.role}`}
                      >
                        <div className="chat-current-message-meta">
                          <strong>
                            {item.role === "self"
                              ? "我"
                              : item.role === "system"
                                ? "系统"
                                : person.name}
                          </strong>
                          <span>{time(item.sentAt)}</span>
                          {item.kind !== "text" && (
                            <Tag>{currentKindLabels[item.kind]}</Tag>
                          )}
                        </div>
                        <div className="chat-current-bubble">
                          <p>
                            {item.text || `[${currentKindLabels[item.kind]}]`}
                          </p>
                          {item.truncated && <small>较长内容已截取</small>}
                          {item.mediaSummary && (
                            <section className="chat-current-media">
                              <strong>
                                {item.kind === "voice"
                                  ? "语音转写"
                                  : item.kind === "emoji" ||
                                      item.recognition?.provider === "local"
                                    ? "表情解析"
                                    : "媒体解析"}
                              </strong>
                              <p>{item.mediaSummary}</p>
                              {item.recognition && (
                                <small>
                                  {item.recognition.modelName ||
                                    item.recognition.provider}{" "}
                                  · {time(item.recognition.recognizedAt)}
                                </small>
                              )}
                            </section>
                          )}
                        </div>
                        {person.processing?.intentEnabled &&
                          !!item.analysis?.intents.length && (
                            <div
                              className="chat-current-analysis"
                              aria-label="这条消息的意图分析"
                            >
                              <Sparkles size={13} />
                              <span>可能的意图（模型估计）</span>
                              {item.analysis?.stale && (
                                <Tag color="orange">
                                  历史或模型有变化，待更新
                                </Tag>
                              )}
                              <div className="chat-current-intents">
                                {currentIntentLabels(item).map(
                                  (intent, index) => (
                                    <Tag key={`${intent.label}-${index}`}>
                                      {intent.label}{" "}
                                      <strong>{intent.percentage}%</strong>
                                    </Tag>
                                  ),
                                )}
                              </div>
                              <details className="chat-current-intent-help">
                                <summary>比例说明</summary>
                                <p>
                                  这些比例是模型对不同理解分配的相对权重。比例越高，表示模型越倾向这种理解；各项合计
                                  100%，不表示真实概率或情绪强度。
                                </p>
                                {item.analysis.intents.some(
                                  (intent) => intent.label === "其他",
                                ) && <p>其他：未归入现有分类的可能含义。</p>}
                              </details>
                              <small>
                                {item.analysis.modelName ||
                                  item.analysis.provider}{" "}
                                · {time(item.analysis.analyzedAt)}
                              </small>
                            </div>
                          )}
                        {item.role === "peer" && (
                          <Space className="chat-current-message-actions" wrap>
                            {supported("conversation.message.analyze") &&
                              (person.processing?.intentEnabled ||
                                person.processing?.affinityEnabled) && (
                                <Button
                                  size="small"
                                  disabled={
                                    operationDisabled ||
                                    !!pending(
                                      "conversation.message.analyze",
                                      item.id,
                                    )
                                  }
                                  onClick={() =>
                                    actions(
                                      "conversation.message.analyze",
                                      item.id,
                                    )
                                  }
                                >
                                  {item.analysis
                                    ? "更新这条分析"
                                    : "分析这条消息"}
                                </Button>
                              )}
                            {supported("conversation.message.recognize") &&
                              ["image", "voice", "emoji"].includes(
                                item.kind,
                              ) && (
                                <Button
                                  size="small"
                                  disabled={
                                    operationDisabled ||
                                    !!pending(
                                      "conversation.message.recognize",
                                      item.id,
                                    )
                                  }
                                  onClick={() =>
                                    actions(
                                      "conversation.message.recognize",
                                      item.id,
                                    )
                                  }
                                >
                                  {item.mediaSummary
                                    ? "查看 / 更新媒体解析"
                                    : "解析媒体内容"}
                                </Button>
                              )}
                          </Space>
                        )}
                      </article>
                    ))}
                  </section>
                  <aside className="chat-current-context">
                    <section
                      className="paper-panel chat-current-drafts"
                      aria-label="本次回复草稿"
                    >
                      <h3>
                        回复草稿<span>{current.drafts.length} 条</span>
                      </h3>
                      {supported("conversation.drafts.generate") && (
                        <div className="chat-current-reply-intent">
                          <label htmlFor={`remote-reply-intent-${person.id}`}>
                            这次想表达什么（可选）
                          </label>
                          <Input.TextArea
                            id={`remote-reply-intent-${person.id}`}
                            maxLength={300}
                            rows={2}
                            value={replyIntents[person.id] ?? ""}
                            onChange={(event) =>
                              setReplyIntents((previous) => ({
                                ...previous,
                                [person.id]: event.target.value,
                              }))
                            }
                            placeholder="例如：自然接话，商量周末时间"
                          />
                          <Button
                            icon={<Sparkles size={14} />}
                            disabled={
                              operationDisabled ||
                              latest?.role !== "peer" ||
                              !!pending("conversation.drafts.generate")
                            }
                            onClick={() =>
                              latest &&
                              actions("conversation.drafts.generate", latest.id)
                            }
                          >
                            生成回复草稿
                          </Button>
                        </div>
                      )}
                      {currentDraftsAreStale(current) && (
                        <Alert
                          type="warning"
                          showIcon
                          message="对话已有变化，请重新生成草稿"
                        />
                      )}
                      {!current.drafts.length && (
                        <Empty description="尚未生成回复草稿" />
                      )}
                      {current.drafts.map((draft) => (
                        <article className="chat-draft" key={draft.id}>
                          <div className="chat-draft-label">
                            <strong>{draft.label || "回复建议"}</strong>
                            <Button
                              size="small"
                              icon={<Copy size={13} />}
                              onClick={() => void copy(draft.text)}
                            >
                              复制
                            </Button>
                          </div>
                          <p className="chat-draft-text">{draft.text}</p>
                          <small>
                            {draft.modelName || draft.provider} ·{" "}
                            {time(draft.createdAt)}
                          </small>
                          {draft.reason && (
                            <p className="chat-draft-reason">{draft.reason}</p>
                          )}
                        </article>
                      ))}
                      <p className="chat-current-note">
                        复制后由你在微信中发送。
                      </p>
                    </section>
                    <section
                      className="paper-panel chat-current-profile"
                      aria-label="对方档案与记忆"
                    >
                      <h3>
                        <BookOpen size={16} />
                        对方档案与记忆
                      </h3>
                      {current.profileTruncated && (
                        <p className="chat-current-note">
                          档案较长，当前仅展示部分内容；完整内容可在“配置与档案”中读取。
                        </p>
                      )}
                      {profile ? (
                        <>
                          {profile.basisFacts.length ? (
                            <ul className="chat-current-facts">
                              {profile.basisFacts.map((fact) => (
                                <li key={fact.id}>
                                  <Tag>{basisLabels[fact.category]}</Tag>
                                  <p>{fact.content}</p>
                                  <small>
                                    {fact.origin === "manual"
                                      ? "个人补充"
                                      : "模型整理"}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="chat-current-note">
                              还没有基础信息。
                            </p>
                          )}
                          {profile.memory?.summary && (
                            <>
                              <h4>对话摘要</h4>
                              <p className="chat-current-memory">
                                {profile.memory.summary}
                              </p>
                            </>
                          )}
                          {!!profile.memory?.openTopics.length && (
                            <>
                              <h4>待续话题</h4>
                              <ul>
                                {profile.memory.openTopics.map(
                                  (topic, index) => (
                                    <li key={index}>{topic}</li>
                                  ),
                                )}
                              </ul>
                            </>
                          )}
                          {!!profile.memory?.entries.length && (
                            <details>
                              <summary>
                                记忆条目（{profile.memory.entries.length}）
                              </summary>
                              <ul>
                                {profile.memory.entries.map((entry) => (
                                  <li key={entry.id}>
                                    {entry.text}
                                    <Tag>
                                      {entry.status === "approved"
                                        ? "已确认"
                                        : "待确认"}
                                    </Tag>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                          {!profile.memory && (
                            <p className="chat-current-note">
                              还没有对话记忆。
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="chat-current-note">
                          档案和记忆尚未同步。
                        </p>
                      )}
                      <Button
                        disabled={!canConfigurePerson}
                        onClick={() =>
                          deviceId && onConfigure(deviceId, person.id)
                        }
                      >
                        修改档案、记忆与个人配置
                      </Button>
                      {!canConfigurePerson && (
                        <p className="chat-current-note">
                          此人的消息已进入历史归档。个人配置尚未进入设备配置快照，可先在
                          Mac 修改；读取、识别、分析和生成草稿仍可在本页操作。
                        </p>
                      )}
                    </section>
                  </aside>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
