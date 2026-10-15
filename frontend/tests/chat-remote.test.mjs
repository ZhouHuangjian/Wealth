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

test("nested model choices are allowlisted and do not submit local credentials", () => {
  const current = {
    provider: "codex",
    modelName: "",
    replyModels: [],
    analysis: { provider: "qwen", modelName: "small", thinkingEnabled: false },
  };
  const edited = {
    ...current,
    revision: "private-snapshot-revision",
    analysis: {
      provider: "qwen",
      modelName: "large",
      thinkingEnabled: true,
      apiKey: "synthetic-secret",
      modelUrl: "https://invalid.example",
      allowRemoteModel: true,
    },
    replyModels: [
      {
        id: "choice-a",
        provider: "compatible",
        modelPreset: "qwen",
        modelName: "large",
        label: "比较",
        apiKey: "synthetic-secret",
      },
    ],
  };
  assert.deepEqual(changedRemoteSettings(current, edited), {
    analysis: { provider: "qwen", modelName: "large", thinkingEnabled: true },
    replyModels: [
      {
        id: "choice-a",
        provider: "compatible",
        modelPreset: "qwen",
        modelName: "large",
        label: "比较",
      },
    ],
  });
  assert.deepEqual(
    changedRemoteSettings(current, {
      ...current,
      analysis: { ...current.analysis },
    }),
    {},
  );
});

test("contact edits preserve inheritance, scope changed fields, and strip hidden settings", async () => {
  const { changedRemoteConversation } = await import(
    "../src/chat-remote-model.ts"
  );
  const current = {
    id: "person-a",
    name: "A",
    note: "",
    enabled: true,
    autoReplyEnabled: false,
    processing: {
      intentEnabled: true,
      replyModels: [{ id: "model-a", provider: "codex", modelName: "" }],
    },
  };
  assert.deepEqual(
    changedRemoteConversation(current, {
      ...current,
      processing: {
        ...current.processing,
        autoRecognizeImages: false,
        affinityEnabled: false,
        analysisModel: null,
        memoryModel: null,
      },
    }),
    { id: "person-a" },
  );
  assert.deepEqual(
    changedRemoteConversation(current, {
      ...current,
      name: " A ",
      processing: {
        intentEnabled: false,
        autoRecognizeImages: true,
        replyModels: null,
        analysisModel: {
          id: "analysis-a",
          provider: "compatible",
          modelPreset: "qwen",
          modelName: "small",
          modelUrl: "https://invalid.example",
          apiKey: "synthetic-secret",
        },
        unknownFlag: true,
      },
    }),
    {
      id: "person-a",
      processing: {
        intentEnabled: false,
        autoRecognizeImages: true,
        replyModels: null,
        analysisModel: {
          id: "analysis-a",
          provider: "compatible",
          modelPreset: "qwen",
          modelName: "small",
        },
      },
    },
  );
});

test("legacy devices cannot receive new profile or memory commands", async () => {
  const { supportsRemoteCommand } = await import("../src/chat-remote-model.ts");
  assert.equal(supportsRemoteCommand(null, "conversation.profile.get"), false);
  assert.equal(
    supportsRemoteCommand(
      { version: 1, capabilities: {} },
      "conversation.patch",
    ),
    true,
  );
  assert.equal(
    supportsRemoteCommand(
      { version: 1, capabilities: {} },
      "conversation.profile.get",
    ),
    false,
  );
  assert.equal(
    supportsRemoteCommand(
      {
        version: 2,
        capabilities: { commandTypes: ["conversation.profile.get"] },
      },
      "conversation.profile.get",
    ),
    true,
  );
  assert.equal(
    supportsRemoteCommand(
      {
        version: 2,
        capabilities: { commandTypes: ["conversation.profile.get"] },
      },
      "conversation.memory.patch",
    ),
    false,
  );
});

test("model candidates follow both provider and supported input instead of mixing model families", async () => {
  const { remoteModelOptions } = await import("../src/chat-remote-model.ts");
  const models = [
    { id: "codex-text", label: "文字模型", inputModalities: ["text"] },
    {
      id: "codex-image",
      label: "图片模型",
      inputModalities: ["text", "image"],
    },
  ];
  assert.deepEqual(
    remoteModelOptions("codex", "reply", models).map((m) => m.id),
    ["codex-text", "codex-image"],
  );
  assert.deepEqual(
    remoteModelOptions("codex", "vision", models).map((m) => m.id),
    ["codex-image"],
  );
  assert.deepEqual(remoteModelOptions("codex", "audio", models), []);
  assert.equal(
    remoteModelOptions("qwen", "analysis", models).every((m) =>
      m.id.startsWith("qwen"),
    ),
    true,
  );
  assert.deepEqual(remoteModelOptions("compatible", "analysis", models), []);
});
