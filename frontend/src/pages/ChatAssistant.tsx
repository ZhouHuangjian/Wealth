import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Tabs,
  Tag,
} from "antd";
import {
  ArrowLeft,
  Copy,
  Download,
  Laptop,
  LogOut,
  MessageCircle,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, send } from "../api";
import { PageTitle, Panel } from "../components";
import { ThemeSwitcher } from "../ThemeProvider";
import {
  chatInboxEmptyState,
  deviceConfigurationAction,
  deviceConnectionState,
  reconcileDeviceList,
} from "../chat-device-model";
import type { ChatDevice as Device } from "../chat-device-model";
import DeviceRemoteControl from "./DeviceRemoteControl";
import "./chat-assistant.css";

type AccountResponse = { user_id: string | number };
type ChatAccess = AccountResponse & { enabled: boolean; is_admin: boolean };
type DraftBatch = {
  id: string;
  device_id: string;
  device_name: string;
  batch_id: string;
  conversation_key: string;
  conversation_name: string;
  based_on_message_id: string;
  created_at: string | null;
  deleted_at: string | null;
  can_restore: boolean;
  received_at: string;
  provider: string;
  profile_version: string | null;
  drafts: { text: string; label: string; reason: string }[];
};
type DraftPage = AccountResponse & {
  items: DraftBatch[];
  next_cursor: string | null;
};
type Binding = AccountResponse & {
  device: Device;
  token: string;
  upload_path: string;
};

export function chatTime(value: string | null) {
  if (!value) return "尚未连接";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { hour12: false });
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  try {
    if (!document.execCommand("copy"))
      throw new Error("复制失败，请手动选择并复制文本");
  } finally {
    input.remove();
  }
}

