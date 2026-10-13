import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Draft, Message } from '../shared/types.js';
import { AutoReplyEngine, replyContextFingerprint } from '../server/auto-reply.js';
import { latestConversationMessage } from '../server/generation.js';
import { messageEvidenceHash } from '../server/contact-evidence.js';

function fixture(): AppState {
  return {version: 1, settings: {autoReplyEnabled: true, autoReplyMode: 'send', provider: 'demo', modelUrl: 'http://localhost:11434', modelName: '', apiKey: '',
    allowRemoteModel: false, replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20, quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00'},
    conversations: ['a', 'b'].map(id => ({id, name: id, avatar: '', color: '', note: '', autoReplyEnabled: true, channel: 'simulator',
      externalId: null, createdAt: '', updatedAt: ''})), messages: [], claims: [], drafts: [], jobs: [], activity: [], feedback: []};
}
class MemoryStore {
  constructor(private state: AppState = fixture()) {}
  read(): AppState { return structuredClone(this.state); }
  update(fn: (state: AppState) => void): void { const next = this.read(); fn(next); this.state = next; }
}
function add(store: MemoryStore, id: string, role: Message['role'] = 'peer', source: Message['source'] = 'manual', conversationId = 'a', text = '今天怎么样？') {
  store.update(state => state.messages.push({id, conversationId, role, source, text, sentAt: null,
    sequence: state.messages.length + 1, externalId: null, aiAssisted: false}));
}
async function generate(state: AppState, conversationId: string): Promise<Draft[]> {
  return [{id: `draft-${state.messages.length}`, conversationId, basedOnMessageId: latestConversationMessage(state, conversationId)!.id,
    text: '我听到了，你想聊聊吗？', label: '测试回复', reason: 'stub', createdAt: '', provider: state.settings.provider}];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {resolve = res;});
  return {promise, resolve};
}

function addRecipientContext(state: AppState, conversationId = 'a') {
  const conversation = state.conversations.find(item => item.id === conversationId)!;
  const peer = state.messages.find(item => item.conversationId === conversationId && item.role === 'peer')!;
  conversation.basisFacts = [{id: 'basis-1', category: 'current_status', content: '对方正在学习摄影', sourceNote: '手动输入', createdAt: '', updatedAt: ''}];
  conversation.processing = {memoryEnabled: true};
  conversation.memory = {summary: '未确认模型回顾', openTopics: ['下次摄影活动'], throughSequence: peer.sequence, sourceDigest: 'source-digest',
    provider: 'qwen', modelName: 'summary-model', updatedAt: '', entries: [{id: 'memory-1', kind: 'event', text: '用户审核的摄影话题',
      sourceMessageIds: [peer.id], sourceMessageHashes: {[peer.id]: messageEvidenceHash(peer)}, status: 'approved', createdAt: ''}]};
}

test('same-contact foundation, reviewed memory and memory switch changes invalidate an in-flight draft', async () => {
  for (const change of ['basis', 'approved-memory', 'summary', 'disable-memory', 'clear-memory', 'account'] as const) {
    const store = new MemoryStore(); add(store, 'm1');
    store.update(state => {state.settings.autoReplyMode = 'draft'; addRecipientContext(state); state.conversations[0].wechat = {
      enabled: true, initialized: true, cursor: null, accountFingerprint: 'account-before', lastCheckedAt: null, status: 'ready', detail: ''};});
    const gate = deferred<Draft[]>(); let sends = 0;
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
    engine.enqueue('a', 'm1'); const tick = engine.tick(); const oldDrafts = await generate(store.read(), 'a');
    store.update(state => {
      const conversation = state.conversations[0];
      if (change === 'basis') conversation.basisFacts![0].content = '对方最近学习烹饪';
      if (change === 'approved-memory') conversation.memory!.entries[0].text = '用户修订了摄影话题';
      if (change === 'summary') conversation.memory!.summary = '更新的未确认回顾';
      if (change === 'disable-memory') conversation.processing!.memoryEnabled = false;
      if (change === 'clear-memory') delete conversation.memory;
      if (change === 'account') {conversation.wechat!.accountFingerprint = 'account-after'; delete conversation.memory;}
    });
    gate.resolve(oldDrafts); await tick;
    assert.equal(sends, 0, change); assert.equal(store.read().drafts.length, 0, change);
    assert.equal(store.read().jobs[0].status, 'cancelled', change);
  }
});

