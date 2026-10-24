import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type { AppState, Message } from '../shared/types.js';
import { compressContactMemory, memoryInputDigest, memoryRemainingCount } from '../server/contact-memory.js';
import { messageEvidenceHash } from '../server/contact-evidence.js';

function state(): AppState {
  return {version: 1, settings: {provider: 'compatible', modelPreset: 'qwen', modelName: 'reply-model',
    modelUrl: 'https://synthetic-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'TEST-KEY', allowRemoteModel: true,
    autoReplyEnabled: false, autoReplyMode: 'draft', replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
    quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00',
    memory: {provider: 'qwen', modelName: 'memory-default', modelUrl: 'https://synthetic-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      useReplyApiKey: true, allowRemoteModel: true}},
    conversations: ['A', 'B'].map(id => ({id, name: id, avatar: id, color: '', note: '', autoReplyEnabled: false,
      channel: 'simulator', externalId: null, createdAt: '', updatedAt: '', processing: {memoryEnabled: id === 'A'}})),
    messages: [message('a1', 'A', 1, '我喜欢跑步'), message('b1', 'B', 2, 'OTHER-CONTACT-PRIVATE'),
      message('a2', 'A', 3, '周六下午去公园吧', 'self'), message('a3', 'A', 4, '行，到时候再定时间')],
    claims: [], drafts: [], jobs: [], activity: []};
}
function message(id: string, conversationId: string, sequence: number, text: string, role: Message['role'] = 'peer'): Message {
  return {id, conversationId, sequence, text, role, kind: 'text', sentAt: null, source: 'manual', externalId: null, aiAssisted: false};
}
const result = {summary: '对方说喜欢跑步，双方暂定周六去公园，具体时间待定。',
  entries: [{kind: 'preference', text: '对方说自己喜欢跑步。', sourceMessageIds: ['a1']},
    {kind: 'openTopic', text: '周六去公园的具体时间尚未定。', sourceMessageIds: ['a2', 'a3']}], openTopics: ['确认周六去公园的时间']};
function response(value: unknown = result) {return Response.json({choices: [{message: {content: JSON.stringify({...value as any,entries:(value as any).entries?.map((entry:any)=>({...entry,event:entry.kind==='event'?{kind:'other',state:'active',resolvedByMessageIds:[]}:null}))})}}]});}

test('memory compressor scopes evidence, respects independent model, and saves pending entries with hashes', async () => {
  const app = state(); app.conversations[0].processing!.memoryModel = {id: 'mem-choice', provider: 'compatible', modelPreset: 'qwen', modelName: 'picked-memory'};
  const compressed = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    const body = JSON.parse(String(init!.body)); assert.equal(body.model, 'picked-memory'); assert.doesNotMatch(String(init!.body), /OTHER-CONTACT-PRIVATE|TEST-KEY/);
    const context = JSON.parse(body.messages[1].content);
    assert.deepEqual(context.messages.map((item: any) => item.id), ['a1', 'a2', 'a3']);
    assert.deepEqual(context.allowedSourceMessageIds, ['a1', 'a2', 'a3']); assert.match(body.messages[0].content, /不总结人格/); return response();
  }});
  assert.equal(compressed.throughSequence, 4); assert.equal(compressed.sourceDigest, memoryInputDigest(app, 'A'));
  assert.equal(compressed.modelName, 'picked-memory'); assert.equal(compressed.entries.length, 2);
  assert.ok(compressed.entries.every(entry => entry.status === 'pending'));
  assert.equal(compressed.entries[0].sourceMessageHashes!.a1, messageEvidenceHash(app.messages[0]));
  assert.deepEqual(app.claims, []); assert.equal(app.conversations[0].memory, undefined);
});

