import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '../shared/types.js';
import { AutoReplyEngine } from '../server/auto-reply.js';
import { Store } from '../server/store.js';
import { WechatCollector } from '../server/wechat-collector.js';
import type { WechatPage, WechatQuery, WechatRecord } from '../server/wechat-cli.js';

const NOW = Date.parse('2026-10-10T04:00:00Z');
const account = 'synthetic-account-fingerprint';
type Input = Parameters<WechatQuery>[0];
type Event = {cid: string; latest: string | null; live: boolean};
function conversation(overrides: Partial<NonNullable<Conversation['wechat']>> = {}): Conversation {
  return {id: 'wechat-test', name: '合成文件传输助手', avatar: '', color: '', note: '', autoReplyEnabled: true,
    channel: 'wechat', externalId: 'filehelper', createdAt: '', updatedAt: '',
    wechat: {enabled: false, initialized: false, cursor: null, accountFingerprint: null, lastCheckedAt: null,
      status: 'paused', detail: '', ...overrides}};
}
function record(sequence: string | number, overrides: Partial<WechatRecord> = {}): WechatRecord {
  const sortSeq = String(sequence);
  return {id: `id-${sortSeq}`, sortSeq, sentAt: '2026-10-10T03:00:00Z', role: 'peer', kind: 'text', text: `合成消息 ${sortSeq}`, ...overrides};
}
function page(records: WechatRecord[], hasMore = false, accountFingerprint = account): WechatPage {
  return {records, hasMore, accountFingerprint};
}
function setup(t: TestContext, query: WechatQuery, binding: Partial<NonNullable<Conversation['wechat']>> = {},
  onMessages?: (cid: string, latest: string | null, live: boolean) => void) {
  const store = new Store(':memory:'); const events: Event[] = [];
  store.update(state => {state.conversations.push(conversation(binding));});
  const collector = new WechatCollector(store, {query, now: () => NOW, onMessages: (cid, latest, live) => {
    events.push({cid, latest, live}); onMessages?.(cid, latest, live);
  }});
  t.after(() => {collector.stop(); store.close();});
  return {store, collector, events};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {resolve = res;});
  return {promise, resolve};
}

test('first poll reads the newest fifty as a non-live baseline without following older pages', async t => {
  const inputs: Input[] = [];
  const rows = Array.from({length: 50}, (_, index) => record(100 + index));
  const {store, collector, events} = setup(t, async input => {inputs.push(input); return page([...rows].reverse(), true);});
  const result = await collector.poll('wechat-test');
  assert.deepEqual(result, {added: 50, baseline: true});
  assert.deepEqual(inputs[0], {contact: 'filehelper', order: 'desc', limit: 50, offset: 0});
  const initial = store.read(); const binding = initial.conversations[0].wechat!;
  assert.equal(binding.cursor, '149'); assert.equal(binding.accountFingerprint, account); assert.equal(binding.initialized, true);
  assert.equal(binding.status, 'paused'); assert.equal(binding.lastCheckedAt, new Date(NOW).toISOString());
  assert.deepEqual(initial.messages.map(message => message.sourceSequence), rows.map(row => row.sortSeq));
  assert.equal(events.length, 1); assert.equal(events[0].live, false);
  assert.equal(events[0].latest, initial.messages.at(-1)!.id); assert.equal(initial.jobs.length, 0);
});

test('enabling and resuming only catch up; later new peer messages are live and repeated rows are idempotent', async t => {
  let rows = [record(100)];
  const {store, collector, events} = setup(t, async () => page(rows));
  await collector.poll('wechat-test');
  collector.setEnabled('wechat-test', true); rows = [record(100), record(101)];
  await collector.tick(); assert.equal(events.at(-1)!.live, false);
  rows.push(record(102)); await collector.tick();
  assert.equal(events.at(-1)!.live, true); assert.equal(store.read().messages.at(-1)!.externalId, 'id-102');
  const eventCount = events.length; await collector.tick();
  assert.equal(events.length, eventCount); assert.equal(store.read().messages.length, 3);
  collector.setEnabled('wechat-test', false); rows.push(record(103)); await collector.tick();
  assert.equal(store.read().messages.length, 3);
  collector.setEnabled('wechat-test', true); await collector.tick();
  assert.equal(events.at(-1)!.live, false); assert.equal(store.read().messages.length, 4);
  rows.push(record(104)); await collector.tick(); assert.equal(events.at(-1)!.live, true);
});

