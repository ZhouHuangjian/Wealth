import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Draft, Message } from '../shared/types.js';
import { AutoReplyEngine, replyContextFingerprint } from '../server/auto-reply.js';
import { generateDrafts, latestConversationMessage } from '../server/generation.js';
import { assertReplyContextReady, pendingMediaMessages } from '../server/message-context.js';
import { WechatCollector } from '../server/wechat-collector.js';

function fixture(): AppState {
  return {version: 1, settings: {autoReplyEnabled: true, autoReplyMode: 'draft', provider: 'demo', modelUrl: 'http://localhost:11434',
    modelName: '', apiKey: '', allowRemoteModel: true, replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
    quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00'},
    conversations: ['a', 'b'].map(id => ({id, name: id, avatar: '', color: '', note: '', autoReplyEnabled: true,
      channel: 'wechat', externalId: null, createdAt: '', updatedAt: ''})),
    messages: [], claims: [], drafts: [], jobs: [], activity: []};
}
function message(id: string, sequence: number, overrides: Partial<Message> = {}): Message {
  return {id, conversationId: 'a', role: 'peer', source: 'wechat', text: '今天怎么样？', sequence, kind: 'text',
    sentAt: null, externalId: null, aiAssisted: false, ...overrides};
}
class MemoryStore {
  constructor(private state: AppState) {}
  read(): AppState { return structuredClone(this.state); }
  update(fn: (state: AppState) => void): void { const next = this.read(); fn(next); this.state = next; }
}
function fakeDrafts(state: AppState, conversationId: string): Draft[] {
  return [{id: 'draft', conversationId, basedOnMessageId: latestConversationMessage(state, conversationId)!.id,
    text: '测试候选回复', label: '测试', reason: '合成上下文', createdAt: '', provider: state.settings.provider}];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {resolve = res;});
  return {promise, resolve};
}
function validContent(): string {
  return JSON.stringify({replies: ['一', '二', '三'].map(value => ({text: `测试回复${value}`, label: '测试', reason: '文字上下文'}))});
}

test('sending mode still blocks pending image or voice before any model call', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {throw new Error('must not call HTTP');});
  let codexCalls = 0;
  for (const kind of ['image', 'voice'] as const) for (const provider of ['demo', 'compatible', 'codex'] as const) {
    const state = fixture(); state.settings.provider = provider; state.settings.autoReplyMode = 'send';
    state.messages = [message('media', 1, {kind, mediaStatus: 'pending', text: `[${kind}]`}), message('text', 2)];
    await assert.rejects(generateDrafts(state, 'a', '', undefined, {codex: async () => {codexCalls++; return validContent();}}), /先在微信中查看.*标记为已查看/);
  }
  assert.equal(fetch.mock.callCount(), 0); assert.equal(codexCalls, 0);
});

test('draft mode generates with pending media placeholders, including after newer text, without requiring review', async () => {
  for (const kind of ['image', 'voice'] as const) for (const hasNewerText of [true, false]) {
    const state = fixture();
    state.messages = [message('media', 1, {kind, mediaStatus: 'pending', text: `[${kind}，内容未解析]`})];
    if (hasNewerText) state.messages.push(message('text', 2));
    assert.doesNotThrow(() => assertReplyContextReady(state, 'a'));
    assert.equal((await generateDrafts(state, 'a')).length, 3);
    state.settings.provider = 'codex'; let context: {recentMessages: {kind: string; mediaStatus: string; text: string}[]} | undefined;
    const drafts = await generateDrafts(state, 'a', '', undefined, {codex: async (_settings, messages) => {
      context = JSON.parse(messages[1].content); return validContent();
    }});
    assert.equal(drafts.length, 3); assert.equal(drafts[0].basedOnMessageId, hasNewerText ? 'text' : 'media');
    assert.ok(context!.recentMessages.some(item => item.kind === kind && item.mediaStatus === 'pending' && item.text.includes('内容未解析')));
    assert.equal(state.messages[0].mediaStatus, 'pending', 'generation does not pretend the media has been reviewed');
  }
});

test('reviewed media permits generation but is identified as unavailable media content to the model', async () => {
  const state = fixture();
  state.messages = [message('media', 1, {kind: 'image', mediaStatus: 'reviewed', text: '[图片]'}), message('text', 2)];
  assert.equal((await generateDrafts(state, 'a')).length, 3);
  state.settings.provider = 'codex';
  let prompt: {role: string; content: string}[] = [];
  const drafts = await generateDrafts(state, 'a', '', undefined, {codex: async (_settings, messages) => {prompt = messages; return validContent();}});
  assert.equal(drafts.length, 3);
  const context = JSON.parse(prompt[1].content);
  assert.equal(context.recentMessages[0].kind, 'image'); assert.equal(context.recentMessages[0].mediaStatus, 'reviewed');
  assert.match(prompt[0].content, /只表示用户已查看，不表示你已理解其内容/);
});

