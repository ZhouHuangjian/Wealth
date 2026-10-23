import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '../shared/types.js';
import { AutoReplyEngine } from '../server/auto-reply.js';
import { Store } from '../server/store.js';
import { WechatCollector } from '../server/wechat-collector.js';
import { insightsInputDigest } from '../server/contact-insights.js';
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
function paged(rows:WechatRecord[],input:Input):WechatPage{
  let selected=rows.filter(row=>input.after===undefined||BigInt(row.sortSeq)>BigInt(input.after))
    .sort((a,b)=>BigInt(a.sortSeq)<BigInt(b.sortSeq)?-1:BigInt(a.sortSeq)>BigInt(b.sortSeq)?1:a.id.localeCompare(b.id));
  if(input.order==='desc')selected=selected.reverse();const offset=input.offset??0;
  return page(selected.slice(offset,offset+input.limit),offset+input.limit<selected.length);
}
function setup(t: TestContext, query: WechatQuery, binding: Partial<NonNullable<Conversation['wechat']>> = {},
  onMessages?: (cid: string, latest: string | null, live: boolean) => void) {
  const store = new Store(':memory:'); const events: Event[] = [], invalidations: string[] = [];
  store.update(state => {state.conversations.push(conversation(binding));});
  const collector = new WechatCollector(store, {query, now: () => NOW, onContextInvalidated: cid => {invalidations.push(cid);}, onMessages: (cid, latest, live) => {
    events.push({cid, latest, live}); onMessages?.(cid, latest, live);
  }});
  t.after(() => {collector.stop(); store.close();});
  return {store, collector, events, invalidations};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {resolve = res;});
  return {promise, resolve};
}

function saveSyntheticInsights(store: Store, cid: string) {
  store.update(state => {
    const conversation = state.conversations.find(item => item.id === cid)!;
    conversation.processing = {...conversation.processing, intentEnabled: true};
    state.settings.analysis = {provider: 'compatible', modelUrl: 'http://127.0.0.1:11435/v1', modelName: 'analysis-test',
      useReplyApiKey: false, allowRemoteModel: false};
    for (const message of state.messages.filter(item => item.conversationId === cid)) message.insights = {
      conversationId: cid, messageId: message.id, intents: [{label: '询问', percentage: 100}], affinity: null,
      uncertainty: '纯合成分析', provider: 'compatible', modelName: 'analysis-test', analyzedAt: '',
      inputDigest: insightsInputDigest(state, cid, message.id),
    };
  });
}

test('source changes clear their analysis and stale later analysis while preserving earlier and other-contact results', async t => {
  let rows = [record(100), record(101), record(102)];
  const {store, collector, invalidations} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test');
  store.update(state => {
    state.conversations.push({...conversation({initialized: true, enabled: false, accountFingerprint: account}), id: 'other-contact', externalId: 'other-peer'});
    state.messages.push({id: 'other-message', conversationId: 'other-contact', role: 'peer', text: '另一人的合成消息', source: 'manual',
      sentAt: null, sequence: 1, externalId: null, aiAssisted: false});
  });
  saveSyntheticInsights(store, 'wechat-test'); saveSyntheticInsights(store, 'other-contact');
  const before = store.read(), firstId = before.messages.find(message => message.externalId === 'id-100')!.id;
  const changedId = before.messages.find(message => message.externalId === 'id-101')!.id;
  const laterId = before.messages.find(message => message.externalId === 'id-102')!.id;
  const firstAnalysis = before.messages.find(message => message.id === firstId)!.insights;
  const otherAnalysis = before.messages.find(message => message.id === 'other-message')!.insights;
  rows = [record(100), record(101, {text: '修正的合成消息'}), record(102)];
  await collector.poll('wechat-test'); const after = store.read();
  assert.deepEqual(after.messages.find(message => message.id === firstId)!.insights, firstAnalysis);
  assert.equal(after.messages.find(message => message.id === changedId)!.insights, undefined);
  assert.equal(after.messages.find(message => message.id === laterId)!.insights, undefined);
  assert.deepEqual(after.messages.find(message => message.id === 'other-message')!.insights, otherAnalysis);
  assert.deepEqual(invalidations, ['wechat-test']);
});

