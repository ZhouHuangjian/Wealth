import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import {
  analyzeContactMessage,
  insightsInputDigest,
} from "../server/contact-insights.js";
import { compressContactMemory } from "../server/contact-memory.js";
import { messageEvidenceHash } from "../server/contact-evidence.js";
import { eventEvidenceContext } from "../server/event-context.js";
import { ContactInsightService } from "../server/contact-insight-service.js";
import { InsightBreakdown } from "../src/InsightBreakdown.js";
import {
  AFFINITY_DIMENSIONS,
  REPLY_CRITERIA,
  distributionPreview,
  ANALYSIS_RUBRIC_VERSION,
} from "../shared/analysis-rubric.js";
import type { AppState, ContactInsights } from "../shared/types.js";

function fixture(): AppState {
  const store = new Store(":memory:");
  const state = store.read();
  store.close();
  state.settings.analysis = state.settings.memory = {
    provider: "compatible",
    modelUrl: "http://127.0.0.1:11435/v1",
    modelName: "synthetic",
    useReplyApiKey: false,
    allowRemoteModel: false,
  };
  state.conversations = [
    {
      id: "A",
      name: "合成联系人",
      avatar: "",
      color: "",
      note: "",
      autoReplyEnabled: false,
      channel: "simulator",
      externalId: null,
      createdAt: "",
      updatedAt: "",
      processing: {
        intentEnabled: true,
        emotionEnabled: true,
        affinityEnabled: true,
        replyReviewEnabled: true,
        memoryEnabled: true,
      },
    },
  ];
  state.messages = Array.from({ length: 4 }, (_, index) => ({
    id: `m${index + 1}`,
    conversationId: "A",
    sequence: index + 1,
    role: index === 2 ? ("self" as const) : ("peer" as const),
    text: ["周末去公园吗", "我最近有点忙", "那下周再定", "FUTURE-PRIVATE"][
      index
    ],
    kind: "text" as const,
    sentAt: null,
    source: "manual" as const,
    externalId: null,
    aiAssisted: false,
  }));
  return state;
}
const parts = () =>
  AFFINITY_DIMENSIONS.map((d, i) => ({
    key: d.key,
    score: [80, 60, 70, 50, 40, 30][i],
    evidenceMessageIds: ["m2"],
  }));
const analysis = () => ({
  intents: [
    { label: "解释说明", percentage: 65 },
    { label: "婉拒", percentage: 35 },
  ]
    .slice(0, 1)
    .map((i) => ({ ...i, percentage: 100 })),
  emotions: [
    { label: "平静", percentage: 80 },
    { label: "难以判断", percentage: 20 },
  ],
  affinity: {
    score: 99,
    confidence: 30,
    evidence: ["回应安排，仍需核实。"],
    dimensions: parts(),
  },
  replyReview: null,
  uncertainty: "仅有文字线索。",
});
const response = (value: unknown) =>
  Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });

test("six dimensions compose the displayed score independently of a model total, with explicit coverage", async () => {
  const state = fixture();
  const result = await analyzeContactMessage(state, "A", "m2", undefined, {
    fetch: async () => response(analysis()),
  });
  assert.equal(result.affinity!.score, 57);
  assert.equal(result.affinity!.confidence, 30);
  assert.equal(result.affinity!.coverage, 100);
  assert.equal(result.rubricVersion, ANALYSIS_RUBRIC_VERSION);
  assert.deepEqual(result.emotions, analysis().emotions);
  const sparse = analysis();
  sparse.affinity.dimensions = parts().map((p, i) =>
    i < 2
      ? p
      : { ...p, score: null as unknown as number, evidenceMessageIds: [] },
  );
  const missing = await analyzeContactMessage(state, "A", "m2", undefined, {
    fetch: async () => response(sparse),
  });
  assert.equal(missing.affinity!.score, null);
  assert.equal(missing.affinity!.coverage, 35);
});