test('self media placeholders and review notes remain context but never become original style samples or claim evidence', async () => {
  const state = fixture(); state.settings.provider = 'codex';
  state.messages = [
    message('self-text', 1, {role: 'self', text: '本人原始文字表达'}),
    message('self-image', 2, {role: 'self', kind: 'image', mediaStatus: 'reviewed', text: '[图片，待人工查看]'}),
    message('self-voice', 3, {role: 'self', kind: 'voice', mediaStatus: 'reviewed', text: '[人工补充] 语音在说明集合地点'}),
    message('peer-text', 4, {text: '收到，那待会儿见'}),
  ];
  state.claims = ['self-text', 'self-image', 'self-voice'].map(id => ({id: `claim-${id}`, category: 'style',
    statement: `合成依据 ${id}`, status: 'approved', evidenceIds: [id], scope: 'a', createdAt: ''}));
  let prompt: {role: string; content: string}[] = [];
  await generateDrafts(state, 'a', '', undefined, {codex: async (_settings, messages) => {prompt = messages; return validContent();}});
  const context = JSON.parse(prompt[1].content);
  assert.deepEqual(context.selfStyleSamples, ['本人原始文字表达']);
  assert.deepEqual(context.approvedSelfClaims.map((claim: {statement: string}) => claim.statement), ['合成依据 self-text']);
  for (const id of ['self-image', 'self-voice']) {
    const original = state.messages.find(item => item.id === id)!;
    assert.ok(context.recentMessages.some((item: {text: string; kind: string; mediaStatus: string}) =>
      item.text === original.text && item.kind === original.kind && item.mediaStatus === 'reviewed'));
  }
});

test('pending checks use the latest twenty sequence values of this conversation, independent of storage order', async () => {
  const state = fixture(); state.settings.autoReplyMode = 'send';
  state.messages = [message('old-media', 1, {kind: 'voice', mediaStatus: 'pending'}),
    ...Array.from({length: 20}, (_, index) => message(`text-${index}`, index + 2)),
    message('other-contact', 999, {conversationId: 'b', kind: 'image', mediaStatus: 'pending'})].reverse();
  assert.deepEqual(pendingMediaMessages(state, 'a'), []); assert.doesNotThrow(() => assertReplyContextReady(state, 'a'));
  assert.equal((await generateDrafts(state, 'a')).length, 3);
  state.messages.find(item => item.id === 'text-0')!.mediaStatus = 'pending';
  assert.deepEqual(pendingMediaMessages(state, 'a').map(item => item.id), ['text-0']);
  assert.throws(() => assertReplyContextReady(state, 'a'), /1 条/);
});

test('sending mode also blocks pending system, unknown and self media messages', async () => {
  for (const kind of ['system', 'unknown', 'file'] as const) {
    const state = fixture(); state.settings.autoReplyMode = 'send';
    state.messages = [message('media', 1, {kind, role: kind === 'file' ? 'self' : 'system', mediaStatus: 'pending'}), message('text', 2)];
    await assert.rejects(generateDrafts(state, 'a'), /尚未查看/);
  }
});

test('automatic sending blocks pending media even with an injected generator that would ignore it', async () => {
  for (const kind of ['image', 'voice'] as const) {
    const state = fixture(); state.messages = [message('media', 1, {kind, mediaStatus: 'pending'}), message('text', 2)];
    state.settings.autoReplyMode = 'send'; state.conversations[0].channel = 'simulator';
    const store = new MemoryStore(state); let calls = 0, sends = 0;
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async (current, id) => {calls++; return fakeDrafts(current, id);}});
    engine.enqueue('a', 'text'); await engine.tick();
    assert.equal(calls, 0); assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'blocked');
    assert.equal(store.read().drafts.length, 0);
  }
});

test('automatic sending rechecks media made pending after enqueue and after generation starts', async () => {
  for (const stage of ['queued', 'generating'] as const) {
    const state = fixture(); state.messages = [message('media', 1, {kind: 'image', mediaStatus: 'reviewed'}), message('text', 2)];
    state.settings.autoReplyMode = 'send'; state.conversations[0].channel = 'simulator';
    const store = new MemoryStore(state); const gate = deferred<Draft[]>(); let calls = 0, sends = 0;
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => {calls++; return gate.promise;}});
    engine.enqueue('a', 'text'); const pending = stage === 'generating' ? engine.tick() : undefined;
    store.update(current => {current.messages[0].mediaStatus = 'pending';});
    gate.resolve(fakeDrafts(state, 'a')); await (pending ?? engine.tick());
    assert.equal(calls, stage === 'generating' ? 1 : 0); assert.equal(sends, 0);
    assert.equal(store.read().jobs[0].status, 'blocked'); assert.equal(store.read().drafts.length, 0);
  }
});