test('incremental memory keeps confirmed entries only with unchanged source and omits rejected summary', async () => {
  const app = state(); const confirmed = {id: 'confirmed', kind: 'preference' as const, text: '对方说自己喜欢跑步。', sourceMessageIds: ['a1'],
    sourceMessageHashes: {a1: messageEvidenceHash(app.messages[0])}, status: 'approved' as const, createdAt: 'original-date'};
  app.conversations[0].memory = {summary: 'OLD-CONFIRMED-SUMMARY', entries: [confirmed], openTopics: [], throughSequence: 1,
    compressedMessageHashes:{a1:messageEvidenceHash(app.messages[0])},sourceDigest: 'old', provider: 'qwen', modelName: 'old-model', updatedAt: ''};
  const compressed = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    const context = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.deepEqual(context.messages.map((item: any) => item.id), ['a2', 'a3']); assert.equal(context.previousMemory.entries[0].confirmedByUser, true);
    return response({summary: '双方暂定周六去公园。', entries: [result.entries[1]], openTopics: result.openTopics});
  }});
  assert.equal(compressed.entries.find(entry => entry.id === 'confirmed')!.status, 'approved');
  assert.equal(compressed.entries.find(entry => entry.id === 'confirmed')!.createdAt, 'original-date');
  app.conversations[0].memory.entries.push({id: 'rejected', kind: 'fact', text: 'REJECTED-FACT', sourceMessageIds: ['a1'],
    sourceMessageHashes: {a1: messageEvidenceHash(app.messages[0])}, status: 'rejected', createdAt: ''});
  await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.doesNotMatch(JSON.stringify(context.previousMemory), /REJECTED-FACT|OLD-CONFIRMED-SUMMARY/);
    assert.equal(context.rejectedMemory[0].text,'REJECTED-FACT');assert.equal(context.rejectedMemory[0].untrustedSuppressionData,true);
    return response(result);
  }});
  app.messages[0].text = '我不喜欢跑步';
  const stale = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    assert.doesNotMatch(String(init!.body), /对方说自己喜欢跑步/);
    return response({summary: '周六安排待确认。', entries: [result.entries[1]], openTopics: result.openTopics});
  }});
  assert.equal(stale.entries.some(entry => entry.id === 'confirmed'), false);
});

test('memory never accepts cross-contact, future, fabricated, or unprovided source IDs', async () => {
  const app = state();
  for (const id of ['b1', 'does-not-exist', 'future-not-provided']) {
    await assert.rejects(compressContactMemory(app, 'A', undefined, {fetch: async () => response({...result,
      entries: [{kind: 'fact', text: '无效证据', sourceMessageIds: [id]}]})}), /这个会话内实际提供的消息/);
  }
  await assert.rejects(compressContactMemory(app, 'A', undefined, {fetch: async () => response({...result,
    entries: [{kind: 'fact', text: '重复证据', sourceMessageIds: ['a1', 'a1']}]})}), /实际提供/);
  await assert.rejects(compressContactMemory(app, 'A', undefined, {fetch: async () => response({...result,
    entries: [{kind: 'diagnosis', text: '不应记忆诊断', sourceMessageIds: ['a1']}]})}), /实际提供/);
  await assert.rejects(compressContactMemory(app, 'A', undefined, {fetch: async () => response({...result, hidden: true})}), /字段无效/);
});

test('memory selection processes the first chronological batch and never skips old uncompressed messages', async () => {
  const app = state(); app.messages = Array.from({length: 150}, (_, index) => message(`a${index + 1}`, 'A', index + 1, '合成消息'));
  assert.equal(memoryRemainingCount(app, 'A'), 150);
  const compressed = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    const context = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.equal(context.messages.length, 120); assert.equal(context.messages[0].id, 'a1'); assert.equal(context.messages.at(-1).id, 'a120');
    return response({summary: '合成消息摘要', entries: [{kind: 'event', text: '测试记录', sourceMessageIds: ['a120']}], openTopics: []});
  }});
  assert.equal(compressed.throughSequence, 120); app.conversations[0].memory = compressed;
  assert.equal(memoryRemainingCount(app, 'A'), 30);
  app.messages = app.messages.filter(item => item.sequence <= 120);
  let calls = 0;
  await assert.rejects(compressContactMemory(app, 'A', undefined, {fetch: async () => {calls++; return response();}}), /没有尚未压缩的新消息/);
  assert.equal(calls, 0);
});