test('collector live self events cannot enqueue replies and new live peer messages only generate drafts', async t => {
  let rows = [record(100)]; let engine!: AutoReplyEngine; let sends = 0;
  const {store, collector} = setup(t, async () => page(rows), {enabled: true}, (cid, latest, live) => {
    engine.conversationChanged(cid);
    if (live && latest) engine.enqueue(cid, latest);
  });
  store.update(state => {state.settings.autoReplyEnabled = true; state.settings.autoReplyMode = 'draft';
    state.settings.replyDelaySeconds = 0; state.settings.cooldownSeconds = 0;});
  engine = new AutoReplyEngine(store, {send: async () => {sends++;}}, {now: () => NOW});
  await collector.tick(); assert.equal(store.read().jobs.length, 0);
  rows.push(record(101, {role: 'self'})); await collector.tick(); await engine.tick();
  assert.equal(store.read().jobs.length, 0); assert.equal(store.read().messages.length, 2);
  rows.push(record(102)); await collector.tick(); await engine.tick();
  assert.equal(store.read().jobs.length, 1); assert.equal(store.read().jobs[0].status, 'drafted');
  assert.equal(store.read().drafts.length, 3); assert.equal(sends, 0); assert.equal(store.read().messages.length, 3);
});

test('paginated catch-up preserves adjacent nineteen-digit identifiers and sequences exactly', async t => {
  const base = 9007199254740993000n; const inputs: Input[] = []; let first = true;
  const rows = Array.from({length: 402}, (_, index) => record((base + BigInt(index)).toString(), {
    id: (8007199254740993000n + BigInt(index)).toString(),
  }));
  const {store, collector, events} = setup(t, async input => {
    inputs.push(input);
    if (first) {first = false; return page([rows[0]]);}
    const offset = input.offset ?? 0;
    return page(rows.slice(offset, offset + 200), offset + 200 < rows.length);
  });
  await collector.poll('wechat-test'); collector.setEnabled('wechat-test', true);
  const result = await collector.poll('wechat-test');
  assert.deepEqual(result, {added: 401, baseline: false});
  assert.deepEqual(inputs.slice(1).map(input => input.offset), [0, 200, 400]);
  assert.ok(inputs.slice(1).every(input => input.after === (base - 1n).toString() && input.order === 'asc' && input.limit === 200));
  assert.equal(store.read().messages.length, 402); assert.equal(new Set(store.read().messages.map(message => message.externalId)).size, 402);
  assert.deepEqual(store.read().messages.map(message => message.sourceSequence), rows.map(row => row.sortSeq));
  assert.equal(store.read().conversations[0].wechat!.cursor, (base + 401n).toString());
  assert.equal(events.at(-1)!.live, false);
});

test('last-fifty overlap recovers equal-boundary and recent delayed rows without moving the high cursor backwards', async t => {
  let rows = Array.from({length: 60}, (_, index) => record(100 + index));
  const inputs: Input[] = [];
  const {store, collector, events} = setup(t, async input => {inputs.push(input); return page(rows);},
    {initialized: true, cursor: '99', accountFingerprint: account, enabled: true});
  await collector.poll('wechat-test');
  const originalLatest = store.read().messages.at(-1)!.id;
  rows = [record(110, {id: 'late-equal-floor', text: '合成迟到内容'}), record(130, {id: 'late-middle'}), record(159), record(159, {id: 'same-high'})];
  await collector.poll('wechat-test');
  assert.equal(inputs[1].after, '109');
  const state = store.read();
  assert.equal(state.messages.length, 63); assert.equal(state.conversations[0].wechat!.cursor, '159');
  for (const id of ['late-equal-floor', 'late-middle', 'same-high']) assert.ok(state.messages.some(message => message.externalId === id));
  assert.ok(state.messages.some(message => message.id === originalLatest));
  const eventCount = events.length; await collector.poll('wechat-test');
  assert.equal(store.read().messages.length, 63); assert.equal(events.length, eventCount);
});

test('late in-flight results after pause, deletion or collector stop never write messages or advance cursor', async t => {
  for (const action of ['pause', 'delete', 'stop'] as const) {
    const gate = deferred<WechatPage>(); let signal: AbortSignal | undefined;
    const {store, collector, events} = setup(t, async (_input, passedSignal) => {signal = passedSignal; return gate.promise;},
      {enabled: true, initialized: true, cursor: '100', accountFingerprint: account});
    const pending = collector.poll('wechat-test'); const rejected = assert.rejects(pending, /暂停|停止|绑定|改变/);
    if (action === 'pause') collector.setEnabled('wechat-test', false);
    if (action === 'delete') {collector.cancel('wechat-test'); store.update(state => {state.conversations = [];});}
    if (action === 'stop') collector.stop();
    assert.equal(signal?.aborted, true, action);
    gate.resolve(page([record(101)])); await rejected;
    assert.equal(store.read().messages.length, 0, action); assert.equal(events.length, 0, action);
    if (action !== 'delete') assert.equal(store.read().conversations[0].wechat!.cursor, '100', action);
  }
});

