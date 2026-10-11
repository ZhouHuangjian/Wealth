import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';
import { buildDraftBatch, uploadDraftBatch, type DraftSyncConfig } from '../server/draft-sync.js';
import type { Draft, LearnedProfile } from '../shared/types.js';

type Options = Parameters<typeof createApplication>[0];
const syncToken = 'synthetic-draft-inbox-token-'.repeat(2);
const profile: LearnedProfile = {version: '1.8', digest: 'synthetic-profile-digest-private', title: 'synthetic-full-profile-private', loadedAt: '2026-10-10T00:00:00.000Z',
  rules: [{id: 'r1', rule: 'synthetic-profile-rule-private', limitation: 'synthetic-profile-limitation-private', evidenceIds: ['synthetic-evidence-private']}], examples: [], limitations: []};

async function node(config: DraftSyncConfig, overrides: Pick<Options, 'generate' | 'uploadDrafts'> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xiangzhi-draft-sync-api-'));
  const calls = {generate: 0, send: 0};
  const generate: NonNullable<Options['generate']> = async (state, cid) => {
    calls.generate++;
    return ['自然', '简短', '接话'].map((label, index): Draft => ({id: `synthetic-${calls.generate}-${index}`, conversationId: cid,
      basedOnMessageId: state.messages.filter(message => message.conversationId === cid).at(-1)!.id,
      text: `虚构的候选回复${index}`, label, reason: '根据当前对话情境生成', provider: state.settings.provider, createdAt: new Date().toISOString(),
      profileVersion: state.learnedProfile?.version ?? null, profileDigest: state.learnedProfile?.digest ?? null}));
  };
  const instance = createApplication({databasePath: join(dir, 'test.db'), seed: false, profileManifestPath: null,
    bridge: {inboundToken: '', outboundUrl: '', outboundToken: ''}, draftSync: config,
    inspectCodex: async () => ({available: false, version: null, message: '测试替身：未运行真实 Codex'}),
    generate: overrides.generate ?? generate, uploadDrafts: overrides.uploadDrafts,
    send: async () => {calls.send++; return 'synthetic-receipt';}});
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${base}/api/session`);
  const {token} = await session.json() as {token: string};
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method, headers: {Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json', ...extra},
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
  });
  return {...instance, base, calls, request, close: async () => {
    await new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();});
    instance.close(); rmSync(dir, {recursive: true, force: true});
  }};
}

async function pair(overrides: Pick<Options, 'generate' | 'uploadDrafts'> = {}) {
  const cloud = await node({url: '', token: '', inboxToken: syncToken});
  const mac = await node({url: `${cloud.base}/api/sync/drafts`, token: syncToken, inboxToken: ''}, overrides);
  assert.equal((await mac.request('/api/settings', 'PATCH', {provider: 'codex', allowRemoteModel: true, apiKey: 'synthetic-api-key-private'})).status, 200);
  mac.store.update(state => {state.learnedProfile = structuredClone(profile);});
  const created = await mac.request('/api/conversations', 'POST', {name: '虚构联系人'});
  assert.equal(created.status, 201);
  const {id: cid} = await created.json() as {id: string};
  await mac.request(`/api/conversations/${cid}/messages`, 'POST', {role: 'peer', text: 'synthetic-original-chat-private'});
  return {cloud, mac, cid, close: async () => {await mac.close(); await cloud.close();}};
}

function assertCloudOnlyStoresDrafts(cloud: Awaited<ReturnType<typeof node>>) {
  const state = cloud.store.read();
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.conversations, []);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.drafts, []);
  assert.equal(cloud.calls.generate, 0);
  assert.equal(cloud.calls.send, 0);
}

test('Mac generation and explicit HTTP synchronization store only a minimal cloud draft batch and deduplicate it', async () => {
  const h = await pair();
  try {
    assert.equal(h.mac.store.read().settings.syncDraftsEnabled, false);
    const generated = await h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {});
    assert.equal(generated.status, 200);
    const {drafts} = await generated.json() as {drafts: Draft[]};
    assert.equal(drafts.length, 3);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 0, 'default generation does not synchronize');
    const uploaded = await h.mac.request(`/api/conversations/${h.cid}/sync-drafts`, 'POST', {});
    assert.equal(uploaded.status, 200);
    const receipt = await uploaded.json();
    assert.equal(receipt.ok, true); assert.equal(receipt.duplicate, false);
    const batches = h.cloud.store.read().cloudDrafts!;
    assert.equal(batches.length, 1); assert.equal(batches[0].id, receipt.id);
    assert.equal(batches[0].provider, 'codex'); assert.equal(batches[0].profileVersion, '1.8');
    assert.equal(batches[0].conversationKey, h.cid); assert.equal(batches[0].conversationName, '虚构联系人');
    assert.deepEqual(batches[0].drafts, drafts.map(({text, label, reason}) => ({text, label, reason})));
    const repeated = await h.mac.request(`/api/conversations/${h.cid}/sync-drafts`, 'POST', {});
    assert.equal((await repeated.json()).duplicate, true);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 1);
    assert.equal(h.mac.store.read().draftUploads!.length, 1);
    assert.equal(h.mac.store.read().draftUploads![0].status, 'uploaded');
    assert.equal(h.mac.store.read().drafts.length, 3);
    const visible = JSON.stringify(await (await h.cloud.request('/api/state')).json());
    for (const secret of ['synthetic-original-chat-private', 'synthetic-api-key-private', 'synthetic-profile-digest-private', 'synthetic-full-profile-private', 'synthetic-profile-rule-private', 'synthetic-profile-limitation-private', 'synthetic-evidence-private', syncToken]) assert.ok(!visible.includes(secret), secret);
    assertCloudOnlyStoresDrafts(h.cloud); assert.equal(h.mac.calls.send, 0);
  } finally {await h.close();}
});

test('automatic synchronization requires its explicit switch and applies to manual and automatic draft generation', async () => {
  const h = await pair();
  try {
    assert.equal((await h.mac.request('/api/settings', 'PATCH', {syncDraftsEnabled: true})).status, 200);
    assert.equal((await h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {})).status, 200);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 1);
    h.mac.store.update(state => {
      state.settings.autoReplyEnabled = true; state.settings.autoReplyMode = 'draft'; state.settings.replyDelaySeconds = 0;
      state.settings.cooldownSeconds = 0; state.conversations.find(conversation => conversation.id === h.cid)!.autoReplyEnabled = true;
    });
    assert.equal((await h.mac.request(`/api/conversations/${h.cid}/messages`, 'POST', {role: 'peer', text: '另一条虚构来信'})).status, 201);
    await h.mac.engine.tick();
    assert.equal(h.mac.store.read().jobs.at(-1)!.status, 'drafted');
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 2);
    assert.equal((await h.mac.request('/api/settings', 'PATCH', {syncDraftsEnabled: false})).status, 200);
    assert.equal((await h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {})).status, 200);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 2, 'disabling the switch takes effect on new generation');
    assert.equal(h.mac.calls.generate, 3); assert.equal(h.mac.calls.send, 0);
    assertCloudOnlyStoresDrafts(h.cloud);
  } finally {await h.close();}
});

test('cloud inbox authenticates, validates idempotency and strict bounded payloads independently of browser session', async () => {
  const h = await pair();
  try {
    await h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {});
    const local = h.mac.store.read();
    const batch = buildDraftBatch(local.conversations[0], local.drafts);
    const incoming = (body: unknown, headers: Record<string, string> = {}) => fetch(`${h.cloud.base}/api/sync/drafts`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${syncToken}`, 'Idempotency-Key': batch.id, ...headers}, body: JSON.stringify(body)});
    assert.equal((await incoming(batch, {Authorization: ''})).status, 401);
    assert.equal((await incoming(batch, {Authorization: 'Bearer wrong-token'})).status, 401);
    assert.equal((await incoming(batch, {'Idempotency-Key': 'wrong-batch'})).status, 400);
    assert.equal((await incoming({...batch, originalChat: 'forbidden'})).status, 400);
    assert.equal((await incoming({...batch, receivedAt: new Date().toISOString()})).status, 400);
    assert.equal((await incoming({...batch, padding: 'x'.repeat(33_000)})).status, 413);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 0);
    assert.equal((await incoming(batch)).status, 201);
    const duplicate = await incoming(batch);
    assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
    assert.equal((await incoming({...batch, drafts: [{...batch.drafts[0], text: '同一 ID 的不同内容'}]})).status, 409);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 1);
    assertCloudOnlyStoresDrafts(h.cloud);
  } finally {await h.close();}
});

