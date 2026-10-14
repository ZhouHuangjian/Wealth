import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';
import { Store } from '../server/store.js';
import { remoteConversationRevision, remoteProfileRevision, remoteSettingsRevision, type RemoteCommand } from '../server/remote-protocol.js';
import { compressContactMemory, memoryInputDigest } from '../server/contact-memory.js';
import { generateContactBasis, basisInputDigest } from '../server/contact-basis.js';
import { contactModelIdentity } from '../server/contact-model.js';
import { contactBasisContext, memoryContext } from '../server/contact-context.js';
import { messageEvidenceHash } from '../server/contact-evidence.js';
import { unavailableModelCatalog } from '../shared/model-catalog.js';
import type { AppState, ContactBasisGeneration, ContactMemory, Message } from '../shared/types.js';

type Options = Parameters<typeof createApplication>[0];
const connection = { url: 'http://127.0.0.1:9876/api/v1/chat/ingest', token: 'PRIVATE-SYNTHETIC-DEVICE-TOKEN'.repeat(2), inboxToken: '' };
const keys = ['PRIVATE-REPLY-KEY', 'PRIVATE-VISION-KEY', 'PRIVATE-AUDIO-KEY', 'PRIVATE-ANALYSIS-KEY', 'PRIVATE-MEMORY-KEY'];
const moduleConfig = (name: string, apiKey: string) => ({ provider: 'compatible' as const,
  modelUrl: 'http://127.0.0.1:11435/v1', modelName: name, apiKey, useReplyApiKey: false, allowRemoteModel: true });
const command = (type: RemoteCommand['type'], payload: Record<string, unknown>): RemoteCommand => ({
  id: randomUUID(), type, payload, expires_at: new Date(Date.now() + 60_000).toISOString(),
});
const modelResponse = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });

function addMessage(state: AppState, cid: string, text: string): Message {
  const message: Message = { id: randomUUID(), conversationId: cid, role: 'peer', kind: 'text', text,
    sentAt: new Date().toISOString(), sequence: Math.max(0, ...state.messages.filter(m => m.conversationId === cid).map(m => m.sequence)) + 1,
    source: 'wechat', externalId: randomUUID(), aiAssisted: false };
  state.messages.push(message); return message;
}

async function harness(overrides: Partial<Options> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'xiangzhi-remote-edit-'));
  const databasePath = join(directory, 'test.sqlite');
  let next: RemoteCommand | null = null, sends = 0, modelCalls = 0, catalogReads = 0;
  const polls: any[] = [];
  const catalog = { ...unavailableModelCatalog(), codex: { source: 'local-cache' as const, fetchedAt: null,
    audioSupported: false as const, models: [{ id: 'gpt-synthetic', label: 'Synthetic GPT', inputModalities: ['text', 'image'] as ('text' | 'image')[] }] } };
  const app = createApplication({ databasePath, seed: false, profileManifestPath: null, draftSync: connection,
    inspectCodex: async () => ({ available: true, version: 'synthetic', message: '合成测试' }),
    inspectWechat: () => ({ available: true, message: '合成测试' }),
    readModelCatalog: async () => { catalogReads++; return catalog; },
    queryWechat: async () => { throw new Error('Synthetic test must not read real WeChat'); },
    send: async () => { sends++; },
    generateContactBasis: (state, cid, signal) => generateContactBasis(state, cid, signal, { fetch: async () => {
      modelCalls++; const source = state.messages.find(m => m.conversationId === cid && m.role === 'peer')!;
      return modelResponse({ facts: [{ category: 'interest', content: '模型整理：对方提到散步', sourceMessageIds: [source.id] }] });
    } }),
    compressContactMemory: (state, cid, signal) => compressContactMemory(state, cid, signal, { fetch: async () => {
      modelCalls++; const source = state.messages.filter(m => m.conversationId === cid).at(-1)!;
      return modelResponse({ summary: '模型回顾', openTopics: ['模型待确认话题'],
        entries: Array.from({ length: 32 }, (_, index) => ({ kind: 'event', text: `模型记忆 ${index}`, sourceMessageIds: [source.id] })) });
    } }),
    remoteFetch: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:9876/api/v1/chat/device/poll');
      assert.equal(init?.redirect, 'error');
      polls.push(JSON.parse(String(init?.body)));
      const pending = next; next = null;
      return Response.json({ ok: true, commands: pending ? [pending] : [], server_time: new Date().toISOString() });
    }, ...overrides });
  app.store.update(state => {
    Object.assign(state.settings, { provider: 'compatible', modelPreset: 'custom', modelName: 'reply-default',
      modelUrl: 'http://127.0.0.1:11435/v1', apiKey: keys[0], allowRemoteModel: true,
      vision: moduleConfig('vision-default', keys[1]), audio: moduleConfig('audio-default', keys[2]),
      analysis: moduleConfig('analysis-default', keys[3]), memory: moduleConfig('memory-default', keys[4]) });
  });
  const queue = (type: RemoteCommand['type'], payload: Record<string, unknown>) => { const value = command(type, payload); next = value; return value; };
  const receipt = async (value: RemoteCommand) => {
    await app.remote.tick();
    const found = polls.at(-1).completed.find((item: any) => item.id === value.id);
    assert.ok(found, `Expected acknowledgement for ${value.type}`); return found;
  };
  const run = async (type: RemoteCommand['type'], payload: Record<string, unknown>) => {
    const value = queue(type, payload); await app.remote.tick(); return receipt(value);
  };
  const create = async (name: string) => {
    const result = await run('conversation.add', { name, externalId: `wxid_${randomUUID().replaceAll('-', '')}` });
    assert.equal(result.status, 'succeeded'); return result.result.conversation.id as string;
  };
  const a = await create('合成甲'), b = await create('合成乙');
  const conversation = (cid: string) => app.store.read().conversations.find(c => c.id === cid)!;
  const revision = (cid: string) => remoteProfileRevision(conversation(cid));
  const profileRun = async (type: RemoteCommand['type'], cid: string, payload: Record<string, unknown> = {}) => {
    const result = await run(type, { id: cid, expectedRevision: revision(cid), ...payload });
    if (result.status === 'succeeded') {
      assert.equal(result.result.profile.id, cid);
      assert.equal(result.result.profile.revision, revision(cid));
      assert.deepEqual(Object.keys(result.result), ['profile']);
    }
    return result;
  };
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(base + '/api/session'), { token } = await session.json() as { token: string };
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + '/api' + path, { method,
    headers: { Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...app, a, b, base, directory, databasePath, catalog, polls, run, queue, receipt, profileRun, request,
    conversation, revision, counters: () => ({ sends, modelCalls, catalogReads }),
    close: async () => { app.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      rmSync(directory, { recursive: true, force: true }); } };
}