test('other contact context and unused analysis estimates do not invalidate a reply', async () => {
  const store = new MemoryStore(); add(store, 'b-message', 'peer', 'manual', 'b'); add(store, 'a-message');
  store.update(state => {state.settings.autoReplyMode = 'draft'; addRecipientContext(state, 'a'); addRecipientContext(state, 'b');});
  const before = replyContextFingerprint(store.read(), 'a');
  const gate = deferred<Draft[]>(); let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
  engine.enqueue('a', 'a-message'); const tick = engine.tick(); const drafts = await generate(store.read(), 'a');
  store.update(state => {
    const other = state.conversations[1]; other.basisFacts![0].content = '其他联系人的新爱好';
    other.memory!.summary = '其他联系人的新摘要'; other.memory!.entries[0].text = '其他联系人的新记忆';
    Object.assign(state.conversations[0].processing!, {intentEnabled: true, affinityEnabled: true, autoAnalyzeMessages: true,
      autoCompressMemory: true, analysisModel: {id: 'new-analysis-model', provider: 'compatible', modelName: 'analysis-v2'},
      memoryModel: {id: 'new-memory-model', provider: 'compatible', modelName: 'memory-v2'}});
    state.settings.analysis = {provider: 'compatible', modelUrl: 'http://127.0.0.1:1234/v1', modelName: 'analysis-v2', useReplyApiKey: false, allowRemoteModel: false};
    state.settings.memory = {provider: 'compatible', modelUrl: 'http://127.0.0.1:1234/v1', modelName: 'memory-v2', useReplyApiKey: false, allowRemoteModel: false};
    state.claims.push({id: 'other-claim', category: 'fact', statement: '另一会话范围的本人声明', status: 'approved', scope: 'b',
      evidenceIds: [], createdAt: ''});
    state.messages.find(message => message.id === 'a-message')!.insights = {conversationId: 'a', messageId: 'a-message',
      intents: [{label: '关心', percentage: 20}, {label: '质问', percentage: 80}], affinity: {score: 60, confidence: 30, evidence: []},
      uncertainty: '不能验证真实心理', provider: 'qwen', modelName: 'analysis-model', analyzedAt: ''};
  });
  assert.equal(replyContextFingerprint(store.read(), 'a'), before);
  gate.resolve(drafts); await tick;
  assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'drafted'); assert.equal(store.read().drafts.length, 1);
});

test('fingerprints omit disabled memory changes and invalidate approved entries when old evidence changes beyond recent messages', () => {
  const state = fixture(); state.settings.autoReplyMode = 'draft';
  state.messages.push({id: 'old-source', conversationId: 'a', role: 'peer', source: 'manual', text: '最初的事实', sentAt: null,
    sequence: 0, externalId: null, aiAssisted: false});
  for (let i = 1; i <= 25; i++) state.messages.push({id: `later-${i}`, conversationId: 'a', role: 'peer', source: 'manual',
    text: `后来的消息${i}`, sentAt: null, sequence: i, externalId: null, aiAssisted: false});
  addRecipientContext(state);
  const enabled = replyContextFingerprint(state, 'a'); state.messages[0].text = '修正的旧事实';
  assert.notEqual(replyContextFingerprint(state, 'a'), enabled, 'changed old evidence removes its approved memory from the projection');
  state.conversations[0].processing!.memoryEnabled = false; const disabled = replyContextFingerprint(state, 'a');
  state.conversations[0].memory!.summary = '停用状态下新的摘要'; state.conversations[0].memory!.entries[0].text = '停用状态下新的记忆';
  assert.equal(replyContextFingerprint(state, 'a'), disabled);
});

