import test from "node:test";
import assert from "node:assert/strict";
import {
  changedRemoteSettings,
  commandPending,
  remoteConnectionState,
  remoteResponseMatches,
} from "../src/chat-remote-model.ts";

const now = Date.parse("2026-10-11T00:00:00Z");
const status = (changes = {}) => ({
  snapshot: { remoteEnabled: true },
  last_poll_at: new Date(now - 30_000).toISOString(),
  ...changes,
});
test("remote availability relies on heartbeat and opt-in, not historic device verification", () => {
  assert.equal(remoteConnectionState(status(), now), "online");
  for (const last_poll_at of [
    null,
    "bad timestamp",
    new Date(now - 60_001).toISOString(),
    new Date(now + 60_001).toISOString(),
  ]) {
    assert.equal(
      remoteConnectionState(status({ last_poll_at }), now),
      "offline",
    );
  }
  assert.equal(
    remoteConnectionState(status({ snapshot: null }), now),
    "unconfigured",
  );
  assert.equal(
    remoteConnectionState(status({ snapshot: { remoteEnabled: false } }), now),
    "disabled",
  );
});
test("only edited allowlisted fields are submitted, never credentials or model URLs", () => {
  const settings = {
    provider: "codex",
    modelName: "",
    autoReplyEnabled: false,
    syncDraftsEnabled: false,
    replyDelaySeconds: 10,
    cooldownSeconds: 60,
    dailyLimit: 30,
    quietHoursEnabled: false,
    quietStart: "23:00",
    quietEnd: "08:00",
  };
  assert.deepEqual(changedRemoteSettings(settings, { ...settings }), {});
  assert.deepEqual(
    changedRemoteSettings(settings, {
      ...settings,
      syncDraftsEnabled: true,
      replyDelaySeconds: 20,
      apiKey: "synthetic-secret",
      modelUrl: "https://invalid.example",
      autoReplyMode: "send",
    }),
    { syncDraftsEnabled: true, replyDelaySeconds: 20 },
  );
});
test("account and device changes reject stale private responses", () => {
  assert.equal(
    remoteResponseMatches({ user_id: 5, device_id: "a" }, "5", "a"),
    true,
  );
  assert.equal(
    remoteResponseMatches({ user_id: 6, device_id: "a" }, "5", "a"),
    false,
  );
  assert.equal(
    remoteResponseMatches({ user_id: 5, device_id: "b" }, "5", "a"),
    false,
  );
  assert.equal(remoteResponseMatches({ user_id: 5 }, "5", "a"), true);
});
test("queued and received commands are not presented as completed operations", () => {
  for (const status of ["pending", "delivered"])
    assert.equal(commandPending({ status }), true);
  for (const status of ["succeeded", "failed", "expired", "cancelled"])
    assert.equal(commandPending({ status }), false);
});
