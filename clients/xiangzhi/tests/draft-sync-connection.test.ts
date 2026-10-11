import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DraftSyncConnection } from '../server/draft-sync-connection.js';
import { createApplication } from '../server/app.js';
import type { Draft } from '../shared/types.js';

const env = {url: 'https://environment.example.test/inbox', token: 'synthetic-environment-token-'.repeat(2), inboxToken: ''};
const saved = {uploadUrl: 'https://wealth.example.test/api/v1/chat/ingest', token: 'synthetic-device-token-'.repeat(2)};

test('private binding overrides environment, survives restart, isolates each database and never exposes a token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiangzhi-binding-'));
  try {
    const path = join(dir, 'a.sqlite');
    const a = new DraftSyncConnection(path, env);
    assert.equal(a.status().source, 'environment');
    a.save(saved);
    const b = new DraftSyncConnection(join(dir, 'b.sqlite'), env);
    assert.equal(b.config().token, env.token);
    const reopened = new DraftSyncConnection(path, env);
    assert.equal(reopened.config().token, saved.token);
    assert.equal(reopened.status().bindingId, a.status().bindingId);
    assert.equal(reopened.status().uploadUrl, saved.uploadUrl);
    assert.equal(statSync(a.directory!).mode & 0o777, 0o700);
    assert.equal(statSync(a.path!).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(a.directory!), ['connection.json']);
    for (const token of [env.token, saved.token]) assert.ok(!JSON.stringify(a.status()).includes(token));
    a.disable();
    assert.ok(!readFileSync(a.path!, 'utf8').includes(saved.token));
    assert.equal(new DraftSyncConnection(path, env).status().source, 'disabled');
    assert.equal(new DraftSyncConnection(path, env).config().token, '');
    a.restoreEnvironment();
    assert.equal(new DraftSyncConnection(path, env).config().token, env.token);
    assert.ok(!readFileSync(a.path!, 'utf8').includes(env.token));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('bad packages do not overwrite a binding; malformed persisted configuration fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiangzhi-binding-invalid-'));
  try {
    const a = new DraftSyncConnection(join(dir, 'a.sqlite'), env);
    a.save(saved);
    for (const value of [null, {token: saved.token}, {...saved, token: 'short'}, {...saved, extra: saved.token},
      {...saved, token: `${saved.token}\n`}, {...saved, uploadUrl: `https://host.test/api?token=${saved.token}`},
      {...saved, uploadUrl: `https://user:${saved.token}@host.test/api`}, {...saved, uploadUrl: 'http://remote.test/api'}]) {
      assert.throws(() => a.save(value), error => error instanceof Error && !error.message.includes(saved.token));
      assert.equal(a.config().token, saved.token);
    }
    writeFileSync(a.path!, '{invalid');
    const corrupt = new DraftSyncConnection(join(dir, 'a.sqlite'), env);
    assert.equal(corrupt.status().source, 'error'); assert.equal(corrupt.config().token, '');
    corrupt.disable(); assert.equal(corrupt.status().source, 'disabled');
    const badEnv = new DraftSyncConnection(':memory:', {...env, url: `https://host.test/?secret=${saved.token}`});
    assert.equal(badEnv.status().uploadUrl, ''); assert.equal(badEnv.status().configured, false);
    const memoryA = new DraftSyncConnection(':memory:', env), memoryB = new DraftSyncConnection(':memory:', env);
    memoryA.save(saved); assert.equal(memoryB.config().token, env.token);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

const checkReceipt = {ok: true as const, device: {id: '501f6be4-9fde-4d86-a4a1-7bf8c521c236', name: '合成 Mac'}, checkedAt: '2026-10-11T04:00:00.000Z'};
async function harness(uploadDrafts?: Parameters<typeof createApplication>[0]['uploadDrafts'], check?: Parameters<typeof createApplication>[0]['checkDraftConnection']) {
  const dir = mkdtempSync(join(tmpdir(), 'xiangzhi-binding-api-'));
  const instance = createApplication({databasePath: join(dir, 'state.sqlite'), seed: false, profileManifestPath: null,
    draftSync: env, uploadDrafts, checkDraftConnection: check ?? (async () => checkReceipt),
    bridge: {inboundToken: '', outboundToken: '', outboundUrl: ''},
    inspectCodex: async () => ({available: false, version: null, message: '合成测试'}),
    inspectWechat: () => ({available: false, message: '合成测试'}),
    generate: async (state, cid) => [{id: `draft-${state.messages.at(-1)!.id}`, conversationId: cid,
      basedOnMessageId: state.messages.at(-1)!.id, text: '合成候选回复', label: '自然', reason: '合成测试',
      provider: 'demo', createdAt: new Date().toISOString()} satisfies Draft]});
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${base}/api/session`);
  const {token} = await session.json() as {token: string};
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api${path}`, {
    method, headers: {Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json', ...extra},
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
  });
  return {...instance, dir, request, close: async () => {
    await new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve());server.closeAllConnections();});
    instance.close(); rmSync(dir, {recursive: true, force: true});
  }};
}

