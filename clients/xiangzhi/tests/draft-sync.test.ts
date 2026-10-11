import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Conversation, Draft } from '../shared/types.js';
import { buildDraftBatch, cloudDraftBatchSchema, draftSyncConfig, isDraftInboxConfigured, isDraftSyncConfigured, uploadDraftBatch, type DraftSyncConfig } from '../server/draft-sync.js';

const createdAt = '2026-10-10T00:00:00.000Z';
const conversation: Conversation = {id: 'conversation-fixture', name: '虚构会话', avatar: '', color: '', note: '不应上传的联系人备注',
  autoReplyEnabled: false, channel: 'webhook', externalId: '不应上传的微信标识', createdAt, updatedAt: createdAt};
function drafts(): Draft[] {
  return ['直接', '简短', '自然'].map((label, index) => ({id: `draft-${index}`, conversationId: conversation.id, basedOnMessageId: 'peer-fixture',
    text: `虚构测试回复${index}`, label, reason: '根据当前情境生成', createdAt, provider: 'codex', profileVersion: '1.8', profileDigest: '不应上传的档案摘要'}));
}
const config = (url: string): DraftSyncConfig => ({url, token: 'synthetic-sync-token-'.repeat(3), inboxToken: ''});
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })};
}

test('draft batches are minimal, deterministic and tied to one conversation, message and profile', () => {
  const source = drafts();
  const batch = buildDraftBatch(conversation, source);
  assert.deepEqual(Object.keys(batch).sort(), ['id', 'conversationKey', 'conversationName', 'basedOnMessageId', 'createdAt', 'provider', 'profileVersion', 'drafts'].sort());
  assert.deepEqual(batch.drafts, source.map(({text, label, reason}) => ({text, label, reason})));
  assert.match(batch.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(buildDraftBatch({...conversation, note: '不同备注'}, structuredClone(source)), batch);
  assert.notEqual(buildDraftBatch(conversation, source.map(draft => ({...draft, id: `${draft.id}-new`}))).id, batch.id);
  const serialized = JSON.stringify(batch);
  for (const privateValue of ['不应上传的联系人备注', '不应上传的微信标识', '不应上传的档案摘要']) assert.ok(!serialized.includes(privateValue));
  for (const override of [{conversationId: 'foreign'}, {basedOnMessageId: 'foreign'}, {provider: 'demo' as const}, {profileVersion: '1.9'}, {profileDigest: 'different'}, {createdAt: 'invalid'}]) {
    assert.throws(() => buildDraftBatch(conversation, [source[0], {...source[1], ...override}]), /同一会话/);
  }
  assert.throws(() => buildDraftBatch(conversation, []));
  assert.throws(() => buildDraftBatch(conversation, [source[0], source[0]]));
  assert.throws(() => buildDraftBatch(conversation, [...source, {...source[0], id: 'fourth'}]));
});

test('wire schema is strict and limits identifiers, text, timestamps and nested fields', () => {
  const batch = buildDraftBatch(conversation, drafts());
  assert.equal(cloudDraftBatchSchema.safeParse(batch).success, true);
  for (const payload of [
    {...batch, receivedAt: createdAt}, {...batch, sourceMessages: ['not permitted']}, {...batch, id: 'bad\r\nheader'},
    {...batch, conversationKey: 'x'.repeat(301)}, {...batch, basedOnMessageId: ''}, {...batch, conversationName: '名'.repeat(81)},
    {...batch, createdAt: '2026-10-10'}, {...batch, provider: 'unknown'}, {...batch, profileVersion: '1'.repeat(33)},
    {...batch, drafts: []}, {...batch, drafts: [batch.drafts[0], batch.drafts[0], batch.drafts[0], batch.drafts[0]]},
    {...batch, drafts: [{...batch.drafts[0], text: ' '}]}, {...batch, drafts: [{...batch.drafts[0], text: '长'.repeat(501)}]},
    {...batch, drafts: [{...batch.drafts[0], label: '长'.repeat(41)}]}, {...batch, drafts: [{...batch.drafts[0], reason: '长'.repeat(301)}]},
    {...batch, drafts: [{...batch.drafts[0], fullProfile: {secret: true}}]},
  ]) assert.equal(cloudDraftBatchSchema.safeParse(payload).success, false);
});

test('draft synchronization and inbox independently validate configuration and environment settings', () => {
  assert.equal(isDraftSyncConfigured(config('https://example.com/api/draft-inbox')), true);
  assert.equal(isDraftSyncConfigured(config('http://127.0.0.1:4317/api/draft-inbox')), true);
  assert.equal(isDraftInboxConfigured(config('')), false);
  assert.equal(isDraftInboxConfigured({...config(''), inboxToken: 'x'.repeat(32)}), true);
  for (const url of ['', 'not-a-url', 'http://example.com/inbox', 'https://name:password@example.com/inbox', 'https://example.com/inbox?key=secret', 'https://example.com/inbox#fragment']) {
    assert.equal(isDraftSyncConfigured(config(url)), false);
  }
  assert.equal(isDraftSyncConfigured({...config('https://example.com/inbox'), token: 'short'}), false);
  const envNames = ['DRAFT_SYNC_URL', 'DRAFT_SYNC_TOKEN', 'DRAFT_INBOX_TOKEN'] as const;
  const previous = envNames.map(name => process.env[name]);
  try {
    process.env.DRAFT_SYNC_URL = 'https://example.com/inbox'; process.env.DRAFT_SYNC_TOKEN = 'synthetic-token'; process.env.DRAFT_INBOX_TOKEN = 'synthetic-inbox';
    assert.deepEqual(draftSyncConfig(), {url: 'https://example.com/inbox', token: 'synthetic-token', inboxToken: 'synthetic-inbox'});
  } finally {
    envNames.forEach((name, index) => {if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];});
  }
});

