import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
} from "antd";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  BookOpen,
  ChartNoAxesCombined,
  CircleHelp,
  ClipboardList,
  Eye,
  EyeOff,
  FolderInput,
  House,
  Landmark,
  Leaf,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sprout,
  WalletCards,
  X,
  ChevronDown,
  SlidersHorizontal,
} from "lucide-react";
import {
  api,
  currencyOptions,
  dateToday,
  listOf,
  send,
  setCsrf,
  subscribeApiFailures,
} from "./api";
import {
  adminAccessRequired,
  canDelegate,
  isDelegationDenied,
} from "./admin-access";
import type { Item } from "./api";
import { DetailDrawer, EventModal, Fields } from "./components";
import { WorkspaceContext, useWorkspace } from "./state";
import type { Space as Workspace } from "./state";
import { NavigationProvider, useNavigation } from "./navigation";
import { GlossaryProvider } from "./help";
import { navigationHidden, orderedNavigation } from "./navigation-model";
import {
  ThemePreferences,
  ThemeSwitcher,
  useWealthTheme,
} from "./ThemeProvider";
import { ThemeCharacter, ThemeScene } from "./theme-character";
import {
  InviteResult,
  WorkspaceActions,
  WorkspaceTrash,
  ConfigurationLibrary,
} from "./pages/ManagementExtras";
const AdminConsole = lazy(() => import("./pages/AdminConsole"));
const AdminDataManagement = lazy(() => import("./pages/AdminDataManagement"));
const Home = lazy(() => import("./pages/Home"));
const Assets = lazy(() => import("./pages/Assets"));
const Cashbook = lazy(() => import("./pages/Cashbook"));
const Planning = lazy(() => import("./pages/Planning"));
const Notebook = lazy(() => import("./pages/Notebook"));
const Analytics = lazy(() => import("./pages/Analytics"));
const Settings = lazy(() => import("./pages/Settings"));
type Auth = {
  user: { id: string; username: string; is_platform_admin?: boolean } | null;
  spaces: Workspace[];
  csrf_token: string;
  setup_required?: boolean;
};
const nav = [
  { path: "home", name: "首页", simple: "首页", icon: House },
  { path: "assets", name: "资产与投资", simple: "资产", icon: Landmark },
  { path: "cashbook", name: "收支账本", simple: "收支", icon: WalletCards },
  { path: "planning", name: "财富规划", simple: "规划", icon: Sprout },
  { path: "notebook", name: "投资手札", simple: "笔记", icon: BookOpen },
  { path: "analytics", name: "分析复盘", simple: "分析", icon: ClipboardList },
];
export default function App() {
  const { setIdentity } = useWealthTheme();
  const [auth, setAuth] = useState<Auth | null>(null),
    [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const a = await api<Auth>("/auth/me");
      setAuth(a);
      setCsrf(a.csrf_token);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    setIdentity(auth?.user?.id);
  }, [auth?.user?.id, setIdentity]);
  if (error)
    return (
      <div className="auth-scene">
        <div className="auth-card">
          <Brand />
          <h1>暂时无法连接账簿服务</h1>
          <Alert type="error" message={error} showIcon />
          <p>请确认后台服务正在运行，之后重新读取。</p>
          <Button type="primary" onClick={load}>
            重新连接
          </Button>
        </div>
      </div>
    );
  if (!auth)
    return (
      <div className="full-loader">
        <Sprout size={40} />
        <Spin />
        <p>正在安全打开账簿…</p>
      </div>
    );
  if (!auth.user)
    return <AuthPage initial={!!auth.setup_required} onSuccess={load} />;
  if (!auth.spaces?.length && !auth.user.is_platform_admin)
    return <NoSpace onDone={load} username={auth.user.username} />;
  return (
    <GlossaryProvider key={auth.user.id}>
      <NavigationProvider isAdmin={!!auth.user.is_platform_admin}>
        <Routes>
          <Route
            path="/admin"
            element={
              auth.user.is_platform_admin ? (
                <Suspense fallback={<Spin />}>
                  <AdminConsole user={auth.user} onAuthChange={load} />
                </Suspense>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/spaces/:spaceId/*"
            element={<WorkspaceGate auth={auth} onAuthChange={load} />}
          />
          <Route
            path="*"
            element={
              <Navigate
                to={
                  auth.user.is_platform_admin
                    ? "/admin"
                    : auth.spaces.length
                      ? `/spaces/${auth.spaces[0].id}/home`
                      : "/"
                }
                replace
              />
            }
          />
        </Routes>
      </NavigationProvider>
    </GlossaryProvider>
  );
}
function Brand() {
  const { name } = useWealthTheme();
  return (
    <div className="brand">
      <span className="brand-symbol">
        <ThemeCharacter name={name} />
      </span>
      <div>
        <strong>拾财</strong>
        <small>WEALTH, IN ORDER</small>
      </div>
    </div>
  );
}
function AuthPage({
  initial,
  onSuccess,
}: {
  initial: boolean;
  onSuccess: () => void;
}) {
  const { name: themeName } = useWealthTheme();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [join, setJoin] = useState(false),
    [invitePreview, setInvitePreview] = useState<any>(null);
  const [authForm] = Form.useForm();
  const navigate = useNavigate();
  return (
    <div className="auth-scene">
      <div className="auth-aside">
        <Brand />
        <div>
          <ThemeScene name={themeName} />
          <h1>拾财</h1>
          <p>个人与家庭财务管理</p>
        </div>
        <div className="auth-foot">账簿独立保存 · 权限按空间隔离</div>
      </div>
      <div className="auth-card">
        <h2>
          {initial
            ? "建立平台管理员"
            : join
              ? "接受邀请并创建账户"
              : "登录拾财"}
        </h2>
        <p>
          {initial
            ? "管理员只负责平台管理；普通用户独立建立或加入账簿空间。"
            : "普通账号进入自己的账簿，管理员账号进入管理工作台。"}
        </p>
        {error && (
          <Alert className="form-alert" message={error} type="error" showIcon />
        )}
        <Form
          form={authForm}
          layout="vertical"
          onValuesChange={() => {
            if (invitePreview) setInvitePreview(null);
          }}
          onFinish={async (values) => {
            setBusy(true);
            setError("");
            try {
              if (join && !invitePreview) {
                setInvitePreview(
                  await send("/invitations/preview", { token: values.token }),
                );
                return;
              }
              await send(
                initial ? "/auth/setup" : join ? "/auth/join" : "/auth/login",
                values,
              );
              navigate("/", { replace: true });
              onSuccess();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[
              { required: true, message: "请输入密码" },
              ...(initial ? [{ min: 10, message: "密码至少 10 位" }] : []),
            ]}
          >
            <Input.Password
              autoComplete={
                initial || join ? "new-password" : "current-password"
              }
            />
          </Form.Item>
          {join && (
            <Form.Item
              label="邀请码"
              name="token"
              rules={[
                { required: true, message: "请输入空间管理员提供的邀请码" },
              ]}
            >
              <Input.TextArea rows={3} />
            </Form.Item>
          )}
          {invitePreview && (
            <Alert
              className="form-alert"
              type="info"
              showIcon
              message={`加入「${invitePreview.space_name}」· ${invitePreview.role}`}
              description={`${invitePreview.sharing}。有效至 ${invitePreview.expires_at?.slice(0, 16).replace("T", " ")}`}
            />
          )}
          <Button type="primary" block htmlType="submit" loading={busy}>
            {initial
              ? "创建平台管理员"
              : join
                ? invitePreview
                  ? "确认共享范围并加入"
                  : "核实邀请与共享范围"
                : "登录"}
          </Button>
        </Form>
        {!initial && (
          <Button
            type="link"
            block
            onClick={() => {
              setJoin(!join);
              setError("");
            }}
          >
            {join ? "已有账户，返回登录" : "持有邀请码？创建账户并加入"}
          </Button>
        )}
        <div className="auth-disclaimer">
          账目记录与计划管理不会触发外部付款或交易。
        </div>
      </div>
    </div>
  );
}
function NoSpace({
  onDone,
  username,
}: {
  onDone: () => void;
  username: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [join, setJoin] = useState(false),
    [preview, setPreview] = useState<any>(null);
  const { modal } = AntApp.useApp();
  return (
    <div className="auth-scene">
      <div className="auth-card">
        <Brand />
        <h2>
          {username}，{join ? "加入已授权空间" : "建立一个独立空间"}
        </h2>
        <p>每个空间的数据独立保存。加入前会显示目标名称、角色与共享范围。</p>
        {error && (
          <Alert className="form-alert" message={error} type="error" showIcon />
        )}
        <Form
          key={join ? "join" : "create"}
          layout="vertical"
          initialValues={{ base_currency: "CNY" }}
          onValuesChange={() => setPreview(null)}
          onFinish={async (values) => {
            setBusy(true);
            setError("");
            try {
              if (join && !preview) {
                setPreview(await send("/invitations/preview", values));
                return;
              }
              const created = await send(
                join ? "/invitations/accept" : "/spaces",
                values,
              );
              if (created.invitation?.token)
                modal.info({
                  title: "邀请加入新空间",
                  content: <InviteResult token={created.invitation.token} />,
                  width: 580,
                });
              onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {join ? (
            <Form.Item
              name="token"
              label="邀请码"
              rules={[
                { required: true, message: "填写空间管理员提供的邀请码" },
              ]}
            >
              <Input.TextArea rows={3} />
            </Form.Item>
          ) : (
            <Fields
              fields={[
                { name: "name", label: "账簿名称", required: true },
                {
                  name: "base_currency",
                  label: "本位币",
                  type: "select",
                  required: true,
                  options: currencyOptions,
                },
              ]}
            />
          )}{" "}
          {preview && (
            <Alert
              className="form-alert"
              showIcon
              message={`${preview.space_name} · ${preview.role}`}
              description={preview.sharing}
            />
          )}
          {!join && (
            <Form.Item name="create_invitation" valuePropName="checked">
              <Checkbox>同时生成邀请码（只读成员，7 天有效）</Checkbox>
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" loading={busy}>
            {join
              ? preview
                ? "确认共享范围并加入"
                : "核实邀请与共享范围"
              : "创建账簿"}
          </Button>
        </Form>
        <Button
          type="link"
          onClick={() => {
            setJoin(!join);
            setPreview(null);
            setError("");
          }}
        >
          {join ? "返回创建独立空间" : "使用邀请码加入已有空间"}
        </Button>
        <WorkspaceTrash onChanged={onDone} />
      </div>
    </div>
  );
}
function WorkspaceGate({
  auth,
  onAuthChange,
}: {
  auth: Auth;
  onAuthChange: () => void;
}) {
  const location = useLocation(),
    spaceId = location.pathname.split("/")[2];
  const memberSpace = auth.spaces.find((s) => s.id === spaceId);
  const [managedSpace, setManagedSpace] = useState<Workspace | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    let active = true,
      pending = false;
    setManagedSpace(null);
    setError("");
    if (!auth.user?.is_platform_admin) return;
    const check = async () => {
      if (pending) return;
      pending = true;
      const current = ++sequence.current;
      try {
        const result = await api<Workspace>("/admin/spaces/" + spaceId);
        if (active && current === sequence.current) {
          if (canDelegate(result)) {
            setManagedSpace({ ...result, administration: true });
            setError("");
          } else {
            Modal.destroyAll();
            setManagedSpace(null);
            setError(adminAccessRequired);
          }
        }
      } catch (e) {
        if (active && current === sequence.current) {
          Modal.destroyAll();
          setManagedSpace(null);
          setError((e as Error).message);
        }
      } finally {
        pending = false;
      }
    };
    const unsubscribe = subscribeApiFailures((failure) => {
      if (active && isDelegationDenied(failure.path, failure.status, spaceId)) {
        sequence.current++;
        Modal.destroyAll();
        setManagedSpace(null);
        setError(
          failure.code === "admin_access_required"
            ? adminAccessRequired
            : "代管访问已被拒绝，请重新检查空间所有者的授权。",
        );
      }
    });
    void check();
    const onFocus = () => {
      void check();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void check();
    }, 15000);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      sequence.current++;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [spaceId, auth, attempt]);
  if (
    auth.user?.is_platform_admin &&
    (!canDelegate(managedSpace) || managedSpace?.id !== spaceId)
  )
    return (
      <main className="admin-console">
        {error ? (
          <Alert
            type="warning"
            showIcon
            message="当前不能代管此空间"
            description={error}
            action={
              <Space>
                <Button
                  size="small"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  重新检查
                </Button>
                <NavLink to="/admin">返回管理工作台</NavLink>
              </Space>
            }
          />
        ) : (
          <Spin />
        )}
      </main>
    );
  const space = auth.user?.is_platform_admin ? managedSpace : memberSpace;
  if (!space)
    return (
      <Navigate
        to={
          auth.user?.is_platform_admin
            ? "/admin"
            : auth.spaces.length
              ? "/spaces/" + auth.spaces[0].id + "/home"
              : "/"
        }
        replace
      />
    );
  return (
    <WorkspaceApp
      key={space.id}
      auth={auth}
      space={space}
      onAuthChange={onAuthChange}
    />
  );
}
function WorkspaceApp({
  auth,
  space,
  onAuthChange,
}: {
  auth: Auth;
  space: Workspace;
  onAuthChange: () => void;
}) {
  const navigate = useNavigate(),
    location = useLocation();
  const { modal, message } = AntApp.useApp();
  const navigation = useNavigation();
  const visibleNav = orderedNavigation(
    nav.map((n) => ({ ...n, key: n.path })),
    navigation.preferences.groups.main,
  ).filter(
    (n) => !navigationHidden("main", n.key, navigation.preferences.groups.main),
  );
  const [hidden, setHidden] = useState(
      localStorage.getItem("wealth:hidden") === "1",
    ),
    [quiet, setQuiet] = useState(localStorage.getItem("wealth:quiet") === "1"),
    [simple, setSimple] = useState(
      localStorage.getItem("wealth:simple") === "1",
    ),
    [collapsed, setCollapsed] = useState(false),
    [refresh, setRefresh] = useState(0),
    [eventOpen, setEventOpen] = useState(false),
    [preset, setPreset] = useState<Item>(),
    [detail, setDetail] = useState<Item | null>(null),
    [searchOpen, setSearchOpen] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [newSpaceOpen, setNewSpaceOpen] = useState(false),
    [newSpaceBusy, setNewSpaceBusy] = useState(false),
    [joinOpen, setJoinOpen] = useState(false),
    [invitePreview, setInvitePreview] = useState<any>(null);
  const newSpaceSubmitting = useRef(false);
  const current = nav.find((n) => location.pathname.endsWith(`/${n.path}`));
  const reload = () => setRefresh((r) => r + 1);
  function requestReveal(action: () => void) {
    if (!hidden) {
      action();
      return;
    }
    modal.confirm({
      title: "显示受保护内容后继续？",
      content: "编辑和预览中可能包含金额及原始说明。确认后将关闭金额遮挡。",
      okText: "显示内容并继续",
      cancelText: "保持隐藏",
      onOk: () => {
        localStorage.setItem("wealth:hidden", "0");
        setHidden(false);
        action();
      },
    });
  }
  const context = useMemo(
    () => ({
      space,
      hidden,
      refresh,
      reload,
      refreshIdentity: onAuthChange,
      requestReveal,
      openEvent: (item?: Item) =>
        requestReveal(() => {
          setPreset(item);
          setEventOpen(true);
        }),
      showDetail: setDetail,
    }),
    [space, hidden, refresh, onAuthChange],
  );
  function togglePrivacy() {
    setHidden((x) => {
      localStorage.setItem("wealth:hidden", x ? "0" : "1");
      return !x;
    });
  }
  function changeSpace(id: string) {
    const run = () => navigate(`/spaces/${id}/home`);
    if (document.querySelector('[data-dirty="true"]'))
      modal.confirm({
        title: "切换账簿空间？",
        content:
          "未保存的表单不会提交。记账草稿按原空间保留，其他未保存修改将丢弃。",
        okText: "切换空间",
        cancelText: "继续编辑",
        onOk: run,
      });
    else run();
  }
  return (
    <WorkspaceContext.Provider value={context}>
      <div
        className={`app-shell ${quiet ? "low-decoration" : ""} ${collapsed ? "nav-collapsed" : ""}`}
      >
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <aside className="sidebar">
          <Brand />
          <div className="workspace-label">
            {auth.user?.is_platform_admin ? "正在代管空间" : "我的财富空间"}
          </div>
          <nav aria-label="主要导航">
            {visibleNav.map((n) => (
              <NavLink
                key={n.path}
                to={`/spaces/${space.id}/${n.path}`}
                className={({ isActive }) =>
                  `nav-item ${isActive ? "active" : ""}`
                }
                title={n.name}
              >
                <n.icon size={20} strokeWidth={1.7} />
                <span>{simple ? n.simple : n.name}</span>
                <span className="nav-nail" />
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {auth.user?.is_platform_admin && (
              <NavLink
                className={({ isActive }) =>
                  `nav-item ${isActive ? "active" : ""}`
                }
                to={`/spaces/${space.id}/administration`}
                title="代管数据管理"
              >
                <ClipboardList size={20} />
                <span>代管数据管理</span>
              </NavLink>
            )}
            <NavLink
              className="nav-item settings-nav"
              to={`/spaces/${space.id}/manage`}
            >
              <SettingsIcon size={20} />
              <span>管理中心</span>
            </NavLink>
            <button
              className="user-button"
              onClick={() =>
                modal.confirm({
                  title: "退出当前账户？",
                  okText: "退出登录",
                  cancelText: "取消",
                  onOk: async () => {
                    await send("/auth/logout");
                    onAuthChange();
                  },
                })
              }
            >
              <Avatar
                size={30}
                style={{
                  background: "var(--theme-primary-soft)",
                  color: "var(--theme-primary-ink)",
                }}
              >
                {auth.user?.username[0]?.toUpperCase()}
              </Avatar>
              <span>
                {auth.user?.username}
                <small>
                  {auth.user?.is_platform_admin
                    ? "平台管理员 · 代管中"
                    : {
                        owner: "空间管理员",
                        editor: "可编辑成员",
                        viewer: "只读成员",
                      }[space.role] || space.role}
                </small>
              </span>
              <LogOut size={15} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="topbar-left">
              <Button
                type="text"
                aria-label={collapsed ? "展开导航" : "折叠导航"}
                icon={<Menu size={20} />}
                onClick={() => setCollapsed(!collapsed)}
              />
              {auth.user?.is_platform_admin ? (
                <Space wrap>
                  <Button onClick={() => navigate("/admin")}>
                    返回管理工作台
                  </Button>
                  <strong>{space.name}</strong>
                  <Tag color="blue">代管中</Tag>
                </Space>
              ) : (
                <Dropdown
                  menu={{
                    items: [
                      ...auth.spaces.map((s) => ({
                        key: s.id,
                        label: (
                          <span>
                            {s.name} {s.id === space.id ? "✓" : ""}
                          </span>
                        ),
                        onClick: () => changeSpace(s.id),
                      })),
                      { type: "divider" },
                      {
                        key: "new",
                        label: "＋ 新建账簿空间",
                        onClick: () => setNewSpaceOpen(true),
                      },
                      {
                        key: "join",
                        label: "使用邀请码加入",
                        onClick: () => {
                          setJoinOpen(true);
                          setInvitePreview(null);
                        },
                      },
                    ],
                  }}
                  trigger={["click"]}
                >
                  <button className="space-picker">
                    {space.name}
                    <ChevronDown size={14} />
                  </button>
                </Dropdown>
              )}
              <span className="context-currency">{space.base_currency}</span>
              <span className="topbar-divider" />
              <span className="date-label">
                {dateToday().replaceAll("-", ".")}
              </span>
            </div>
            <div className="topbar-actions">
              <ThemeSwitcher />
              <Tooltip title="搜索当前空间">
                <Button
                  type="text"
                  aria-label="搜索当前空间"
                  icon={<Search size={18} />}
                  onClick={() => setSearchOpen(true)}
                />
              </Tooltip>
              <Tooltip title={hidden ? "显示金额" : "隐藏金额"}>
                <Button
                  type="text"
                  aria-label={hidden ? "显示金额" : "隐藏金额"}
                  icon={hidden ? <EyeOff size={18} /> : <Eye size={18} />}
                  onClick={togglePrivacy}
                />
              </Tooltip>
              <Tooltip title="显示偏好">
                <Button
                  type="text"
                  aria-label="显示偏好"
                  icon={<SlidersHorizontal size={18} />}
                  onClick={() => setSettingsOpen(true)}
                />
              </Tooltip>
              <Button
                className="import-shortcut"
                icon={<FolderInput size={16} />}
                onClick={() =>
                  navigate(
                    `/spaces/${space.id}/cashbook?tab=imports&upload=${Date.now()}`,
                  )
                }
              >
                导入账单
              </Button>
              <Button
                type="text"
                className="todo-shortcut"
                onClick={() =>
                  navigate(`/spaces/${space.id}/cashbook?tab=todos`)
                }
              >
                待办
              </Button>
              {space.role !== "viewer" && (
                <Button
                  type="primary"
                  icon={<Plus size={16} />}
                  onClick={() => context.openEvent()}
                >
                  记一笔
                </Button>
              )}
            </div>
          </header>
          <main id="main-content" className="page-content">
            {current &&
              navigationHidden(
                "main",
                current.path,
                navigation.preferences.groups.main,
              ) && (
                <Alert
                  className="navigation-hidden-note"
                  type="info"
                  message="此页面的一级入口已隐藏，当前通过直接链接打开。"
                  action={
                    <Button
                      size="small"
                      onClick={() => navigation.edit("main")}
                    >
                      调整导航
                    </Button>
                  }
                />
              )}
            <Suspense
              fallback={
                <div className="loading-state">
                  <Spin />
                  正在打开页面…
                </div>
              }
            >
              <Routes>
                {auth.user?.is_platform_admin && (
                  <Route
                    path="administration"
                    element={<AdminDataManagement />}
                  />
                )}
                <Route path="home" element={<Home />} />
                <Route path="assets" element={<Assets />} />
                <Route
                  path="investments"
                  element={
                    <Navigate
                      to={`/spaces/${space.id}/assets?tab=holdings`}
                      replace
                    />
                  }
                />
                <Route
                  path="cashbook"
                  element={<Cashbook key={location.search} />}
                />
                <Route path="planning" element={<Planning />} />
                <Route path="notebook" element={<Notebook />} />
                <Route path="analytics" element={<Analytics />} />
                <Route
                  path="manage"
                  element={
                    <Settings
                      workspaceActions={
                        <WorkspaceActions
                          onChanged={onAuthChange}
                          admin={!!auth.user?.is_platform_admin}
                        />
                      }
                      templateContent={<ConfigurationLibrary />}
                    />
                  }
                />
                <Route
                  path="settings"
                  element={
                    <Navigate
                      to={`/spaces/${space.id}/manage${location.search}`}
                      replace
                    />
                  }
                />
                <Route path="*" element={<Navigate to="home" replace />} />
              </Routes>
            </Suspense>
            <footer className="workspace-footer">
              <span>拾财 / {current?.simple || "管理中心"}</span>
              <span>当前空间数据 · {space.base_currency} 本位币</span>
            </footer>
          </main>
        </div>
        <EventModal
          open={eventOpen}
          onClose={() => setEventOpen(false)}
          preset={preset}
        />
        <DetailDrawer item={detail} onClose={() => setDetail(null)} />
        <SearchDrawer open={searchOpen} onClose={() => setSearchOpen(false)} />
        <Drawer
          title="显示偏好"
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          width={360}
        >
          <ThemePreferences />
          <div className="preference-item">
            <div>
              <strong>低装饰模式</strong>
              <p>隐藏背景纹理和场景插画</p>
            </div>
            <Switch
              aria-label="低装饰模式"
              checked={quiet}
              onChange={(v) => {
                setQuiet(v);
                localStorage.setItem("wealth:quiet", v ? "1" : "0");
              }}
            />
          </div>
          <div className="preference-item">
            <div>
              <strong>简洁菜单名称</strong>
              <p>使用资产、收支、规划等简称</p>
            </div>
            <Switch
              aria-label="简洁菜单名称"
              checked={simple}
              onChange={(v) => {
                setSimple(v);
                localStorage.setItem("wealth:simple", v ? "1" : "0");
              }}
            />
          </div>
          <div className="preference-item">
            <div>
              <strong>遮挡金额</strong>
              <p>同时隐藏图表、说明和完整记录详情</p>
            </div>
            <Switch
              aria-label="遮挡金额"
              checked={hidden}
              onChange={togglePrivacy}
            />
          </div>
        </Drawer>
        <Modal
          title="新建账簿空间"
          open={newSpaceOpen}
          onCancel={() => {
            if (!newSpaceSubmitting.current) setNewSpaceOpen(false);
          }}
          closable={!newSpaceBusy}
          maskClosable={!newSpaceBusy}
          keyboard={!newSpaceBusy}
          footer={null}
        >
          <Form
            layout="vertical"
            disabled={newSpaceBusy}
            initialValues={{ base_currency: "CNY" }}
            onFinish={async (values) => {
              if (newSpaceSubmitting.current) return;
              newSpaceSubmitting.current = true;
              setNewSpaceBusy(true);
              try {
                const created = await send("/spaces", values);
                message.success("空间已建立");
                setNewSpaceOpen(false);
                await onAuthChange();
                navigate(`/spaces/${created.id}/manage?tab=members`);
                if (created.invitation?.token)
                  modal.info({
                    title: "邀请加入新空间",
                    content: <InviteResult token={created.invitation.token} />,
                    width: 580,
                  });
              } catch (e) {
                message.error((e as Error).message);
              } finally {
                newSpaceSubmitting.current = false;
                setNewSpaceBusy(false);
              }
            }}
          >
            <Fields
              fields={[
                { name: "name", label: "空间名称", required: true },
                {
                  name: "base_currency",
                  label: "本位币",
                  type: "select",
                  options: currencyOptions,
                  required: true,
                },
              ]}
            />
            <Form.Item name="create_invitation" valuePropName="checked">
              <Checkbox>同时生成邀请码（只读成员，7 天有效）</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={newSpaceBusy}>
              创建独立空间
            </Button>
          </Form>
        </Modal>
        <Modal
          title="使用邀请码加入空间"
          open={joinOpen}
          onCancel={() => setJoinOpen(false)}
          footer={null}
        >
          <Alert
            className="form-alert"
            type="info"
            showIcon
            message="加入前请向邀请方确认空间名称、角色与共享范围。"
          />
          <Form
            layout="vertical"
            onValuesChange={() => setInvitePreview(null)}
            onFinish={async (values) => {
              try {
                if (!invitePreview) {
                  setInvitePreview(await send("/invitations/preview", values));
                  return;
                }
                await send("/invitations/accept", values);
                message.success("已加入空间");
                setJoinOpen(false);
                onAuthChange();
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            <Form.Item
              name="token"
              label="邀请码"
              rules={[{ required: true, message: "请输入邀请码" }]}
            >
              <Input.TextArea rows={3} />
            </Form.Item>
            {invitePreview && (
              <Alert
                className="form-alert"
                type="info"
                showIcon
                message={`空间：${invitePreview.space_name} · ${invitePreview.role}`}
                description={`${invitePreview.sharing}。有效至 ${invitePreview.expires_at?.slice(0, 16).replace("T", " ")}`}
              />
            )}
            <Button type="primary" htmlType="submit">
              {invitePreview ? "确认共享范围并加入" : "核实邀请与共享范围"}
            </Button>
          </Form>
        </Modal>
      </div>
    </WorkspaceContext.Provider>
  );
}
function SearchDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const location = useLocation(),
    navigate = useNavigate();
  const { hidden } = useWorkspace();
  const spaceId = location.pathname.split("/")[2];
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    setBusy(true);
    setError("");
    Promise.all(
      ["accounts", "instruments", "events", "notes"].map(async (resource) => ({
        resource,
        data: await api(`/spaces/${spaceId}/${resource}`),
      })),
    )
      .then((result) => {
        if (live)
          setItems(
            result.flatMap((r) =>
              listOf<Item>(r.data).map((item) => ({
                ...item,
                resource: r.resource,
              })),
            ),
          );
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [open, spaceId]);
  const results = query
    ? items
        .filter((i) =>
          [i.name, i.title, i.description, i.code]
            .filter(Boolean)
            .join(" ")
            .includes(query),
        )
        .slice(0, 30)
    : [];
  return (
    <Drawer title="搜索当前空间" open={open} onClose={onClose} width={480}>
      <Input.Search
        autoFocus
        placeholder="账户、产品、记录说明或手札标题"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        allowClear
      />
      {busy ? (
        <div className="loading-state">
          <Spin />
        </div>
      ) : error ? (
        <Alert className="form-alert" type="error" message={error} />
      ) : (
        <div className="search-results">
          {results.map((i) => (
            <button
              key={`${i.resource}-${i.id}`}
              onClick={() => {
                navigate(
                  `/spaces/${spaceId}/${({ accounts: "assets", instruments: "assets?tab=products", events: "cashbook", notes: "notebook" } as any)[i.resource]}`,
                );
                onClose();
              }}
            >
              <span>
                {i.name || i.title || (hidden ? "内容已隐藏" : i.description)}
              </span>
              <small>
                {
                  {
                    accounts: "账户",
                    instruments: "投资产品",
                    events: "真实事项",
                    notes: "手札",
                  }[i.resource as string]
                }
              </small>
            </button>
          ))}
          {query && !results.length && <p>当前空间没有匹配记录。</p>}
          {!query && <p>请输入关键词。搜索结果不包含其他空间的数据。</p>}
        </div>
      )}
    </Drawer>
  );
}
