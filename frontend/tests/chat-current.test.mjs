import test from "node:test";
import assert from "node:assert/strict";
import {
  currentConversation,
  currentDraftsAreStale,
  currentIntentLabels,
  mergeCurrentView,
  reconcileCurrentStatus,
} from "../src/chat-current-model.ts";

const at = (minute) => `2026-10-14T00:${String(minute).padStart(2, "0")}:00Z`;
const conversation = (id, minute, text = "收到") => ({
  conversationId: id,
  revision: "a".repeat(64),
  syncedAt: at(minute),
  messages: [
    {
      id: "message-a",
      revision: "b".repeat(64),
      role: "peer",
      text,
      kind: "text",
      sequence: 1,
      sentAt: at(minute),
    },
  ],
  drafts: [],
});
const status = (view, commands = [], changes = {}) => ({
  user_id: "5",
  device_id: "mac-a",
  last_poll_at: at(1),
  commands,
  snapshot: {
    version: 2,
    remoteEnabled: true,
    settings: {},
    capabilities: {},
    conversations: [{ id: "person-a" }],
    currentView: view,
  },
  ...changes,
});

test("conversation feed stays scoped to selected contact", () => {
  const selected = conversation("person-a", 1);
  assert.equal(
    currentConversation(
      { syncedAt: at(1), conversations: [selected] },
      { id: "person-a" },
    ),
    selected,
  );
  assert.equal(
    currentConversation(
      { syncedAt: at(1), conversations: [selected] },
      { id: "person-b" },
    ),
    undefined,
  );
});
test("intent labels and percentages stay together in sorted display", () => {
  assert.deepEqual(
    currentIntentLabels({
      analysis: {
        intents: [
          { label: "关心", percentage: 20 },
          { label: "质问", percentage: 80 },
        ],
      },
    }),
    [
      { label: "质问", percentage: 80 },
      { label: "关心", percentage: 20 },
    ],
  );
});
test("fresh command receipts do not get overwritten by older snapshots", () => {
  const old = conversation("person-a", 1, "旧内容");
  const fresh = conversation("person-a", 2, "新内容");
  const view = { syncedAt: at(1), conversations: [old] };
  const receipt = { status: "succeeded", result: { currentView: fresh } };
  const result = reconcileCurrentStatus(null, status(view, [receipt]));
  assert.equal(
    result.snapshot.currentView.conversations[0].messages[0].text,
    "新内容",
  );
  assert.equal(
    reconcileCurrentStatus(result, status(view)).snapshot.currentView
      .conversations[0].messages[0].text,
    "新内容",
  );
  assert.equal(
    mergeCurrentView(result.snapshot.currentView, old),
    result.snapshot.currentView,
  );
});
test("disabled, revoked, switched account and removed contacts never restore cached private feeds", () => {
  const previous = status({
    syncedAt: at(2),
    conversations: [conversation("person-a", 2)],
  });
  const receipt = {
    status: "succeeded",
    result: { currentView: conversation("person-a", 2) },
  };
  const disabled = status(undefined, [receipt]);
  disabled.snapshot.remoteEnabled = false;
  assert.equal(
    reconcileCurrentStatus(previous, disabled).snapshot.currentView,
    undefined,
  );
  assert.equal(
    reconcileCurrentStatus(
      previous,
      status(undefined, [receipt], { snapshot: null }),
    ).snapshot,
    null,
  );
  const changed = status(
    { syncedAt: at(1), conversations: [conversation("person-a", 1)] },
    [],
    { user_id: "6" },
  );
  assert.equal(
    reconcileCurrentStatus(previous, changed).snapshot.currentView
      .conversations[0].syncedAt,
    at(1),
  );
  const removed = status({ syncedAt: at(1), conversations: [] }, [receipt]);
  removed.snapshot.conversations = [];
  assert.deepEqual(
    reconcileCurrentStatus(previous, removed).snapshot.currentView
      .conversations,
    [],
  );
});
test("drafts remain tied to exact newest peer message", () => {
  const current = conversation("person-a", 1);
  current.drafts = [{ basedOnMessageId: "message-a" }];
  assert.equal(currentDraftsAreStale(current), false);
  current.messages.push({ id: "message-b", role: "peer" });
  assert.equal(currentDraftsAreStale(current), true);
  current.messages.at(-1).role = "self";
  assert.equal(currentDraftsAreStale(current), true);
});