test('real remote v2 settings select independent models while private endpoints, credentials and permissions remain on Mac', async () => {
  const h = await harness();
  try {
    const before = h.store.read().settings;
    const result = await h.run('settings.patch', { expectedRevision: remoteSettingsRevision(before),
      replyModels: [{ id: 'codex-choice', provider: 'codex', modelName: 'gpt-synthetic' },
        { id: 'api-choice', provider: 'compatible', modelPreset: 'custom', modelName: 'reply-alternative' }],
      vision: { provider: 'codex', modelName: 'gpt-synthetic' }, audio: { provider: 'compatible', modelName: 'audio-alternative' },
      analysis: { provider: 'codex', modelName: 'gpt-synthetic' }, memory: { provider: 'compatible', modelName: 'memory-alternative' } });
    assert.equal(result.status, 'succeeded');
    const after = h.store.read().settings;
    assert.equal(after.autoReplyMode, 'draft');
    assert.equal(after.replyModels?.length, 2);
    for (const key of ['vision', 'audio', 'analysis', 'memory'] as const) {
      assert.equal(after[key]!.modelUrl, before[key]!.modelUrl);
      assert.equal(after[key]!.apiKey, before[key]!.apiKey);
      assert.equal(after[key]!.allowRemoteModel, before[key]!.allowRemoteModel);
      assert.equal(after[key]!.useReplyApiKey, before[key]!.useReplyApiKey);
    }
    assert.equal(after.apiKey, before.apiKey); assert.equal(after.modelUrl, before.modelUrl);
    const snapshot = h.polls.at(-1).snapshot;
    assert.equal(snapshot.version, 2);
    assert.deepEqual(snapshot.capabilities.codexModels, h.catalog.codex.models);
    assert.ok(snapshot.capabilities.commandTypes.includes('conversation.memory.compress'));
    assert.equal(snapshot.settings.analysis.modelName, 'gpt-synthetic');
    const wire = JSON.stringify(h.polls);
    for (const secret of [...keys, connection.token]) assert.ok(!wire.includes(secret));
    assert.doesNotMatch(wire, /11435|allowRemoteModel|useReplyApiKey|apiKey|sourceMessageHashes/);
    assert.equal((await h.run('settings.patch', { expectedRevision: remoteSettingsRevision(after),
      analysis: { provider: 'compatible', modelName: 'memory-alt', modelUrl: 'https://attacker.invalid/v1' } })).status, 'failed');
    assert.deepEqual(h.store.read().settings, after);
    assert.deepEqual(h.counters(), { sends: 0, modelCalls: 0, catalogReads: 1 });
  } finally { await h.close(); }
});