test("distribution and dimension validation rejects non-totaling emotion weights, duplicates and foreign/future evidence", async () => {
  for (const change of [
    (a: any) => {
      a.emotions[0].percentage = 50;
    },
    (a: any) => {
      a.affinity.dimensions[0].key = a.affinity.dimensions[1].key;
    },
    (a: any) => {
      a.affinity.dimensions[0].evidenceMessageIds = ["m4"];
    },
    (a: any) => {
      a.affinity.dimensions[0].evidenceMessageIds = ["other-contact"];
    },
    (a: any) => {
      a.affinity.dimensions[0].evidenceMessageIds = [];
    },
  ]) {
    const value = analysis();
    change(value);
    await assert.rejects(
      analyzeContactMessage(fixture(), "A", "m2", undefined, {
        fetch: async () => response(value),
      }),
      /100|证据|无效|重复/,
    );
  }
});

test("reply review sees only its historical prefix and the personal style profile; missing profile cannot get a style score", async () => {
  const state = fixture();
  state.learnedProfile = {
    version: "test-v1",
    digest: "style-private-digest",
    title: "合成习惯",
    loadedAt: "",
    rules: [
      {
        id: "r",
        rule: "简短口语，先确认情况",
        limitation: "",
        evidenceIds: [],
      },
    ],
    examples: [],
    limitations: [],
  };
  const value = {
    intents: [],
    emotions: [],
    affinity: null,
    replyReview: {
      summary: "先接住了对方的时间安排。",
      criteria: REPLY_CRITERIA.map((d) => ({
        key: d.key,
        score: 80 as number | null,
        evidenceMessageIds: ["m3"],
      })),
    },
    uncertainty: "不评估后续结果。",
  };
  const result = await analyzeContactMessage(state, "A", "m3", undefined, {
    fetch: async (_url, init) => {
      const body = String(init!.body);
      assert.match(body, /简短口语/);
      assert.doesNotMatch(body, /FUTURE-PRIVATE|style-private-digest/);
      return response(value);
    },
  });
  assert.equal(result.replyReview!.score, 80);
  assert.equal(result.affinity, null);
  assert.deepEqual(result.intents, []);
  delete state.learnedProfile;
  await assert.rejects(
    analyzeContactMessage(state, "A", "m3", undefined, {
      fetch: async () => response(value),
    }),
    /习惯档案/,
  );
  value.replyReview.criteria[0] = {
    key: "style",
    score: null,
    evidenceMessageIds: [],
  };
  const withoutStyle = await analyzeContactMessage(
    state,
    "A",
    "m3",
    undefined,
    { fetch: async () => response(value) },
  );
  assert.equal(withoutStyle.replyReview!.criteria[0].score, null);
});

test("new switches change only the scoped analysis cache identity and remain independent", async () => {
  const state = fixture(),
    digest = insightsInputDigest(state, "A", "m2");
  state.messages[3].text = "another future";
  assert.equal(insightsInputDigest(state, "A", "m2"), digest);
  state.conversations[0].processing!.emotionEnabled = false;
  assert.notEqual(insightsInputDigest(state, "A", "m2"), digest);
  const value = analysis();
  await assert.rejects(
    analyzeContactMessage(state, "A", "m2", undefined, {
      fetch: async () => response(value),
    }),
    /情绪/,
  );
  value.emotions = [];
  await analyzeContactMessage(state, "A", "m2", undefined, {
    fetch: async () => response(value),
  });
  state.conversations[0].processing!.replyReviewEnabled = false;
  await assert.rejects(analyzeContactMessage(state, "A", "m3"), /回复复盘/);
});

