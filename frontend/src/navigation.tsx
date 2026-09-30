import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tooltip,
} from "antd";
import type { TabsProps } from "antd";
import { ArrowDown, ArrowUp, Settings2 } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";
import { api, send } from "./api";
import {
  navigationCatalog,
  navigationHidden,
  orderedNavigation,
  selectNavigationKey,
} from "./navigation-model";
import type { NavigationPreferences } from "./navigation-model";
type NavigationState = {
  preferences: NavigationPreferences;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  save: (groups: NavigationPreferences["groups"]) => Promise<void>;
  edit: (group?: string) => void;
  isAdmin: boolean;
};
const NavigationContext = createContext<NavigationState>(null!);
export const useNavigation = () => useContext(NavigationContext);
export function NavigationProvider({
  children,
  isAdmin = false,
}: {
  children: ReactNode;
  isAdmin?: boolean;
}) {
  const [preferences, setPreferences] = useState<NavigationPreferences>({
    version: 0,
    groups: {},
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [editor, setEditor] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api<NavigationPreferences>("/me/navigation-preferences")
      .then((r) => {
        if (active) setPreferences(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(groups: NavigationPreferences["groups"]) {
    const result = await send(
      "/me/navigation-preferences",
      { version: preferences.version, groups },
      "PUT",
    );
    setPreferences(result);
    setError("");
  }
  return (
    <NavigationContext.Provider
      value={{
        preferences,
        isAdmin,
        loading,
        error,
        save,
        reload: async () => {
          setPreferences(
            await api<NavigationPreferences>("/me/navigation-preferences"),
          );
        },
        edit: (group = "main") => setEditor(group),
      }}
    >
      {children}
      <Drawer
        title="导航偏好"
        width={650}
        open={editor !== null}
        onClose={() => setEditor(null)}
      >
        {editor !== null && <NavigationEditor initialGroup={editor} />}
      </Drawer>
    </NavigationContext.Provider>
  );
}
export function NavigationEditor({
  initialGroup = "main",
}: {
  initialGroup?: string;
}) {
  const { preferences, loading, error, save, isAdmin } = useNavigation();
  const { message } = App.useApp();
  const [groups, setGroups] = useState(preferences.groups),
    [selected, setSelected] = useState(initialGroup),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setGroups(preferences.groups);
  }, [preferences]);
  useEffect(() => setSelected(initialGroup), [initialGroup]);
  const catalog = navigationCatalog[selected] || navigationCatalog.main;
  const rows = orderedNavigation(
    catalog.items.map(([key, name]) => ({ key, name })),
    groups[selected],
  );
  function change(key: string, direction: number) {
    const order = rows.map((r) => r.key),
      i = order.indexOf(key);
    [order[i], order[i + direction]] = [order[i + direction], order[i]];
    setGroups({
      ...groups,
      [selected]: { hidden: groups[selected]?.hidden || [], order },
    });
  }
  async function submit(next = groups) {
    setBusy(true);
    try {
      await save(next);
      message.success("个人导航偏好已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="navigation-editor">
      <p className="data-caption">
        顺序和显示仅影响你自己的入口，跨设备保存。隐藏不会撤销权限，已有直接链接仍可打开。管理中心始终保留；导航调整也可以统一在管理中心中完成。
      </p>
      {error && <Alert type="warning" message={error} className="form-alert" />}
      <Select
        aria-label="选择导航层级"
        value={selected}
        onChange={setSelected}
        style={{ width: "100%" }}
        options={Object.entries(navigationCatalog)
          .filter(([key]) => isAdmin || key !== "admin")
          .map(([value, r]) => ({
            value,
            label: r.title,
          }))}
      />
      <Table
        rowKey="key"
        dataSource={rows}
        loading={loading}
        pagination={false}
        columns={[
          { title: "入口", dataIndex: "name" },
          {
            title: "显示",
            render: (_, r) => (
              <Switch
                aria-label={`显示${r.name}`}
                checked={!navigationHidden(selected, r.key, groups[selected])}
                disabled={catalog.locked?.includes(r.key)}
                onChange={(checked) => {
                  const hidden = new Set(groups[selected]?.hidden || []);
                  checked ? hidden.delete(r.key) : hidden.add(r.key);
                  setGroups({
                    ...groups,
                    [selected]: {
                      order: rows.map((x) => x.key),
                      hidden: [...hidden],
                    },
                  });
                }}
              />
            ),
          },
          {
            title: "顺序",
            render: (_, r, i) => (
              <Space>
                <Button
                  aria-label={`上移${r.name}`}
                  icon={<ArrowUp size={15} />}
                  disabled={i === 0}
                  onClick={() => change(r.key, -1)}
                />
                <Button
                  aria-label={`下移${r.name}`}
                  icon={<ArrowDown size={15} />}
                  disabled={i === rows.length - 1}
                  onClick={() => change(r.key, 1)}
                />
              </Space>
            ),
          },
        ]}
      />
      <Space wrap>
        <Button type="primary" loading={busy} onClick={() => submit()}>
          保存导航
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            const next = { ...groups };
            delete next[selected];
            setGroups(next);
          }}
        >
          恢复本组默认
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setGroups({});
            void submit({});
          }}
        >
          恢复全部默认
        </Button>
      </Space>
    </div>
  );
}
export function NavigationTabs({
  group,
  routeParam = "section",
  items = [],
  activeKey,
  defaultActiveKey,
  onChange,
  ...props
}: TabsProps & { group: string; routeParam?: string | false }) {
  const { preferences, edit } = useNavigation();
  const location = useLocation();
  const [, setParams] = useSearchParams();
  const params = new URLSearchParams(location.search);
  const explicit =
    routeParam &&
    (params.has(routeParam) ||
      (routeParam === "section" &&
        items.some((i) => i.key === params.get("tab"))));
  const ordered = orderedNavigation(items, preferences.groups[group]);
  const visible = ordered.filter(
    (i) => !navigationHidden(group, i.key, preferences.groups[group]),
  );
  const [chosen, setChosen] = useState<string>();
  const directKey = routeParam
    ? params.get(routeParam) || params.get("tab")
    : undefined;
  const selected = selectNavigationKey(
    items,
    group,
    preferences.groups[group],
    { explicit: !!explicit, directKey, activeKey, defaultActiveKey, chosen },
  );
  const isHidden = selected
    ? navigationHidden(group, selected, preferences.groups[group])
    : false;
  // A route is the source of truth, including browser Back/Forward. Never
  // write navigation from a render effect: inactive tab panels stay mounted
  // and their nested tabs must not navigate the active page back.
  const rendered = isHidden
    ? ordered.filter(
        (i) =>
          i.key === selected ||
          !navigationHidden(group, i.key, preferences.groups[group]),
      )
    : visible;
  return (
    <>
      {isHidden && (
        <Alert
          className="navigation-hidden-note"
          type="info"
          message="此入口已在个人导航中隐藏，当前通过直接链接打开。"
          action={
            <Button size="small" onClick={() => edit(group)}>
              调整导航
            </Button>
          }
        />
      )}
      {rendered.length ? (
        <Tabs
          {...props}
          className={[props.className, "personal-navigation-tabs"]
            .filter(Boolean)
            .join(" ")}
          activeKey={selected}
          items={rendered}
          onChange={(key) => {
            setChosen(key);
            onChange?.(key);
            if (routeParam) {
              const next = new URLSearchParams(location.search);
              if (routeParam === "tab") next.delete("section");
              next.set(routeParam, key);
              setParams(next);
            }
          }}
          tabBarExtraContent={
            <Tooltip title="调整本组菜单；也可在管理中心统一设置">
              <Button
                className="nav-config-trigger"
                type="text"
                size="small"
                aria-label={`调整${navigationCatalog[group]?.title || "当前"}导航`}
                icon={<Settings2 size={14} />}
                onClick={() => edit(group)}
              />
            </Tooltip>
          }
        />
      ) : (
        <Alert
          className="form-alert"
          message="本组入口已全部隐藏"
          action={<Button onClick={() => edit(group)}>恢复或调整导航</Button>}
        />
      )}
    </>
  );
}