test('first-time analysis configuration does not change an otherwise unconfigured contact reply context', () => {
  const state = fixture();
  const before = replyContextFingerprint(state, 'a');
  state.conversations[0].processing = {intentEnabled: true, affinityEnabled: true,
    analysisModel: {id: 'analysis-only', provider: 'compatible', modelName: 'analysis-model'}};
  assert.equal(replyContextFingerprint(state, 'a'), before);
});

test('automatic sending checks the contact model list rather than another contact or global defaults', async () => {
  const store=new MemoryStore();let sends=0,generates=0;
  store.update(s=>{
    s.settings.replyModels=[{id:'global-a',provider:'demo',modelName:''},{id:'global-b',provider:'demo',modelName:''}];
    s.conversations[0].processing={replyModels:[]};
    s.conversations[1].processing={replyModels:[{id:'b-a',provider:'demo',modelName:''},{id:'b-b',provider:'demo',modelName:''}]};
  });
  add(store,'a-message','peer','manual','a');add(store,'b-message','peer','manual','b');
  const engine=new AutoReplyEngine(store,{send:async()=>{sends++;}},{generate:async(s,cid)=>{generates++;assert.deepEqual(s.settings.replyModels,[]);return generate(s,cid);}});
  engine.enqueue('a','a-message');engine.enqueue('b','b-message');await engine.tick();
  assert.equal(sends,1);assert.equal(generates,1);
  assert.equal(store.read().jobs.find(j=>j.conversationId==='a')?.status,'sent');
  assert.equal(store.read().jobs.find(j=>j.conversationId==='b')?.status,'blocked');
});

test('global switch, contact whitelist and historical imports never enter sending', async () => {
  for (const mode of ['global', 'contact', 'import', 'self'] as const) {
    const store = new MemoryStore(); let sends = 0;
    if (mode === 'global') store.update(s => {s.settings.autoReplyEnabled = false;});
    if (mode === 'contact') store.update(s => {s.conversations[0].autoReplyEnabled = false;});
    add(store, 'm1', mode === 'self' ? 'self' : 'peer', mode === 'import' ? 'import' : 'manual');
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate});
    engine.enqueue('a', 'm1'); await engine.tick();
    assert.equal(sends, 0, mode); assert.equal(store.read().jobs.length, 0, mode);
  }
});

test('a successful simulator send is persisted once, and duplicate delivery/ticks are idempotent', async () => {
  const store = new MemoryStore(); add(store, 'm1'); const sent: string[] = [];
  const engine = new AutoReplyEngine(store, {send: async (_conversation, _text, key) => {sent.push(key);}}, {generate});
  engine.enqueue('a', 'm1'); engine.enqueue('a', 'm1');
  await Promise.all([engine.tick(), engine.tick(), engine.tick()]);
  engine.enqueue('a', 'm1'); await engine.tick();
  const state = store.read();
  assert.equal(sent.length, 1); assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].status, 'sent');
  assert.match(state.jobs[0].detail, /没有向微信发送/);
  assert.ok(sent[0].startsWith('auto:'));
  assert.equal(state.messages.filter(m => m.source === 'auto' && m.aiAssisted).length, 1);
  assert.equal(state.messages.at(-1)!.role, 'self');
});

test('a bridge echo arriving before acknowledgement is reconciled without a duplicate self message', async () => {
  const store = new MemoryStore(); add(store, 'm1');
  store.update(state => {state.settings.provider = 'compatible'; state.conversations[0].channel = 'webhook';});
  const started = deferred<void>(); const acknowledgement = deferred<string>();
  const engine = new AutoReplyEngine(store, {send: async () => {started.resolve(); return acknowledgement.promise;}}, {generate});
  engine.enqueue('a', 'm1'); const pending = engine.tick(); await started.promise;
  add(store, 'echo', 'self', 'bridge', 'a', '我听到了，你想聊聊吗？');
  store.update(state => {state.messages.at(-1)!.externalId = 'platform-123';});
  engine.conversationChanged('a');
  acknowledgement.resolve('platform-123'); await pending;
  const state = store.read();
  assert.equal(state.jobs[0].status, 'sent'); assert.match(state.jobs[0].detail, /真实桥接接口已确认/);
  const selfMessages = state.messages.filter(message => message.role === 'self' && message.conversationId === 'a');
  assert.equal(selfMessages.length, 1); assert.equal(selfMessages[0].id, 'echo');
  assert.equal(selfMessages[0].externalId, 'platform-123'); assert.equal(selfMessages[0].aiAssisted, true);
  assert.equal(selfMessages[0].source, 'auto');
});