test('large memory batches read complete long messages and leave later batches available for continuation', async () => {
  const app = state(); app.messages = Array.from({length: 150}, (_, index) => message(`a${index + 1}`, 'A', index + 1, '很长的合成内容'.repeat(1000)));
  const readIds=new Set<string>();let selectedIds:string[]=[],summaryCalls=0;
  const compressed = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    const body = JSON.parse(String(init!.body)); const context = JSON.parse(body.messages[1].content);
    assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) < 128_000);
    if(context.level!==undefined){summaryCalls++;for(const item of context.messages??[])readIds.add(item.id);return response({summary:'已读取本段完整长消息'});}
    selectedIds=context.allowedSourceMessageIds;assert.ok(selectedIds.length<120);assert.equal(selectedIds[0],'a1');
    assert.equal(context.fullHistory.coveredMessages,selectedIds.length);
    return response({summary: '有多条合成内容', entries: [{kind: 'event', text: '合成测试', sourceMessageIds: [selectedIds.at(-1)!]}], openTopics: []});
  }});
  assert.ok(compressed.throughSequence > 0 && compressed.throughSequence < 120);
  assert.ok(summaryCalls>1);assert.deepEqual(readIds,new Set(selectedIds));assert.deepEqual(Object.keys(compressed.compressedMessageHashes!),selectedIds);
  app.conversations[0].memory=compressed;assert.equal(memoryRemainingCount(app,'A'),150-selectedIds.length);
});

test('memory digest includes source evidence changes, config and contact basis but ignores other contacts', () => {
  const app = state(); const digest = memoryInputDigest(app, 'A');
  app.messages[1].text = 'different other'; assert.equal(memoryInputDigest(app, 'A'), digest);
  app.messages[0].text += 'changed'; assert.notEqual(memoryInputDigest(app, 'A'), digest);
  const next = memoryInputDigest(app, 'A'); app.settings.memory!.modelName = 'another-memory'; assert.notEqual(memoryInputDigest(app, 'A'), next);
  app.conversations[0].processing!.memoryEnabled = false; assert.throws(() => memoryInputDigest(app, 'A'), /开启记忆/);
});

test('rejected unchanged memory survives repeated compression and cannot return as a pending item', async () => {
  const app = state(); const source = app.messages[0];
  const rejected = {id: 'rejected-tombstone', kind: 'fact' as const, text: '已拒绝的推测', sourceMessageIds: ['a1'],
    sourceMessageHashes: {a1: messageEvidenceHash(source)}, status: 'rejected' as const, createdAt: 'original-rejection'};
  const approved = {...rejected, id: 'keep-source', kind: 'preference' as const, text: '对方说自己喜欢跑步。', status: 'approved' as const};
  app.conversations[0].memory = {summary: '无需要复用的摘要', entries: [approved, rejected], openTopics: [], throughSequence: 1,
    sourceDigest: 'old', provider: 'qwen', modelName: 'old', updatedAt: ''};
  for (let pass = 0; pass < 2; pass++) {
    if (pass) app.messages.push(message('a4', 'A', 5, '又一条新消息'));
    const compressed = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
      const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
      assert.doesNotMatch(JSON.stringify(context.previousMemory), /已拒绝的推测/);
      assert.equal(context.rejectedMemory[0].text,'已拒绝的推测');assert.equal(context.rejectedMemory[0].rejectedByUser,true);
      return response({summary: '已有对话的新摘要', entries: [{kind: rejected.kind, text: rejected.text, sourceMessageIds: rejected.sourceMessageIds}], openTopics: []});
    }});
    assert.deepEqual(compressed.entries.find(entry => entry.id === rejected.id), rejected);
    assert.equal(compressed.entries.filter(entry => entry.text === rejected.text).length, 1);
    assert.ok(!compressed.entries.some(entry => entry.text === rejected.text && entry.status !== 'rejected'));
    app.conversations[0].memory = compressed;
  }
});

