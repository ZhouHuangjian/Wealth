import test from "node:test";
import assert from "node:assert/strict";
import {
  chatInboxEmptyState,
  deviceConfigurationAction,
  deviceConnectionState,
  reconcileDeviceList,
} from "../src/chat-device-model.ts";
const device = (changes = {}) => ({
  id: "test-mac",
  name: "合成 Mac",
  created_at: "2026-10-11T00:00:00Z",
  last_seen_at: null,
  revoked_at: null,
  config_available: true,
  connection_state: "awaiting_connection",
  ...changes,
});

test("adding a device immediately replaces the repeat-binding prompt with the connection step", () => {
  assert.equal(chatInboxEmptyState([]).stage, "no_device");
  const added = chatInboxEmptyState([device()]);
  assert.equal(added.stage, "awaiting_connection");
  assert.equal(added.action, "查看连接配置");
});
test("validated devices wait for drafts without claiming they are currently online", () => {
  const validated = device({
    last_seen_at: "2026-10-11T01:00:00Z",
    connection_state: "connected",
  });
  assert.equal(deviceConnectionState(validated), "connected");
  assert.equal(
    chatInboxEmptyState([device(), validated]).stage,
    "awaiting_drafts",
  );
  assert.equal(
    chatInboxEmptyState([validated]).description.includes("在线"),
    false,
  );
  const rotated = {
    ...validated,
    last_seen_at: null,
    connection_state: "awaiting_connection",
  };
  assert.equal(chatInboxEmptyState([rotated]).stage, "awaiting_connection");
});
test("revoked devices never count as connected or expose configuration actions", () => {
  for (const revoked of [
    device({
      revoked_at: "2026-10-11T02:00:00Z",
      last_seen_at: "2026-10-11T01:00:00Z",
      connection_state: "connected",
    }),
    device({ connection_state: "revoked" }),
  ]) {
    assert.equal(deviceConnectionState(revoked), "revoked");
    assert.equal(deviceConfigurationAction(revoked), null);
    assert.equal(chatInboxEmptyState([revoked]).stage, "no_device");
    assert.equal(
      chatInboxEmptyState([revoked, device()]).stage,
      "awaiting_connection",
    );
  }
});
test("new configurations can be retrieved while legacy devices require an explicit rotation", () => {
  assert.equal(deviceConfigurationAction(device()), "config");
  assert.equal(
    deviceConfigurationAction(device({ config_available: false })),
    "rotate",
  );
});

test("delayed device reads cannot undo creation, rotation, or revocation", async () => {
  const connected = device({
    last_seen_at: "2026-10-11T01:00:00Z",
    connection_state: "connected",
  });
  for (const [before, after] of [
    [[], [device()]],
    [[connected], [device()]],
    [
      [connected],
      [
        device({
          revoked_at: "2026-10-11T02:00:00Z",
          connection_state: "revoked",
        }),
      ],
    ],
  ]) {
    let resolveRead;
    const response = new Promise((resolve) => {
      resolveRead = resolve;
    });
    let revision = 0;
    const requestedRevision = revision;
    let state = before;
    const read = response.then((items) => {
      state = reconcileDeviceList(state, items, requestedRevision, revision);
    });
    revision++;
    state = after;
    resolveRead(before);
    await read;
    assert.deepEqual(state, after);
    assert.equal(
      reconcileDeviceList(state, before, revision, revision),
      before,
    );
  }
});
