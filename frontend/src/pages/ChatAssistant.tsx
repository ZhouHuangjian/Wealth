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
  Laptop,
  LogOut,
  MessageCircle,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, send } from "../api";
import { PageTitle, Panel } from "../components";
import { ThemeSwitcher } from "../ThemeProvider";
import "./chat-assistant.css";

type AccountResponse = { user_id: string | number };
type ChatAccess = AccountResponse & { enabled: boolean; is_admin: boolean };
type Device = {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};
type DraftBatch = {
  id: string;
  device_id: string;
  device_name: string;
  batch_id: string;
  conversation_key: string;
  conversation_name: string;
  based_on_message_id: string;
  created_at: string;
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
}: {
  user: { id: string; username: string; is_platform_admin?: boolean };
  returnPath: string;
  onAuthChange: () => Promise<void>;
}) {
  const navigate = useNavigate();
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
  const [adding, setAdding] = useState(false);
  const [createError, setCreateError] = useState("");
  const [binding, setBinding] = useState<Binding | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [form] = Form.useForm();
  const active = useRef(false),
    reading = useRef(false),
    historyMode = useRef(false),
    generation = useRef(0),
    refreshAuth = useRef(onAuthChange);
  refreshAuth.current = onAuthChange;

  const clearPrivate = useCallback(() => {
    generation.current++;
    reading.current = false;
    Modal.destroyAll();
    setLoading(false);
    setBusy(null);
    setDevices([]);
    setBatches([]);
    setCursor(null);
    setBinding(null);
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
      setLoading(true);
      setError("");
      try {
        const status = await api<ChatAccess>("/chat/me");
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
                `/chat/drafts?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`,
              )
            : Promise.resolve(null),
        ]);
        if (
          !acceptResponse(deviceResult, current) ||
          (draftResult && !acceptResponse(draftResult, current))
        )
          return;
        setDevices(deviceResult.items);
        if (draftResult) {
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
        if (!active.current || current !== generation.current) return;
        rejectAccess(e);
        setError((e as Error).message);
      } finally {
        if (current === generation.current) {
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
  async function remove(path: string, key: string) {
    const current = generation.current;
    setBusy(key);
    try {
      const result = await api<AccountResponse>(path, {
        method: "DELETE",
        body: JSON.stringify({}),
        headers: { "X-Chat-User-Id": String(user.id) },
      });
      if (!acceptResponse(result, current)) return;
      if (key.startsWith("draft:"))
        setBatches((items) => items.filter((item) => item.id !== key.slice(6)));
      else
        setDevices((items) =>
          items.map((item) =>
            item.id === key.slice(7)
              ? { ...item, revoked_at: new Date().toISOString() }
              : item,
          ),
        );
      message.success(key.startsWith("draft:") ? "草稿已删除" : "设备已撤销");
    } catch (e) {
      if (current !== generation.current || !active.current) return;
      rejectAccess(e);
      message.error((e as Error).message);
    } finally {
      if (current === generation.current && active.current) setBusy(null);
    }
  }
  const uploadUrl = binding
    ? new URL(binding.upload_path, window.location.origin).href
    : "";

  return (
    <main className="chat-workspace">
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
              ? "在聊天管理中为自己的账号开启，再绑定 Mac。"
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
            onChange={setTab}
            items={[
              {
                key: "drafts",
                label: "回复草稿",
                children: (
                  <>
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
                        <Empty description="还没有同步的回复草稿" />
                        <p className="chat-center">
                          先绑定
                          Mac，并在相知中导入同步配置。收到新消息生成草稿后，会显示在这里。
                        </p>
                        <div className="chat-center">
                          <Button
                            type="primary"
                            icon={<Laptop size={16} />}
                            onClick={() => setTab("devices")}
                          >
                            绑定 Mac 设备
                          </Button>
                        </div>
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
                          <article
                            className="chat-batch paper-panel"
                            key={batch.id}
                          >
                            <div className="chat-batch-heading">
                              <div>
                                <h2>
                                  {batch.conversation_name || "未命名会话"}
                                </h2>
                                <p>
                                  {chatTime(batch.created_at)} 生成 ·{" "}
                                  {batch.device_name || "已绑定设备"}
                                </p>
                              </div>
                              <Button
                                type="text"
                                danger
                                aria-label={`删除${batch.conversation_name || "此会话"}的这批草稿`}
                                icon={<Trash2 size={16} />}
                                loading={busy === `draft:${batch.id}`}
                                disabled={
                                  !!busy && busy !== `draft:${batch.id}`
                                }
                                onClick={() =>
                                  modal.confirm({
                                    title: "删除这批回复草稿？",
                                    content:
                                      "删除此批次在服务器保存的草稿，Mac 上的记录保留。",
                                    okText: "删除草稿",
                                    okButtonProps: { danger: true },
                                    cancelText: "取消",
                                    onOk: () =>
                                      remove(
                                        `/chat/drafts/${batch.id}`,
                                        `draft:${batch.id}`,
                                      ),
                                  })
                                }
                              />
                            </div>
                            <div className="chat-draft-options">
                              {batch.drafts.map((draft, index) => (
                                <section className="chat-draft" key={index}>
                                  <div className="chat-draft-label">
                                    <strong>
                                      {draft.label || `回复 ${index + 1}`}
                                    </strong>
                                    <Button
                                      size="small"
                                      icon={<Copy size={14} />}
                                      onClick={() =>
                                        void copy(draft.text, "回复")
                                      }
                                    >
                                      复制回复
                                    </Button>
                                  </div>
                                  <p className="chat-draft-text">
                                    {draft.text}
                                  </p>
                                  {draft.reason && (
                                    <p className="chat-draft-reason">
                                      {draft.reason}
                                    </p>
                                  )}
                                </section>
                              ))}
                            </div>
                            <div className="chat-batch-meta">
                              <span>
                                {batch.provider || "本地生成"}
                                {batch.profile_version
                                  ? ` · 习惯版本 ${batch.profile_version}`
                                  : ""}
                              </span>
                              <span>同步于 {chatTime(batch.received_at)}</span>
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
                ),
              },
              {
                key: "devices",
                label: `设备绑定${devices.length ? ` (${devices.filter((device) => !device.revoked_at).length})` : ""}`,
                children: (
                  <Panel
                    title="我的 Mac 设备"
                    subtitle="在此创建设备凭据，然后在 Mac 的相知设置中导入同步配置。"
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
                        绑定新设备
                      </Button>
                    }
                  >
                    {!devices.length ? (
                      <Empty description="尚未绑定设备" />
                    ) : (
                      <div className="chat-device-list">
                        {devices.map((device) => (
                          <div className="chat-device" key={device.id}>
                            <Laptop size={24} />
                            <div>
                              <strong>{device.name}</strong>
                              <p>创建于 {chatTime(device.created_at)}</p>
                              <p>最近连接：{chatTime(device.last_seen_at)}</p>
                            </div>
                            {device.revoked_at ? (
                              <Tag>已撤销</Tag>
                            ) : (
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
                                      "此设备将不能继续上传。已同步草稿保留，重新连接需创建新的设备凭据。",
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
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Panel>
                ),
              },
            ]}
          />
        </>
      )}
      <Modal
        title="绑定新设备"
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
        title="复制设备同步配置"
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
              message="凭据仅在本次显示"
              description="复制配置后，到这台 Mac 的相知设置中导入。关闭后无法再次查看；丢失时可撤销设备并重新创建。"
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
    </main>
  );
}
