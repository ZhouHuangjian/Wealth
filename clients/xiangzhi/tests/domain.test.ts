import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { commitImport, deleteConversation, extractClaims, previewImport, seedDemo } from '../server/domain.js';
import type { ImportInput } from '../shared/types.js';

function fixture(t: { after: (fn: () => void) => void }): Store {
  const directory = mkdtempSync(join(tmpdir(), 'xiangzhi-domain-'));
  const store = new Store(join(directory, 'private', 'state.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function chatlab(messages: unknown[], overrides: Record<string, unknown> = {}): ImportInput {
  return { filename: 'conversation.json', selfId: 'me', text: JSON.stringify({
    chatlab: { version: '0.0.2', exportedAt: 1703001600 },
    meta: { name: '测试会话', platform: 'test', type: 'private' },
    members: [{ platformId: 'me', accountName: '本人' }, { platformId: 'peer', accountName: '同名联系人' }],
    messages, ...overrides,
  }) };
}
const chatMessage = (id: string, content = '我喜欢安静的咖啡馆。') => ({ sender: 'me', accountName: '本人', type: 0, content, timestamp: 1703001600, platformMessageId: id });

test('store snapshots are isolated, writes roll back, file permissions restrict access', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'xiangzhi-permissions-'));
  const path = join(directory, 'data', 'state.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(statSync(join(directory, 'data')).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const snapshot = store.read();
  snapshot.settings.modelName = 'uncommitted';
  assert.equal(store.read().settings.modelName, '');
  assert.throws(() => store.update((state) => { state.settings.modelName = 'rolled back'; throw new Error('abort'); }), /abort/);
  assert.equal(store.read().settings.modelName, '');
  store.update((state) => { state.settings.modelName = 'saved'; });
  assert.equal(store.read().settings.modelName, 'saved');
});

test('restart disables auto, cancels queued jobs and marks interrupted outcomes unconfirmed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'xiangzhi-restart-'));
  const path = join(directory, 'data', 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.update((state) => {
    state.settings.autoReplyEnabled = true;
    for (const status of ['queued', 'generating', 'sent'] as const) state.jobs.push({
      id: status, conversationId: 'c', messageId: 'm', status, dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), finishedAt: null, detail: '', replyText: 'unfinished text',
    });
  });
  store.close(); store = new Store(path);
  assert.equal(store.read().settings.autoReplyEnabled, false);
  assert.deepEqual(store.read().jobs.map((job) => job.status), ['cancelled', 'failed', 'sent']);
  assert.equal(store.read().jobs[0].replyText, null);
  assert.match(store.read().jobs[1].detail, /结果未确认/);
  assert.equal(store.read().jobs[1].replyText, 'unfinished text');
});

test('demo seed is idempotent and never overwrites imported data', (t) => {
  const store = fixture(t);
  seedDemo(store); seedDemo(store);
  assert.equal(store.read().conversations.length, 2);
  assert.equal(store.read().messages.length, 16);
  assert.ok(store.read().conversations.every((conversation) => !conversation.autoReplyEnabled));
  const imported = fixture(t);
  commitImport(imported, { filename: 'chat.txt', text: '我：今天去散步了\n对方：天气不错' });
  seedDemo(imported);
  assert.equal(imported.read().conversations.length, 1);
});

test('ChatLab requires explicit identity, supports JSONL, and does not infer self from ownerId', (t) => {
  const store = fixture(t);
  const input = chatlab([chatMessage('m1')]);
  delete input.selfId;
  const preview = previewImport(input);
  assert.equal(preview.needsSelfId, true);
  assert.equal(preview.members.length, 2);
  assert.throws(() => commitImport(store, input), /本人 ID/);
  assert.equal(store.read().messages.length, 0);
  const jsonl: ImportInput = { filename: 'chat.jsonl', selfId: 'me', text: [
    '# export',
    JSON.stringify({ _type: 'header', chatlab: { version: '0.0.2', exportedAt: 1703001600 }, meta: { name: '私聊', platform: 'test', type: 'private' } }),
    JSON.stringify({ _type: 'message', ...chatMessage('m1') }),
    JSON.stringify({ _type: 'message', ...chatMessage('m2', '你好'), sender: 'peer', accountName: '对方' }),
  ].join('\n') };
  const parsed = previewImport(jsonl);
  assert.deepEqual(parsed.messages.map((message) => message.role), ['self', 'peer']);
  assert.equal(parsed.messages[0].sentAt, '2023-12-19T16:00:00.000Z');
  assert.equal(commitImport(store, jsonl).added, 2);
  assert.equal(store.read().jobs.length, 0);
});

test('idempotent import preserves two identical messages in the same second', (t) => {
  const store = fixture(t);
  const input: ImportInput = { filename: 'simple.json', text: JSON.stringify([
    { role: 'self', text: '嗯', sentAt: '2026-10-01T12:00:00+08:00' },
    { role: 'self', text: '嗯', sentAt: '2026-10-01T12:00:00+08:00' },
  ]) };
  const first = commitImport(store, input);
  const second = commitImport(store, input);
  assert.equal(first.added, 2);
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 2);
  assert.equal(store.read().messages.length, 2);
  assert.notEqual(store.read().messages[0].id, store.read().messages[1].id);
});

test('ChatLab incremental import uses platform IDs; any conflict rolls back the whole batch', (t) => {
  const store = fixture(t);
  const first = commitImport(store, chatlab([chatMessage('m1')]));
  const second = commitImport(store, chatlab([chatMessage('m1'), chatMessage('m2')]));
  assert.equal(first.conversationId, second.conversationId);
  assert.equal(second.added, 1);
  assert.equal(second.duplicates, 1);
  assert.throws(() => commitImport(store, chatlab([chatMessage('m3'), chatMessage('m1', 'changed')])), /冲突/);
  assert.equal(store.read().messages.length, 2);
});