async function createDraft(h: Awaited<ReturnType<typeof harness>>) {
  const created = await h.request('/conversations', 'POST', {name: '合成联系人'});
  const {id} = await created.json() as {id: string};
  await h.request(`/conversations/${id}/messages`, 'POST', {role: 'peer', text: '合成来信'});
  assert.equal((await h.request(`/conversations/${id}/suggest`, 'POST', {})).status, 200);
  return id;
}

test('connection APIs require browser session and CSRF; save performs only device verification and preserves generation, reading and drafts', async () => {
  let calls = 0;
  const h = await harness(async (_config, batch) => {calls++;return {id: batch.id, duplicate: false};});
  try {
    await createDraft(h);
    h.store.update(state => {state.settings.autoReplyEnabled = true;state.settings.syncDraftsEnabled = true;});
    const before = h.store.read();
    assert.equal((await h.request('/draft-sync/connection', 'PUT', saved, {Cookie: ''})).status, 401);
    assert.equal((await h.request('/draft-sync/connection', 'PUT', saved, {'X-CSRF-Token': ''})).status, 403);
    assert.equal((await h.request('/draft-sync/connection', 'DELETE', undefined, {'X-CSRF-Token': ''})).status, 403);
    assert.equal((await h.request('/draft-sync/connection/environment', 'POST', {}, {'X-CSRF-Token': ''})).status, 403);
    const response = await h.request('/draft-sync/connection', 'PUT', saved);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(saved.token));
    assert.equal(calls, 0);
    const after = h.store.read();
    assert.equal(after.settings.autoReplyEnabled, true); assert.equal(after.settings.syncDraftsEnabled, false);
    assert.deepEqual(after.drafts, before.drafts); assert.deepEqual(after.jobs, before.jobs);assert.deepEqual(after.conversations, before.conversations);
    // Settings form submits unchanged model values together with its sync switch.
    assert.equal((await h.request('/settings', 'PATCH', {...after.settings, syncDraftsEnabled: true})).status, 200);
    assert.deepEqual(h.store.read().drafts, before.drafts);
    assert.equal(h.store.read().settings.autoReplyEnabled, true);
    const visible = JSON.stringify(await (await h.request('/state')).json());
    for (const secret of [env.token, saved.token]) {
      assert.ok(!visible.includes(secret)); assert.ok(!JSON.stringify(after).includes(secret));
      assert.ok(!readFileSync(join(h.dir, 'state.sqlite')).includes(Buffer.from(secret)));
    }
    assert.equal((await h.request('/draft-sync/connection', 'DELETE')).status, 200);
    assert.equal(h.publicState().runtime.draftSyncConfigured, false);
    assert.equal((await h.request('/settings', 'PATCH', {syncDraftsEnabled: true})).status, 400);
    assert.equal((await h.request('/draft-sync/connection/environment', 'POST')).status, 200);
    assert.equal(h.publicState().runtime.draftSyncConnection!.source, 'environment');
    assert.equal(h.store.read().settings.syncDraftsEnabled, false); assert.equal(calls, 0);
  } finally { await h.close(); }
});