test('stable processed hashes find a late older insertion after sequence renumbering and a changed old message', async () => {
  const app = state(); let calls = 0;
  app.conversations[0].memory = await compressContactMemory(app, 'A', undefined, {fetch: async () => {calls++; return response();}});
  assert.equal(memoryRemainingCount(app, 'A'), 0);
  for (const message of app.messages.filter(message => message.conversationId === 'A')) message.sequence++;
  app.messages.push(message('late-old', 'A', 1, '补读到一条较早的真实消息'));
  assert.equal(memoryRemainingCount(app, 'A'), 1);
  const inserted = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    calls++; const context = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.deepEqual(context.messages.map((message: any) => message.id), ['late-old']);
    return response({summary: '包括补读旧消息的摘要', entries: [{kind: 'event', text: '补读到旧消息', sourceMessageIds: ['late-old']}], openTopics: []});
  }});
  app.conversations[0].memory = inserted;
  assert.equal(memoryRemainingCount(app, 'A'), 0); assert.equal(inserted.throughSequence, 5);
  const old = app.messages.find(message => message.id === 'a1')!;old.text = '我已经不喜欢跑步了';
  assert.equal(memoryRemainingCount(app, 'A'), 1);
  const edited = await compressContactMemory(app, 'A', undefined, {fetch: async (_url, init) => {
    calls++; const context = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.deepEqual(context.messages.map((message: any) => message.id), ['a1']);
    assert.equal(context.previousMemory.summary, '');
    return response({summary: '包含修正后发言的摘要', entries: [{kind: 'preference', text: '对方明确说已不喜欢跑步', sourceMessageIds: ['a1']}], openTopics: []});
  }});
  app.conversations[0].memory = edited;
  assert.equal(edited.compressedMessageHashes!.a1, messageEvidenceHash(old));
  assert.equal(memoryRemainingCount(app, 'A'), 0);assert.equal(calls, 3);
});

test('full prior memory, evidence IDs and manual basis fit a dynamic input budget without marking postponed messages processed', async () => {
  const app=state();app.messages=[];
  const sources=Array.from({length:384},(_,index)=>message(randomUUID(),'A',index+1,'旧消息'));
  const hashes=Object.fromEntries(sources.map(source=>[source.id,messageEvidenceHash(source)]));
  const entries=Array.from({length:32},(_,index)=>({id:randomUUID(),kind:'event' as const,text:'合'.repeat(300),
    sourceMessageIds:sources.slice(index*12,index*12+12).map(source=>source.id),sourceMessageHashes:hashes,status:'approved' as const,createdAt:''}));
  app.messages.push(...sources);
  app.conversations[0].basisFacts=Array.from({length:12},()=>({id:randomUUID(),category:'fact' as const,content:'合'.repeat(300),
    sourceNote:'成'.repeat(160),createdAt:'',updatedAt:''}));
  app.conversations[0].memory={summary:'旧'.repeat(1200),entries,openTopics:Array.from({length:8},()=> '题'.repeat(200)),
    throughSequence:384,compressedMessageHashes:hashes,sourceDigest:'old',provider:'qwen',modelName:'old',updatedAt:''};
  app.conversations[0].memory.entries.push(...Array.from({length:32},(_,index)=>({...entries[index],id:randomUUID(),text:'拒'.repeat(160),status:'rejected' as const})));
  const fresh=Array.from({length:120},(_,index)=>message(randomUUID(),'A',385+index,'新'.repeat(1400)));
  app.messages.push(...fresh);
  let sentIds:string[]=[];
  const compressed=await compressContactMemory(app,'A',undefined,{fetch:async(_url,init)=>{
    const body=JSON.parse(String(init!.body));const context=JSON.parse(body.messages[1].content);
    assert.ok(Buffer.byteLength(JSON.stringify(context))<=90_000);
    assert.ok(Buffer.byteLength(JSON.stringify(context.rejectedMemory))<=8000);assert.ok(context.rejectedMemory.length>0);
    assert.ok(Buffer.byteLength(JSON.stringify(body.messages))<=120_000);
    sentIds=context.messages.map((item:any)=>item.id);
    assert.ok(sentIds.length>0&&sentIds.length<12,'prior state must reduce the previously fixed-size message batch');
    assert.deepEqual(sentIds,fresh.slice(0,sentIds.length).map(source=>source.id));
    return response({summary:'合成整理后的摘要',entries:[],openTopics:[]});
  }});
  app.conversations[0].memory=compressed;
  assert.equal(memoryRemainingCount(app,'A'),120-sentIds.length);
  assert.equal(compressed.throughSequence,384+sentIds.length);
  for(const source of fresh)assert.equal(Object.hasOwn(compressed.compressedMessageHashes!,source.id),sentIds.includes(source.id));
});