test('acknowledgement stores the platform receipt for late-echo deduplication and never answers its own echo', async () => {
  const store = new MemoryStore(); add(store, 'm1'); let sends = 0;
  store.update(state => {state.settings.provider = 'compatible'; state.conversations[0].channel = 'webhook';});
  const engine = new AutoReplyEngine(store, {send: async () => {sends++; return 'platform-456';}}, {generate});
  engine.enqueue('a', 'm1'); await engine.tick();
  const acknowledgementMessage = store.read().messages.find(message => message.externalId === 'platform-456')!;
  assert.ok(acknowledgementMessage); assert.equal(acknowledgementMessage.role, 'self');
  engine.enqueue('a', acknowledgementMessage.id); engine.enqueue('a', 'm1'); await engine.tick();
  assert.equal(sends, 1); assert.equal(store.read().jobs.length, 1);
  assert.equal(store.read().messages.filter(message => message.externalId === 'platform-456').length, 1);
});

test('receipt deduplication is restricted to self messages in the same conversation', async () => {
  const store = new MemoryStore(); add(store, 'other-self', 'self', 'bridge', 'b');
  store.update(state => {state.messages.at(-1)!.externalId = 'shared-receipt';});
  add(store, 'm1');
  store.update(state => {state.messages.at(-1)!.externalId = 'shared-receipt';});
  const engine = new AutoReplyEngine(store, {send: async () => 'shared-receipt'}, {generate});
  engine.enqueue('a', 'm1'); await engine.tick();
  const self = store.read().messages.filter(message => message.conversationId === 'a' && message.role === 'self');
  assert.equal(self.length, 1); assert.equal(self[0].externalId, 'shared-receipt'); assert.equal(self[0].source, 'auto');
});

test('pause immediately aborts an in-flight generation and prevents sending even when a model ignores abort', async () => {
  const store = new MemoryStore(); add(store, 'm1'); const gate = deferred<Draft[]>(); let signal: AbortSignal | undefined; let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async (_state, _id, _intent, passedSignal) => {signal = passedSignal; return gate.promise;}});
  engine.enqueue('a', 'm1'); const tick = engine.tick();
  assert.equal(store.read().jobs[0].status, 'generating');
  engine.pause(); assert.equal(signal?.aborted, true);
  gate.resolve(await generate(store.read(), 'a')); await tick;
  assert.equal(sends, 0); assert.equal(store.read().settings.autoReplyEnabled, false); assert.equal(store.read().jobs[0].status, 'cancelled');
});

test('new peer messages cancel stale work and only the newest message is answered', async () => {
  const store = new MemoryStore(); add(store, 'm1'); const gate = deferred<Draft[]>(); const sent: string[] = []; let calls = 0;
  const engine = new AutoReplyEngine(store, {send: async (_conversation, text) => {sent.push(text);}}, {generate: async (state, id) => {
    calls++; if (calls === 1) return gate.promise;
    const result = await generate(state, id); result[0].text = '回复最新消息'; return result;
  }});
  engine.enqueue('a', 'm1'); const tick = engine.tick(); const oldDrafts = await generate(store.read(), 'a');
  add(store, 'm2'); engine.enqueue('a', 'm2'); engine.enqueue('a', 'm1');
  gate.resolve(oldDrafts); await tick;
  assert.deepEqual(sent, ['回复最新消息']);
  assert.equal(store.read().jobs.find(j => j.messageId === 'm1')!.status, 'cancelled');
  assert.equal(store.read().jobs.find(j => j.messageId === 'm2')!.status, 'sent');
});

