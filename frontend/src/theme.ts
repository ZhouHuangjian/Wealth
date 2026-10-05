export type ThemePreference = "day" | "night" | "system";
export type ThemeName = "day" | "night";

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "day" || value === "night" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ThemeName {
  return preference === "system" ? (systemDark ? "night" : "day") : preference;
}

export function themePreferenceKey(userId?: unknown): string {
  const value =
    typeof userId === "string" || typeof userId === "number"
      ? String(userId).trim()
      : "";
  return `wealth:appearance:v1:${value && value.length <= 200 ? encodeURIComponent(value) : "guest"}`;
}

export const themeOptions = [
  { value: "day", label: "日间", name: "大耳狗 · 云朵日间" },
  { value: "night", label: "夜间", name: "库洛米 · 星月夜间" },
  { value: "system", label: "跟随系统", name: "随系统切换日间与夜间" },
] as const;

export const themePalettes = {
  day: {
    page: "#edf5fc",
    surface: "#ffffff",
    surfaceAlt: "#f4f9fe",
    elevated: "#ffffff",
    sidebar: "#e7f2fc",
    border: "#d5e4f0",
    borderStrong: "#abc6dc",
    text: "#253b50",
    textSecondary: "#4c6378",
    muted: "#596f84",
    primary: "#256fa1",
    primaryHover: "#1c5e8c",
    primarySoft: "#dceefd",
    primaryInk: "#225f89",
    primaryContrast: "#ffffff",
    accent: "#a7d7f7",
    pink: "#eeb5cc",
    pinkSoft: "#fff0f6",
    gain: "#bd3b53",
    loss: "#18754f",
    error: "#ba354d",
    warning: "#93601b",
    success: "#18754f",
    info: "#286fa7",
    errorSoft: "#fff0f3",
    warningSoft: "#fff8e9",
    successSoft: "#edf9f3",
    infoSoft: "#edf6ff",
    shadow: "#567d9f",
    chart: "#3a91c6",
    chartArea: "#a5d6f2",
    grid: "#dce8f2",
    mask: "rgba(26,48,69,0.38)",
  },
  night: {
    page: "#14111e",
    surface: "#211c2e",
    surfaceAlt: "#292236",
    elevated: "#30273f",
    sidebar: "#1c1729",
    border: "#463850",
    borderStrong: "#756086",
    text: "#f4eefa",
    textSecondary: "#d2c4de",
    muted: "#b5a6c4",
    primary: "#c7a8f6",
    primaryHover: "#dbc4ff",
    primarySoft: "#3a2b4d",
    primaryInk: "#e1c9fa",
    primaryContrast: "#241631",
    accent: "#80609f",
    pink: "#f4a4cd",
    pinkSoft: "#43263d",
    gain: "#ff96b0",
    loss: "#69d9b0",
    error: "#ff98a8",
    warning: "#efc47d",
    success: "#69d9b0",
    info: "#b2c9ff",
    errorSoft: "#412536",
    warningSoft: "#3c3027",
    successSoft: "#21392f",
    infoSoft: "#283047",
    shadow: "#080611",
    chart: "#c8a7fb",
    chartArea: "#644d86",
    grid: "#46394f",
    mask: "rgba(4,2,10,0.62)",
  },
} as const;

export function themeVariables(name: ThemeName): Record<string, string> {
  return Object.fromEntries(
    Object.entries(themePalettes[name]).map(([key, value]) => [
      `--theme-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    ]),
  );
}