test('changing binding aborts old upload and late acknowledgement cannot modify or deduplicate the new destination', async () => {
  let enter!: () => void; const entered = new Promise<void>(resolve => {enter = resolve;});
  let release!: () => void; const holding = new Promise<void>(resolve => {release = resolve;});
  let firstSignal: AbortSignal | undefined; let calls = 0;
  const h = await harness(async (_config, batch, signal) => {
    calls++;
    if (calls === 1) {firstSignal = signal;enter();await holding;}
    return {id: batch.id, duplicate: false};
  });
  let pending: Promise<Response> | undefined;
  try {
    const cid = await createDraft(h);
    const oldId = h.publicState().runtime.draftSyncConnection!.bindingId;
    pending = h.request(`/conversations/${cid}/sync-drafts`, 'POST'); await entered;
    assert.equal((await h.request('/draft-sync/connection', 'PUT', saved)).status, 200);
    assert.equal(firstSignal!.aborted, true);
    const newId = h.publicState().runtime.draftSyncConnection!.bindingId;
    assert.notEqual(newId, oldId);
    assert.equal((await h.request(`/conversations/${cid}/sync-drafts`, 'POST')).status, 200);
    release(); assert.equal((await pending).status, 409);
    const uploads = h.store.read().draftUploads!;
    assert.equal(uploads.length, 2);
    assert.equal(uploads.find(item => item.destinationId === oldId)!.status, 'failed');
    assert.equal(uploads.find(item => item.destinationId === newId)!.status, 'uploaded');
    assert.equal((await h.request(`/conversations/${cid}/sync-drafts`, 'POST')).status, 200);
    assert.equal(calls, 2);
    assert.equal(h.store.read().drafts.length, 1);
  } finally {release();await pending;await h.close();}
});

test('save verifies once without uploading; failed checks retain the configuration and explicit retry succeeds', async () => {
  let checks = 0, uploads = 0;
  const h = await harness(async (_config, batch) => {uploads++;return {id: batch.id, duplicate: false};}, async config => {
    checks++;assert.equal(config.token, saved.token);
    if (checks === 1) throw new Error(`untrusted provider echo ${saved.token}`);
    return checkReceipt;
  });
  try {
    assert.equal(checks, 0, 'startup does not verify');
    const response = await h.request('/draft-sync/connection', 'PUT', saved);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.configured, true); assert.equal(status.source, 'saved');
    assert.equal(status.verification.status, 'failed');assert.equal(checks, 1);
    assert.ok(!JSON.stringify(status).includes(saved.token));
    assert.equal(h.store.read().settings.syncDraftsEnabled, false);assert.equal(uploads, 0);
    assert.equal((await h.request('/draft-sync/connection/check', 'POST', {}, {'X-CSRF-Token': ''})).status, 403);
    assert.equal((await h.request('/draft-sync/connection/check', 'POST', {}, {Cookie: ''})).status, 401);
    assert.equal((await h.request('/draft-sync/connection/check', 'POST', {token: 'unexpected'})).status, 400);
    assert.equal(checks, 1);
    const checked = await (await h.request('/draft-sync/connection/check', 'POST', {})).json();
    assert.equal(checked.verification.status, 'verified');assert.deepEqual(checked.verification.device, checkReceipt.device);
    assert.equal(checked.verification.checkedAt, checkReceipt.checkedAt);assert.equal(checks, 2);assert.equal(uploads, 0);
    assert.equal(h.store.read().settings.syncDraftsEnabled, false);
    await h.request('/draft-sync/connection', 'DELETE');
    assert.equal(h.publicState().runtime.draftSyncConnection!.verification.status, 'not_checked');
    assert.equal(h.publicState().runtime.draftSyncConnection!.verification.device, null);
  } finally {await h.close();}
});