test('background polling rechecks later bindings after an earlier query awaits', async t => {
  for (const action of ['pause', 'delete'] as const) {
    const gate = deferred<WechatPage>(); const contacts: string[] = [];
    const {store, collector} = setup(t, async input => {
      contacts.push(input.contact);
      return input.contact === 'filehelper' ? gate.promise : page([record(200)]);
    }, {enabled: true});
    store.update(state => {state.conversations.push({...conversation({enabled: true}), id: 'wechat-second', externalId: 'synthetic-second'});});
    const pending = collector.tick();
    assert.deepEqual(contacts, ['filehelper']);
    if (action === 'pause') collector.setEnabled('wechat-second', false);
    else {collector.cancel('wechat-second'); store.update(state => {state.conversations = state.conversations.filter(c => c.id !== 'wechat-second');});}
    gate.resolve(page([record(100)]));
    await assert.doesNotReject(pending);
    assert.deepEqual(contacts, ['filehelper'], action);
    assert.equal(store.read().messages.filter(m => m.conversationId === 'wechat-second').length, 0, action);
    assert.equal(store.read().messages.filter(m => m.conversationId === 'wechat-test').length, 1, action);
  }
});

test('query failure after a successful page rolls back the entire batch and backs off background retry', async t => {
  let calls = 0;
  const {store, collector, events} = setup(t, async () => {
    if (++calls === 1) return page([record(101)], true);
    throw new Error('synthetic query failure');
  }, {enabled: true, initialized: true, cursor: '100', accountFingerprint: account});
  await assert.rejects(collector.poll('wechat-test'), /synthetic query failure/);
  const state = store.read(); assert.equal(state.messages.length, 0); assert.equal(state.conversations[0].wechat!.cursor, '100');
  assert.equal(state.conversations[0].wechat!.status, 'error'); assert.equal(events.length, 0);
  await collector.tick(); assert.equal(calls, 2, 'failed query is not immediately retried by background ticks');
});

test('the first successful read after a query failure catches up without generating replies', async t => {
  let rows = [record(100)], fail = false;
  const {store, collector, events} = setup(t, async () => {
    if (fail) throw new Error('synthetic interrupted query');
    return page(rows);
  }, {enabled: true});
  await collector.poll('wechat-test');
  rows.push(record(101)); await collector.poll('wechat-test'); assert.equal(events.at(-1)!.live, true);
  const eventCount = events.length; fail = true;
  await assert.rejects(collector.poll('wechat-test'), /synthetic interrupted query/);
  assert.equal(store.read().conversations[0].wechat!.cursor, '101'); assert.equal(events.length, eventCount);
  fail = false; rows.push(record(102), record(103)); await collector.poll('wechat-test');
  assert.equal(events.at(-1)!.live, false); assert.equal(store.read().messages.length, 4);
  assert.equal(store.read().conversations[0].wechat!.cursor, '103');
  rows.push(record(104)); await collector.poll('wechat-test');
  assert.equal(events.at(-1)!.live, true); assert.equal(store.read().messages.length, 5);
});

test('a provisional sequence ID upgrades to the stable server ID without a duplicate or new-message event', async t => {
  const provisional = record(101, {id: 'seq:101', role: 'self'});
  const stable = {...provisional, id: '9007199254740993001'};
  let rows = [provisional];
  const {store, collector, events} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test');
  const internalId = store.read().messages[0].id; const eventCount = events.length;
  rows = [stable]; assert.deepEqual(await collector.poll('wechat-test'), {added: 0, baseline: false});
  assert.equal(store.read().messages.length, 1); assert.equal(store.read().messages[0].id, internalId);
  assert.equal(store.read().messages[0].externalId, stable.id); assert.equal(events.length, eventCount);
  rows = [provisional, stable]; await collector.poll('wechat-test');
  assert.equal(store.read().messages.length, 1); assert.equal(store.read().messages[0].id, internalId);
  assert.equal(store.read().messages[0].externalId, stable.id); assert.equal(store.read().messages[0].sourceSequence, '101');
  assert.equal(store.read().conversations[0].wechat!.cursor, '101'); assert.equal(events.length, eventCount);
});

test('more than ten catch-up pages or an empty continuing page never commits partial records', async t => {
  for (const mode of ['over-limit', 'empty-page'] as const) {
    let calls = 0;
    const {store, collector, events} = setup(t, async () => {
      calls++;
      return page(mode === 'empty-page' ? [] : [record(100 + calls)], true);
    }, {enabled: true, initialized: true, cursor: '100', accountFingerprint: account});
    await assert.rejects(collector.poll('wechat-test'), /分页异常/);
    assert.equal(calls, mode === 'over-limit' ? 10 : 1);
    assert.equal(store.read().messages.length, 0); assert.equal(store.read().conversations[0].wechat!.cursor, '100');
    assert.equal(events.length, 0);
  }
});