test('real HTTP upload sends only the minimal packet with bearer authentication and stable idempotency', async () => {
  const batch = buildDraftBatch(conversation, drafts());
  const received: {auth: string | undefined; key: string | string[] | undefined; path: string | undefined; body: unknown}[] = [];
  const ids = new Set<string>();
  const local = await endpoint((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const packet = JSON.parse(body);
      received.push({auth: req.headers.authorization, key: req.headers['idempotency-key'], path: req.url, body: packet});
      const duplicate = ids.has(packet.id); ids.add(packet.id);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ok: true, id: packet.id, duplicate}));
    });
  });
  try {
    const settings = config(`${local.url}/api/draft-inbox`);
    assert.deepEqual(await uploadDraftBatch(settings, batch), {id: batch.id, duplicate: false});
    assert.deepEqual(await uploadDraftBatch(settings, buildDraftBatch(conversation, drafts())), {id: batch.id, duplicate: true});
    assert.equal(ids.size, 1);
    assert.equal(received.length, 2);
    for (const request of received) assert.deepEqual(request, {auth: `Bearer ${settings.token}`, key: batch.id, path: '/api/draft-inbox', body: batch});
  } finally { await local.close(); }
});

test('invalid acknowledgement or server errors never count as successful upload or expose response contents', async () => {
  const batch = buildDraftBatch(conversation, drafts());
  let calls = 0;
  const local = await endpoint((req, res) => {
    calls++;
    if (req.url === '/failure') {res.statusCode = 500; res.end('private-response-secret'); return;}
    res.setHeader('Content-Type', 'application/json');
    const replies: Record<string, unknown> = {'/wrong': {ok: true, id: 'wrong'}, '/missing': {ok: true}, '/false': {ok: false, id: batch.id}, '/duplicate': {ok: true, id: batch.id, duplicate: 'true'}};
    res.end(req.url === '/not-json' ? 'private-response-secret' : JSON.stringify(replies[req.url ?? '']));
  });
  try {
    for (const path of ['/wrong', '/missing', '/false', '/duplicate', '/not-json', '/failure']) {
      await assert.rejects(uploadDraftBatch(config(`${local.url}${path}`), batch), error => error instanceof Error && !error.message.includes('private-response-secret') && /未|确认/.test(error.message));
    }
    assert.equal(calls, 6, 'transport never retries automatically');
  } finally { await local.close(); }
});

test('redirects are not followed and invalid payload or remote plaintext never initiates a request', async () => {
  const batch = buildDraftBatch(conversation, drafts());
  let calls = 0;
  const local = await endpoint((_req, res) => {calls++; res.statusCode = 307; res.setHeader('Location', '/must-not-receive'); res.end();});
  try {
    await assert.rejects(uploadDraftBatch(config(local.url), batch), /连接失败/);
    assert.equal(calls, 1);
    await assert.rejects(uploadDraftBatch(config('http://example.com/private-path'), batch), error => error instanceof Error && !error.message.includes('private-path'));
    await assert.rejects(uploadDraftBatch(config(local.url), {...batch, apiKey: 'secret'} as typeof batch), /格式不正确/);
    assert.equal(calls, 1);
  } finally { await local.close(); }
});

test('acknowledgement size limit applies to declared and streamed responses', async () => {
  const batch = buildDraftBatch(conversation, drafts());
  const local = await endpoint((req, res) => {
    const content = JSON.stringify({ok: true, id: batch.id}) + ' '.repeat(8192);
    if (req.url === '/declared') res.setHeader('Content-Length', Buffer.byteLength(content));
    else res.setHeader('Transfer-Encoding', 'chunked');
    res.write(content.slice(0, 30)); res.end(content.slice(30));
  });
  try {
    for (const path of ['/declared', '/streamed']) await assert.rejects(uploadDraftBatch(config(`${local.url}${path}`), batch), /确认内容过大/);
  } finally { await local.close(); }
});

test('caller cancellation aborts a pending HTTP upload without retry or leaking transport details', async () => {
  let started!: () => void;
  const incoming = new Promise<void>(resolve => {started = resolve;});
  let calls = 0;
  const local = await endpoint((_req, _res) => {calls++; started();});
  try {
    const abort = new AbortController();
    const pending = uploadDraftBatch(config(`${local.url}/private-path`), buildDraftBatch(conversation, drafts()), abort.signal);
    await incoming; abort.abort(new Error('private-cancellation-secret'));
    await assert.rejects(pending, error => error instanceof Error && /已取消/.test(error.message) && !error.message.includes('private'));
    assert.equal(calls, 1);
  } finally { await local.close(); }
});