test('a manual self reply cancels a queued job; sending rechecks contact settings even without explicit notification', async () => {
  const store = new MemoryStore(); add(store, 'm1'); let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate});
  engine.enqueue('a', 'm1'); add(store, 'self', 'self'); engine.conversationChanged('a'); await engine.tick();
  assert.equal(store.read().jobs[0].status, 'cancelled'); assert.equal(sends, 0);
  const gate = deferred<Draft[]>(); add(store, 'm2');
  const other = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
  other.enqueue('a', 'm2'); const pending = other.tick(); const drafts = await generate(store.read(), 'a');
  store.update(s => {s.conversations[0].autoReplyEnabled = false;}); gate.resolve(drafts); await pending;
  assert.equal(sends, 0); assert.equal(store.read().jobs.at(-1)!.status, 'cancelled');
});

test('failed or uncertain sends are never automatically retried', async () => {
  const store = new MemoryStore(); add(store, 'm1'); let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++; throw new Error('network failure after possible delivery');}}, {generate});
  engine.enqueue('a', 'm1'); await engine.tick();
  engine.enqueue('a', 'm1'); await engine.tick(); await engine.tick();
  assert.equal(sends, 1); assert.equal(store.read().jobs[0].status, 'failed'); assert.match(store.read().jobs[0].detail, /不会自动重试/);
  assert.equal(store.read().messages.filter(message => message.source === 'auto').length, 0);
});

test('pausing while a send awaits acknowledgement preserves confirmed or uncertain outcomes without retrying', async () => {
  for (const confirmed of [true, false]) {
    const store = new MemoryStore(); add(store, 'm1'); const started = deferred<void>(); const finishSend = deferred<void>();
    let sendSignal: AbortSignal | undefined; let sends = 0;
    const engine = new AutoReplyEngine(store, {send: async (_conversation, _text, _key, signal) => {
      sends++; sendSignal = signal; started.resolve(); await finishSend.promise;
      if (!confirmed) throw new Error('aborted with unknown delivery status');
    }}, {generate});
    engine.enqueue('a', 'm1'); const pending = engine.tick(); await started.promise;
    engine.pause(); assert.equal(sendSignal?.aborted, true); finishSend.resolve(); await pending;
    const state = store.read();
    assert.equal(state.jobs[0].status, confirmed ? 'sent' : 'failed');
    assert.equal(state.messages.filter(message => message.source === 'auto').length, confirmed ? 1 : 0);
    store.update(s => {s.settings.autoReplyEnabled = true;}); engine.enqueue('a', 'm1'); await engine.tick();
    assert.equal(sends, 1);
  }
});

test('delay, Shanghai quiet hours, cooldown and daily limit postpone jobs and recheck after waiting', async () => {
  const store = new MemoryStore(); let now = Date.parse('2026-10-02T14:59:58Z'); let sends = 0;
  store.update(s => {s.settings.replyDelaySeconds = 5; s.settings.quietHoursEnabled = true; s.settings.cooldownSeconds = 60; s.settings.dailyLimit = 1;});
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate, now: () => now});
  add(store, 'm1'); engine.enqueue('a', 'm1'); await engine.tick(); assert.equal(sends, 0);
  now += 6000; await engine.tick(); assert.equal(sends, 0);
  assert.equal(store.read().jobs[0].dueAt, '2026-10-03T00:00:00.000Z');
  now = Date.parse('2026-10-03T00:00:00Z'); await engine.tick(); assert.equal(sends, 1);
  add(store, 'm2'); engine.enqueue('a', 'm2'); now += 6000; await engine.tick(); assert.equal(sends, 1);
  assert.equal(store.read().jobs.at(-1)!.dueAt, '2026-10-03T16:00:00.000Z');
  now = Date.parse('2026-10-03T16:00:00Z'); await engine.tick(); assert.equal(sends, 1);
  assert.equal(store.read().jobs.at(-1)!.dueAt, '2026-10-04T00:00:00.000Z');
  now = Date.parse('2026-10-04T00:00:00Z'); await engine.tick(); assert.equal(sends, 2);
});