test('CSV parses quoted commas/newlines and text import preserves unknown timestamps', () => {
  const csv = previewImport({ filename: 'test.csv', text: 'role,text,sentAt\nself,"我喜欢咖啡,也喜欢茶\n慢慢聊",2026-10-01T10:00:00Z\npeer,好呀,' });
  assert.equal(csv.messages[0].text, '我喜欢咖啡,也喜欢茶\n慢慢聊');
  assert.equal(csv.messages[1].sentAt, null);
  const text = previewImport({ filename: 'test.txt', text: '我：你好\n对方：你好' });
  assert.ok(text.messages.every((message) => message.sentAt === null));
  assert.throws(() => previewImport({ filename: 'test.txt', text: '张三：你好' }), /我：/);
});

test('malformed dates, unknown roles, unsupported groups, huge input fail explicitly', () => {
  assert.throws(() => previewImport({ filename: 'bad.json', text: '[{"role":"unknown","text":"hi"}]' }), /role/);
  assert.throws(() => previewImport({ filename: 'bad.json', text: '[{"role":"self","text":"hi","sentAt":"2026-10-01 12:00:00"}]' }), /时区/);
  assert.throws(() => previewImport({ filename: 'bad.json', text: '[{"role":"self","text":"hi","sentAt":"2026-02-30T12:00:00Z"}]' }), /有效日期/);
  assert.throws(() => previewImport(chatlab([chatMessage('m1')], { meta: { name: 'group', platform: 'test', type: 'group' } })), /群聊/);
  assert.throws(() => previewImport({ filename: 'large.txt', text: 'a'.repeat(5 * 1024 * 1024 + 1) }), /5 MiB/);
  assert.throws(() => previewImport(chatlab([{ ...chatMessage('m1'), timestamp: 1703001600000 }])), /毫秒/);
});

test('claims only use original self statements, preserve evidence and pending/rejected status', (t) => {
  const store = fixture(t);
  const imported = commitImport(store, { filename: 'claims.json', text: JSON.stringify([
    { role: 'peer', text: '我喜欢游泳。' },
    { role: 'self', text: '我喜欢安静的咖啡馆。' },
    { role: 'self', text: '我喜欢安静的咖啡馆。' },
    { role: 'self', text: '我喜欢冲浪。', aiAssisted: true },
    { role: 'self', text: '她说：“我喜欢唱歌”。' },
    { role: 'self', text: '如果我喜欢跑步，就去参加比赛。' },
    { role: 'self', text: '我希望慢慢聊天。' },
  ]) });
  const claims = extractClaims(store, imported.conversationId);
  assert.equal(claims.length, 2);
  assert.ok(claims.every((claim) => claim.status === 'pending' && claim.scope === imported.conversationId));
  assert.equal(claims.find((claim) => claim.category === 'preference')?.evidenceIds.length, 2);
  store.update((state) => { state.claims[0].status = 'rejected'; });
  assert.equal(extractClaims(store, imported.conversationId).length, 0);
  assert.equal(store.read().claims[0].status, 'rejected');
});

test('ChatLab quoted/forwarded/nontext content is never used for self modeling', (t) => {
  const store = fixture(t);
  const imported = commitImport(store, chatlab([25, 26, 1].map((type) => ({ ...chatMessage(`m${type}`), type }))));
  assert.ok(store.read().messages.every((message) => message.role === 'system'));
  assert.equal(extractClaims(store, imported.conversationId).length, 0);
});

test('later AI provenance is retained and invalidates derived personal claims', (t) => {
  const store = fixture(t);
  const original = chatMessage('m1');
  const imported = commitImport(store, chatlab([original]));
  extractClaims(store, imported.conversationId);
  assert.equal(store.read().claims.length, 1);
  commitImport(store, chatlab([{ ...original, aiAssisted: true }]));
  assert.equal(store.read().messages[0].aiAssisted, true);
  assert.equal(store.read().claims.length, 0);
  commitImport(store, chatlab([original]));
  assert.equal(store.read().messages[0].aiAssisted, true);
  assert.equal(extractClaims(store, imported.conversationId).length, 0);
});

test('conversation deletion cascades even through mixed-source claims and keeps other conversations', (t) => {
  const store = fixture(t);
  seedDemo(store);
  const id = 'demo-lin';
  const otherMessage = store.read().messages.find((message) => message.conversationId !== id)!;
  const ownMessage = store.read().messages.find((message) => message.conversationId === id)!;
  store.update((state) => {
    state.claims.push({ id: 'mixed', category: 'fact', statement: 'sensitive', scope: null, status: 'approved', evidenceIds: [ownMessage.id, otherMessage.id], createdAt: '' });
    state.drafts.push({ id: 'd', conversationId: id, basedOnMessageId: ownMessage.id, text: 'sensitive', label: '', reason: '', createdAt: '', provider: 'demo' });
    state.jobs.push({ id: 'j', conversationId: id, messageId: ownMessage.id, status: 'queued', dueAt: '', createdAt: '', finishedAt: null, detail: 'sensitive', replyText: null });
    state.activity.push({ id: 'a', conversationId: id, kind: 'info', title: '', detail: 'sensitive', createdAt: '' });
  });
  deleteConversation(store, id);
  const state = store.read();
  assert.equal(state.conversations.length, 1);
  assert.equal(state.messages.length, 8);
  assert.equal(state.claims.length, 0);
  assert.equal(state.drafts.length, 0);
  assert.equal(state.jobs.length, 0);
  assert.ok(!JSON.stringify(state).includes('sensitive'));
  assert.ok(state.activity.every((item) => item.conversationId !== id));
});