test('account switches on any page disable collection and preserve the original account and cursor', async t => {
  for (const mismatchPage of [1, 2]) {
    let calls = 0;
    const {store, collector, events} = setup(t, async () => {
      calls++;
      return page([record(100 + calls)], calls < mismatchPage, calls === mismatchPage ? 'different-account' : account);
    }, {enabled: true, initialized: true, cursor: '100', accountFingerprint: account});
    await assert.rejects(collector.poll('wechat-test'), /账号已变化/);
    const state = store.read(); const binding = state.conversations[0].wechat!;
    assert.equal(state.messages.length, 0); assert.equal(binding.cursor, '100'); assert.equal(binding.accountFingerprint, account);
    assert.equal(binding.enabled, false); assert.equal(binding.status, 'error'); assert.match(binding.detail, /账号已变化/);
    assert.equal(events.length, 0); await collector.tick(); assert.equal(calls, mismatchPage);
  }
});

test('reviewed media survives identical rereads, but real source changes reset review and invalidate drafts', async t => {
  const media = record(100, {kind: 'image', text: '[图片，待人工查看]', mediaStatus: 'pending'});
  let rows = [media, record(101)];
  const {store, collector, events} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test');
  const mediaId = store.read().messages[0].id; const latestId = store.read().messages[1].id;
  store.update(state => {
    state.messages[0].mediaStatus = 'reviewed';
    state.drafts.push({id: 'synthetic-draft', conversationId: 'wechat-test', basedOnMessageId: latestId,
      text: '合成草稿', label: '测试', reason: '测试', provider: 'demo', createdAt: ''});
  });
  const eventCount = events.length; await collector.poll('wechat-test');
  assert.equal(store.read().messages.find(message => message.id === mediaId)!.mediaStatus, 'reviewed');
  assert.equal(store.read().drafts.length, 1); assert.equal(events.length, eventCount);
  rows = [{...media, kind: 'voice', text: '[语音，待人工查看]'}, record(101)];
  await collector.poll('wechat-test');
  const updated = store.read().messages.find(message => message.id === mediaId)!;
  assert.equal(updated.kind, 'voice'); assert.equal(updated.mediaStatus, 'pending'); assert.equal(updated.externalId, media.id);
  assert.equal(store.read().messages.length, 2); assert.equal(store.read().drafts.length, 0);
  assert.equal(events.length, eventCount + 1); assert.equal(events.at(-1)!.live, false);
});

test('concurrent polls share one query and empty baseline can later collect new text', async t => {
  const gate = deferred<WechatPage>(); let calls = 0;
  const {store, collector, events} = setup(t, async () => {calls++; return calls === 1 ? gate.promise : page([record(1)]);}, {enabled: true});
  const first = collector.poll('wechat-test'); const second = collector.poll('wechat-test'); assert.equal(first, second);
  gate.resolve(page([])); assert.deepEqual(await first, {added: 0, baseline: true});
  assert.equal(calls, 1); assert.equal(events.length, 0); assert.equal(store.read().conversations[0].wechat!.cursor, '0');
  await collector.poll('wechat-test');
  assert.equal(store.read().messages.length, 1); assert.equal(events.at(-1)!.live, true);
});

test('reopening the store pauses WeChat bindings while preserving account, cursor and messages', t => {
  const directory = mkdtempSync(join(tmpdir(), 'xiangzhi-wechat-restart-'));
  const path = join(directory, 'state.sqlite'); let store = new Store(path);
  t.after(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  store.update(state => {
    state.conversations.push(conversation({enabled: true, initialized: true, cursor: '9007199254740993001',
      accountFingerprint: account, status: 'reading'}));
    state.messages.push({id: 'retained-message', conversationId: 'wechat-test', role: 'peer', text: '合成历史',
      source: 'wechat', externalId: '9007199254740993001', sequence: 1, sourceSequence: '9007199254740993001',
      sentAt: null, aiAssisted: false, kind: 'text'});
  });
  store.close(); store = new Store(path);
  const binding = store.read().conversations[0].wechat!;
  assert.equal(binding.enabled, false); assert.equal(binding.status, 'paused');
  assert.equal(binding.initialized, true); assert.equal(binding.cursor, '9007199254740993001');
  assert.equal(binding.accountFingerprint, account); assert.equal(store.read().messages.length, 1);
});
