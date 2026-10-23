import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';
import type { Conversation, Draft } from '../shared/types.js';
import type { WechatPage, WechatQuery, WechatRecord } from '../server/wechat-cli.js';

type Options = Parameters<typeof createApplication>[0];
type QueryInput = Parameters<WechatQuery>[0];
const account = 'synthetic-wechat-account-fingerprint';
const row = (sequence: number, overrides: Partial<WechatRecord> = {}): WechatRecord => ({
  id: `synthetic-external-${sequence}`, sortSeq: String(sequence), sentAt: '2026-10-10T04:00:00.000Z',
  role: 'peer', kind: 'text', text: `虚构来信 ${sequence}`, ...overrides,
});
const page = (records: WechatRecord[]): WechatPage => ({records, hasMore: false, accountFingerprint: account});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise, resolve};
}

async function harness(overrides: Pick<Options, 'queryWechat' | 'generate' | 'inspectWechat'> = {}) {
  const calls = {query: [] as QueryInput[], generate: [] as string[], send: 0};
  const generate: NonNullable<Options['generate']> = async (state, cid) => {
    calls.generate.push(cid);
    return ['自然', '简短', '接话'].map((label, index): Draft => ({
      id: `synthetic-draft-${calls.generate.length}-${index}`, conversationId: cid,
      basedOnMessageId: state.messages.filter(message => message.conversationId === cid).at(-1)!.id,
      text: `虚构候选 ${index}`, label, reason: '接口测试', provider: 'demo', createdAt: new Date().toISOString(),
    }));
  };
  const instance = createApplication({databasePath: ':memory:', seed: false, profileManifestPath: null,
    bridge: {inboundToken: '', outboundToken: '', outboundUrl: ''}, draftSync: {url: '', token: '', inboxToken: ''},
    inspectCodex: async () => ({available: false, version: null, message: 'synthetic Codex inspector'}),
    inspectWechat: overrides.inspectWechat ?? (() => ({available: true, message: 'synthetic WeChat inspector'})),
    queryWechat: async (input, signal) => {
      calls.query.push(structuredClone(input));
      return overrides.queryWechat ? overrides.queryWechat(input, signal) : page([]);
    },
    generate: overrides.generate ?? generate,
    send: async () => {calls.send++; return 'synthetic-send-receipt';},
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${base}/api/session`);
  const {token} = await session.json() as {token: string};
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method, headers: {Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json', ...extra},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const bind = async (externalId = 'filehelper', name = '虚构文件传输助手') => {
    const response = await request('/api/wechat/conversations', 'POST', {name, externalId});
    assert.equal(response.status, 201);
    return await response.json() as Conversation;
  };
  return {...instance, base, calls, request, bind, close: async () => {
    await new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();});
    instance.close();
  }};
}

test('WeChat binding requires authentication, remains off, rejects duplicates/invalid parameters, and caps eight contacts', async () => {
  const h = await harness();
  try {
    const body = {name: '虚构文件传输助手', externalId: 'filehelper'};
    assert.equal((await fetch(`${h.base}/api/wechat/conversations`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})).status, 401);
    assert.equal((await h.request('/api/wechat/conversations', 'POST', body, {'X-CSRF-Token': ''})).status, 403);
    for (const invalid of [
      {...body, externalId: '-all'}, {...body, externalId: 'filehelper; echo unsafe'}, {...body, externalId: ''},
      {...body, externalId: 'x'.repeat(201)}, {...body, name: ''}, {...body, enabled: true},
    ]) assert.equal((await h.request('/api/wechat/conversations', 'POST', invalid)).status, 400);
    const bound = await h.bind();
    assert.equal(bound.channel, 'wechat'); assert.equal(bound.autoReplyEnabled, false);
    assert.equal(bound.wechat!.enabled, false); assert.equal(bound.wechat!.initialized, false);
    assert.equal(bound.wechat!.cursor, null); assert.equal(h.store.read().settings.autoReplyEnabled, false);
    assert.equal((await h.request('/api/wechat/conversations', 'POST', body)).status, 400);
    for (let index = 1; index < 8; index++) await h.bind(`synthetic_${index}`);
    assert.equal((await h.request('/api/wechat/conversations', 'POST', {name: '第九个虚构会话', externalId: 'synthetic_ninth'})).status, 400);
    await h.collector.tick();
    assert.equal(h.store.read().conversations.length, 8); assert.deepEqual(h.calls.query, []);
    assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.send, 0);
    const state = await (await h.request('/api/state')).json();
    assert.equal(state.runtime.wechatAvailable, true); assert.equal(state.runtime.wechatStatus, 'synthetic WeChat inspector');
  } finally {await h.close();}
});

test('manual API distinguishes a saved batch from completed history and preserves the continuation checkpoint',async()=>{
  const rows=Array.from({length:1001},(_,index)=>row(index+1));
  const h=await harness({queryWechat:async input=>{
    const selected=rows.filter(r=>input.after===undefined||BigInt(r.sortSeq)>BigInt(input.after));
    if(input.order==='desc')selected.reverse();const offset=input.offset??0;
    return {records:selected.slice(offset,offset+input.limit),hasMore:offset+input.limit<selected.length,accountFingerprint:account};
  }});
  try{
    const c=await h.bind();
    const first=await(await h.request(`/api/conversations/${c.id}/wechat/poll`,'POST',{})).json();
    assert.equal(first.historyComplete,false);assert.equal(first.savedMessages,800);
    const checkpoint=h.store.read().conversations[0].wechat!.history!;
    assert.equal(checkpoint.status,'running');assert.equal(checkpoint.scanned,600);
    const second=await(await h.request(`/api/conversations/${c.id}/wechat/poll`,'POST',{})).json();
    assert.equal(second.historyComplete,true);assert.equal(second.savedMessages,1001);
    assert.deepEqual(h.calls.generate,[]);assert.equal(h.calls.send,0);
  }finally{await h.close();}
});

test('WeChat reads only an exact bound contact and manual baseline never schedules a reply', async () => {
  const h = await harness({queryWechat: async input => {
    assert.equal(input.contact, 'filehelper'); return page([row(2), row(1)]);
  }});
  try {
    const selected = await h.bind(); const unrelated = await h.bind('unrelated_synthetic');
    const simulator = await (await h.request('/api/conversations', 'POST', {name: '虚构演练'})).json() as Conversation;
    assert.equal((await h.request(`/api/conversations/${simulator.id}/wechat/poll`, 'POST', {})).status, 400);
    assert.equal((await h.request('/api/conversations/missing/wechat/poll', 'POST', {})).status, 400);
    assert.equal((await h.request(`/api/conversations/${selected.id}/messages`, 'POST', {role: 'peer', text: '禁止伪造采集消息'})).status, 400);
    await h.request(`/api/conversations/${selected.id}`, 'PATCH', {autoReplyEnabled: true});
    await h.request('/api/settings', 'PATCH', {autoReplyEnabled: true});
    const result = await h.request(`/api/conversations/${selected.id}/wechat/poll`, 'POST', {});
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), {added: 2, baseline: true, historyComplete:true, savedMessages:2});
    assert.deepEqual(h.calls.query, [{contact: 'filehelper', order: 'desc', limit: 200, offset: 0}]);
    const state = h.store.read();
    assert.deepEqual(state.messages.map(message => message.sourceSequence), ['1', '2']);
    assert.ok(state.messages.every(message => message.conversationId === selected.id && message.source === 'wechat'));
    assert.equal(state.conversations.find(contact => contact.id === unrelated.id)!.wechat!.initialized, false);
    assert.equal(state.conversations.find(contact => contact.id === selected.id)!.wechat!.cursor, '2');
    assert.equal(state.conversations.find(contact => contact.id === selected.id)!.wechat!.history!.status, 'complete');
    assert.equal(state.conversations.find(contact => contact.id === selected.id)!.wechat!.accountFingerprint, account);
    assert.deepEqual(state.jobs, []); assert.deepEqual(h.calls.generate, []); assert.equal(h.calls.send, 0);
    assert.equal((await h.request(`/api/conversations/${selected.id}/wechat/poll`, 'POST', {})).status, 200);
    assert.equal(h.store.read().messages.length, 2); assert.deepEqual(h.store.read().jobs, []);
  } finally {await h.close();}
});

test('enabled WeChat collection treats first and resumed catch-up as history; only a later peer message generates drafts', async () => {
  let rows = [row(1)];
  const h = await harness({queryWechat: async () => page(rows)});
  try {
    const selected = await h.bind(); await h.bind('unrelated_synthetic');
    assert.equal((await h.request(`/api/conversations/${selected.id}`, 'PATCH', {autoReplyEnabled: true})).status, 200);
    assert.equal((await h.request('/api/settings', 'PATCH', {autoReplyEnabled: true, autoReplyMode: 'draft', cooldownSeconds: 0, replyDelaySeconds: 1})).status, 200);
    assert.equal((await h.request(`/api/conversations/${selected.id}/wechat`, 'PATCH', {enabled: true})).status, 200);
    await h.collector.tick(); await h.engine.tick();
    assert.equal(h.store.read().jobs.length, 0); assert.equal(h.calls.generate.length, 0);
    rows = [row(1), row(2)]; await h.collector.tick();
    assert.equal(h.store.read().jobs.length, 1); assert.equal(h.store.read().jobs[0].status, 'queued');
    h.store.update(state => {state.jobs[0].dueAt = new Date(0).toISOString();});
    await h.engine.tick();
    assert.equal(h.store.read().jobs[0].status, 'drafted'); assert.equal(h.store.read().drafts.length, 3);
    assert.deepEqual(h.calls.generate, [selected.id]); assert.equal(h.calls.send, 0);
    assert.ok(h.calls.query.every(input => input.contact === 'filehelper'));
    rows = [...rows, row(3, {role: 'self', text: '本人从微信回复的虚构消息'})]; await h.collector.tick();
    assert.equal(h.store.read().jobs.length, 1); assert.equal(h.store.read().drafts.length, 0);
    await h.request(`/api/conversations/${selected.id}/wechat`, 'PATCH', {enabled: false});
    rows = [...rows, row(4)]; await h.collector.tick();
    assert.equal(h.store.read().messages.length, 3);
    await h.request(`/api/conversations/${selected.id}/wechat`, 'PATCH', {enabled: true});
    await h.collector.tick(); await h.engine.tick();
    assert.equal(h.store.read().messages.length, 4); assert.equal(h.store.read().jobs.length, 1);
    assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send, 0);
  } finally {await h.close();}
});

test('pending media permits draft suggestions; optional review stays idempotent and does not generate by itself', async () => {
  const h = await harness({queryWechat: async () => page([
    row(1, {kind: 'image', text: '[图片，待人工查看]', mediaStatus: 'pending'}), row(2),
  ])});
  try {
    const contact = await h.bind();
    await h.request(`/api/conversations/${contact.id}`, 'PATCH', {autoReplyEnabled: true});
    await h.request('/api/settings', 'PATCH', {autoReplyEnabled: true});
    await h.request(`/api/conversations/${contact.id}/wechat/poll`, 'POST', {});
    const media = h.store.read().messages.find(message => message.kind === 'image')!;
    const pendingDrafts = await h.request(`/api/conversations/${contact.id}/suggest`, 'POST', {});
    assert.equal(pendingDrafts.status, 200); assert.equal((await pendingDrafts.json()).drafts.length, 3);
    assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send, 0);
    assert.equal(h.store.read().messages.find(message => message.id === media.id)!.mediaStatus, 'pending');
    assert.equal((await h.request(`/api/messages/${media.id}/review-media`, 'POST', {summary: 'x'.repeat(2001)})).status, 400);
    const reviewed = await h.request(`/api/messages/${media.id}/review-media`, 'POST', {summary: '合成说明：对方分享了一张风景照'});
    assert.equal(reviewed.status, 200); assert.deepEqual(await reviewed.json(), {ok: true});
    const saved = h.store.read().messages.find(message => message.id === media.id)!;
    assert.equal(saved.mediaStatus, 'reviewed'); assert.match(saved.text, /本人查看后补充.*风景照/);
    const repeated = await h.request(`/api/messages/${media.id}/review-media`, 'POST', {summary: '重复确认不得覆盖原说明'});
    assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), {ok: true, duplicate: true});
    assert.equal(h.store.read().messages.find(message => message.id === media.id)!.text, saved.text);
    await h.engine.tick();
    assert.equal(h.calls.query.length, 1, 'review never invokes the CLI');
    assert.equal(h.calls.generate.length, 1, 'review never generates automatically');
    assert.equal(h.calls.send, 0); assert.equal(h.store.read().jobs.length, 0);
    const result = await h.request(`/api/conversations/${contact.id}/suggest`, 'POST', {});
    assert.equal(result.status, 200); assert.equal((await result.json()).drafts.length, 3);
    assert.equal(h.calls.generate.length, 2); assert.equal(h.calls.send, 0);
    await h.request(`/api/conversations/${contact.id}/wechat/poll`, 'POST', {});
    assert.equal(h.store.read().messages.find(message => message.id === media.id)!.text, saved.text, 'identical source rereads preserve local review');
  } finally {await h.close();}
});

test('WeChat manual sending and both global/contact routes into send mode remain blocked even with an injected sender', async () => {
  const h = await harness({queryWechat: async () => page([row(1)])});
  try {
    const contact = await h.bind();
    await h.request(`/api/conversations/${contact.id}/wechat/poll`, 'POST', {});
    const before = h.store.read().messages;
    const send = await h.request(`/api/conversations/${contact.id}/send`, 'POST', {text: '不得实际发送的合成文本', requestId: 'synthetic-send-id'});
    assert.equal(send.status, 400); assert.match((await send.json()).error, /仅接收/);
    assert.deepEqual(h.store.read().messages, before); assert.equal(h.calls.send, 0);
    assert.equal((await h.request(`/api/conversations/${contact.id}`, 'PATCH', {autoReplyEnabled: true})).status, 200);
    assert.equal((await h.request('/api/settings', 'PATCH', {autoReplyMode: 'send'})).status, 200);
    assert.equal(h.store.read().settings.autoReplyEnabled, false);
    assert.equal((await h.request('/api/settings', 'PATCH', {autoReplyEnabled: true})).status, 400);
    await h.request(`/api/conversations/${contact.id}`, 'PATCH', {autoReplyEnabled: false});
    assert.equal((await h.request('/api/settings', 'PATCH', {autoReplyEnabled: true})).status, 200);
    assert.equal((await h.request(`/api/conversations/${contact.id}`, 'PATCH', {autoReplyEnabled: true})).status, 400);
    // A persisted or administratively injected invalid combination is stopped
    // again in the engine; a injected sender cannot turn collection into sending.
    h.store.update(state => {state.conversations.find(item => item.id === contact.id)!.autoReplyEnabled = true;});
    h.engine.enqueue(contact.id, before[0].id); await h.engine.tick();
    assert.equal(h.store.read().jobs[0].status, 'blocked');
    assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.send, 0);
  } finally {await h.close();}
});

test('disabling WeChat collection aborts an in-flight HTTP poll and discards a late result', async () => {
  const entered = deferred<void>(); const response = deferred<WechatPage>();
  let querySignal: AbortSignal | undefined;
  const h = await harness({queryWechat: async (_input, signal) => {querySignal = signal; entered.resolve(); return response.promise;}});
  let pending: Promise<Response> | undefined;
  try {
    const contact = await h.bind();
    await h.request(`/api/conversations/${contact.id}/wechat`, 'PATCH', {enabled: true});
    pending = h.request(`/api/conversations/${contact.id}/wechat/poll`, 'POST', {});
    await entered.promise;
    assert.equal((await h.request(`/api/conversations/${contact.id}/wechat`, 'PATCH', {enabled: false})).status, 200);
    assert.equal(querySignal?.aborted, true);
    response.resolve(page([row(1)]));
    assert.equal((await pending).status, 400);
    const state = h.store.read();
    assert.deepEqual(state.messages, []); assert.deepEqual(state.jobs, []); assert.deepEqual(state.drafts, []);
    assert.equal(state.conversations[0].wechat!.enabled, false);
    assert.equal(state.conversations[0].wechat!.cursor, null); assert.equal(state.conversations[0].wechat!.initialized, false);
    assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.send, 0);
  } finally {response.resolve(page([])); await pending; await h.close();}
});

test('unavailable WeChat inspection prevents binding and polling without touching the query dependency', async () => {
  const h = await harness({inspectWechat: () => ({available: false, message: 'synthetic unavailable'})});
  try {
    assert.equal((await h.request('/api/wechat/conversations', 'POST', {name: '虚构会话', externalId: 'filehelper'})).status, 400);
    assert.equal((await h.request('/api/conversations/unknown/wechat/poll', 'POST', {})).status, 400);
    assert.equal(h.calls.query.length, 0); assert.equal(h.store.read().conversations.length, 0);
  } finally {await h.close();}
});