test('cloud viewing and deletion require a valid browser session and deletion also requires CSRF', async () => {
  const h = await pair();
  try {
    await h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {});
    await h.mac.request(`/api/conversations/${h.cid}/sync-drafts`, 'POST', {});
    const batchId = h.cloud.store.read().cloudDrafts![0].id;
    const unauthorizedHeaders: Record<string, string>[] = [{}, {Cookie: 'xz_session=wrong-token'}, {Authorization: `Bearer ${syncToken}`}];
    for (const headers of unauthorizedHeaders) {
      assert.equal((await fetch(`${h.cloud.base}/api/state`, {headers})).status, 401);
      assert.equal((await fetch(`${h.cloud.base}/api/sync/drafts/${batchId}`, {method: 'DELETE', headers})).status, 401);
    }
    assert.equal((await h.cloud.request(`/api/sync/drafts/${batchId}`, 'DELETE', undefined, {'X-CSRF-Token': ''})).status, 403);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 1);
    assert.equal((await h.cloud.request('/api/state')).status, 200);
    assert.equal((await h.cloud.request(`/api/sync/drafts/${batchId}`, 'DELETE')).status, 200);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 0);
    assertCloudOnlyStoresDrafts(h.cloud);
  } finally {await h.close();}
});

test('lost upload acknowledgement preserves local drafts and retry reuses the id after the cloud has saved', async () => {
  let uploads = 0;
  const ids: string[] = [];
  const h = await pair({uploadDrafts: async (config, batch, signal) => {
    ids.push(batch.id); uploads++;
    const receipt = await uploadDraftBatch(config, batch, signal);
    if (uploads === 1) throw new Error('synthetic lost acknowledgement after server saved');
    return receipt;
  }});
  try {
    await h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {});
    const originalDrafts = h.mac.store.read().drafts;
    const failed = await h.mac.request(`/api/conversations/${h.cid}/sync-drafts`, 'POST', {});
    assert.equal(failed.status, 502);
    assert.ok(!(await failed.text()).includes('synthetic lost'));
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 1);
    assert.deepEqual(h.mac.store.read().drafts, originalDrafts);
    assert.equal(h.mac.store.read().draftUploads![0].status, 'failed');
    const retry = await h.mac.request(`/api/conversations/${h.cid}/sync-drafts`, 'POST', {});
    assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
    assert.deepEqual(ids, [ids[0], ids[0]]);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 1);
    assert.equal(h.mac.store.read().draftUploads!.length, 1);
    assert.equal(h.mac.store.read().draftUploads![0].status, 'uploaded');
    await h.mac.request(`/api/conversations/${h.cid}/sync-drafts`, 'POST', {});
    assert.equal(uploads, 2, 'confirmed batches do not upload again');
    assertCloudOnlyStoresDrafts(h.cloud); assert.equal(h.mac.calls.send, 0);
  } finally {await h.close();}
});

