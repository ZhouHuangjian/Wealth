import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Space, Switch, Table, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { api, ApiError } from "../api";
import { Panel } from "../components";
import { useDebounced } from "../state";
import "./chat-assistant.css";

type ChatUser = {
  id: string;
  username: string;
  is_active: boolean;
  is_platform_admin: boolean;
  enabled: boolean;
  device_count: number;
  last_seen_at: string | null;
};
type AccountResponse = { user_id: string | number };
type UserPage = AccountResponse & {
  items: ChatUser[];
  next_cursor: number | null;
};

export default function AdminChatUsers({
  currentId,
  onAuthChange,
}: {
  currentId: string;
  onAuthChange: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const settled = useDebounced(query.trim());
  const sequence = useRef(0),
    mutation = useRef(false),
    refreshAuth = useRef(onAuthChange);
  refreshAuth.current = onAuthChange;
  const clear = useCallback(() => {
    sequence.current++;
    setUsers([]);
    setCursor(null);
    setBusy(null);
    setLoading(false);
  }, []);
  const verify = useCallback(
    (result: AccountResponse) => {
      if (String(result.user_id) === String(currentId)) return true;
      clear();
      setError("登录账号已变化，正在重新载入…");
      void refreshAuth.current();
      return false;
    },
    [currentId, clear],
  );
  const reject = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        clear();
        void refreshAuth.current();
      }
    },
    [clear],
  );
  const read = useCallback(
    async (after?: number) => {
      const current = ++sequence.current;
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ limit: "50", q: settled });
        if (after !== undefined) params.set("after", String(after));
        const result = await api<UserPage>(`/admin/chat/users?${params}`);
        if (current !== sequence.current || !verify(result)) return;
        setUsers((previous) =>
          after === undefined
            ? result.items
            : [
                ...previous,
                ...result.items.filter(
                  (user) => !previous.some((item) => item.id === user.id),
                ),
              ],
        );
        setCursor(result.next_cursor);
      } catch (e) {
        if (current === sequence.current) {
          reject(e);
          setError((e as Error).message);
        }
      } finally {
        if (current === sequence.current) setLoading(false);
      }
    },
    [settled, verify, reject],
  );
  useEffect(() => {
    setUsers([]);
    setCursor(null);
    void read();
    const onFocus = () => {
      clear();
      void read();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus();
      else clear();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      sequence.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [read, clear]);

  return (
    <Panel
      title="按账号启用聊天助手"
      subtitle="管理员和普通用户均可独立使用，默认关闭。"
    >
      <p className="chat-admin-note">
        开启后，用户可在自己的聊天助手中绑定
        Mac、查看并复制已同步草稿。停用会立即停止该账号的聊天访问和设备上传，原有设备与草稿保留。这里仅管理功能权限，不展示他人的聊天内容。
      </p>
      <div className="chat-admin-toolbar">
        <Input.Search
          aria-label="搜索聊天用户"
          placeholder="搜索用户名"
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
        />
        <Button
          aria-label="刷新聊天用户"
          icon={<RefreshCw size={16} />}
          loading={loading}
          disabled={!!busy}
          onClick={() => void read()}
        >
          刷新
        </Button>
      </div>
      {error && (
        <Alert
          className="form-alert"
          type="error"
          showIcon
          message={error}
          action={
            <Button
              size="small"
              disabled={loading || !!busy}
              onClick={() => void read()}
            >
              重试
            </Button>
          }
        />
      )}
      <Table<ChatUser>
        rowKey="id"
        dataSource={users}
        loading={loading}
        pagination={false}
        scroll={{ x: 700 }}
        locale={{ emptyText: query ? "没有匹配的用户" : "暂无用户" }}
        columns={[
          {
            title: "用户名",
            dataIndex: "username",
            render: (_, user) => (
              <Space wrap>
                <span>{user.username}</span>
                {String(user.id) === String(currentId) && <Tag>当前登录</Tag>}
                {user.is_platform_admin && <Tag color="blue">管理员</Tag>}
                {!user.is_active && <Tag>登录已停用</Tag>}
              </Space>
            ),
          },
          {
            title: "聊天功能",
            render: (_, user) => (
              <Switch
                aria-label={`${user.username}的聊天功能`}
                checked={user.enabled}
                checkedChildren="已开启"
                unCheckedChildren="关闭"
                loading={busy === String(user.id)}
                disabled={loading || !!busy}
                onChange={async (enabled) => {
                  if (mutation.current) return;
                  mutation.current = true;
                  const current = sequence.current;
                  setBusy(String(user.id));
                  try {
                    const result = await api<AccountResponse>(
                      `/admin/chat/users/${user.id}`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({ enabled }),
                        headers: { "X-Chat-User-Id": String(currentId) },
                      },
                    );
                    if (current !== sequence.current || !verify(result)) return;
                    setUsers((previous) =>
                      previous.map((item) =>
                        item.id === user.id ? { ...item, enabled } : item,
                      ),
                    );
                    message.success(
                      `${user.username}的聊天助手已${enabled ? "开启" : "停用"}`,
                    );
                  } catch (e) {
                    if (current !== sequence.current) return;
                    reject(e);
                    message.error((e as Error).message);
                  } finally {
                    mutation.current = false;
                    if (current === sequence.current) setBusy(null);
                  }
                }}
              />
            ),
          },
          { title: "有效设备", dataIndex: "device_count" },
          {
            title: "设备最近连接",
            render: (_, user) =>
              user.last_seen_at
                ? new Date(user.last_seen_at).toLocaleString("zh-CN", {
                    hour12: false,
                  })
                : "尚未连接",
          },
        ]}
      />
      {cursor !== null && (
        <div className="chat-load-more">
          <Button
            loading={loading}
            disabled={!!busy}
            onClick={() => void read(cursor)}
          >
            加载更多用户
          </Button>
        </div>
      )}
    </Panel>
  );
}