test('identical rereads, identifier upgrades and new later messages retain historical analysis with unchanged digests', async t => {
  const first = record(100, {id: 'seq:100'}); let rows = [first, record(101)];
  const {store, collector, invalidations} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test'); saveSyntheticInsights(store, 'wechat-test');
  const saved = new Map(store.read().messages.map(message => [message.id, message.insights]));
  await collector.poll('wechat-test');
  rows = [{...first, id: 'stable-100'}, record(101), record(102)]; await collector.poll('wechat-test');
  const after = store.read();
  for (const [id, insight] of saved) {
    const current = after.messages.find(message => message.id === id)!;
    assert.deepEqual(current.insights, insight); assert.equal(current.insights!.inputDigest, insightsInputDigest(after, 'wechat-test', id));
  }
  assert.equal(after.messages.at(-1)!.insights, undefined); assert.deepEqual(invalidations, []);
});

test('late earlier records invalidate only cached sentences whose preceding context changes', async t => {
  let rows = [record(100), record(102)];
  const {store, collector, invalidations} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test'); saveSyntheticInsights(store, 'wechat-test');
  const before = store.read(), first = before.messages.find(message => message.externalId === 'id-100')!;
  const later = before.messages.find(message => message.externalId === 'id-102')!;
  rows = [record(100), record(101), record(102)]; await collector.poll('wechat-test'); const after = store.read();
  assert.deepEqual(after.messages.find(message => message.id === first.id)!.insights, first.insights);
  assert.equal(after.messages.find(message => message.id === later.id)!.insights, undefined);
  assert.deepEqual(invalidations, ['wechat-test']);
});

test('an account switch signals context invalidation before any foreign records can be committed', async t => {
  let response = page([record(100)]);
  const {store, collector, events, invalidations} = setup(t, async () => response, {enabled: true});
  await collector.poll('wechat-test'); saveSyntheticInsights(store, 'wechat-test');
  const before = store.read(), eventCount = events.length;
  response = page([record(101, {text: '另一个账号的数据不得提交'})], false, 'foreign-account');
  await assert.rejects(collector.poll('wechat-test'), /账号已变化/);
  const after = store.read();
  assert.deepEqual(after.messages, before.messages); assert.equal(after.conversations[0].wechat!.accountFingerprint, account);
  assert.equal(after.conversations[0].wechat!.enabled, false); assert.equal(events.length, eventCount);
  assert.deepEqual(invalidations, ['wechat-test']);
});

test('first poll previews current messages and reads all 301 historical rows rather than stopping at a recent-message limit', async t => {
  const inputs: Input[] = [];
  const rows = Array.from({length: 301}, (_, index) => record(100 + index));
  const {store, collector, events} = setup(t, async input => {inputs.push(input); return paged(rows,input);});
  const result = await collector.poll('wechat-test');
  assert.deepEqual(result, {added: 301, baseline: true});
  assert.deepEqual(inputs[0], {contact: 'filehelper', order: 'desc', limit: 200, offset: 0});
  assert.equal(inputs.filter(input=>input.order==='asc').length,2);
  const initial = store.read(); const binding = initial.conversations[0].wechat!;
  assert.equal(binding.cursor, '400'); assert.equal(binding.accountFingerprint, account); assert.equal(binding.initialized, true);
  assert.equal(binding.history!.status,'complete');assert.equal(binding.history!.scanned,301);assert.equal(binding.history!.added,301);
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
    return paged(rows,input);
  });
  await collector.poll('wechat-test'); collector.setEnabled('wechat-test', true);
  const result = await collector.poll('wechat-test');
  assert.deepEqual(result, {added: 401, baseline: false});
  assert.deepEqual(inputs.slice(1).map(input => input.offset), [0, 1, 1]);
  assert.deepEqual(inputs.slice(1).map(input => input.after), [(base-1n).toString(),(base+198n).toString(),(base+398n).toString()]);
  assert.ok(inputs.slice(1).every(input => input.order === 'asc' && input.limit === 200));
  assert.equal(store.read().messages.length, 402); assert.equal(new Set(store.read().messages.map(message => message.externalId)).size, 402);
  assert.deepEqual(store.read().messages.map(message => message.sourceSequence), rows.map(row => row.sortSeq));
  assert.equal(store.read().conversations[0].wechat!.cursor, (base + 401n).toString());
  assert.equal(events.at(-1)!.live, false);
});