export default function ChatAssistant({
  user,
  returnPath,
  onAuthChange,
  embedded = false,
}: {
  embedded?: boolean;
  user: { id: string; username: string; is_platform_admin?: boolean };
  returnPath: string;
  onAuthChange: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const Container = embedded ? "section" : "main";
  const { message, modal } = App.useApp();
  const [access, setAccess] = useState<ChatAccess | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [batches, setBatches] = useState<DraftBatch[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [conversation, setConversation] = useState<string | undefined>();
  const [tab, setTab] = useState("drafts");
  const [trash, setTrash] = useState(false);
  const [adding, setAdding] = useState(false);
  const [createError, setCreateError] = useState("");
  const [binding, setBinding] = useState<Binding | null>(null);
  const [remoteDeviceId, setRemoteDeviceId] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [form] = Form.useForm();
  const active = useRef(false),
    reading = useRef(false),
    historyMode = useRef(false),
    generation = useRef(0),
    deviceRevision = useRef(0),
    draftRevision = useRef(0),
    readEpoch = useRef(0),
    trashMode = useRef(false),
    refreshAuth = useRef(onAuthChange);
  refreshAuth.current = onAuthChange;

  const clearPrivate = useCallback(() => {
    generation.current++;
    readEpoch.current++;
    reading.current = false;
    Modal.destroyAll();
    setLoading(false);
    setBusy(null);
    setDevices([]);
    setBatches([]);
    setCursor(null);
    setBinding(null);
    setRemoteDeviceId(null);
    setAdding(false);
    setConversation(undefined);
    setHistory(false);
    historyMode.current = false;
  }, []);
  const acceptResponse = useCallback(
    (response: AccountResponse, current: number) => {
      if (!active.current || current !== generation.current) return false;
      if (String(response.user_id) === String(user.id)) return true;
      clearPrivate();
      setAccess(null);
      setError("登录账号已变化，正在重新载入…");
      void refreshAuth.current();
      return false;
    },
    [user.id, clearPrivate],
  );
  const rejectAccess = useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError) || ![401, 403].includes(e.status)) return;
      clearPrivate();
      setAccess(null);
      void refreshAuth.current();
    },
    [clearPrivate],
  );
  const read = useCallback(
    async (reset = false, before?: string) => {
      if (reading.current) return;
      reading.current = true;
      const current = generation.current;
      const epoch = ++readEpoch.current;
      const requestedDeviceRevision = deviceRevision.current;
      const requestedDraftRevision = draftRevision.current;
      const requestedTrash = trashMode.current;
      setLoading(true);
      setError("");
      try {
        const status = await api<ChatAccess>("/chat/me");
        if (epoch !== readEpoch.current) return;
        if (!acceptResponse(status, current)) return;
        setAccess(status);
        if (!status.enabled) {
          clearPrivate();
          return;
        }
        const shouldReadDrafts = reset || !!before || !historyMode.current;
        const [deviceResult, draftResult] = await Promise.all([
          api<AccountResponse & { items: Device[] }>("/chat/devices"),
          shouldReadDrafts
            ? api<DraftPage>(
                `/chat/drafts?limit=50${requestedTrash ? "&deleted=true" : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
              )
            : Promise.resolve(null),
        ]);
        if (epoch !== readEpoch.current) return;
        if (
          !acceptResponse(deviceResult, current) ||
          (draftResult && !acceptResponse(draftResult, current))
        )
          return;
        setDevices((previous) =>
          reconcileDeviceList(
            previous,
            deviceResult.items,
            requestedDeviceRevision,
            deviceRevision.current,
          ),
        );
        if (
          draftResult &&
          requestedTrash === trashMode.current &&
          requestedDraftRevision === draftRevision.current
        ) {
          setBatches((previous) =>
            before
              ? [
                  ...previous,
                  ...draftResult.items.filter(
                    (item) => !previous.some((old) => old.id === item.id),
                  ),
                ]
              : draftResult.items,
          );
          setCursor(draftResult.next_cursor);
          historyMode.current = !!before;
          setHistory(!!before);
        }
        setCheckedAt(new Date().toISOString());
      } catch (e) {
        if (
          !active.current ||
          current !== generation.current ||
          epoch !== readEpoch.current
        )
          return;
        rejectAccess(e);
        setError((e as Error).message);
      } finally {
        if (current === generation.current && epoch === readEpoch.current) {
          reading.current = false;
          if (active.current) setLoading(false);
        }
      }
    },
    [clearPrivate, acceptResponse, rejectAccess],
  );

  useEffect(() => {
    active.current = true;
    void read(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 30000);
    // Another tab can replace the session cookie; discard cached private state
    // before showing this page again, and verify the owner of every response.
    const checkFocus = () => {
      clearPrivate();
      setAccess(null);
      void read(true);
    };
    const visibility = () => {
      if (document.visibilityState === "visible") checkFocus();
      else {
        clearPrivate();
        setAccess(null);
      }
    };
    window.addEventListener("focus", checkFocus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active.current = false;
      Modal.destroyAll();
      generation.current++;
      reading.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", checkFocus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [read, clearPrivate]);

  const contacts = useMemo(
    () => [
      ...new Map(
        batches.map((batch) => [
          batch.conversation_key,
          batch.conversation_name || "未命名会话",
        ]),
      ).entries(),
    ],
    [batches],
  );
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return batches.filter(
      (batch) =>
        (!conversation || batch.conversation_key === conversation) &&
        (!search ||
          [batch.conversation_name, ...batch.drafts.map((draft) => draft.text)]
            .join(" ")
            .toLocaleLowerCase()
            .includes(search)),
    );
  }, [batches, conversation, query]);

  async function copy(value: string, label: string) {
    try {
      await copyText(value);
      message.success(`${label}已复制`);
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  function refreshAfterMutation() {
    readEpoch.current++;
    reading.current = false;
    void read(true);
  }
  function switchTab(next: string) {
    setTab(next);
    if (next === "devices") return;
    const deleted = next === "trash";
    if (deleted === trashMode.current) return;
    trashMode.current = deleted;
    setTrash(deleted);
    draftRevision.current++;
    setBatches([]);
    setCursor(null);
    setQuery("");
    setConversation(undefined);
    historyMode.current = false;
    setHistory(false);
    refreshAfterMutation();
  }
  async function remove(
    path: string,
    key: string,
    action: "trash" | "restore" | "permanent" | "revoke" = "revoke",
  ) {
    const current = generation.current;
    setBusy(key);
    try {
      const result = await api<AccountResponse>(path, {
        method: action === "restore" ? "POST" : "DELETE",
        body: JSON.stringify({}),
        headers: { "X-Chat-User-Id": String(user.id) },
      });
      if (!acceptResponse(result, current)) return;
      if (key.startsWith("draft:")) {
        draftRevision.current++;
        if (
          action === "permanent" ||
          (action === "restore" && trashMode.current) ||
          (action === "trash" && !trashMode.current)
        )
          setBatches((items) =>
            items.filter((item) => item.id !== key.slice(6)),
          );
      } else {
        deviceRevision.current++;
        setRemoteDeviceId((selected) =>
          selected === key.slice(7) ? null : selected,
        );
        if (action === "permanent") {
          draftRevision.current++;
          setDevices((items) =>
            items.filter((item) => item.id !== key.slice(7)),
          );
          setBatches((items) =>
            items.filter((item) => item.device_id !== key.slice(7)),
          );
          setBinding((currentBinding) =>
            currentBinding?.device.id === key.slice(7) ? null : currentBinding,
          );
        } else
          setDevices((items) =>
            items.map((item) =>
              item.id === key.slice(7)
                ? {
                    ...item,
                    revoked_at: new Date().toISOString(),
                    config_available: false,
                    connection_state: "revoked" as const,
                  }
                : item,
            ),
          );
      }
      message.success(
        action === "trash"
          ? "草稿已移到回收站"
          : action === "restore"
            ? "草稿已恢复"
            : action === "permanent"
              ? "已永久删除"
              : "设备已撤销",
      );
      if (action !== "revoke") refreshAfterMutation();
    } catch (e) {
      if (current !== generation.current || !active.current) return;
      rejectAccess(e);
      message.error((e as Error).message);
    } finally {
      if (current === generation.current && active.current) setBusy(null);
    }
  }
  async function loadConfiguration(device: Device, rotate = false) {
    if (busy || deviceConnectionState(device) === "revoked") return;
    const current = generation.current;
    setBusy(`config:${device.id}`);
    setError("");
    try {
      const result = await api<Binding>(
        `/chat/devices/${device.id}/${rotate ? "rotate" : "config"}`,
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "X-Chat-User-Id": String(user.id) },
        },
      );
      if (!acceptResponse(result, current)) return;
      deviceRevision.current++;
      setDevices((items) =>
        items.map((item) =>
          item.id === result.device.id ? result.device : item,
        ),
      );
      setBinding(result);
    } catch (e) {
      if (current !== generation.current || !active.current) return;
      rejectAccess(e);
      setError((e as Error).message);
      // A device created before encrypted configuration storage may need a
      // single explicit rotation; a failed fetch never rotates credentials.
      if (!rotate && e instanceof ApiError && e.status === 409) {
        deviceRevision.current++;
        setDevices((items) =>
          items.map((item) =>
            item.id === device.id ? { ...item, config_available: false } : item,
          ),
        );
      }
    } finally {
      if (current === generation.current && active.current) setBusy(null);
    }
  }
  function confirmRotation(device: Device) {
    modal.confirm({
      title: `重新生成“${device.name}”的连接配置？`,
      content:
        "旧配置将立即失效，需要把新配置重新导入 Mac。设备和已同步草稿保留，生成后可随时再次查看。",
      okText: "重新生成配置",
      cancelText: "取消",
      onOk: () => loadConfiguration(device, true),
    });
  }
  function confirmPermanentDraft(batch: DraftBatch) {
    modal.confirm({
      title: "永久删除这批回复草稿？",
      content:
        "将从服务器永久删除，此操作不可恢复。Mac 原始记录保留；已永久删除的草稿之后再次同步可能重新出现。",
      okText: "永久删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () =>
        remove(
          `/chat/drafts/${batch.id}/permanent`,
          `draft:${batch.id}`,
          "permanent",
        ),
    });
  }
  function confirmPermanentDevice(device: Device) {
    modal.confirm({
      title: `永久删除“${device.name}”？`,
      content: `将永久删除此设备、远程配置与操作记录及全部关联云端草稿（目前 ${device.draft_count ?? 0} 批，含回收站），不可恢复。旧凭据失效，需要重新添加设备。Mac 原始记录保留；已永久删除的草稿之后再次同步可能重新出现。`,
      okText: "永久删除设备和草稿",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () =>
        remove(
          `/chat/devices/${device.id}/permanent`,
          `device:${device.id}`,
          "permanent",
        ),
    });
  }
  const remoteDevice = devices.find(
    (device) =>
      device.id === remoteDeviceId &&
      deviceConnectionState(device) !== "revoked",
  );
  const inboxEmpty = chatInboxEmptyState(devices);
  const activeDevices = devices.filter(
    (device) => deviceConnectionState(device) !== "revoked",
  );
  const publicUploadUrl = new URL("/api/v1/chat/ingest", window.location.origin)
    .href;
  const uploadUrl = binding
    ? new URL(binding.upload_path, window.location.origin).href
    : "";

  const draftContent = (
    <>
      {trash && (
        <Alert
          className="form-alert"
          type="info"
          showIcon
          message="草稿回收站"
          description="移到回收站的草稿可以恢复。永久删除不可恢复；Mac 原始记录保留，已永久删除的草稿之后再次同步可能重新出现。"
        />
      )}
      <div className="chat-filters">
        <Input.Search
          aria-label="搜索已加载草稿"
          placeholder="搜索已加载的联系人或草稿"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
        />
        <Select
          aria-label="按会话筛选"
          placeholder="全部会话"
          allowClear
          value={conversation}
          onChange={setConversation}
          options={contacts.map(([value, label]) => ({
            value,
            label,
          }))}
        />
      </div>
      {history && (
        <Alert
          className="form-alert"
          type="info"
          message="正在浏览历史草稿，自动更新列表已暂停。点击刷新可返回最近草稿。"
        />
      )}
      {loading && !batches.length ? (
        <div className="chat-empty">
          <Spin />
        </div>
      ) : !batches.length ? (
        <Panel>
          <Empty description={trash ? "回收站是空的" : inboxEmpty.title} />
          {!trash && <p className="chat-center">{inboxEmpty.description}</p>}
          {!trash && (
            <div className="chat-center">
              <Button
                type="primary"
                icon={<Laptop size={16} />}
                onClick={() => setTab("devices")}
              >
                {inboxEmpty.action}
              </Button>
            </div>
          )}
        </Panel>
      ) : !filtered.length ? (
        <Panel>
          <Empty description="已加载草稿中没有匹配内容" />
          <Button
            onClick={() => {
              setQuery("");
              setConversation(undefined);
            }}
          >
            清除筛选
          </Button>
        </Panel>
      ) : (
        <div className="chat-draft-list">
          {filtered.map((batch) => (
            <article className="chat-batch paper-panel" key={batch.id}>
              <div className="chat-batch-heading">
                <div>
                  <h2>{batch.conversation_name || "未命名会话"}</h2>
                  <p>
                    {batch.created_at
                      ? `${chatTime(batch.created_at)} 生成`
                      : "原生成时间不可用"}{" "}
                    · {batch.device_name || "已绑定设备"}
                  </p>
                </div>
                <Space className="chat-batch-actions" wrap>
                  {trash ? (
                    <Button
                      icon={<Undo2 size={15} />}
                      disabled={!batch.can_restore || !!busy}
                      onClick={() =>
                        void remove(
                          `/chat/drafts/${batch.id}/restore`,
                          `draft:${batch.id}`,
                          "restore",
                        )
                      }
                    >
                      恢复
                    </Button>
                  ) : (
                    <Button
                      icon={<Trash2 size={15} />}
                      disabled={!!busy}
                      onClick={() =>
                        modal.confirm({
                          title: "将这批草稿移到回收站？",
                          content:
                            "之后可以在回收站恢复或永久删除。Mac 原始记录保留。",
                          okText: "移到回收站",
                          cancelText: "取消",
                          onOk: () =>
                            remove(
                              `/chat/drafts/${batch.id}`,
                              `draft:${batch.id}`,
                              "trash",
                            ),
                        })
                      }
                    >
                      移到回收站
                    </Button>
                  )}
                  <Button
                    danger
                    disabled={!!busy}
                    onClick={() => confirmPermanentDraft(batch)}
                  >
                    永久删除
                  </Button>
                </Space>
              </div>
              <div className="chat-draft-options">
                {trash && !batch.can_restore && (
                  <Alert
                    type="warning"
                    showIcon
                    message="旧版内容已清除，无法恢复"
                    description="这条旧记录仍可永久删除。"
                  />
                )}
                {batch.drafts.map((draft, index) => (
                  <section className="chat-draft" key={index}>
                    <div className="chat-draft-label">
                      <strong>{draft.label || `回复 ${index + 1}`}</strong>
                      <Button
                        size="small"
                        icon={<Copy size={14} />}
                        onClick={() => void copy(draft.text, "回复")}
                      >
                        复制回复
                      </Button>
                    </div>
                    <p className="chat-draft-text">{draft.text}</p>
                    {draft.reason && (
                      <p className="chat-draft-reason">{draft.reason}</p>
                    )}
                  </section>
                ))}
              </div>
              <div className="chat-batch-meta">
                <span>
                  {batch.provider || "生成来源不可用"}
                  {batch.profile_version
                    ? ` · 习惯版本 ${batch.profile_version}`
                    : ""}
                </span>
                <span>同步于 {chatTime(batch.received_at)}</span>
                {batch.deleted_at && (
                  <span>移入回收站于 {chatTime(batch.deleted_at)}</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {!!batches.length && (
        <div className="chat-load-more">
          <span>
            已加载 {batches.length} 批草稿
            {filtered.length !== batches.length
              ? `，匹配 ${filtered.length} 批`
              : ""}
          </span>
          {cursor ? (
            <Button
              loading={loading}
              disabled={!!busy}
              onClick={() => void read(false, cursor)}
            >
              加载更早草稿
            </Button>
          ) : (
            <span>已显示全部</span>
          )}
        </div>
      )}
    </>
  );

  return (
    <Container
      className={`chat-workspace${embedded ? " chat-workspace-embedded" : ""}`}
    >
      {!embedded && (
        <div className="chat-topbar">
          <Button
            icon={<ArrowLeft size={16} />}
            onClick={() => navigate(returnPath)}
          >
            {user.is_platform_admin ? "管理工作台" : "返回账簿"}
          </Button>
          <Space>
            <ThemeSwitcher />
            <Button
              aria-label="退出登录"
              icon={<LogOut size={16} />}
              onClick={() =>
                modal.confirm({
                  title: "退出当前账户？",
                  okText: "退出登录",
                  cancelText: "取消",
                  onOk: async () => {
                    await send("/auth/logout");
                    await onAuthChange();
                  },
                })
              }
            />
          </Space>
        </div>
      )}
      {embedded ? (
        <div className="chat-embedded-heading">
          <div>
            <h2>我的聊天</h2>
            <p>{user.username} 的个人会话 · 无需创建或代管财务空间</p>
          </div>
          <Button
            icon={<RefreshCw size={16} />}
            loading={loading}
            disabled={!!busy}
            onClick={() => void read(true)}
          >
            刷新
          </Button>
        </div>
      ) : (
        <PageTitle
          eyebrow=""
          title="聊天助手"
          description={`${user.username} 的个人会话 · 在 Mac 生成，随时查看回复草稿`}
          actions={
            <Button
              icon={<RefreshCw size={16} />}
              loading={loading}
              disabled={!!busy}
              onClick={() => void read(true)}
            >
              刷新
            </Button>
          }
        />
      )}
      {error && (
        <Alert
          className="form-alert"
          type="error"
          showIcon
          message={error}
          action={
            <Button
              size="small"
              onClick={() => void read(true)}
              disabled={loading}
            >
              重试
            </Button>
          }
        />
      )}
      {!access ? (
        <div className="chat-empty">
          {loading ? <Spin /> : <MessageCircle size={32} />}
          <p>
            {loading ? "正在检查聊天功能…" : "暂时无法读取聊天功能，请重试。"}
          </p>
        </div>
      ) : !access.enabled ? (
        <Panel>
          <Empty description="此账号尚未开启聊天助手" />
          <p className="chat-center">
            {access.is_admin
              ? "在“聊天管理”中为自己的账号开启，再回到“我的聊天”添加 Mac 设备。"
              : "请联系管理员为此账号开启聊天功能，无需建立财务空间。"}
          </p>
          {access.is_admin && (
            <div className="chat-center">
              <Button
                type="primary"
                onClick={() => navigate("/admin?tab=chat")}
              >
                前往聊天管理
              </Button>
            </div>
          )}
        </Panel>
      ) : (
        <>
          <div className="chat-status-line">
            <Tag icon={<MessageCircle size={13} />}>个人专属</Tag>
            <span>草稿由绑定的 Mac 上传，网页可查看和复制，不会发送微信。</span>
            <span>
              上次检查：{checkedAt ? chatTime(checkedAt) : "正在读取"}
            </span>
          </div>
          <Tabs
            activeKey={tab}
            onChange={switchTab}
            items={[
              {
                key: "drafts",
                label: "回复草稿",
                destroyOnHidden: true,
                children: draftContent,
              },
              {
                key: "trash",
                label: "回收站",
                destroyOnHidden: true,
                children: draftContent,
              },
              {
                key: "devices",
                label: `我的设备${activeDevices.length ? ` (${activeDevices.length})` : ""}`,
                children: (
                  <Panel
                    title="我的 Mac 设备"
                    subtitle="可随时查看连接配置、远程管理 Mac，或永久删除设备及关联云端数据。"
                    action={
                      <Button
                        type="primary"
                        icon={<Plus size={16} />}
                        disabled={!!busy}
                        onClick={() => {
                          setAdding(true);
                          setCreateError("");
                          form.resetFields();
                        }}
                      >
                        添加设备
                      </Button>
                    }
                  >
                    <div className="chat-upload-address">
                      <label htmlFor="chat-upload-url">草稿上传地址</label>
                      <Space.Compact block>
                        <Input
                          id="chat-upload-url"
                          readOnly
                          value={publicUploadUrl}
                        />
                        <Button
                          icon={<Copy size={14} />}
                          onClick={() => void copy(publicUploadUrl, "上传地址")}
                        >
                          复制地址
                        </Button>
                      </Space.Compact>
                    </div>
                    {!devices.length ? (
                      <Empty description="尚未添加设备" />
                    ) : (
                      <div className="chat-device-list">
                        {devices.map((device) => {
                          const state = deviceConnectionState(device);
                          const configurationAction =
                            deviceConfigurationAction(device);
                          return (
                            <div className="chat-device" key={device.id}>
                              <Laptop size={24} />
                              <div className="chat-device-info">
                                <div className="chat-device-name">
                                  <strong>{device.name}</strong>
                                  <Tag
                                    color={
                                      state === "connected"
                                        ? "green"
                                        : state === "awaiting_connection"
                                          ? "gold"
                                          : undefined
                                    }
                                  >
                                    {state === "revoked"
                                      ? "已撤销"
                                      : state === "connected"
                                        ? "已验证连接"
                                        : "等待 Mac 连接"}
                                  </Tag>
                                </div>
                                <p>创建于 {chatTime(device.created_at)}</p>
                                <p>
                                  最近验证：
                                  {device.last_seen_at
                                    ? chatTime(device.last_seen_at)
                                    : "尚未收到 Mac 验证"}
                                </p>
                                {configurationAction === "rotate" && (
                                  <p>
                                    此设备的旧配置无法取回，请重新生成后导入
                                    Mac。
                                  </p>
                                )}
                              </div>
                              <Space className="chat-device-actions" wrap>
                                {state !== "revoked" && (
                                  <>
                                    <Button
                                      disabled={!!busy}
                                      onClick={() =>
                                        setRemoteDeviceId(device.id)
                                      }
                                    >
                                      远程管理
                                    </Button>
                                    <Button
                                      type="primary"
                                      loading={busy === `config:${device.id}`}
                                      disabled={
                                        !!busy && busy !== `config:${device.id}`
                                      }
                                      onClick={() =>
                                        configurationAction === "rotate"
                                          ? confirmRotation(device)
                                          : void loadConfiguration(device)
                                      }
                                    >
                                      {configurationAction === "rotate"
                                        ? "重新生成配置"
                                        : "查看连接配置"}
                                    </Button>
                                    {configurationAction === "config" && (
                                      <Button
                                        disabled={!!busy}
                                        onClick={() => confirmRotation(device)}
                                      >
                                        重新生成
                                      </Button>
                                    )}
                                    <Button
                                      danger
                                      loading={busy === `device:${device.id}`}
                                      disabled={
                                        !!busy && busy !== `device:${device.id}`
                                      }
                                      onClick={() =>
                                        modal.confirm({
                                          title: `撤销“${device.name}”的连接？`,
                                          content:
                                            "此设备将不能继续连接和上传。已同步草稿保留，重新连接需添加新的设备。",
                                          okText: "撤销设备",
                                          okButtonProps: { danger: true },
                                          cancelText: "取消",
                                          onOk: () =>
                                            remove(
                                              `/chat/devices/${device.id}`,
                                              `device:${device.id}`,
                                            ),
                                        })
                                      }
                                    >
                                      撤销
                                    </Button>
                                  </>
                                )}
                                <Button
                                  danger
                                  disabled={!!busy}
                                  onClick={() => confirmPermanentDevice(device)}
                                >
                                  永久删除
                                </Button>
                              </Space>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Panel>
                ),
              },
            ]}
          />
        </>
      )}
      {remoteDevice && access?.enabled && (
        <DeviceRemoteControl
          key={`${user.id}:${remoteDevice.id}`}
          userId={String(user.id)}
          device={remoteDevice}
          onClose={() => setRemoteDeviceId(null)}
          onAccessError={rejectAccess}
          onPrivateError={() => {
            clearPrivate();
            setAccess(null);
            setError("登录账号已变化，正在重新载入…");
            void refreshAuth.current();
          }}
        />
      )}
      <Modal
        title="添加 Mac 设备"
        open={adding}
        onCancel={() => {
          if (busy !== "create") setAdding(false);
        }}
        footer={null}
        destroyOnHidden
        maskClosable={busy !== "create"}
        closable={busy !== "create"}
      >
        <p>给这台 Mac 起个易于识别的名称。</p>
        {createError && (
          <Alert
            className="form-alert"
            type="error"
            message={createError}
            showIcon
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onFinish={async ({ name }) => {
            const current = generation.current;
            setBusy("create");
            setCreateError("");
            try {
              const result = await api<Binding>("/chat/devices", {
                method: "POST",
                body: JSON.stringify({ name: name.trim() }),
                headers: { "X-Chat-User-Id": String(user.id) },
              });
              if (!acceptResponse(result, current)) return;
              deviceRevision.current++;
              setDevices((items) => [result.device, ...items]);
              setBinding(result);
              setAdding(false);
            } catch (e) {
              if (current !== generation.current || !active.current) return;
              rejectAccess(e);
              setCreateError((e as Error).message);
            } finally {
              if (current === generation.current && active.current)
                setBusy(null);
            }
          }}
        >
          <Form.Item
            name="name"
            label="设备名称"
            rules={[
              { required: true, whitespace: true, message: "请输入设备名称" },
              { max: 80, message: "最多 80 个字符" },
            ]}
          >
            <Input
              autoComplete="off"
              maxLength={80}
              placeholder="例如：我的 MacBook"
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy === "create"}>
            创建同步配置
          </Button>
        </Form>
      </Modal>
      <Modal
        title="设备连接配置"
        open={!!binding}
        onCancel={() => setBinding(null)}
        footer={
          <Button type="primary" onClick={() => setBinding(null)}>
            已保存，关闭
          </Button>
        }
        maskClosable={false}
        destroyOnHidden
      >
        {binding && (
          <div className="chat-binding">
            <Alert
              type="info"
              showIcon
              message="配置已保存，可随时再次查看"
              description="复制或下载配置，到 Mac 相知的设置中导入并验证连接。以后可在“我的设备”中再次打开；重新查看不会使原配置失效。"
            />
            <Form layout="vertical">
              <Form.Item label="设备">{binding.device.name}</Form.Item>
              <Form.Item label="上传地址">
                <Input readOnly value={uploadUrl} />
              </Form.Item>
              <Form.Item label="设备凭据">
                <Input.Password
                  readOnly
                  value={binding.token}
                  autoComplete="off"
                />
              </Form.Item>
            </Form>
            <Space wrap>
              <Button
                type="primary"
                icon={<Copy size={15} />}
                onClick={() =>
                  void copy(
                    JSON.stringify(
                      { uploadUrl, token: binding.token },
                      null,
                      2,
                    ),
                    "同步配置",
                  )
                }
              >
                复制同步配置
              </Button>
              <Button
                icon={<Download size={15} />}
                onClick={() => {
                  const blob = new Blob(
                    [
                      JSON.stringify(
                        { uploadUrl, token: binding.token },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  );
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `xiangzhi-device-${binding.device.id}.json`;
                  link.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                下载配置
              </Button>
              <Button onClick={() => void copy(uploadUrl, "上传地址")}>
                复制地址
              </Button>
              <Button onClick={() => void copy(binding.token, "设备凭据")}>
                复制凭据
              </Button>
            </Space>
          </div>
        )}
      </Modal>
    </Container>
  );
}
