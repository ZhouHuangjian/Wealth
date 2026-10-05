import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeThemePreference,
  resolveTheme,
  themePalettes,
  themePreferenceKey,
  themeVariables,
} from "../src/theme.ts";

function luminance(hex) {
  const parts = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("explicit appearance overrides system changes while automatic appearance follows them", () => {
  assert.equal(resolveTheme("system", false), "day");
  assert.equal(resolveTheme("system", true), "night");
  for (const systemDark of [false, true]) {
    assert.equal(resolveTheme("day", systemDark), "day");
    assert.equal(resolveTheme("night", systemDark), "night");
  }
  for (const value of [null, undefined, "", "dark", "NIGHT", {}, "<script>"])
    assert.equal(normalizeThemePreference(value), "system");
});

test("appearance preferences are separated by user and anonymous session", () => {
  assert.notEqual(
    themePreferenceKey("user-one"),
    themePreferenceKey("user-two"),
  );
  assert.notEqual(themePreferenceKey("user-one"), themePreferenceKey());
  assert.equal(themePreferenceKey(null), themePreferenceKey());
  assert.equal(
    themePreferenceKey("user / one"),
    "wealth:appearance:v1:user%20%2F%20one",
  );
  assert.equal(themePreferenceKey(12), themePreferenceKey("12"));
});

test("both themes supply identical complete tokens including chart and feedback colors", () => {
  const names = Object.keys(themeVariables("day")).sort();
  assert.deepEqual(names, Object.keys(themeVariables("night")).sort());
  for (const name of ["day", "night"]) {
    const vars = themeVariables(name);
    assert.equal(
      vars["--theme-primary-contrast"],
      themePalettes[name].primaryContrast,
    );
    for (const key of [
      "surface",
      "elevated",
      "border",
      "text",
      "muted",
      "chart",
      "chart-area",
      "error-soft",
      "warning-soft",
      "success-soft",
      "mask",
    ])
      assert.ok(vars[`--theme-${key}`], `${name}: ${key}`);
  }
});

test("financial text and secondary information keep readable contrast in either theme", () => {
  for (const [name, palette] of Object.entries(themePalettes)) {
    for (const background of ["surface", "surfaceAlt", "page", "elevated"]) {
      for (const foreground of [
        "text",
        "textSecondary",
        "muted",
        "gain",
        "loss",
      ]) {
        assert.ok(
          contrast(palette[foreground], palette[background]) >= 4.5,
          `${name} ${foreground}/${background}: ${contrast(palette[foreground], palette[background]).toFixed(2)}`,
        );
      }
    }
    assert.ok(
      contrast(palette.primaryContrast, palette.primary) >= 4.5,
      `${name}: primary button`,
    );
    assert.ok(
      contrast(palette.primaryInk, palette.primarySoft) >= 4.5,
      `${name}: selected controls`,
    );
    for (const semantic of ["error", "warning", "success", "info"])
      assert.ok(
        contrast(palette[semantic], palette[`${semantic}Soft`]) >= 4.5,
        `${name}: ${semantic}`,
      );
  }
});
