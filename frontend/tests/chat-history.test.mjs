import test from "node:test";
import assert from "node:assert/strict";
import {
  historyResponseMatches,
  mergeHistoryPage,
  historyPeople,
  historyCurrent,
  historyReadLabel,
} from "../src/chat-history-model.ts";

const item = (sequence, extra = {}) => ({
  id: `message-${sequence}`,
  sequence,
  role: "peer",
  text: `完整消息${sequence}`,
  kind: "text",
  revision: "a".repeat(64),
  sentAt: null,
  ...extra,
});
const page = (items, extra = {}) => ({
  user_id: "1",
  device_id: "mac-a",
  conversationId: "person-a",
  version: 1,
  historyRevision: 7,
  items,
  next_cursor: "older",
  total: 1800,
  progress: {
    streamId: "stream-a",
    phase: "live",
    totalMessages: 1800,
    lastSyncedAt: "2026-10-23T00:00:00Z",
  },
  ...extra,
});

test("history responses require account, device and selected conversation to match", () => {
  assert.equal(
    historyResponseMatches(page([]), "1", "mac-a", "person-a"),
    true,
  );
  for (const [key, value] of [
    ["user_id", "2"],
    ["device_id", "mac-b"],
    ["conversationId", "person-b"],
  ]) {
    assert.equal(
      historyResponseMatches(
        page([], { [key]: value }),
        "1",
        "mac-a",
        "person-a",
      ),
      false,
    );
  }
  assert.equal(
    historyResponseMatches(
      page([], { conversationId: null }),
      "1",
      "mac-a",
      null,
    ),
    true,
  );
});

test("paging keeps every older message, updates analysis and keeps the oldest cursor", () => {
  const latest = page([item(1799), item(1800)]);
  const previous = mergeHistoryPage(
    latest,
    page([item(1), item(2)], { next_cursor: null }),
    true,
  );
  assert.deepEqual(
    previous.items.map((row) => row.sequence),
    [1, 2, 1799, 1800],
  );
  assert.equal(previous.next_cursor, null);
  const updated = mergeHistoryPage(
    previous,
    page([
      item(1799),
      item(1800, {
        analysis: {
          intents: [{ label: "关心", percentage: 100 }],
          stale: true,
        },
      }),
    ]),
    false,
  );
  assert.equal(updated.items.length, 4);
  assert.equal(updated.items.at(-1).analysis.stale, true);
  assert.equal(updated.next_cursor, null);
});

test("a source revision or private scope change resets pages instead of reviving deleted messages", () => {
  const previous = page([item(1), item(1800)]);
  for (const extra of [
    { historyRevision: 8 },
    { device_id: "mac-b" },
    { user_id: "2" },
    { conversationId: "person-b" },
  ]) {
    const received = page([item(1800)], extra);
    assert.equal(mergeHistoryPage(previous, received, false), received);
  }
});

test("archive directory contains every contact and its tombstones override bounded snapshots", () => {
  const contacts = Array.from({ length: 15 }, (_, i) => ({
    id: `person-${i}`,
    name: `联系人${i}`,
    note: "",
    enabled: true,
    processing: { intentEnabled: true },
  }));
  const snapshot = [
    { id: "removed", name: "旧快照已删除的人", externalId: "private" },
    {
      id: "person-0",
      name: "旧名字",
      externalId: "bound-id",
      revision: "old-config",
      enabled: false,
    },
  ];
  const people = historyPeople(contacts, snapshot);
  assert.equal(people.length, 15);
  assert.equal(
    people.some((person) => person.id === "removed"),
    false,
  );
  assert.equal(people[0].name, "联系人0");
  assert.equal(people[0].externalId, "bound-id");
  assert.equal(people[0].enabled, true);
  assert.equal(people.at(-1).externalId, "");
});

test("archive-only contact uses its scoped successful result and archive history", () => {
  const person = { id: "person-a" };
  const current = {
    conversationId: "person-a",
    revision: "rev",
    syncedAt: "2026-10-23T00:01:00Z",
    messages: [item(1800)],
    drafts: [{ id: "draft", basedOnMessageId: "message-1800" }],
    profile: { basisFacts: [] },
  };
  const status = {
    user_id: "1",
    device_id: "mac-a",
    snapshot: { remoteEnabled: true, conversations: [] },
    commands: [{ status: "succeeded", result: { currentView: current } }],
  };
  const result = historyCurrent(status, person, page([item(1), item(1800)]));
  assert.equal(result.messages.length, 2);
  assert.equal(result.drafts[0].id, "draft");
  assert.equal(result.truncated, false);
  assert.equal(
    historyCurrent(
      { ...status, snapshot: { remoteEnabled: false } },
      person,
      page([]),
    ),
    undefined,
  );
  assert.equal(historyCurrent(status, undefined, page([])), undefined);
  assert.equal(
    historyCurrent(status, person, page([item(99)], { user_id: "2" })),
    current,
  );
});

test("read labels distinguish loaded complete history from interrupted or incomplete history", () => {
  assert.match(
    historyReadLabel({ status: "complete", scanned: 12000 }),
    /全部读取.*12000/,
  );
  assert.match(
    historyReadLabel({ status: "error", scanned: 600 }),
    /中断.*600/,
  );
  assert.match(
    historyReadLabel({ status: "pending", scanned: 200 }),
    /补齐.*200/,
  );
  assert.match(historyReadLabel(undefined), /等待/);
});
