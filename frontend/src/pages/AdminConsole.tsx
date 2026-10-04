import { helpColumns } from "../help";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { ArrowDown, ArrowUp, LogOut, Plus, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, currencyOptions, listOf, send } from "../api";
import type { Item } from "../api";
import { LoadState, PageTitle, Panel } from "../components";
import { NavigationTabs } from "../navigation";
import { useDebounced } from "../state";
import { adminAccessRequired, canDelegate } from "../admin-access";
import AdminTemplates from "./AdminTemplates";
import AdminGlossary from "./AdminGlossary";
import { WorkspaceTrash } from "./ManagementExtras";
import { PasswordForm } from "./Settings";
function useAdminResource(path: string) {
  const [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const sequence = useRef(0);
  const retry = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await api(`/admin/${path}`);
      if (current === sequence.current) setData(result);
    } catch (e) {
      if (current === sequence.current) {
        setError((e as Error).message);
        setData(null);
      }
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void retry();
    return () => {
      sequence.current++;
    };
  }, [retry]);
  return { data, loading, error, retry };
}
export default function AdminConsole({
  user,
  onAuthChange,
}: {
  user: { id: string; username: string };
  onAuthChange: () => Promise<void>;
}) {
  const { modal } = App.useApp();
  return (
    <main className="admin-console">
      <PageTitle
        eyebrow=""
        title="管理工作台"
        actions={
          <Button
            icon={<LogOut size={16} />}
            onClick={() =>
              modal.confirm({
                title: "退出管理员账户？",
                okText: "退出登录",
                cancelText: "取消",
                onOk: async () => {
                  await send("/auth/logout");
                  await onAuthChange();
                },
              })
            }
          >
            退出登录
          </Button>
        }
      />
      <Alert
        className="admin-identity-banner"
        type="info"
        showIcon
        message={`当前管理员：${user.username}`}
        description="管理员没有个人账簿。仅在空间所有者允许代管后，才可进入账簿、修改配置或导出数据；平台用户与空间生命周期管理仍在此处理。管理操作保留审计记录。"
      />
      <NavigationTabs
        group="admin"
        routeParam="tab"
        items={[
          {
            key: "users",
            label: "用户管理",
            children: <Users currentId={user.id} onChanged={onAuthChange} />,
          },
          {
            key: "spaces",
            label: "空间管理",
            children: <AdminSpaces onChanged={onAuthChange} />,
          },
          {
            key: "trash",
            label: "空间回收站",
            children: <WorkspaceTrash admin onChanged={onAuthChange} />,
          },
          {
            key: "glossary",
            label: "名词帮助配置",
            children: <AdminGlossary />,
          },
          { key: "templates", label: "配置参考", children: <AdminTemplates /> },
          {
            key: "security",
            label: "管理员安全",
            children: (
              <Panel title="登录安全">
                <PasswordForm />
              </Panel>
            ),
          },
          { key: "sources", label: "数据源配置", children: <DataSources /> },
          { key: "audit", label: "管理审计", children: <AdminAudit /> },
        ]}
      />
    </main>
  );
}
function Users({
  currentId,
  onChanged,
}: {
  currentId: string;
  onChanged: () => Promise<void>;
}) {
  const [page, setPage] = useState(1),
    [query, setQuery] = useState("");
  const q = useDebounced(query);
  const state = useAdminResource(
    `users?${new URLSearchParams({ q, offset: String((page - 1) * 20), limit: "20" })}`,
  );
  const { message, modal } = App.useApp();
  const [editing, setEditing] = useState<Item | null>(null),
    [mode, setMode] = useState<"create" | "edit" | "password" | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [form] = Form.useForm();
  const creatingAdmin = Form.useWatch("is_platform_admin", form);
  const [deleting, setDeleting] = useState<Item | null>(null);
  function open(next: typeof mode, r?: Item) {
    setMode(next);
    setEditing(r || null);
    setError("");
    form.resetFields();
    if (next === "create") form.setFieldValue("is_platform_admin", false);
    if (r && next === "edit") form.setFieldsValue(r);
  }
  async function patch(r: Item, changes: any) {
    await send(
      `/admin/users/${r.id}`,
      { version: r.version, ...changes },
      "PATCH",
    );
    await state.retry();
    await onChanged();
  }
  return (
    <>
      <Panel
        title="平台用户"
        action={
          <Button
            type="primary"
            icon={<Plus size={15} />}
            onClick={() => open("create")}
          >
            新增用户
          </Button>
        }
      >
        <Input.Search
          className="form-alert"
          aria-label="搜索平台用户"
          placeholder="按用户名搜索"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          allowClear
        />
        <LoadState {...state}>
          <Table<Item>
            rowKey="id"
            pagination={{
              current: page,
              pageSize: 20,
              total: state.data?.count || 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            dataSource={listOf<Item>(state.data)}
            scroll={{ x: 850 }}
            columns={helpColumns<Item>([
              {
                title: "用户名",
                render: (_, r) => (
                  <Space>
                    {r.username}
                    {r.id === currentId && <Tag>当前登录</Tag>}
                    {r.is_platform_admin && <Tag color="blue">管理员</Tag>}
                  </Space>
                ),
              },
              { title: "邮箱", dataIndex: "email" },
              { title: "空间数", dataIndex: "space_count" },
              {
                title: "状态",
                render: (_, r) => (
                  <Switch
                    checked={r.is_active}
                    disabled={r.id === currentId}
                    checkedChildren="启用"
                    unCheckedChildren="停用"
                    aria-label={`${r.username}登录状态`}
                    onChange={(v) =>
                      modal.confirm({
                        title: `${v ? "启用" : "停用"}用户 ${r.username}？`,
                        content: v
                          ? "用户可重新登录其授权空间。"
                          : "该用户将无法继续访问；原有账簿数据保留。",
                        onOk: async () => {
                          try {
                            await patch(r, { is_active: v });
                          } catch (e) {
                            message.error((e as Error).message);
                            throw e;
                          }
                        },
                      })
                    }
                  />
                ),
              },
              {
                title: "最近登录",
                render: (_, r) =>
                  r.last_login?.slice(0, 16).replace("T", " ") || "尚未登录",
              },
              {
                title: "操作",
                render: (_, r) => (
                  <Space>
                    <Button type="link" onClick={() => open("edit", r)}>
                      编辑资料
                    </Button>
                    <Button
                      type="link"
                      disabled={r.id === currentId}
                      onClick={() => open("password", r)}
                    >
                      重设密码
                    </Button>
                    <Button
                      type="link"
                      danger
                      disabled={r.id === currentId}
                      onClick={() => setDeleting(r)}
                    >
                      删除账号
                    </Button>
                  </Space>
                ),
              },
            ])}
          />
        </LoadState>
      </Panel>
      {deleting && (
        <AdminDeleteDialog
          target={deleting}
          kind="user"
          onCancel={() => setDeleting(null)}
          onDone={async () => {
            setDeleting(null);
            await state.retry();
            await onChanged();
          }}
        />
      )}
      <Modal
        title={
          mode === "create"
            ? "新增用户"
            : mode === "password"
              ? `重设 ${editing?.username} 的密码`
              : `用户 · ${editing?.username}`
        }
        open={mode !== null}
        onCancel={() => setMode(null)}
        onOk={() => form.submit()}
        confirmLoading={busy}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            setBusy(true);
            setError("");
            try {
              if (mode === "create") await send("/admin/users", values);
              else if (mode === "password")
                await send(`/admin/users/${editing!.id}/password`, {
                  version: editing!.version,
                  password: values.password,
                });
              else
                await send(
                  `/admin/users/${editing!.id}`,
                  { version: editing!.version, ...values },
                  "PATCH",
                );
              message.success("已保存");
              setMode(null);
              await state.retry();
              await onChanged();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Alert
            className="form-alert"
            type="info"
            message={
              mode === "password"
                ? "设置新密码后旧密码失效；请通过可信方式告知用户，系统不会自动发送。"
                : "账号类型创建后不可切换。管理员只管理平台，普通用户按空间成员权限使用账簿。"
            }
          />
          {error && (
            <Alert className="form-alert" type="error" message={error} />
          )}
          {mode !== "password" && (
            <>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true }]}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="email"
                label="邮箱（选填）"
                rules={[{ type: "email" }]}
              >
                <Input />
              </Form.Item>
            </>
          )}
          {mode === "create" && (
            <Form.Item
              name="is_platform_admin"
              label="账号类型"
              rules={[{ required: true }]}
            >
              <Select
                options={[
                  { value: false, label: "普通用户 · 使用账簿" },
                  { value: true, label: "平台管理员 · 独立管理账号" },
                ]}
              />
            </Form.Item>
          )}
          {mode === "create" && !creatingAdmin && (
            <Form.Item
              preserve={false}
              name="space_name"
              label="同时新建空间（选填）"
            >
              <Input />
            </Form.Item>
          )}
          {mode === "edit" && (
            <p>
              账号类型：
              <Tag>
                {editing?.is_platform_admin ? "平台管理员" : "普通用户"}
              </Tag>
              创建后不可切换。
            </p>
          )}
          {mode !== "edit" && (
            <Form.Item
              name="password"
              label="新密码"
              rules={[{ required: true }, { min: 10, message: "至少 10 位" }]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}
function AdminSpaces({ onChanged }: { onChanged: () => Promise<void> }) {
  const [page, setPage] = useState(1),
    [query, setQuery] = useState("");
  const q = useDebounced(query);
  const state = useAdminResource(
    `spaces?${new URLSearchParams({ q, offset: String((page - 1) * 20), limit: "20" })}`,
  );
  useEffect(() => {
    const refresh = () => {
      void state.retry();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [state.retry]);
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [memberSpace, setMemberSpace] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Item | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [form] = Form.useForm();
  return (
    <>
      <Panel
        title="全部空间"
        action={
          <Button
            type="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setEditing(null);
              form.resetFields();
              form.setFieldValue("base_currency", "CNY");
              setError("");
              setOpen(true);
            }}
          >
            新建空间
          </Button>
        }
      >
        <Input.Search
          className="form-alert"
          aria-label="搜索平台空间"
          placeholder="按空间名称搜索"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          allowClear
        />
        <p className="data-caption">
          未授权时仅显示空间基础资料。{adminAccessRequired}
        </p>
        <LoadState {...state}>
          <Table<Item>
            rowKey="id"
            pagination={{
              current: page,
              pageSize: 20,
              total: state.data?.count || 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            dataSource={listOf<Item>(state.data)}
            scroll={{ x: 800 }}
            columns={helpColumns<Item>([
              { title: "空间", dataIndex: "name" },
              { title: "本位币", dataIndex: "base_currency" },
              {
                title: "成员",
                render: (_, r) =>
                  (r.members || [])
                    .map((m: any) => `${m.username} (${m.role})`)
                    .join("、"),
              },
              { title: "时区", dataIndex: "timezone" },
              {
                title: "代管授权",
                render: (_, r) => (
                  <Tooltip
                    title={
                      canDelegate(r)
                        ? "空间所有者已允许管理员代管"
                        : adminAccessRequired
                    }
                  >
                    <Tag color={canDelegate(r) ? "green" : undefined}>
                      {canDelegate(r) ? "已授权" : "未授权"}
                    </Tag>
                  </Tooltip>
                ),
              },
              {
                title: "操作",
                render: (_, r) => (
                  <Space>
                    <Button
                      type="link"
                      disabled={!canDelegate(r)}
                      title={!canDelegate(r) ? adminAccessRequired : undefined}
                      onClick={() => navigate(`/spaces/${r.id}/home`)}
                    >
                      代管空间
                    </Button>
                    <Button
                      type="link"
                      disabled={!canDelegate(r)}
                      title={!canDelegate(r) ? adminAccessRequired : undefined}
                      onClick={() => setMemberSpace(r)}
                    >
                      成员权限
                    </Button>
                    <Button
                      type="link"
                      disabled={!canDelegate(r)}
                      title={!canDelegate(r) ? adminAccessRequired : undefined}
                      onClick={() => {
                        setEditing(r);
                        form.resetFields();
                        form.setFieldsValue(r);
                        setError("");
                        setOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button type="link" danger onClick={() => setDeleting(r)}>
                      删除空间
                    </Button>
                  </Space>
                ),
              },
            ])}
          />
        </LoadState>
      </Panel>
      {deleting && (
        <AdminDeleteDialog
          target={deleting}
          kind="space"
          onCancel={() => setDeleting(null)}
          onDone={async () => {
            setDeleting(null);
            await state.retry();
            await onChanged();
          }}
        />
      )}
      <Modal
        title={editing ? "编辑空间" : "新建空间"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={busy}
        okButtonProps={{ disabled: !!editing && !canDelegate(editing) }}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (v) => {
            setBusy(true);
            setError("");
            try {
              await send(
                `/admin/spaces${editing ? `/${editing.id}` : ""}`,
                {
                  ...v,
                  ...(editing
                    ? { version: editing.version ?? editing.revision }
                    : {}),
                },
                editing ? "PATCH" : "POST",
              );
              await onChanged();
              await state.retry();
              setOpen(false);
              message.success("空间已保存");
            } catch (e) {
              setError((e as Error).message);
              if (e instanceof ApiError && e.status === 403 && editing) {
                setEditing({ ...editing, can_delegate: false });
                await state.retry();
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && (
            <Alert type="error" message={error} className="form-alert" />
          )}
          <Form.Item name="name" label="空间名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {editing ? (
            <Form.Item
              name="timezone"
              label="时区"
              rules={[{ required: true }]}
            >
              <Input placeholder="Asia/Shanghai" />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name="owner_user_id"
                label="空间拥有者"
                rules={[{ required: true }]}
              >
                <AdminUserSelect />
              </Form.Item>
              <Form.Item
                name="base_currency"
                label="本位币"
                rules={[{ required: true }]}
              >
                <Select options={currencyOptions} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
      {memberSpace && (
        <SpaceMembers
          space={memberSpace}
          onClose={() => setMemberSpace(null)}
          onChanged={async () => {
            await state.retry();
            await onChanged();
          }}
        />
      )}
    </>
  );
}
function SpaceMembers({
  space,
  onClose,
  onChanged,
}: {
  space: Item;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [members, setMembers] = useState<Item[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [form] = Form.useForm();
  const { modal, message } = App.useApp();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMembers(listOf<Item>(await api(`/spaces/${space.id}/members`)));
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, [space.id]);
  useEffect(() => {
    void load();
  }, [load]);
  async function mutate(action: () => Promise<any>) {
    try {
      await action();
      await load();
      await onChanged();
    } catch (e) {
      message.error((e as Error).message);
      if (e instanceof ApiError && e.status === 403) {
        setMembers([]);
        setError(adminAccessRequired);
      }
      throw e;
    }
  }
  return (
    <Modal
      title={`成员权限 · ${space.name}`}
      open
      onCancel={onClose}
      footer={null}
      width={780}
    >
      {error && <Alert className="form-alert" type="error" message={error} />}
      <Table<Item>
        loading={loading}
        rowKey="id"
        dataSource={members}
        pagination={false}
        columns={helpColumns<Item>([
          {
            title: "用户",
            render: (_, r) => r.username || r.user?.username || r.user_id,
          },
          {
            title: "角色",
            render: (_, r) => (
              <Select
                value={r.role}
                disabled={loading || busy || !!error}
                aria-label="修改成员角色"
                options={["owner", "editor", "viewer"].map((v) => ({
                  value: v,
                  label: v,
                }))}
                onChange={(role) =>
                  modal.confirm({
                    title: "调整成员权限？",
                    content: "新权限立即生效；最后一位拥有者必须保留。",
                    onOk: () =>
                      mutate(() =>
                        send(
                          `/spaces/${space.id}/members/${r.id}`,
                          { role, version: r.version },
                          "PATCH",
                        ),
                      ),
                  })
                }
              />
            ),
          },
          {
            title: "操作",
            render: (_, r) => (
              <Button
                type="link"
                danger
                disabled={loading || busy || !!error}
                onClick={() =>
                  modal.confirm({
                    title: "移除该成员？",
                    content: "该用户将失去本空间访问权，原有业务数据仍保留。",
                    onOk: () =>
                      mutate(() =>
                        api(`/spaces/${space.id}/members/${r.id}`, {
                          method: "DELETE",
                        }),
                      ),
                  })
                }
              >
                移除
              </Button>
            ),
          },
        ])}
      />
      <Form
        form={form}
        layout="vertical"
        disabled={loading || busy || !!error}
        initialValues={{ role: "viewer" }}
        className="form-alert"
        onFinish={async (v) => {
          setBusy(true);
          try {
            await mutate(() => send(`/spaces/${space.id}/members`, v));
            form.resetFields();
            message.success("已加入空间");
          } catch {
            /* the mutation displays its actionable error */
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>添加已有用户</h3>
        <div className="form-grid">
          <Form.Item name="user_id" label="用户" rules={[{ required: true }]}>
            <AdminUserSelect
              excludeIds={members.map((m) => String(m.user_id || m.user?.id))}
            />
          </Form.Item>
          <Form.Item name="role" label="权限" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "viewer", label: "Viewer · 查看" },
                { value: "editor", label: "Editor · 编辑账目" },
                { value: "owner", label: "Owner · 空间管理" },
              ]}
            />
          </Form.Item>
        </div>
        <Button type="primary" htmlType="submit" loading={busy}>
          添加成员
        </Button>
      </Form>
    </Modal>
  );
}
function DataSources() {
  const state = useAdminResource("data-sources");
  const { message } = App.useApp();
  const [config, setConfig] = useState<any>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => setConfig(state.data?.config || null), [state.data]);
  const providers: any[] = Array.isArray(state.data?.providers)
    ? state.data.providers
    : Object.values(state.data?.providers || {});
  const label = (id: string) => providers.find((p) => p.id === id)?.name || id;
  const kindNames: Record<string, string> = {
    fund: "基金",
    stock: "股票",
    etf: "ETF",
    future: "期货",
    option: "期权",
    index: "指数",
    gold: "黄金",
  };
  return (
    <Panel
      title="内置公开数据源"
      action={
        <Space>
          <Button icon={<RefreshCw size={15} />} onClick={state.retry}>
            重新读取
          </Button>
          <Button
            type="primary"
            disabled={!config}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await send(
                  "/admin/data-sources",
                  { version: state.data.version, config },
                  "PUT",
                );
                await state.retry();
                message.success("数据源配置已保存");
              } catch (e) {
                message.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存配置
          </Button>
        </Space>
      }
    >
      <p className="data-caption">
        只使用内置提供方。停用会影响后续查询与刷新，已有历史记录保留。优先顺序仅在支持相同市场和操作的源之间生效。
      </p>
      <LoadState {...state}>
        {config && (
          <>
            <Table
              rowKey="id"
              dataSource={providers}
              pagination={false}
              columns={helpColumns([
                {
                  title: "提供方",
                  render: (_, r: any) => (
                    <div className="cell-name">
                      <strong>{r.name}</strong>
                      <small>{r.description}</small>
                    </div>
                  ),
                },
                {
                  title: "范围",
                  render: (_, r: any) => (
                    <div className="cell-name">
                      <span>
                        {(r.kinds || [])
                          .map((k: string) => kindNames[k] || k)
                          .join("、")}
                      </span>
                      <small>
                        {(r.operations || [])
                          .map(
                            (operation: string) =>
                              (
                                ({
                                  quote: "最新行情",
                                  history: "历史行情",
                                  search: "产品搜索",
                                  catalog: "产品目录",
                                  dividends: "基金分红公告",
                                }) as Record<string, string>
                              )[operation] || operation,
                          )
                          .join(" / ")}
                      </small>
                    </div>
                  ),
                },
                {
                  title: "启用",
                  render: (_, r: any) => (
                    <Switch
                      aria-label={`启用${r.name}`}
                      checked={config.enabled?.[r.id] !== false}
                      onChange={(checked) =>
                        setConfig({
                          ...config,
                          enabled: { ...config.enabled, [r.id]: checked },
                        })
                      }
                    />
                  ),
                },
              ])}
            />
            <h3>各类产品的优先顺序</h3>
            <div className="source-priority-grid">
              {Object.entries(config.priority || {}).map(([kind, ids]) => {
                const order = ids as string[];
                const available = providers.filter((p) =>
                  p.kinds?.includes(kind),
                );
                return (
                  <section key={kind}>
                    <h4>{kindNames[kind] || kind}</h4>
                    <Select
                      mode="multiple"
                      aria-label={`${kindNames[kind] || kind}启用来源`}
                      style={{ width: "100%" }}
                      value={order}
                      options={available.map((p) => ({
                        value: p.id,
                        label: p.name,
                      }))}
                      onChange={(next) =>
                        setConfig({
                          ...config,
                          priority: { ...config.priority, [kind]: next },
                        })
                      }
                    />
                    {order.map((id, i) => (
                      <div className="source-priority-row" key={id}>
                        <span>
                          {i + 1}. {label(id)}
                          {config.enabled?.[id] === false ? "（已停用）" : ""}
                        </span>
                        <Space>
                          <Button
                            size="small"
                            aria-label={`上移${kind}${id}`}
                            icon={<ArrowUp size={13} />}
                            disabled={i === 0}
                            onClick={() => {
                              const next = [...order];
                              [next[i - 1], next[i]] = [next[i], next[i - 1]];
                              setConfig({
                                ...config,
                                priority: { ...config.priority, [kind]: next },
                              });
                            }}
                          />
                          <Button
                            size="small"
                            aria-label={`下移${kind}${id}`}
                            icon={<ArrowDown size={13} />}
                            disabled={i === order.length - 1}
                            onClick={() => {
                              const next = [...order];
                              [next[i + 1], next[i]] = [next[i], next[i + 1]];
                              setConfig({
                                ...config,
                                priority: { ...config.priority, [kind]: next },
                              });
                            }}
                          />
                        </Space>
                      </div>
                    ))}
                    {available.length <= 1 && (
                      <p className="data-caption">
                        此类产品当前没有第二个同等能力的内置来源。
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </LoadState>
    </Panel>
  );
}
function AdminAudit() {
  const [page, setPage] = useState(1);
  const state = useAdminResource(`audit?offset=${(page - 1) * 20}&limit=20`);
  return (
    <Panel title="管理员操作记录">
      <LoadState {...state}>
        <Table
          rowKey={(r: any, i) => r.id || String(i)}
          pagination={{
            current: page,
            pageSize: 20,
            total: state.data?.count || 0,
            onChange: setPage,
            showSizeChanger: false,
          }}
          dataSource={listOf<Item>(state.data)}
          scroll={{ x: 850 }}
          columns={helpColumns([
            {
              title: "时间",
              render: (_, r: any) =>
                r.created_at?.slice(0, 19).replace("T", " "),
            },
            {
              title: "操作者",
              render: (_, r: any) =>
                r.actor_name || r.actor_username || r.username || r.actor_id,
            },
            { title: "操作", dataIndex: "action" },
            {
              title: "对象",
              render: (_, r: any) =>
                r.target ||
                `${r.resource || r.object_type || ""} ${r.object_id || r.entity_id || ""}`,
            },
            {
              title: "说明",
              render: (_, r: any) =>
                r.reason ||
                r.description ||
                (r.detail ? JSON.stringify(r.detail) : "—"),
            },
          ])}
        />
      </LoadState>
    </Panel>
  );
}

function AdminUserSelect({
  excludeIds = [],
  ...props
}: {
  excludeIds?: string[];
  value?: string | number;
  onChange?: (v: any) => void;
  id?: string;
}) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query);
  const state = useAdminResource(
    `users?${new URLSearchParams({ q, limit: "100" })}`,
  );
  return (
    <Select
      {...props}
      showSearch
      filterOption={false}
      onSearch={setQuery}
      loading={state.loading}
      placeholder="搜索用户名"
      options={listOf<Item>(state.data)
        .filter(
          (u) =>
            u.is_active &&
            !u.is_platform_admin &&
            !excludeIds.includes(String(u.id)),
        )
        .map((u) => ({ value: u.id, label: u.username }))}
      notFoundContent={state.error || "未找到用户，可输入用户名搜索"}
    />
  );
}

function AdminDeleteDialog({
  target,
  kind,
  onCancel,
  onDone,
}: {
  target: Item;
  kind: "user" | "space";
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [acknowledged, setAcknowledged] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const expected = kind === "user" ? target.username : target.name;
  const { message } = App.useApp();
  return (
    <Modal
      open
      title={kind === "user" ? "删除用户账号" : "删除空间并移入回收站"}
      onCancel={() => {
        if (!lock.current) onCancel();
      }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      cancelButtonProps={{ disabled: busy }}
      okText={kind === "user" ? "确认删除账号" : "移入回收站"}
      cancelText="取消"
      okButtonProps={{
        danger: true,
        disabled: busy || name !== expected || !acknowledged,
      }}
      confirmLoading={busy}
      onOk={async () => {
        if (lock.current || name !== expected || !acknowledged) return;
        lock.current = true;
        setBusy(true);
        setError("");
        try {
          await send(
            `/admin/${kind === "user" ? "users" : "spaces"}/${target.id}`,
            {
              version: target.version ?? target.revision,
              [kind === "user" ? "confirm_username" : "confirm_name"]: name,
            },
            "DELETE",
          );
          message.success(
            kind === "user" ? "用户账号已删除" : "空间已移入回收站",
          );
          await onDone();
        } catch (e) {
          const suffix =
            e instanceof ApiError && e.fields.space_ids?.length
              ? "。请先到空间管理，将该用户唯一拥有的活跃空间交给其他普通用户，或将空间移入回收站。"
              : "";
          setError((e as Error).message + suffix);
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }}
    >
      <p>
        {kind === "user"
          ? "删除后此账号无法登录，其成员资格被移除，账号无法从回收站恢复；原有空间账目保留。唯一拥有者仍有活跃空间时，必须先转交空间或删除空间。"
          : "本空间所有成员将无法访问，后台自动更新停止。账目暂时保留，可在空间回收站恢复；旧邀请码失效。"}
      </p>
      <p>
        请输入完整{kind === "user" ? "用户名" : "空间名称"}：
        <strong>{expected}</strong>
      </p>
      <Input
        aria-label={kind === "user" ? "确认删除的用户名" : "确认删除的空间名称"}
        disabled={busy}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <p>
        <Checkbox
          checked={acknowledged}
          disabled={busy}
          onChange={(e) => setAcknowledged(e.target.checked)}
        >
          我已核对对象，并了解以上影响
        </Checkbox>
      </p>
      {error && <Alert type="error" message={error} showIcon />}
    </Modal>
  );
}