test('generic upload endpoints never receive an invented verification request', async () => {
  let checks = 0;
  const h = await harness(undefined, async () => {checks++;return checkReceipt;});
  try {
    const status = await (await h.request('/draft-sync/connection', 'PUT', {...saved, uploadUrl: 'https://other.example.test/inbox'})).json();
    assert.equal(status.configured, true);assert.equal(status.verification.supported, false);
    assert.equal((await h.request('/draft-sync/connection/check', 'POST', {})).status, 400);
    assert.equal(checks, 0);
  } finally {await h.close();}
});

test('restarting with a saved Wealth connection does not contact its server or turn on automatic work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiangzhi-binding-restart-'));
  const databasePath = join(dir, 'restart.sqlite');
  new DraftSyncConnection(databasePath, env).save(saved);
  let checks = 0;
  const instance = createApplication({databasePath, seed:false, profileManifestPath:null, draftSync:env,
    inspectCodex:async()=>({available:false,version:null,message:'合成测试'}), inspectWechat:()=>({available:false,message:'合成测试'}),
    checkDraftConnection:async()=>{checks++;return checkReceipt;}});
  try {
    instance.engine.start();instance.collector.start();await instance.engine.tick();
    assert.equal(checks,0);
    assert.equal(instance.publicState().runtime.draftSyncConnection!.verification.status,'not_checked');
    assert.equal(instance.store.read().settings.autoReplyEnabled,false);
    assert.equal(instance.store.read().settings.syncDraftsEnabled,false);
  } finally {instance.close();rmSync(dir,{recursive:true,force:true});}
});

test('a superseded failed check cannot overwrite a newer successful check', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => {entered = resolve;});
  let release!: () => void; const holding = new Promise<void>(resolve => {release = resolve;});
  let calls = 0; let oldSignal: AbortSignal | undefined;
  const h = await harness(undefined, async (_config, signal) => {
    if (++calls === 2) {oldSignal = signal;entered();await holding;throw new Error('old failure');}
    return checkReceipt;
  });
  let pending: Promise<Response> | undefined;
  try {
    await h.request('/draft-sync/connection', 'PUT', saved);
    pending = h.request('/draft-sync/connection/check', 'POST', {}); await started;
    assert.equal((await h.request('/draft-sync/connection/check', 'POST', {})).status, 200);
    assert.equal(oldSignal!.aborted, true);
    release();assert.equal((await pending).status, 409);
    assert.equal(h.publicState().runtime.draftSyncConnection!.verification.status, 'verified');
    assert.equal(h.publicState().runtime.draftSyncConnection!.verification.error, null);
  } finally {release();await pending;await h.close();}
});

test('changing a connection cancels a pending verification and ignores the old success', async () => {
  let entered!: () => void;const started = new Promise<void>(resolve => {entered = resolve;});
  let release!: () => void;const holding = new Promise<void>(resolve => {release = resolve;});
  let oldSignal: AbortSignal | undefined;
  const h = await harness(undefined, async (_config, signal) => {oldSignal=signal;entered();await holding;return checkReceipt;});
  let pending: Promise<Response> | undefined;
  try {
    pending = h.request('/draft-sync/connection', 'PUT', saved);await started;
    const changed = await h.request('/draft-sync/connection', 'PUT', {...saved, uploadUrl: 'https://other.example.test/inbox'});
    assert.equal(changed.status, 200);assert.equal(oldSignal!.aborted, true);
    release();assert.equal((await pending).status, 409);
    const current = h.publicState().runtime.draftSyncConnection!;
    assert.equal(current.uploadUrl, 'https://other.example.test/inbox');
    assert.equal(current.verification.status, 'not_checked');assert.equal(current.verification.device, null);
  } finally {release();await pending;await h.close();}
});