test('last-fifty overlap recovers equal-boundary and recent delayed rows without moving the high cursor backwards', async t => {
  let rows = Array.from({length: 60}, (_, index) => record(100 + index));
  const inputs: Input[] = [];
  const {store, collector, events} = setup(t, async input => {inputs.push(input); return paged(rows,input);},
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

test('query failure preserves a committed preview and durable history checkpoint before backing off', async t => {
  let calls = 0;
  const {store, collector, events} = setup(t, async () => {
    if (++calls === 1) return page([record(101)], true);
    throw new Error('synthetic query failure');
  }, {enabled: true, initialized: true, cursor: '100', accountFingerprint: account});
  await assert.rejects(collector.poll('wechat-test'), /synthetic query failure/);
  const state = store.read(); assert.equal(state.messages.length, 1); assert.equal(state.conversations[0].wechat!.cursor, '101');
  assert.equal(state.conversations[0].wechat!.history!.status,'error');assert.equal(state.conversations[0].wechat!.history!.cursor,'0');
  assert.equal(state.conversations[0].wechat!.status, 'error'); assert.equal(events.length, 1);assert.equal(events[0].live,false);
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

test('more than ten historical pages complete across durable chunks without duplicates or paid-media eligibility',async t=>{
  const rows=Array.from({length:2601},(_,index)=>record(index+1,index%50===0?{kind:'image',text:'[图片]',mediaStatus:'pending'}:{})),inputs:Input[]=[];
  const {store,collector,events}=setup(t,async input=>{inputs.push(input);return paged(rows,input);},{enabled:true});
  store.update(state=>state.conversations[0].processing={autoRecognizeImages:true,autoTranscribeVoice:true});
  await collector.poll('wechat-test');assert.equal(store.read().conversations[0].wechat!.history!.status,'running');
  assert.ok(store.read().messages.length>200&&store.read().messages.length<rows.length);
  for(let round=0;round<10&&store.read().conversations[0].wechat!.history!.status!=='complete';round++)await collector.tick();
  const state=store.read();assert.equal(state.conversations[0].wechat!.history!.status,'complete');assert.equal(state.messages.length,rows.length);
  assert.equal(state.conversations[0].wechat!.history!.scanned,rows.length);assert.equal(state.conversations[0].wechat!.history!.added,rows.length);
  assert.equal(new Set(state.messages.map(message=>message.externalId)).size,rows.length);assert.ok(inputs.filter(input=>input.order==='asc').length>10);
  assert.ok(state.messages.every(message=>!message.autoMediaEligible));assert.ok(events.every(event=>!event.live));assert.deepEqual(state.jobs,[]);
  rows.push(record(2602,{kind:'image',text:'[图片]',mediaStatus:'pending'}));await collector.poll('wechat-test');
  assert.equal(events.at(-1)!.live,true);assert.equal(store.read().messages.at(-1)!.autoMediaEligible,true);
});

test('an empty continuing page is rejected without inventing a checkpoint or dropping old data',async t=>{
  const {store,collector,events}=setup(t,async()=>page([],true),{enabled:true,initialized:true,cursor:'100',accountFingerprint:account});
  await assert.rejects(collector.poll('wechat-test'),/分页异常/);assert.equal(store.read().messages.length,0);
  assert.equal(store.read().conversations[0].wechat!.cursor,'100');assert.equal(store.read().conversations[0].wechat!.history!.cursor,'0');assert.equal(events.length,0);
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
    assert.equal(state.messages.length,mismatchPage===1?0:1);assert.equal(binding.cursor,mismatchPage===1?'100':'101');assert.equal(binding.accountFingerprint,account);
    assert.ok(state.messages.every(message=>message.externalId==='id-101'));assert.equal(binding.history!.status,'error');
    assert.equal(binding.enabled, false); assert.equal(binding.status, 'error'); assert.match(binding.detail, /账号已变化/);
    assert.equal(events.length,mismatchPage===1?0:1);assert.ok(events.every(event=>!event.live));await collector.tick();assert.equal(calls,mismatchPage);
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

test('identifier upgrades and repeated reads preserve recognized summaries, attachments, and reviewed state', async t => {
  const media = record(100, {kind: 'image', text: '[图片，待人工查看]', mediaStatus: 'pending'});
  let rows = [media];
  const {store, collector, events} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test');
  store.update(state => {
    state.messages[0].text = '[图片识别] 合成的识别说明'; state.messages[0].mediaStatus = 'recognized';
    state.messages[0].imageAttachment = {id: 'attachment', filename: 'fixture.png', mimeType: 'image/png', source: 'wechat'};
    state.messages[0].imageRecognition = {summary: '合成说明', visibleText: '', facts: [], provider: 'qwen', modelName: 'synthetic', recognizedAt: ''};
  });
  const eventCount = events.length;
  rows = [{...media, wechatImage: {md5: 'a'.repeat(32)}}];
  await collector.poll('wechat-test');
  assert.equal(store.read().messages[0].text, '[图片识别] 合成的识别说明');
  assert.equal(store.read().messages[0].mediaStatus, 'recognized');
  assert.equal(store.read().messages[0].imageAttachment?.id, 'attachment');
  assert.equal(store.read().messages[0].imageRecognition?.summary, '合成说明');
  assert.equal(store.read().messages[0].wechatImage?.md5, 'a'.repeat(32));
  assert.equal(events.length, eventCount);
});

test('custom sticker metadata upgrades preserve recognition, while changed MD5 invalidates only its source',async t=>{
  const sticker=record(100,{kind:'emoji',text:'[表情，待人工查看]',mediaStatus:'pending'});let rows=[sticker];
  const {store,collector,events}=setup(t,async()=>page(rows),{enabled:true});await collector.poll('wechat-test');
  store.update(state=>{
    const m=state.messages[0];m.mediaStatus='recognized';m.imageAttachment={id:'sticker-image',filename:'emoji.gif',mimeType:'image/gif',source:'wechat'};
    m.imageRecognition={summary:'猫咪表情包',visibleText:'好的',facts:['猫咪'],provider:'qwen',modelName:'vision',recognizedAt:''};
  });
  const eventCount=events.length;rows=[{...sticker,wechatEmoji:{md5:'a'.repeat(32)}}];await collector.poll('wechat-test');
  assert.equal(store.read().messages[0].imageRecognition?.visibleText,'好的');assert.equal(store.read().messages[0].wechatEmoji?.md5,'a'.repeat(32));assert.equal(events.length,eventCount);
  rows=[{...sticker,wechatEmoji:{md5:'b'.repeat(32)}}];await collector.poll('wechat-test');
  assert.equal(store.read().messages[0].imageRecognition,undefined);assert.equal(store.read().messages[0].imageAttachment,undefined);assert.equal(store.read().messages[0].mediaStatus,'pending');assert.equal(events.at(-1)!.live,false);
});

test('only live peer custom stickers opt into their contact automatic image switch',async t=>{
  let rows=[record(100)];const {store,collector}=setup(t,async()=>page(rows),{enabled:true});
  store.update(state=>state.conversations[0].processing={autoRecognizeImages:true});await collector.poll('wechat-test');
  rows.push(record(101,{kind:'emoji',text:'[表情]',mediaStatus:'pending'}),record(102,{kind:'emoji',role:'self',text:'[表情]',mediaStatus:'pending'}));
  await collector.poll('wechat-test');assert.equal(store.read().messages[1].autoMediaEligible,true);assert.equal(store.read().messages[2].autoMediaEligible,false);
  store.update(state=>state.conversations[0].processing!.autoRecognizeImages=false);rows.push(record(103,{kind:'emoji',text:'[表情]',mediaStatus:'pending'}));await collector.poll('wechat-test');
  assert.equal(store.read().messages[3].autoMediaEligible,false);
});

test('a changed voice source invalidates its decoded audio and transcription', async t => {
  const voice = record(100, {kind: 'voice', text: '[语音]', mediaStatus: 'pending'}); let rows = [voice];
  const {store, collector} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test');
  store.update(state => {
    state.messages[0].audioAttachment = {id: 'stale-audio', filename: 'voice.mp3', mimeType: 'audio/mpeg', source: 'wechat'};
    state.messages[0].audioRecognition = {text: '合成转写', provider: 'qwen', modelName: 'synthetic', recognizedAt: ''};
    state.messages[0].text = '[语音识别] 合成转写'; state.messages[0].mediaStatus = 'recognized';
  });
  rows = [{...voice, role: 'self'}]; await collector.poll('wechat-test');
  assert.equal(store.read().messages[0].audioAttachment, undefined); assert.equal(store.read().messages[0].audioRecognition, undefined);
  assert.equal(store.read().messages[0].mediaStatus, 'pending'); assert.equal(store.read().messages[0].text, '[语音]');
});

test('only new live peer media arriving with its switch enabled becomes eligible for automatic recognition', async t => {
  let rows = [record(100, {kind: 'image', text: '[图片]', mediaStatus: 'pending'})];
  const {store, collector} = setup(t, async () => page(rows), {enabled: true});
  store.update(state => {state.conversations[0].processing={autoRecognizeImages:true,autoTranscribeVoice:true};});
  await collector.poll('wechat-test');
  assert.equal(store.read().messages[0].autoMediaEligible, false);
  rows.push(record(101, {kind: 'image', text: '[图片]', mediaStatus: 'pending'}), record(102, {kind: 'voice', text: '[语音]', mediaStatus: 'pending'}), record(103));
  await collector.poll('wechat-test');
  assert.equal(store.read().messages[1].autoMediaEligible, true);
  assert.equal(store.read().messages[2].autoMediaEligible, true);
  assert.equal(store.read().messages[3].autoMediaEligible, false);
  store.update(state => {state.conversations[0].processing!.autoRecognizeImages = false;});
  rows.push(record(104, {kind: 'image', text: '[图片]', mediaStatus: 'pending'}), record(105, {kind: 'voice', role: 'self', text: '[语音]', mediaStatus: 'pending'}));
  await collector.poll('wechat-test');
  assert.equal(store.read().messages[4].autoMediaEligible, false); assert.equal(store.read().messages[5].autoMediaEligible, false);
  store.update(state => {state.conversations[0].processing!.autoRecognizeImages = true;}); await collector.poll('wechat-test');
  assert.equal(store.read().messages[4].autoMediaEligible, false);
});

test('new media eligibility follows only its own contact switches, even when global switches are on', async t => {
  let rows=[record(100)];
  const {store,collector}=setup(t,async()=>page(rows),{enabled:true});
  store.update(s=>{
    s.settings.autoRecognizeImages=true;s.settings.autoTranscribeVoice=true;
    s.conversations[0].processing={autoRecognizeImages:true,autoTranscribeVoice:false};
    s.conversations.push({...conversation({enabled:true}),id:'wechat-b',externalId:'peer-b'});
  });
  await collector.poll('wechat-test');await collector.poll('wechat-b');
  rows.push(record(101,{kind:'image',text:'[图片]',mediaStatus:'pending'}),record(102,{kind:'voice',text:'[语音]',mediaStatus:'pending'}));
  await collector.poll('wechat-test');await collector.poll('wechat-b');
  const state=store.read();
  assert.equal(state.messages.find(m=>m.conversationId==='wechat-test'&&m.kind==='image')?.autoMediaEligible,true);
  assert.equal(state.messages.find(m=>m.conversationId==='wechat-test'&&m.kind==='voice')?.autoMediaEligible,false);
  assert.ok(state.messages.filter(m=>m.conversationId==='wechat-b').every(m=>m.autoMediaEligible===false));
});

test('manually uploaded image context keeps its chronological place when new WeChat messages arrive', async t => {
  let rows = [record(100)];
  const {store, collector} = setup(t, async () => page(rows), {enabled: true});
  await collector.poll('wechat-test');
  store.update(state => {state.messages.push({id: 'uploaded-context', conversationId: 'wechat-test', role: 'peer', source: 'manual',
    text: '[上传图片]', kind: 'image', mediaStatus: 'pending', sentAt: '2026-10-10T03:00:01Z', sequence: 2, externalId: null, aiAssisted: false});});
  rows.push(record(101, {sentAt: '2026-10-10T03:00:02Z'}));
  await collector.poll('wechat-test');
  assert.deepEqual(store.read().messages.map(message => message.externalId ?? message.id), ['id-100', 'uploaded-context', 'id-101']);
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

test('an initialized legacy latest-fifty binding backfills everything without replacing saved IDs, review, caches or analysis',async t=>{
  const rows=Array.from({length:1501},(_,index)=>record(index+1,index===1470?{kind:'image',text:'[图片]',mediaStatus:'pending'}:{}));
  const {store,collector,events}=setup(t,async input=>paged(rows,input),{enabled:true,initialized:true,cursor:'1501',accountFingerprint:account});
  store.update(state=>{
    state.conversations[0].processing={autoRecognizeImages:true,autoTranscribeVoice:true};
    state.messages=rows.slice(-50).map((row,index)=>({id:`preserved-${row.id}`,conversationId:'wechat-test',role:row.role,text:row.text,
      source:'wechat',externalId:row.id,sequence:index+1,sourceSequence:row.sortSeq,sentAt:row.sentAt,aiAssisted:false,kind:row.kind,mediaStatus:row.mediaStatus}));
    const media=state.messages.find(message=>message.kind==='image')!;
    media.text='[图片识别] 用户已核对的合成内容';media.mediaStatus='reviewed';
    media.imageAttachment={id:'saved-file',filename:'synthetic.png',mimeType:'image/png',source:'wechat'};
    media.imageRecognition={summary:'已保存识别',visibleText:'合成文字',facts:[],provider:'qwen',modelName:'vision-fixture',recognizedAt:''};
  });
  saveSyntheticInsights(store,'wechat-test');
  const originals=store.read().messages;
  for(let round=0;round<5&&store.read().conversations[0].wechat?.history?.status!=='complete';round++)await collector.poll('wechat-test');
  const state=store.read();assert.equal(state.messages.length,rows.length);assert.equal(state.conversations[0].wechat!.history!.status,'complete');
  assert.equal(state.conversations[0].wechat!.history!.added,rows.length-50);assert.equal(state.conversations[0].wechat!.history!.scanned,rows.length);
  for(const old of originals){const current=state.messages.find(message=>message.externalId===old.externalId)!;
    assert.equal(current.id,old.id);assert.deepEqual(current.insights,old.insights);assert.equal(current.text,old.text);
    assert.equal(current.mediaStatus,old.mediaStatus);assert.deepEqual(current.imageAttachment,old.imageAttachment);assert.deepEqual(current.imageRecognition,old.imageRecognition);
  }
  assert.ok(events.every(event=>!event.live));assert.ok(state.messages.every(message=>!message.autoMediaEligible));assert.deepEqual(state.jobs,[]);
});

test('a failed historical page resumes its saved tie offset after a real SQLite restart with no missing or duplicated equal-sequence rows',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xiangzhi-history-resume-')),path=join(directory,'state.sqlite');
  let store=new Store(path),collector:WechatCollector;const inputs:Input[]=[],events:boolean[]=[];
  const rows=[record(1),...Array.from({length:1201},(_,index)=>record(100,{id:`tie-${String(index).padStart(5,'0')}`})),record(101)];
  store.update(state=>state.conversations.push(conversation({enabled:true})));
  let ascCalls=0,fail=true;
  const query:WechatQuery=async input=>{inputs.push(input);if(input.order==='asc'&&++ascCalls===2&&fail)throw new Error('synthetic interrupted second page');return paged(rows,input);};
  collector=new WechatCollector(store,{query,onMessages:(_cid,_id,live)=>events.push(live)});
  t.after(()=>{collector.stop();store.close();rmSync(directory,{recursive:true,force:true});});
  await assert.rejects(collector.poll('wechat-test'),/interrupted second page/);
  const checkpoint=store.read().conversations[0].wechat!.history!;
  assert.equal(checkpoint.status,'error');assert.equal(checkpoint.cursor,'99');assert.equal(checkpoint.offset,199);assert.equal(checkpoint.scanned,200);
  assert.match(store.read().conversations[0].wechat!.detail,/已保存 \d+ 条消息.*续读未完成/);
  assert.match(checkpoint.detail,/已扫描 200 条历史/);
  const committed=new Map(store.read().messages.map(message=>[message.externalId,message.id]));
  collector.stop();store.close();store=new Store(path);fail=false;inputs.length=0;
  collector=new WechatCollector(store,{query,onMessages:(_cid,_id,live)=>events.push(live)});collector.setEnabled('wechat-test',true);
  for(let round=0;round<5&&store.read().conversations[0].wechat!.history!.status!=='complete';round++)await collector.tick();
  assert.equal(inputs.find(input=>input.order==='asc')!.offset,199);assert.equal(inputs.find(input=>input.order==='asc')!.after,'99');
  const state=store.read();assert.equal(state.messages.length,rows.length);assert.equal(new Set(state.messages.map(message=>message.externalId)).size,rows.length);
  assert.equal(state.conversations[0].wechat!.history!.scanned,rows.length);assert.equal(state.conversations[0].wechat!.history!.added,rows.length);
  assert.equal(state.conversations[0].wechat!.history!.status,'complete');
  for(const [externalId,id] of committed)assert.equal(state.messages.find(message=>message.externalId===externalId)!.id,id);
  assert.deepEqual(new Set(state.messages.map(message=>message.externalId)),new Set(rows.map(row=>row.id)));assert.ok(events.every(live=>!live));
});

test('a failed incremental check keeps completed history complete and describes only the failed check',async t=>{
  let fail=false;
  const {store,collector}=setup(t,async()=>{if(fail)throw new Error('synthetic incremental failure');return page([record(1),record(2)]);});
  await collector.poll('wechat-test');const saved=store.read().messages;fail=true;
  await assert.rejects(collector.poll('wechat-test'),/incremental failure/);
  const state=store.read();assert.deepEqual(state.messages,saved);
  assert.equal(state.conversations[0].wechat!.history!.status,'complete');
  assert.match(state.conversations[0].wechat!.detail,/已完整保存 2 条历史.*新增消息检查未成功/);
});

test('pausing after a committed historical page blocks a late result and resumes exactly from the checkpoint',async t=>{
  const rows=Array.from({length:1201},(_,index)=>record(index+1)),gate=deferred<WechatPage>();let ascCalls=0;
  const inputs:Input[]=[];let pausedInput:Input|undefined;
  const {store,collector,events}=setup(t,async input=>{inputs.push(input);if(input.order==='asc'&&++ascCalls===2){pausedInput=input;return gate.promise;}return paged(rows,input);},{enabled:true});
  const pending=collector.poll('wechat-test'),rejected=assert.rejects(pending,/暂停|停止|改变/);
  while(!pausedInput)await Promise.resolve();
  const prior=store.read();assert.equal(prior.conversations[0].wechat!.history!.scanned,200);
  collector.setEnabled('wechat-test',false);gate.resolve(paged(rows,pausedInput));await rejected;
  assert.deepEqual(store.read().messages,prior.messages);assert.equal(store.read().conversations[0].wechat!.history!.cursor,'199');
  assert.equal(store.read().conversations[0].wechat!.history!.status,'pending');
  inputs.length=0;collector.setEnabled('wechat-test',true);
  for(let round=0;round<5&&store.read().conversations[0].wechat!.history!.status!=='complete';round++)await collector.tick();
  assert.deepEqual(inputs.find(input=>input.order==='asc'),pausedInput);assert.equal(store.read().messages.length,rows.length);
  assert.equal(store.read().conversations[0].wechat!.history!.scanned,rows.length);assert.ok(events.every(event=>!event.live));
});

test('latest messages appear before historical backfill finishes and a large later catch-up has no total page cap',async t=>{
  const rows=Array.from({length:2401},(_,index)=>record(index+1)),inputs:Input[]=[];
  const {store,collector,events}=setup(t,async input=>{inputs.push(input);return paged(rows,input);},{enabled:true});
  await collector.poll('wechat-test');assert.equal(store.read().conversations[0].wechat!.history!.status,'running');
  rows.push(record(2402,{text:'最新合成来信'}));await collector.poll('wechat-test');
  assert.equal(store.read().messages.at(-1)!.text,'最新合成来信');assert.equal(store.read().conversations[0].wechat!.history!.status,'running');
  assert.ok(events.every(event=>!event.live));
  for(let round=0;round<5&&store.read().conversations[0].wechat!.history!.status!=='complete';round++)await collector.tick();
  const historyCount=store.read().conversations[0].wechat!.history!.scanned;
  rows.push(...Array.from({length:2501},(_,index)=>record(2403+index)));
  await collector.poll('wechat-test');assert.ok(store.read().conversations[0].wechat!.history!.tail);
  for(let round=0;round<10&&store.read().conversations[0].wechat!.history!.tail;round++)await collector.tick();
  const state=store.read();assert.equal(state.messages.length,rows.length);assert.equal(new Set(state.messages.map(message=>message.externalId)).size,rows.length);
  assert.equal(state.conversations[0].wechat!.history!.tail,undefined);assert.equal(state.conversations[0].wechat!.history!.scanned,historyCount);
  assert.equal(state.messages.at(-1)!.externalId,rows.at(-1)!.id);assert.ok(events.every(event=>!event.live));assert.deepEqual(state.jobs,[]);
});

test('a foreign account on a later historical page cannot advance or contaminate the committed account checkpoint',async t=>{
  const rows=Array.from({length:1001},(_,index)=>record(index+1));let ascCalls=0;
  const {store,collector}=setup(t,async input=>{
    const result=paged(rows,input);if(input.order==='asc'&&++ascCalls===2)return {...result,accountFingerprint:'foreign-account'};return result;
  },{enabled:true});
  await assert.rejects(collector.poll('wechat-test'),/账号已变化/);
  const state=store.read(),history=state.conversations[0].wechat!.history!;
  assert.equal(state.conversations[0].wechat!.enabled,false);assert.equal(state.conversations[0].wechat!.accountFingerprint,account);
  assert.equal(history.status,'error');assert.equal(history.cursor,'199');assert.equal(history.offset,1);assert.equal(history.scanned,200);
  assert.equal(state.messages.length,400);assert.ok(!state.messages.some(message=>message.externalId==='id-201'));
  await collector.tick();assert.equal(ascCalls,2);
});

test('background history timers continue durable chunks and pause without polling the contact',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const rows=Array.from({length:1201},(_,index)=>record(index+1));let calls=0;
  const {store,collector}=setup(t,async input=>{calls++;return paged(rows,input);},{enabled:true});
  collector.start();t.mock.timers.tick(1000);await collector.tick();
  assert.equal(store.read().conversations[0].wechat!.history!.scanned,600);const firstCount=calls;
  collector.setEnabled('wechat-test',false);t.mock.timers.tick(1000);await collector.tick();assert.equal(calls,firstCount);
  collector.setEnabled('wechat-test',true);t.mock.timers.tick(1000);await collector.tick();
  assert.equal(store.read().conversations[0].wechat!.history!.scanned,1200);
  t.mock.timers.tick(1000);await collector.tick();
  assert.equal(store.read().conversations[0].wechat!.history!.status,'complete');assert.equal(store.read().messages.length,rows.length);
});

test('one manual history read finishes a paused contact across ticks and then stops monitoring future messages',async t=>{
  const rows=Array.from({length:1501},(_,i)=>record(i+1));let calls=0;
  const {store,collector,events}=setup(t,async input=>{calls++;return paged(rows,input);});
  await collector.readHistory('wechat-test');
  assert.equal(store.read().conversations[0].wechat!.enabled,false);
  assert.equal(store.read().conversations[0].wechat!.history!.status,'running');
  assert.equal(store.read().conversations[0].wechat!.history!.scanned,600);
  for(let i=0;i<4&&store.read().conversations[0].wechat!.history!.status!=='complete';i++)await collector.tick();
  assert.equal(store.read().messages.length,1501);assert.equal(store.read().conversations[0].wechat!.history!.status,'complete');
  assert.equal(store.read().conversations[0].wechat!.enabled,false);
  assert.ok(events.every(event=>!event.live));assert.deepEqual(store.read().jobs,[]);
  const completedCalls=calls;rows.push(record(1502));await collector.tick();
  assert.equal(calls,completedCalls);assert.equal(store.read().messages.length,1501);
});

test('manual history rescan finds newly downloaded older records while preserving stable IDs and parsed media',async t=>{
  const rows=Array.from({length:251},(_,i)=>record(i+100,i===100?{kind:'image',text:'[图片]',mediaStatus:'pending'}:{}));
  const {store,collector,events}=setup(t,async input=>paged(rows,input));
  await collector.readHistory('wechat-test');
  assert.equal(store.read().conversations[0].wechat!.history!.status,'complete');
  const originals=new Map(store.read().messages.map(m=>[m.externalId,m.id]));
  store.update(s=>{const media=s.messages.find(m=>m.kind==='image')!;media.mediaStatus='recognized';
    media.imageRecognition={summary:'已保存的合成识别结果',visibleText:'',facts:[],provider:'codex',modelName:'test-model',recognizedAt:'2026-10-22T00:00:00Z'};});
  const parsed=store.read().messages.find(m=>m.kind==='image')!.imageRecognition;
  rows.unshift(...Array.from({length:99},(_,i)=>record(i+1)));
  await collector.readHistory('wechat-test',undefined,true);
  for(let i=0;i<3&&store.read().conversations[0].wechat!.history!.status!=='complete';i++)await collector.tick();
  const final=store.read();assert.equal(final.messages.length,350);assert.equal(new Set(final.messages.map(m=>m.externalId)).size,350);
  assert.equal(final.conversations[0].wechat!.history!.status,'complete');assert.equal(final.conversations[0].wechat!.enabled,false);
  for(const [externalId,id]of originals)assert.equal(final.messages.find(m=>m.externalId===externalId)!.id,id);
  assert.deepEqual(final.messages.find(m=>m.kind==='image')!.imageRecognition,parsed);assert.ok(events.every(event=>!event.live));
});

test('cancelling an active manual historical read drops a late page and does not restart the one-shot job',async t=>{
  const rows=Array.from({length:1501},(_,i)=>record(i+1)),gate=deferred<WechatPage>();let calls=0,asc=0,waiting:Input|undefined;
  const {store,collector,events}=setup(t,async input=>{calls++;if(input.order==='asc'&&++asc===2){waiting=input;return gate.promise;}return paged(rows,input);});
  const pending=collector.readHistory('wechat-test'),rejection=assert.rejects(pending,/暂停|停止/);
  while(!waiting)await Promise.resolve();
  const committed=store.read();assert.equal(committed.conversations[0].wechat!.history!.scanned,200);
  collector.cancel('wechat-test');gate.resolve(paged(rows,waiting));await rejection;
  assert.deepEqual(store.read().messages,committed.messages);assert.equal(store.read().conversations[0].wechat!.history!.scanned,200);
  const stoppedCalls=calls;await collector.tick();assert.equal(calls,stoppedCalls);
  assert.ok(events.every(event=>!event.live));assert.equal(store.read().conversations[0].wechat!.enabled,false);
});