test('media, real conversation settings or message changes still invalidate in-flight generated replies', async () => {
  for (const change of ['review', 'kind', 'text', 'note', 'name', 'contact', 'account', 'collection-enabled', 'new-message'] as const) {
    const state = fixture(); state.messages = [message('media', 1, {kind: 'image', mediaStatus: 'reviewed'}), message('text', 2)];
    state.conversations[0].wechat = {enabled: true, initialized: true, cursor: '2', accountFingerprint: 'original-account',
      lastCheckedAt: null, status: 'ready', detail: ''};
    const store = new MemoryStore(state); const gate = deferred<Draft[]>(); let sends = 0;
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
    engine.enqueue('a', 'text'); const pending = engine.tick();
    store.update(current => {
      if (change === 'review') current.messages[1].mediaStatus = 'reviewed';
      if (change === 'kind') current.messages[0].kind = 'voice';
      if (change === 'text') current.messages[0].text = '用户补充的媒体说明';
      if (change === 'note') current.conversations[0].note = '新会话备注';
      if (change === 'name') current.conversations[0].name = '更正的联系人名';
      if (change === 'contact') current.conversations[0].externalId = 'different-contact';
      if (change === 'account') current.conversations[0].wechat!.accountFingerprint = 'different-account';
      if (change === 'collection-enabled') current.conversations[0].wechat!.enabled = false;
      if (change === 'new-message') current.messages.push(message('newer-text', 3));
    });
    assert.notEqual(replyContextFingerprint(state, 'a'), replyContextFingerprint(store.read(), 'a'));
    gate.resolve(fakeDrafts(state, 'a')); await pending;
    assert.equal(sends, 0); assert.equal(store.read().drafts.length, 0); assert.equal(store.read().jobs[0].status, 'cancelled');
  }
});

test('unchanged WeChat polls and display metadata do not invalidate a slow draft generation', async t => {
  const state = fixture();
  state.conversations[0].externalId = 'filehelper';
  state.conversations[0].wechat = {enabled: true, initialized: false, cursor: null, accountFingerprint: null,
    lastCheckedAt: null, status: 'paused', detail: ''};
  const store = new MemoryStore(state); let now = Date.parse('2026-10-10T05:00:00Z');
  const collector = new WechatCollector(store, {now: () => now, query: async () => ({accountFingerprint: 'synthetic-account', hasMore: false,
    records: [{id: 'source-100', sortSeq: '100', role: 'peer', kind: 'text', text: '合成文字消息', sentAt: null}]})});
  t.after(() => collector.stop());
  await collector.poll('a');
  const initial = store.read(); const latestId = initial.messages[0].id;
  const gate = deferred<Draft[]>(); let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
  engine.enqueue('a', latestId); const pending = engine.tick();
  assert.equal(store.read().jobs[0].status, 'generating');
  now += 15_000; await collector.poll('a');
  now += 15_000; await collector.poll('a');
  assert.notEqual(store.read().conversations[0].wechat!.lastCheckedAt, initial.conversations[0].wechat!.lastCheckedAt);
  assert.equal(replyContextFingerprint(initial, 'a'), replyContextFingerprint(store.read(), 'a'));
  store.update(current => {
    const conversation = current.conversations[0], binding = conversation.wechat!;
    conversation.updatedAt = new Date(now).toISOString(); conversation.createdAt = 'display-only-time';
    conversation.avatar = '新头像'; conversation.color = 'blue';
    binding.status = 'reading'; binding.detail = '运行进度'; binding.cursor = '101'; binding.initialized = false;
  });
  assert.equal(replyContextFingerprint(initial, 'a'), replyContextFingerprint(store.read(), 'a'));
  gate.resolve(fakeDrafts(initial, 'a')); await pending;
  assert.equal(store.read().jobs[0].status, 'drafted'); assert.equal(store.read().drafts.length, 1); assert.equal(sends, 0);
});

test('WeChat send mode is blocked for both demo and real providers before generation or sender calls', async () => {
  for (const provider of ['demo', 'codex'] as const) {
    const state = fixture(); state.settings.autoReplyMode = 'send'; state.settings.provider = provider; state.messages = [message('text', 1)];
    const store = new MemoryStore(state); let calls = 0, sends = 0;
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async (current, id) => {calls++; return fakeDrafts(current, id);}});
    engine.enqueue('a', 'text'); await engine.tick();
    assert.equal(calls, 0); assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'blocked');
    assert.match(store.read().jobs[0].detail, /只接收消息/);
  }
});

test('switching an in-flight send conversation to WeChat blocks the final send', async () => {
  const state = fixture(); state.settings.autoReplyMode = 'send'; state.conversations[0].channel = 'simulator'; state.messages = [message('text', 1)];
  const store = new MemoryStore(state); const gate = deferred<Draft[]>(); let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
  engine.enqueue('a', 'text'); const pending = engine.tick();
  store.update(current => {current.conversations[0].channel = 'wechat';}); gate.resolve(fakeDrafts(state, 'a')); await pending;
  assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'blocked');
});

test('WeChat draft mode accepts pending media and saves candidates without sender calls or self messages', async () => {
  const state = fixture(); state.messages = [message('media', 1, {kind: 'voice', mediaStatus: 'pending'}), message('text', 2)];
  const store = new MemoryStore(state); let sends = 0, uploads = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {onDrafts: async () => {uploads++;}});
  engine.enqueue('a', 'text'); await engine.tick();
  assert.equal(sends, 0); assert.equal(uploads, 1); assert.equal(store.read().jobs[0].status, 'drafted');
  assert.equal(store.read().drafts.length, 3); assert.equal(store.read().messages.length, 2);
  assert.ok(store.read().messages.every(item => item.role === 'peer'));
});