test('cooldown is per-contact and cannot leak or block another contact', async () => {
  const store = new MemoryStore(); let now = Date.parse('2026-10-02T04:00:00Z'); const sent: string[] = [];
  store.update(s => {s.settings.cooldownSeconds = 60;});
  const engine = new AutoReplyEngine(store, {send: async conversation => {sent.push(conversation.id);}}, {generate, now: () => now});
  add(store, 'a1'); engine.enqueue('a', 'a1'); await engine.tick();
  add(store, 'a2'); engine.enqueue('a', 'a2'); add(store, 'b1', 'peer', 'manual', 'b'); engine.enqueue('b', 'b1'); await engine.tick();
  assert.deepEqual(sent, ['a', 'b']);
  now += 60_000; await engine.tick(); assert.deepEqual(sent, ['a', 'b', 'a']);
});

test('model configuration changes during generation cancel the old result', async () => {
  const store = new MemoryStore(); add(store, 'm1'); const gate = deferred<Draft[]>(); let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
  engine.enqueue('a', 'm1'); const pending = engine.tick(); const drafts = await generate(store.read(), 'a');
  store.update(s => {s.settings.modelName = 'changed-model';}); gate.resolve(drafts); await pending;
  assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'cancelled');
});

test('explicit stop-contact requests and demo-to-webhook jobs are blocked without generating or sending', async () => {
  for (const mode of ['stop', 'webhook'] as const) {
    const store = new MemoryStore(); let calls = 0;
    if (mode === 'webhook') store.update(s => {s.conversations[0].channel = 'webhook';});
    add(store, 'm1', 'peer', 'bridge', 'a', mode === 'stop' ? '请不要再给我发消息' : '你好');
    const engine = new AutoReplyEngine(store, {send: async () => {calls++;}}, {generate: async (state, id) => {calls++; return generate(state, id);}});
    engine.enqueue('a', 'm1'); await engine.tick(); assert.equal(calls, 0); assert.equal(store.read().jobs[0].status, 'blocked');
  }
});

test('wrong-conversation model output is rejected and restart does not retry uncertain work', async () => {
  const store = new MemoryStore(); add(store, 'm1'); let sends = 0;
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async (state, id) => {
    const drafts = await generate(state, id); drafts[0].conversationId = 'b'; return drafts;
  }});
  engine.enqueue('a', 'm1'); await engine.tick();
  assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'failed');
  store.update(s => {s.jobs[0].status = 'generating';});
  const restarted = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate}); await restarted.tick();
  assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'failed'); assert.match(store.read().jobs[0].detail, /上次运行中断/);
});

test('draft mode generates once, stores candidates and never invokes a sender or writes a self message', async () => {
  const store = new MemoryStore(); let calls = 0; let sends = 0;
  store.update(s => {s.settings.autoReplyMode = 'draft';}); add(store, 'm1');
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async (state, cid) => {calls++; return generate(state, cid);}});
  engine.enqueue('a', 'm1'); await engine.tick(); engine.enqueue('a', 'm1'); await engine.tick();
  const state = store.read();
  assert.equal(calls, 1); assert.equal(sends, 0); assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].role, 'peer'); assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].basedOnMessageId, 'm1'); assert.equal(state.jobs[0].mode, 'draft');
  assert.equal(state.jobs[0].status, 'drafted'); assert.ok(state.jobs[0].finishedAt);
});

test('switching mode during generation cancels old work instead of promoting a draft into a send', async () => {
  for (const originalMode of ['draft', 'send'] as const) {
    const store = new MemoryStore(); const gate = deferred<Draft[]>(); let sends = 0;
    store.update(s => {s.settings.autoReplyMode = originalMode;}); add(store, 'm1');
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
    engine.enqueue('a', 'm1'); const pending = engine.tick(); const oldDrafts = await generate(store.read(), 'a');
    store.update(s => {s.settings.autoReplyMode = originalMode === 'draft' ? 'send' : 'draft';});
    gate.resolve(oldDrafts); await pending;
    assert.equal(sends, 0, originalMode); assert.equal(store.read().drafts.length, 0, originalMode);
    assert.equal(store.read().jobs[0].status, 'cancelled', originalMode);
  }
});

