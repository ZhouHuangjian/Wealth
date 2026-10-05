import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  App as AntApp,
  Button,
  ConfigProvider,
  Dropdown,
  Tooltip,
  theme as antTheme,
} from "antd";
import { Monitor } from "lucide-react";
import zhCN from "antd/locale/zh_CN";
import {
  normalizeThemePreference,
  resolveTheme,
  themeOptions,
  themePalettes,
  themePreferenceKey,
  themeVariables,
} from "./theme";
import type { ThemeName, ThemePreference } from "./theme";
import { ThemeCharacter } from "./theme-character";
import "./theme.css";

type ThemeContextValue = {
  name: ThemeName;
  preference: ThemePreference;
  palette: (typeof themePalettes)[ThemeName];
  setPreference: (preference: ThemePreference) => void;
  setIdentity: (userId: unknown) => void;
};
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(key: string): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(key));
  } catch {
    return "system";
  }
}

export function useWealthTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is missing");
  return value;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState(() => themePreferenceKey());
  const [stored, setStored] = useState(() => ({
    key,
    value: readPreference(key),
  }));
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches || false,
  );
  const preference = stored.key === key ? stored.value : readPreference(key);
  const name = resolveTheme(preference, systemDark);
  const palette = themePalettes[name];
  const setIdentity = useCallback(
    (userId: unknown) => setKey(themePreferenceKey(userId)),
    [],
  );
  const setPreference = useCallback(
    (value: ThemePreference) => {
      const next = normalizeThemePreference(value);
      setStored({ key, value: next });
      try {
        localStorage.setItem(key, next);
      } catch {
        /* Preference still applies when browser storage is unavailable. */
      }
    },
    [key],
  );
  useEffect(() => {
    setStored({ key, value: readPreference(key) });
    const listener = (event: StorageEvent) => {
      if (event.key === key || event.key === null)
        setStored({ key, value: readPreference(key) });
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, [key]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    listener();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = name;
    root.dataset.themePreference = preference;
    root.style.colorScheme = name === "night" ? "dark" : "light";
    for (const [key, value] of Object.entries(themeVariables(name)))
      root.style.setProperty(key, value);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", palette.page);
  }, [name, preference]);
  const value = useMemo(
    () => ({ name, preference, palette, setPreference, setIdentity }),
    [name, preference, palette, setPreference, setIdentity],
  );
  const config = useMemo(
    () => ({
      algorithm:
        name === "night" ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
      token: {
        colorPrimary: palette.primary,
        colorInfo: palette.info,
        colorSuccess: palette.success,
        colorWarning: palette.warning,
        colorError: palette.error,
        colorText: palette.text,
        colorTextSecondary: palette.textSecondary,
        colorTextTertiary: palette.muted,
        colorTextQuaternary: palette.muted,
        colorTextPlaceholder: palette.muted,
        colorTextLightSolid: palette.primaryContrast,
        colorBgBase: palette.page,
        colorBgContainer: palette.surface,
        colorBgElevated: palette.elevated,
        colorBgLayout: palette.page,
        colorFillAlter: palette.surfaceAlt,
        colorBgContainerDisabled: palette.surfaceAlt,
        colorBorder: palette.borderStrong,
        colorBorderSecondary: palette.border,
        colorSplit: palette.border,
        colorBgMask: palette.mask,
        borderRadius: 10,
        fontSize: 14,
        controlHeight: 38,
        fontFamily: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
      },
      components: {
        Table: {
          headerBg: palette.surfaceAlt,
          headerColor: palette.textSecondary,
          rowHoverBg: palette.primarySoft,
          borderColor: palette.border,
          headerSplitColor: palette.border,
        },
        Tabs: {
          inkBarColor: palette.primary,
          itemColor: palette.textSecondary,
        },
        Button: {
          primaryShadow: "none",
          defaultShadow: "none",
          defaultBg: palette.surface,
          defaultBorderColor: palette.borderStrong,
        },
        Modal: {
          contentBg: palette.surface,
          headerBg: palette.surface,
          titleColor: palette.text,
        },
        Drawer: { colorBgElevated: palette.surface },
        Tooltip: {
          colorBgSpotlight: name === "night" ? "#e7d9f5" : "#284761",
          colorTextLightSolid: name === "night" ? "#261a35" : "#ffffff",
        },
        Select: {
          optionSelectedBg: palette.primarySoft,
          optionSelectedColor: palette.primaryInk,
          optionActiveBg: palette.surfaceAlt,
        },
        Input: { activeBg: palette.surface, hoverBg: palette.surface },
        Segmented: {
          trackBg: palette.surfaceAlt,
          itemSelectedBg: palette.surface,
          itemSelectedColor: palette.primaryInk,
        },
        Alert: {
          colorInfoBg: palette.infoSoft,
          colorSuccessBg: palette.successSoft,
          colorWarningBg: palette.warningSoft,
          colorErrorBg: palette.errorSoft,
        },
      },
    }),
    [name, palette],
  );
  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider locale={zhCN} theme={config}>
        <AntApp>
          {children}
          <ThemeSwitcher floating />
        </AntApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function ThemeSwitcher({ floating = false }: { floating?: boolean }) {
  const { name, preference, setPreference } = useWealthTheme();
  const [open, setOpen] = useState(false);
  return (
    <div
      className={floating ? "theme-switcher theme-floating" : "theme-switcher"}
    >
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={["click"]}
        menu={{
          selectedKeys: [preference],
          items: themeOptions.map((option) => ({
            key: option.value,
            label: option.name,
            icon:
              option.value === "system" ? (
                <Monitor size={16} />
              ) : (
                <ThemeCharacter
                  name={option.value}
                  className="theme-menu-character"
                />
              ),
            onClick: () => {
              setPreference(option.value);
              setOpen(false);
            },
          })),
        }}
      >
        <Tooltip
          title={
            open
              ? null
              : `外观 · ${name === "day" ? "大耳狗日间" : "库洛米夜间"}${preference === "system" ? " · 跟随系统" : ""}`
          }
        >
          <Button
            type="text"
            aria-label="切换主题"
            className="theme-toggle"
            icon={<ThemeCharacter name={name} />}
          />
        </Tooltip>
      </Dropdown>
    </div>
  );
}

export function ThemePreferences() {
  const { name, preference, setPreference } = useWealthTheme();
  return (
    <section className="theme-preferences" aria-label="外观主题">
      <div className="theme-preferences-title">
        <strong>外观主题</strong>
        <span>
          {preference === "system"
            ? "跟随系统"
            : name === "day"
              ? "日间"
              : "夜间"}
        </span>
      </div>
      <div className="theme-previews">
        {(["day", "night"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`theme-preview ${mode}`}
            aria-pressed={preference === mode}
            onClick={() => setPreference(mode)}
          >
            <ThemeCharacter name={mode} />
            <strong>{mode === "day" ? "大耳狗" : "库洛米"}</strong>
            <small>{mode === "day" ? "云朵日间" : "星月夜间"}</small>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="theme-system-choice"
        aria-pressed={preference === "system"}
        onClick={() => setPreference("system")}
      >
        <Monitor size={15} />
        <span>跟随系统</span>
        {preference === "system" && <span aria-hidden="true">✓</span>}
      </button>
    </section>
  );
}