test('remote settings and contact revisions reject stale writes but changes to another person remain independent', async () => {
  const h = await harness();
  try {
    const settingsRev = remoteSettingsRevision(h.store.read().settings);
    h.store.update(state => { state.settings.memory!.apiKey = 'PRIVATE-NEW-MEMORY-KEY'; });
    const beforeSettings = h.store.read().settings;
    assert.equal((await h.run('settings.patch', { expectedRevision: settingsRev,
      memory: { provider: 'compatible', modelName: 'stale-model' } })).status, 'failed');
    assert.deepEqual(h.store.read().settings, beforeSettings);
    const aRevision = remoteConversationRevision(h.conversation(h.a));
    h.store.update(state => { state.conversations.find(c => c.id === h.b)!.note = '乙的独立备注'; });
    assert.equal((await h.run('conversation.patch', { id: h.a, expectedRevision: aRevision,
      processing: { intentEnabled: true, affinityEnabled: true, memoryEnabled: true,
        autoRecognizeImages: true, autoTranscribeVoice: false,
        analysisModel: { id: 'a-analysis', provider: 'codex', modelName: 'gpt-synthetic' } } })).status, 'succeeded');
    const a = h.conversation(h.a), b = h.conversation(h.b);
    assert.equal(a.processing?.autoRecognizeImages, true); assert.equal(a.processing?.autoTranscribeVoice, false);
    assert.equal(a.processing?.analysisModel?.provider, 'codex'); assert.equal(b.processing, undefined);
    assert.equal(b.note, '乙的独立备注');
    assert.equal((await h.run('conversation.patch', { id: h.a, expectedRevision: aRevision,
      processing: { affinityEnabled: false } })).status, 'failed');
    assert.deepEqual(h.conversation(h.a), a);
    assert.equal((await h.run('conversation.patch', { id: h.a, expectedRevision: remoteConversationRevision(a),
      processing: { analysisModel: { id: 'invalid', provider: 'codex', modelName: 'qwen3.8-flash' } } })).status, 'failed');
    assert.deepEqual(h.conversation(h.a), a);
    assert.equal(h.counters().modelCalls, 0); assert.equal(h.counters().sends, 0);
  } finally { await h.close(); }
});

test('legacy wrong Codex selections can still be paused and repaired without unrelated invalid models blocking the change', async () => {
  const h = await harness();
  try {
    h.store.update(state => {
      Object.assign(state.settings, { provider: 'codex', modelName: 'qwen3.8-max', autoReplyEnabled: true,
        replyModels: [{ id: 'legacy-invalid', provider: 'codex', modelName: 'qwen3.8-flash' }] });
      state.settings.analysis!.provider = 'codex'; state.settings.analysis!.modelName = 'qwen3.8-flash';
      state.conversations.find(c => c.id === h.a)!.processing = { intentEnabled: true, affinityEnabled: true, autoAnalyzeMessages: true,
        analysisModel: { id: 'legacy-contact', provider: 'codex', modelName: 'qwen3.8-max' } };
    });
    assert.equal((await h.run('settings.patch', { autoReplyEnabled: false })).status, 'succeeded');
    assert.equal(h.store.read().settings.autoReplyEnabled, false);
    assert.equal(h.store.read().settings.analysis!.modelName, 'qwen3.8-flash');
    assert.equal((await h.run('settings.patch', { modelName: 'gpt-synthetic' })).status, 'succeeded');
    assert.equal(h.store.read().settings.modelName, 'gpt-synthetic');
    assert.deepEqual(h.store.read().settings.replyModels, []);
    assert.equal((await h.run('conversation.patch', { id: h.a, expectedRevision: remoteConversationRevision(h.conversation(h.a)),
      processing: { intentEnabled: false, affinityEnabled: false } })).status, 'succeeded');
    assert.equal(h.conversation(h.a).processing!.autoAnalyzeMessages, false);
    assert.equal((await h.run('conversation.patch', { id: h.a, expectedRevision: remoteConversationRevision(h.conversation(h.a)),
      processing: { analysisModel: { id: 'repaired-contact', provider: 'codex', modelName: 'gpt-synthetic' } } })).status, 'succeeded');
    assert.equal(h.conversation(h.a).processing!.analysisModel!.modelName, 'gpt-synthetic');
    assert.equal(h.counters().modelCalls, 0); assert.equal(h.counters().sends, 0);
  } finally { await h.close(); }
});