test('profile or same-contact feedback changes during generation invalidate the old result', async () => {
  for (const changedContext of ['profile', 'feedback'] as const) {
    const store = new MemoryStore(); const gate = deferred<Draft[]>(); let sends = 0;
    store.update(s => {s.settings.autoReplyMode = 'draft';}); add(store, 'm1');
    const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async () => gate.promise});
    engine.enqueue('a', 'm1'); const pending = engine.tick(); const oldDrafts = await generate(store.read(), 'a');
    store.update(s => {
      if (changedContext === 'profile') s.learnedProfile = {version:'test-v2',digest:'changed-profile',title:'合成测试档案',loadedAt:'',rules:[],examples:[],limitations:[]};
      else s.feedback!.push({id:'feedback-1',requestId:'review-1',conversationId:'a',draftId:'previous-draft',basedOnMessageId:'m1',originalText:'原始候选',revisedText:'人工修改',kind:'edited',reason:'更自然',source:'review',createdAt:'',profileVersion:null});
    });
    gate.resolve(oldDrafts); await pending;
    assert.equal(sends, 0, changedContext); assert.equal(store.read().drafts.length, 0, changedContext);
    assert.equal(store.read().jobs[0].status, 'cancelled', changedContext);
  }
});

test('drafts ignore sending quiet hours, cooldown, daily quota and stop-contact keyword gates', async () => {
  const store = new MemoryStore(); const now = Date.parse('2026-10-02T15:30:00Z'); let calls = 0; let sends = 0;
  store.update(s => {
    s.settings.autoReplyMode = 'draft'; s.settings.cooldownSeconds = 3600; s.settings.dailyLimit = 1; s.settings.quietHoursEnabled = true;
    s.jobs.push({id: 'previous-send', conversationId: 'a', messageId: 'old-message', mode: 'send', status: 'sent',
      createdAt: new Date(now).toISOString(), dueAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), detail: '', replyText: '已发送'});
  });
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate: async (state, cid) => {calls++; return generate(state, cid);}, now: () => now});
  for (const [id, text] of [['m1', '今天怎么样'], ['m2', '刚才忘了说'], ['m3', '不要再联系我']]) {
    add(store, id, 'peer', 'manual', 'a', text); engine.enqueue('a', id); await engine.tick();
    assert.equal(store.read().jobs.at(-1)!.status, 'drafted');
  }
  engine.enqueue('a', 'm3'); await engine.tick(); assert.equal(calls, 3, 'duplicate deliveries remain idempotent');
  assert.equal(sends, 0); assert.equal(store.read().jobs.filter(j => j.status === 'drafted').length, 3);
});

test('creating drafts does not consume the later sending cooldown or daily sending allowance', async () => {
  const store = new MemoryStore(); const now = Date.parse('2026-10-02T04:00:00Z'); let sends = 0;
  store.update(s => {s.settings.autoReplyMode = 'draft'; s.settings.cooldownSeconds = 3600; s.settings.dailyLimit = 1;});
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate, now: () => now});
  add(store, 'draft-trigger'); engine.enqueue('a', 'draft-trigger'); await engine.tick();
  assert.equal(store.read().jobs[0].status, 'drafted');
  store.update(s => {s.settings.autoReplyMode = 'send';});
  add(store, 'send-trigger'); engine.enqueue('a', 'send-trigger'); await engine.tick();
  assert.equal(sends, 1); assert.equal(store.read().jobs.at(-1)!.status, 'sent');
  add(store, 'next-send'); engine.enqueue('a', 'next-send'); await engine.tick();
  assert.equal(sends, 1); assert.equal(store.read().jobs.at(-1)!.status, 'queued', 'actual sends still consume sending allowance');
});

test('webhook conversations may receive a local rule demonstration draft without any external send', async () => {
  const store = new MemoryStore(); let sends = 0;
  store.update(s => {s.settings.autoReplyMode = 'draft'; s.conversations[0].channel = 'webhook';});
  add(store, 'm1', 'peer', 'bridge');
  const engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {generate});
  engine.enqueue('a', 'm1'); await engine.tick();
  assert.equal(sends, 0); assert.equal(store.read().jobs[0].status, 'drafted');
  assert.equal(store.read().drafts[0].provider, 'demo');
});