test('compression preserves manually edited notes, summary and topics without demanding chat evidence',async()=>{
  const app=state();
  const manual={id:'manual-note',kind:'fact' as const,text:'我补充的真实背景',sourceMessageIds:[],status:'approved' as const,origin:'manual' as const,createdAt:'manual-date',updatedAt:'manual-updated'};
  app.conversations[0].memory={summary:'这是我亲自改写的摘要',summaryOrigin:'manual',summaryUpdatedAt:'summary-date',entries:[manual],
    openTopics:['我手动补充的下一件事'],openTopicsOrigin:'manual',openTopicsUpdatedAt:'topics-date',throughSequence:0,compressedMessageHashes:{},
    sourceDigest:'manual',provider:'manual',modelName:'手动补充',updatedAt:'manual-date'};
  const compressed=await compressContactMemory(app,'A',undefined,{fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);assert.equal(context.manualNotes[0].text,manual.text);
    assert.match(context.manualNotes[0].source,/手动/);
    return response({summary:'模型的新摘要不能覆盖手动摘要',entries:[{kind:'fact',text:manual.text,sourceMessageIds:['a1']}],openTopics:['模型的新话题']});
  }});
  assert.deepEqual(compressed.entries,[manual]);assert.equal(compressed.summary,'这是我亲自改写的摘要');assert.deepEqual(compressed.openTopics,['我手动补充的下一件事']);
  assert.equal(compressed.summaryOrigin,'manual');assert.equal(compressed.summaryUpdatedAt,'summary-date');assert.equal(compressed.openTopicsOrigin,'manual');assert.equal(compressed.openTopicsUpdatedAt,'topics-date');
});

test('protected manual notes do not use the thirty-two model-item capacity or lose source-free additions',async()=>{
  const app=state();const notes=Array.from({length:40},(_,index)=>({id:`manual-${index}`,kind:'fact' as const,text:`手动背景 ${index}`,sourceMessageIds:[],
    status:'approved' as const,origin:'manual' as const,createdAt:''}));
  app.conversations[0].memory={summary:'',entries:notes,openTopics:[],throughSequence:0,compressedMessageHashes:{},sourceDigest:'old',provider:'manual',modelName:'手动补充',updatedAt:''};
  const compressed=await compressContactMemory(app,'A',undefined,{fetch:async()=>response(result)});
  assert.deepEqual(compressed.entries.filter(entry=>entry.origin==='manual'),notes);assert.equal(compressed.entries.filter(entry=>entry.origin==='model').length,2);
});

test('editing an older manual note keeps it in the bounded prompt without changing stored note order',async()=>{
  const app=state();const notes=Array.from({length:45},(_,index)=>({id:`manual-${index}`,kind:'fact' as const,text:`手动背景 ${index}`,sourceMessageIds:[],
    status:'approved' as const,origin:'manual' as const,createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z'}));
  notes[0].text='刚刚修改的较早手动记忆';notes[0].updatedAt='2026-10-14T00:00:00Z';
  app.conversations[0].memory={summary:'',entries:notes,openTopics:[],throughSequence:0,compressedMessageHashes:{},sourceDigest:'old',provider:'manual',modelName:'手动补充',updatedAt:''};
  const compressed=await compressContactMemory(app,'A',undefined,{fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.ok(context.manualNotes.some((entry:any)=>entry.text===notes[0].text));assert.equal(context.manualNotes.at(-1).text,notes[0].text);
    assert.ok(context.manualNotes.length<=32);return response(result);
  }});
  assert.deepEqual(compressed.entries.filter(entry=>entry.origin==='manual'),notes);
});