test('remote basis and memory edits use profile revisions, preserve manual priority and persist without raw provenance upload', async () => {
  const h = await harness();
  try {
    h.store.update(state => {
      state.conversations.find(c => c.id === h.a)!.processing = { memoryEnabled: true };
      addMessage(state, h.a, 'SYNTHETIC-RAW-CHAT-A 我喜欢散步');
      addMessage(state, h.b, 'SYNTHETIC-RAW-CHAT-B');
    });
    assert.equal((await h.run('conversation.basis.generate', { id: h.a })).status, 'succeeded');
    const generated = h.conversation(h.a).basisFacts![0];
    assert.equal(generated.origin, 'model'); assert.ok(generated.sourceMessageIds?.length);
    const oldRevision = h.revision(h.a);
    assert.equal((await h.profileRun('conversation.basis.patch', h.a, { factId: generated.id, content: '本人修正：偏好安静的散步路线' })).status, 'succeeded');
    const manual = h.conversation(h.a).basisFacts![0];
    assert.equal(manual.origin, 'manual'); assert.equal(manual.sourceMessageIds, undefined); assert.equal(manual.sourceMessageHashes, undefined);
    assert.equal((await h.run('conversation.basis.patch', { id: h.a, expectedRevision: oldRevision,
      factId: generated.id, content: '陈旧网页编辑' })).status, 'failed');
    assert.equal((await h.profileRun('conversation.basis.patch', h.b, { factId: generated.id, content: '跨联系人编辑' })).status, 'failed');
    assert.equal((await h.profileRun('conversation.memory.entry.add', h.a, { kind: 'preference', text: '本人补充：周末上午方便' })).status, 'succeeded');
    const entryId = h.conversation(h.a).memory!.entries[0].id;
    assert.equal((await h.profileRun('conversation.memory.entry.patch', h.a, { entryId, text: '本人修正：周末下午方便' })).status, 'succeeded');
    assert.equal((await h.profileRun('conversation.memory.patch', h.a, { summary: '本人维护的回顾', openTopics: ['本人维护的未完话题'] })).status, 'succeeded');
    h.store.update(state => { addMessage(state, h.a, 'SYNTHETIC-RAW-CHAT-A 新的合成消息'); });
    assert.equal((await h.run('conversation.memory.compress', { id: h.a })).status, 'succeeded');
    const a = h.conversation(h.a);
    assert.equal(a.memory!.summary, '本人维护的回顾'); assert.deepEqual(a.memory!.openTopics, ['本人维护的未完话题']);
    assert.equal(a.memory!.entries.find(entry => entry.id === entryId)?.origin, 'manual');
    const context = memoryContext(h.store.read(), a, Infinity)!;
    assert.ok(context.entries.some(entry => entry.text === '本人修正：周末下午方便'));
    assert.ok(contactBasisContext(a, h.store.read()).some(fact => fact.origin === 'manual' && fact.content.startsWith('本人修正')));
    assert.equal(h.conversation(h.b).memory, undefined); assert.equal(h.conversation(h.b).basisFacts, undefined);
    const profileResult = await h.run('conversation.profile.get', { id: h.a });
    assert.equal(profileResult.status, 'succeeded');
    const profileWire = JSON.stringify(profileResult.result);
    assert.doesNotMatch(profileWire, /sourceMessageIds|sourceMessageHashes|compressedMessageHashes|sourceDigest|SYNTHETIC-RAW-CHAT/);
    assert.doesNotMatch(JSON.stringify(h.polls), /SYNTHETIC-RAW-CHAT|sourceMessageIds|sourceMessageHashes/);
    assert.equal((await h.profileRun('conversation.memory.entry.delete', h.a, { entryId })).status, 'succeeded');
    assert.equal(h.conversation(h.a).memory!.entries.some(entry => entry.id === entryId), false);
    assert.equal((await h.profileRun('conversation.basis.delete', h.a, { factId: generated.id })).status, 'succeeded');
    assert.equal(h.conversation(h.a).basisFacts!.length, 0);
    const reopened = new Store(h.databasePath);
    try {
      const persisted = reopened.read().conversations.find(c => c.id === h.a)!;
      assert.equal(persisted.memory!.summary, '本人维护的回顾'); assert.deepEqual(persisted.basisFacts, []);
      assert.equal(reopened.read().settings.memory!.apiKey, keys[4]);
    } finally { reopened.close(); }
    assert.equal(h.counters().modelCalls, 2); assert.equal(h.counters().sends, 0);
  } finally { await h.close(); }
});

