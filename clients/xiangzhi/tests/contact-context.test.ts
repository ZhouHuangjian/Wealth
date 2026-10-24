import test from 'node:test';
import assert from 'node:assert/strict';
import type {AppState, ContactBasisFact, ContactMemory, ContactMemoryEntry, Message} from '../shared/types.js';
import {contactBasisContext, currentModelMemoryRecap, memoryContext, validMemoryEntries} from '../server/contact-context.js';
import {messageEvidenceHash} from '../server/contact-evidence.js';
import {contactReplyMemoryContext} from '../server/generation.js';

function fixture(): AppState {
  return {version: 1, settings: {provider: 'demo', modelUrl: '', modelName: '', apiKey: '', allowRemoteModel: false,
    autoReplyEnabled: false, autoReplyMode: 'draft', replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
    quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00'},
    conversations: ['a', 'b'].map(id => ({id, name: id, avatar: '', color: '', note: '', autoReplyEnabled: false,
      channel: 'simulator', externalId: null, createdAt: '', updatedAt: '', processing: {memoryEnabled: true}})),
    messages: [message('a1', 'a', 1), message('a2', 'a', 2), message('b1', 'b', 1), message('a3', 'a', 3)],
    claims: [], drafts: [], jobs: [], activity: []};
}
function message(id: string, conversationId: string, sequence: number): Message {
  return {id, conversationId, sequence, role: 'peer', text: `合成发言 ${id}`, sentAt: null, source: 'manual', externalId: null, aiAssisted: false};
}
function basis(content: string, origin?: ContactBasisFact['origin']): ContactBasisFact {
  return {id: content, category: 'interest', content, sourceNote: '测试来源', origin, createdAt: '', updatedAt: ''};
}
function entry(text: string, origin?: ContactMemoryEntry['origin']): ContactMemoryEntry {
  return {id: text, kind: 'event', text, origin, sourceMessageIds: [], status: 'approved', createdAt: ''};
}
function memory(): ContactMemory {
  return {summary: '模型生成的回顾', entries: [], openTopics: ['模型生成的话题'], throughSequence: 1,
    sourceDigest: 'synthetic', provider: 'compatible', modelName: 'model-test', updatedAt: ''};
}

test('manual and extracted basis keep their source distinction and model evidence is scoped and bounded by the target sequence', () => {
  const state = fixture(), contact = state.conversations[0], old = state.messages[0], foreign = state.messages[2], future = state.messages[3];
  const modeled = {...basis('当前会话提取的背景', 'model'), sourceMessageIds: [old.id], sourceMessageHashes: {[old.id]: messageEvidenceHash(old)}};
  contact.basisFacts = [basis('旧版人工资料'), basis('人工编辑的资料', 'manual'), modeled,
    {...modeled, id: 'foreign', content: '外人背景不能混入', sourceMessageIds: [foreign.id], sourceMessageHashes: {[foreign.id]: messageEvidenceHash(foreign)}},
    {...modeled, id: 'future', content: '较晚发言的背景不能用于早期分析', sourceMessageIds: [future.id], sourceMessageHashes: {[future.id]: messageEvidenceHash(future)}},
    {...modeled, id: 'stale', content: '失效证据不能使用', sourceMessageHashes: {[old.id]: 'outdated'}},
    {...modeled, id: 'missing', content: '无来源证据不能使用', sourceMessageIds: []}];
  const projected = contactBasisContext(contact, state, 2);
  assert.deepEqual(projected.map(fact => fact.content), ['当前会话提取的背景', '旧版人工资料', '人工编辑的资料']);
  assert.equal(projected[1].origin, 'manual'); assert.equal(projected[0].origin, 'model');
  assert.match(projected[0].source, /未确认背景/); assert.equal(projected[0].uncertain, true);
  assert.deepEqual(contactBasisContext(contact).map(fact => fact.content), ['旧版人工资料', '人工编辑的资料']);
  modeled.origin = 'manual'; modeled.sourceMessageHashes = {[old.id]: 'outdated'};
  assert.equal(contactBasisContext(contact, state, 2).find(fact => fact.id === modeled.id)!.origin, 'manual');
});

test('manual memory notes need no fabricated chat source while model notes retain provenance requirements', () => {
  const state = fixture(), contact = state.conversations[0], old = state.messages[0];
  contact.memory = {...memory(), entries: [entry('人工补充事项', 'manual'),
    {...entry('人工备注不应输出遗留的外人来源', 'manual'), sourceMessageIds: ['b1']},
    {...entry('有效模型记忆', 'model'), sourceMessageIds: [old.id], sourceMessageHashes: {[old.id]: messageEvidenceHash(old)}},
    entry('缺少证据的模型记忆', 'model'), {...entry('被拒绝的人工备注', 'manual'), status: 'rejected'}]};
  assert.deepEqual(validMemoryEntries(state, contact, 2).map(item => item.text), ['有效模型记忆', '人工补充事项', '人工备注不应输出遗留的外人来源']);
  const projected = memoryContext(state, contact, 2)!;
  assert.deepEqual(projected.entries[0].sourceMessageIds, [old.id]); assert.equal(projected.entries[0].origin, 'model');
  assert.deepEqual(projected.entries[1].sourceMessageIds, []);
  assert.equal(projected.entries[2].origin, 'manual'); assert.deepEqual(projected.entries[2].sourceMessageIds, []);
  assert.ok(!JSON.stringify(projected).includes('被拒绝的人工备注')); assert.equal(projected.summary, '');
});

test('edited user recap and topics remain distinct user context despite invalidated old model sources', () => {
  const state = fixture(), contact = state.conversations[0];
  contact.memory = {...memory(), modelRecapInvalidated: true, summaryOrigin: 'manual', openTopicsOrigin: 'manual',
    summary: '用户补充回顾 person@example.com 13812345678', openTopics: ['用户补充的未完话题'],
    compressedMessageHashes: {missing: 'old-hash'}, entries: [entry('用户补充的备注', 'manual')]};
  const projected = memoryContext(state, contact, 2)!;
  assert.match(projected.summary, /用户补充回顾/); assert.doesNotMatch(projected.summary, /person@example.com|13812345678/);
  assert.match(projected.summarySource, /用户补充/); assert.deepEqual(projected.openTopics, ['用户补充的未完话题']);
  assert.match(projected.openTopicsSource, /用户补充/); assert.equal(projected.entries[0].origin, 'manual');
  assert.equal(currentModelMemoryRecap(state, contact), false);
});

test('manual notes cannot revive an invalidated model recap and independently edited topics do not change summary origin', () => {
  const state = fixture(), contact = state.conversations[0], old = state.messages[0];
  contact.memory = {...memory(), modelRecapInvalidated: true, openTopicsOrigin: 'manual', openTopics: ['用户补充的话题'],
    entries: [entry('已编辑的人工事项', 'manual')], compressedMessageHashes: {[old.id]: messageEvidenceHash(old)}};
  let projected = memoryContext(state, contact, 2)!;
  assert.equal(projected.summary, ''); assert.deepEqual(projected.openTopics, ['用户补充的话题']);
  assert.equal(currentModelMemoryRecap(state, contact), false);
  contact.memory.modelRecapInvalidated = false;
  projected = memoryContext(state, contact, 2)!;
  assert.equal(projected.summary, '模型生成的回顾'); assert.match(projected.summarySource, /模型未确认/);
  contact.memory.compressedMessageHashes = {};
  assert.equal(currentModelMemoryRecap(state, contact), false, 'manual notes alone cannot establish old model recap provenance');
});

test('manual recap still respects the memory switch and its edited-through sequence for earlier sentence analysis', () => {
  const state = fixture(), contact = state.conversations[0];
  contact.memory = {...memory(), summaryOrigin: 'manual', openTopicsOrigin: 'manual', throughSequence: 3,
    summary: '晚于目标句补充的人工回顾', entries: [entry('人工备注', 'manual')]};
  assert.equal(memoryContext(state, contact, 2), null);
  assert.match(memoryContext(state, contact, 3)!.summary, /人工回顾/);
  contact.processing!.memoryEnabled = false;
  assert.equal(memoryContext(state, contact, 3), null);
});

test('bounded context favors recently edited manual facts and notes without reordering the stored library', () => {
  const state = fixture(), contact = state.conversations[0], source = state.messages[0];
  const older = '2026-10-01T00:00:00Z', newer = '2026-10-13T00:00:00Z', edited = '2026-10-14T00:00:00Z';
  const editedFact = {...basis('旧条目今天由用户更新'), createdAt: older, updatedAt: edited};
  contact.basisFacts = [editedFact,
    ...Array.from({length: 45}, (_, index) => ({...basis(`其他人工资料${index}`), createdAt: newer, updatedAt: newer})),
    ...Array.from({length: 20}, (_, index) => ({...basis(`新提取模型资料${index}`, 'model'), createdAt: edited, updatedAt: edited,
      sourceMessageIds: [source.id], sourceMessageHashes: {[source.id]: messageEvidenceHash(source)}}))];
  contact.memory = {...memory(), entries: [{...entry('旧人工备注今天由用户修改', 'manual'), createdAt: older, updatedAt: edited},
    ...Array.from({length: 45}, (_, index) => ({...entry(`其他人工备注${index}`, 'manual'), createdAt: newer, updatedAt: newer}))]};
  const factOrder = contact.basisFacts.map(fact => fact.id), noteOrder = contact.memory.entries.map(note => note.id);
  const basisContext = contactBasisContext(contact, state);
  assert.equal(basisContext.length, 12); assert.ok(basisContext.some(fact => fact.content === editedFact.content));
  const remembered = memoryContext(state, contact, 3)!;
  assert.equal(remembered.entries.length, 24); assert.equal(remembered.entries.at(-1)!.text, '旧人工备注今天由用户修改');
  const replyContext = contactReplyMemoryContext(state, contact.id);
  assert.equal(replyContext.confirmedContactFacts.length, 40);
  assert.equal(replyContext.confirmedContactFacts.at(-1)!.content, editedFact.content);
  assert.equal(replyContext.unconfirmedContactFacts.length, 20);
  assert.equal(replyContext.reviewedConversationMemory!.confirmedEntries.length, 32);
  assert.equal(replyContext.reviewedConversationMemory!.confirmedEntries.at(-1)!.text, '旧人工备注今天由用户修改');
  assert.deepEqual(contact.basisFacts.map(fact => fact.id), factOrder); assert.deepEqual(contact.memory.entries.map(note => note.id), noteOrder);
});
