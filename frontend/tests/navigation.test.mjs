import test from "node:test";
import assert from "node:assert/strict";
import {
  orderedNavigation,
  navigationHidden,
  selectNavigationKey,
} from "../src/navigation-model.ts";
const items = [{ key: "first" }, { key: "second" }, { key: "third" }];
test("navigation order tolerates retired keys and keeps newly added entries", () => {
  assert.deepEqual(
    orderedNavigation(items, {
      order: ["retired", "third", "third", "first"],
      hidden: [],
    }).map((i) => i.key),
    ["third", "first", "second"],
  );
});
test("hidden direct links remain accessible and override stale controlled tab state", () => {
  const preference = { order: ["second", "first", "third"], hidden: ["third"] };
  assert.equal(
    selectNavigationKey(items, "assets", preference, {
      explicit: true,
      directKey: "third",
      activeKey: "first",
    }),
    "third",
  );
  assert.equal(navigationHidden("assets", "third", preference), true);
  assert.equal(
    selectNavigationKey(items, "assets", preference, {
      explicit: false,
      activeKey: "first",
    }),
    "second",
  );
});
test("hidden groups have no implicit tab, but an explicit route remains usable", () => {
  const preference = { order: [], hidden: ["first", "second", "third"] };
  assert.equal(
    selectNavigationKey(items, "assets", preference, {
      explicit: false,
      chosen: "first",
    }),
    undefined,
  );
  assert.equal(
    selectNavigationKey(items, "assets", preference, {
      explicit: true,
      directKey: "second",
    }),
    "second",
  );
});
test("navigation recovery settings cannot be hidden and legacy route mappings still work", () => {
  assert.equal(
    navigationHidden("settings", "navigation", {
      order: [],
      hidden: ["navigation"],
    }),
    false,
  );
  assert.equal(
    selectNavigationKey(
      [{ key: "holdings" }, { key: "records" }],
      "assets",
      undefined,
      { explicit: true, directKey: "accounts", activeKey: "records" },
    ),
    "records",
  );
});