test('remote profile projection hides locally known credentials and excludes imported or simulator conversations', async () => {
  const h = await harness();
  try {
    const at = new Date().toISOString(), simulator = randomUUID();
    h.store.update(state => {
      state.conversations.find(c => c.id === h.a)!.basisFacts = [{ id: randomUUID(), category: 'fact',
        content: `手动背景 ${keys[4]}`, sourceNote: `手动来源 ${connection.token}`, origin: 'manual', createdAt: at, updatedAt: at }];
      state.conversations.push({ id: simulator, name: '本机演练', channel: 'simulator', externalId: null,
        avatar: '', color: '', note: '', autoReplyEnabled: false, createdAt: at, updatedAt: at });
    });
    const result = await h.run('conversation.profile.get', { id: h.a });
    assert.equal(result.status, 'succeeded'); assert.match(JSON.stringify(result.result), /凭据已隐藏/);
    for (const secret of [...keys, connection.token]) assert.ok(!JSON.stringify(h.polls).includes(secret));
    assert.equal((await h.run('conversation.profile.get', { id: simulator })).status, 'failed');
    assert.equal((await h.run('conversation.basis.add', { id: h.a, category: 'fact', content: '缺少当前版本' })).status, 'failed');
    assert.equal(h.conversation(h.a).basisFacts!.length, 1);
  } finally { await h.close(); }
});

test('remote invalidation aborts both model job kinds and rejects results even when model transport ignores cancellation', async t => {
  for (const kind of ['conversation.basis.generate', 'conversation.memory.compress'] as const) {
    await t.test(kind, async () => {
      let enter!: () => void, release!: () => void, receivedSignal: AbortSignal | undefined;
      const ready = new Promise<void>(resolve => enter = resolve), wait = new Promise<void>(resolve => release = resolve);
      const delayedBasis: typeof generateContactBasis = async (state, cid, signal): Promise<ContactBasisGeneration> => {
        receivedSignal = signal; enter(); await wait;
        const source = state.messages.find(m => m.conversationId === cid)!;
        return { facts: [{ id: randomUUID(), category: 'fact', content: '过期结果不得保存', sourceNote: '合成模型', origin: 'model',
          sourceMessageIds: [source.id], sourceMessageHashes: { [source.id]: messageEvidenceHash(source) },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          sourceDigest: basisInputDigest(state, cid), modelIdentity: contactModelIdentity(state.settings.memory!),
          provider: 'compatible', modelName: 'memory-default', generatedAt: new Date().toISOString(), sourceMessageCount: 1 };
      };
      const delayedMemory: typeof compressContactMemory = async (state, cid, signal): Promise<ContactMemory> => {
        receivedSignal = signal; enter(); await wait;
        return { summary: '过期结果不得保存', entries: [], openTopics: [], throughSequence: 1,
          sourceDigest: memoryInputDigest(state, cid), provider: 'compatible', modelName: 'memory-default', updatedAt: new Date().toISOString() };
      };
      const h = await harness({ generateContactBasis: delayedBasis, compressContactMemory: delayedMemory });
      try {
        h.store.update(state => {
          state.conversations.find(c => c.id === h.a)!.processing = { memoryEnabled: true };
          addMessage(state, h.a, '合成模型任务输入');
        });
        const value = h.queue(kind, { id: h.a }), pending = h.remote.tick();
        await ready; assert.ok(receivedSignal); assert.equal(receivedSignal.aborted, false);
        h.remote.invalidate(); assert.equal(receivedSignal.aborted, true);
        release(); await pending;
        assert.equal((await h.receipt(value)).status, 'failed');
        assert.equal(h.conversation(h.a).basisFacts, undefined); assert.equal(h.conversation(h.a).memory, undefined);
        assert.equal(h.conversation(h.b).basisFacts, undefined); assert.equal(h.counters().sends, 0);
      } finally { release(); await h.close(); }
    });
  }
});

test('model catalog is protected by the local session and same-origin checks, with no model call', async () => {
  const h = await harness();
  try {
    const reads = h.counters().catalogReads;
    assert.equal((await fetch(h.base + '/api/model-catalog')).status, 401);
    assert.equal(h.counters().catalogReads, reads);
    const response = await h.request('/model-catalog');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), h.catalog);
    assert.equal(h.counters().catalogReads, reads + 1);
    assert.equal((await fetch(h.base + '/api/model-catalog', { headers: { Origin: 'https://other.invalid' } })).status, 403);
    assert.equal(h.counters().catalogReads, reads + 1);
    assert.equal(h.counters().modelCalls, 0); assert.equal(h.counters().sends, 0);
  } finally { await h.close(); }
});