test('drafts invalidated by a new message, configuration or profile reload cannot be uploaded', async () => {
  const h = await pair();
  try {
    for (const invalidate of ['message', 'settings', 'profile'] as const) {
      assert.equal((await h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {})).status, 200);
      if (invalidate === 'message') await h.mac.request(`/api/conversations/${h.cid}/messages`, 'POST', {role: 'peer', text: '新消息使旧草稿过期'});
      else if (invalidate === 'settings') await h.mac.request('/api/settings', 'PATCH', {modelName: 'synthetic-changed-model'});
      else await h.mac.request('/api/profile/reload', 'POST', {});
      assert.equal(h.mac.store.read().drafts.length, 0);
      assert.equal((await h.mac.request(`/api/conversations/${h.cid}/sync-drafts`, 'POST', {})).status, 400);
      assert.equal(h.cloud.store.read().cloudDrafts!.length, 0);
    }
    assert.equal(h.mac.store.read().draftUploads!.length, 0);
    assertCloudOnlyStoresDrafts(h.cloud);
  } finally {await h.close();}
});

test('a generation overtaken by a new message neither stores nor automatically uploads stale drafts', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  let release!: () => void;
  const holding = new Promise<void>(resolve => {release = resolve;});
  const h = await pair({generate: async (state, cid) => {
    const draft: Draft = {id: 'synthetic-late-draft', conversationId: cid, basedOnMessageId: state.messages.at(-1)!.id,
      text: '旧上下文的虚构回复', label: '自然', reason: '测试', provider: 'codex', createdAt: new Date().toISOString()};
    entered(); await holding; return [draft];
  }});
  let pending: Promise<Response> | undefined;
  try {
    await h.mac.request('/api/settings', 'PATCH', {syncDraftsEnabled: true});
    pending = h.mac.request(`/api/conversations/${h.cid}/suggest`, 'POST', {});
    await started;
    await h.mac.request(`/api/conversations/${h.cid}/messages`, 'POST', {role: 'peer', text: '生成期间到达的新消息'});
    release(); assert.equal((await pending).status, 409);
    assert.equal(h.mac.store.read().drafts.length, 0); assert.equal(h.mac.store.read().draftUploads!.length, 0);
    assert.equal(h.cloud.store.read().cloudDrafts!.length, 0);
    assertCloudOnlyStoresDrafts(h.cloud);
  } finally {release(); await pending; await h.close();}
});