test("event resolutions require later originals and retrieval carries only approved current evidence", async () => {
  const state = fixture();
  state.messages = state.messages.slice(0, 3);
  const event = {
    kind: "invitation",
    state: "resolved",
    resolvedByMessageIds: ["m3"],
  };
  const value = {
    summary: "周末邀约已改为下周再定。",
    entries: [
      {
        kind: "event",
        text: "对方提出周末去公园。",
        sourceMessageIds: ["m1"],
        event,
      },
    ],
    openTopics: ["下周确定时间"],
  };
  const memory = await compressContactMemory(state, "A", undefined, {
    fetch: async () => response(value),
  });
  state.conversations[0].memory = memory;
  assert.equal(memory.entries[0].status, "pending");
  assert.equal(memory.entries[0].event!.state, "resolved");
  assert.equal(eventEvidenceContext(state, state.conversations[0]).length, 0);
  memory.entries[0].status = "approved";
  const retrieved = eventEvidenceContext(state, state.conversations[0]);
  assert.deepEqual(
    retrieved[0].originals.map((m) => m.id),
    ["m1", "m3"],
  );
  assert.equal(
    eventEvidenceContext(state, state.conversations[0], 2).length,
    0,
  );
  state.messages[2].text = "修正了结束依据";
  assert.equal(eventEvidenceContext(state, state.conversations[0]).length, 0);
  for (const ids of [[], ["m1"], ["m2", "foreign"]]) {
    const invalid = {
      ...value,
      entries: [
        { ...value.entries[0], event: { ...event, resolvedByMessageIds: ids } },
      ],
    };
    await assert.rejects(
      compressContactMemory(fixture(), "A", undefined, {
        fetch: async () => response(invalid),
      }),
      /后续原话|当前会话/,
    );
  }
});

test("changing event resolution evidence cannot silently keep user approval, and manual status edits take priority", async () => {
  const state = fixture();
  state.messages = state.messages.slice(0, 3);
  const entry = {
    id: "event",
    kind: "event" as const,
    text: "对方提出周末去公园。",
    sourceMessageIds: ["m1"],
    event: {
      kind: "invitation",
      state: "resolved" as const,
      resolvedByMessageIds: ["m3"],
    },
    sourceMessageHashes: {
      m1: messageEvidenceHash(state.messages[0]),
      m3: "obsolete-hash",
    },
    status: "approved" as const,
    origin: "model" as const,
    createdAt: "",
  };
  state.conversations[0].memory = {
    summary: "",
    entries: [entry],
    openTopics: [],
    throughSequence: 1,
    sourceDigest: "old",
    provider: "compatible",
    modelName: "synthetic",
    updatedAt: "",
    compressedMessageHashes: {},
  };
  const result = await compressContactMemory(state, "A", undefined, {
    fetch: async () =>
      response({
        summary: "邀约已变更",
        entries: [
          {
            kind: entry.kind,
            text: entry.text,
            sourceMessageIds: entry.sourceMessageIds,
            event: entry.event,
          },
        ],
        openTopics: [],
      }),
  });
  assert.equal(result.entries[0].status, "pending");
  const store = new Store(":memory:");
  store.update((s) => Object.assign(s, state));
  const service = new ContactInsightService(store, {
    onContextChanged: () => {},
  });
  try {
    service.patchMemoryEntry("A", "event", {
      event: { kind: "invitation", state: "active", resolvedByMessageIds: [] },
    });
    const saved = store.read().conversations[0].memory!.entries[0];
    assert.equal(saved.origin, "manual");
    assert.equal(saved.event!.state, "active");
    assert.equal(saved.status, "approved");
  } finally {
    service.stop();
    store.close();
  }
});

test("analysis UI keeps omitted probability mass visible and explains evidence and model provenance", () => {
  const items = [
    { label: "分享", percentage: 40 },
    { label: "询问", percentage: 25 },
    { label: "玩笑", percentage: 20 },
    { label: "其他", percentage: 15 },
  ];
  assert.deepEqual(distributionPreview(items), {
    items: items.slice(0, 3),
    remaining: 15,
  });
  const saved: ContactInsights = {
    ...analysis(),
    affinity: {
      score: 57,
      coverage: 100,
      confidence: 30,
      evidence: ["合成依据"],
      dimensions: parts(),
    },
    conversationId: "A",
    messageId: "m2",
    provider: "compatible",
    modelName: "synthetic",
    analyzedAt: "",
    rubricVersion: ANALYSIS_RUBRIC_VERSION,
    intents: items,
  };
  const html = renderToStaticMarkup(
    React.createElement(InsightBreakdown, {
      insights: saved,
      processing: fixture().conversations[0].processing,
      messages: fixture().messages,
    }),
  );
  assert.match(html, /其余解读/);
  assert.match(html, /15/);
  assert.match(html, /可能的情绪/);
  assert.match(html, /互动分项/);
  assert.match(html, /原话依据/);
  assert.match(html, /synthetic/);
});
