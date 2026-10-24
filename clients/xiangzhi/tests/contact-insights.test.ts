import test from 'node:test';
import {AFFINITY_DIMENSIONS} from '../shared/analysis-rubric.js';
import assert from 'node:assert/strict';
import type { AppState, Message } from '../shared/types.js';
import { analyzeContactMessage, insightsInputDigest } from '../server/contact-insights.js';
import { messageEvidenceHash } from '../server/contact-evidence.js';

export function insightState(): AppState {
  return {version: 1, settings: {provider: 'compatible', modelPreset: 'qwen', modelName: 'reply-model',
    modelUrl: 'https://synthetic-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'TEST-KEY', allowRemoteModel: true,
    autoReplyEnabled: false, autoReplyMode: 'draft', replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
    quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00',
    analysis: {provider: 'qwen', modelName: 'analysis-default', modelUrl: 'https://synthetic-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      useReplyApiKey: true, allowRemoteModel: true}},
    conversations: [{id: 'A', name: '甲', avatar: '甲', color: '', note: '', autoReplyEnabled: false,
      channel: 'simulator', externalId: null, createdAt: '', updatedAt: '', processing: {intentEnabled: true, affinityEnabled: true},
      basisFacts: [{id: 'fact-A', category: 'interest', content: '喜欢跑步', sourceNote: '手动提供', createdAt: '', updatedAt: ''}]},
    {id: 'B', name: '乙', avatar: '乙', color: '', note: '', autoReplyEnabled: false,
      channel: 'simulator', externalId: null, createdAt: '', updatedAt: '', basisFacts: [{id: 'fact-B', category: 'fact', content: 'OTHER-CONTACT-PRIVATE', sourceNote: '', createdAt: '', updatedAt: ''}]}],
    messages: [message('a1', 'A', 1, '最近工作比较忙', 'self'), message('b1', 'B', 2, 'OTHER-CONTACT-PRIVATE'),
      message('a2', 'A', 3, '你怎么还没下班？'), message('a3', 'A', 4, 'FUTURE-PRIVATE')],
    claims: [], drafts: [], jobs: [], activity: []};
}
export function message(id: string, conversationId: string, sequence: number, text: string, role: Message['role'] = 'peer'): Message {
  return {id, conversationId, sequence, text, role, kind: 'text', sentAt: null, source: 'manual', externalId: null, aiAssisted: false};
}
const valid = {intents: [{label: '关心', percentage: 80}, {label: '询问', percentage: 20}],
  affinity: {score: 60, confidence: 25, evidence: ['询问下班情况，可能是关心，也可能仅是确认时间。']}, uncertainty: '短句存在歧义。'};
function response(content: unknown = valid, evidenceId='a2'): Response { return Response.json({choices: [{message: {content: typeof content === 'string' ? content : !('intents' in (content as any)) ? JSON.stringify(content) : JSON.stringify({...content as object,emotions:[],replyReview:null,affinity:(content as any)?.affinity?{...(content as any).affinity,dimensions:AFFINITY_DIMENSIONS.map(d=>({key:d.key,score:(content as any).affinity.score,evidenceMessageIds:[evidenceId]}))}:null})}}]}); }

test('sentence insights use only this contact up to the target, selected model and scoped manual basis', async () => {
  const state = insightState();
  state.conversations[0].processing!.analysisModel = {id: 'picked-analysis', provider: 'compatible', modelPreset: 'qwen', modelName: 'selected-analysis'};
  const result = await analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    assert.equal(body.model, 'selected-analysis'); assert.match(JSON.stringify(body.messages), /喜欢跑步/);
    assert.match(JSON.stringify(body.messages), /最近工作比较忙/);
    assert.doesNotMatch(JSON.stringify(body.messages), /OTHER-CONTACT-PRIVATE|FUTURE-PRIVATE|TEST-KEY/);
    assert.match(body.messages[0].content, /未经校准/); assert.match(body.messages[0].content, /不诊断/);
    const context = JSON.parse(body.messages[1].content); assert.equal(context.targetMessageId, 'a2'); assert.equal(context.target.text, '你怎么还没下班？');
    assert.deepEqual(context.priorMessages.map((item: any) => item.id), ['a1']); return response();
  }});
  assert.deepEqual(result.intents, valid.intents); assert.equal(result.affinity!.score, 60);
  assert.match(result.uncertainty, /未经过概率校准/); assert.equal(result.modelName, 'selected-analysis');
  assert.equal(result.inputDigest, insightsInputDigest(state, 'A', 'a2'));
});

test('future or rejected memory is excluded from an earlier utterance, even within the same contact', async () => {
  const state = insightState();
  state.conversations[0].processing!.memoryEnabled = true;
  const source = state.messages.find(item => item.id === 'a3')!;
  state.conversations[0].memory = {summary: 'FUTURE-MEMORY', entries: [{id: 'mem1', kind: 'fact', text: 'FUTURE-MEMORY',
    sourceMessageIds: ['a3'], sourceMessageHashes: {a3: messageEvidenceHash(source)}, status: 'approved', createdAt: ''}],
    openTopics: [], throughSequence: 4, sourceDigest: 'x', provider: 'qwen', modelName: 'mem', updatedAt: ''};
  await analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async (_url, init) => {
    assert.doesNotMatch(String(init!.body), /FUTURE-MEMORY/); return response();
  }});
  const older = state.messages[0];
  state.conversations[0].memory = {...state.conversations[0].memory!, summary: 'REJECTED-FACT', throughSequence: 1,
    entries: [{id: 'old', kind: 'fact', text: 'REJECTED-FACT', sourceMessageIds: [older.id],
      sourceMessageHashes: {[older.id]: messageEvidenceHash(older)}, status: 'rejected', createdAt: ''}]};
  await analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async (_url, init) => {
    assert.doesNotMatch(String(init!.body), /REJECTED-FACT/); return response();
  }});
});

test('turning off memory excludes retained local memory from analysis and its digest', async () => {
  const state = insightState(); const source = state.messages[0];
  state.conversations[0].memory = {summary: 'MEMORY-OFF-PRIVATE', entries: [{id: 'off-memory', kind: 'fact', text: 'MEMORY-OFF-PRIVATE',
    sourceMessageIds: [source.id], sourceMessageHashes: {[source.id]: messageEvidenceHash(source)}, status: 'approved', createdAt: ''}],
    openTopics: ['MEMORY-OFF-PRIVATE'], throughSequence: source.sequence, sourceDigest: 'old', provider: 'qwen', modelName: 'mem', updatedAt: ''};
  state.conversations[0].processing!.memoryEnabled = false;
  const digest = insightsInputDigest(state, 'A', 'a2');
  await analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async (_url, init) => {
    const context = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.equal(context.memory, null); assert.doesNotMatch(String(init!.body), /MEMORY-OFF-PRIVATE/); return response();
  }});
  state.conversations[0].memory!.summary = 'UPDATED-OFF-MEMORY';
  assert.equal(insightsInputDigest(state, 'A', 'a2'), digest);
  state.conversations[0].processing!.memoryEnabled = true;
  assert.notEqual(insightsInputDigest(state, 'A', 'a2'), digest);
});

test('processed message IDs keep a renumbered later summary out of earlier sentence analysis', async () => {
  const state=insightState();state.conversations[0].processing!.memoryEnabled=true;
  const later=state.messages.find(message=>message.id==='a3')!;
  state.conversations[0].memory={summary:'RENUMBERED-FUTURE-MEMORY',entries:[],openTopics:[],throughSequence:3,
    compressedMessageHashes:{[later.id]:messageEvidenceHash(later)},sourceDigest:'old',provider:'qwen',modelName:'memory',updatedAt:''};
  await analyzeContactMessage(state,'A','a2',undefined,{fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);assert.equal(context.memory,null);
    assert.doesNotMatch(String(init!.body),/RENUMBERED-FUTURE-MEMORY/);return response();
  }});
});

test('feature switches request only enabled fields and do not analyze another contact target', async () => {
  const state = insightState(); state.conversations[0].processing!.affinityEnabled = false;
  await analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async (_url, init) => {
    const context = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.equal(context.affinityEnabled, false); return response({...valid, affinity: null});
  }});
  await assert.rejects(analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async () => response()}), /好感度/);
  state.conversations[0].processing!.intentEnabled = false; state.conversations[0].processing!.affinityEnabled = true;
  await analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async () => response({...valid, intents: []})});
  await assert.rejects(analyzeContactMessage(state, 'A', 'b1'), /不属于/);
  state.conversations[0].processing!.affinityEnabled = false;
  await assert.rejects(analyzeContactMessage(state, 'A', 'a2'), /开启意图分析或好感度/);
});

test('insight schema rejects non-totaling, duplicate, diagnostic labels, missing evidence and unknown fields', async () => {
  const invalid = [
    {...valid, intents: [{label: '质问', percentage: 80}]},
    {...valid, intents: [{label: '质问', percentage: 50}, {label: '质问', percentage: 50}]},
    {...valid, intents: [{label: '精神疾病', percentage: 100}]},
    {...valid, intents: [{label: '关心', percentage: -10}, {label: '询问', percentage: 110}]},
    {...valid, intents: [{label: '关心', percentage: 99.5}, {label: '询问', percentage: 0.5}]},
    {...valid, intents: valid.intents.map(item=>({...item,reason:'额外说明不能混入固定结构'}))},
    {...valid, affinity: {score: 99, confidence: 90, evidence: []}},
    {...valid, affinity: {score: 1000, confidence: 25, evidence: ['有限线索']}},
    {...valid, hidden: 'unrequested'}, {...valid, uncertainty: ''},
  ];
  for (const item of invalid) await assert.rejects(analyzeContactMessage(insightState(), 'A', 'a2', undefined, {fetch: async () => response(item)}), /无效|100/);
});

test('insight digest tracks relevant media, basics, switches and selected model, ignoring future or other contacts', () => {
  const state = insightState(); const digest = insightsInputDigest(state, 'A', 'a2');
  state.messages.find(item => item.id === 'b1')!.text = 'different other';
  state.messages.find(item => item.id === 'a3')!.text = 'different future';
  assert.equal(insightsInputDigest(state, 'A', 'a2'), digest);
  state.messages.find(item => item.id === 'a1')!.text += '变化';
  assert.notEqual(insightsInputDigest(state, 'A', 'a2'), digest);
  const next = insightsInputDigest(state, 'A', 'a2'); state.settings.analysis!.modelName = 'different';
  assert.notEqual(insightsInputDigest(state, 'A', 'a2'), next);
});

test('picture descriptions and untranscribed media do not become a spoken intent', async () => {
  const state = insightState(); const target = state.messages.find(item => item.id === 'a2')!;
  target.kind = 'image'; target.text = '[图片，未解析]'; target.mediaStatus = 'recognized';
  target.imageRecognition = {summary: '一张写着关心措辞的卡片', visibleText: '早点休息', facts: ['有文字'],
    provider: 'qwen', modelName: 'vision', recognizedAt: ''};
  const result = await analyzeContactMessage(state, 'A', 'a2', undefined, {fetch: async (_url, init) => {
    const context = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.equal(context.targetHasAnalyzableUtterance, false); return response();
  }});
  assert.deepEqual(result.intents, [{label: '其他', percentage: 100}]); assert.match(result.uncertainty, /不能据图片/);
});

test('inline emoji and recognized custom stickers provide bounded expressions, while unresolved stickers remain unknown',async()=>{
  const state=insightState(),target=state.messages.find(item=>item.id==='a2')!;
  target.text='[微笑]😅';
  await analyzeContactMessage(state,'A','a2',undefined,{fetch:async(_url,init)=>{
    const body=JSON.parse(String(init!.body)),context=JSON.parse(body.messages[1].content);
    assert.equal(context.targetHasAnalyzableUtterance,true);
    assert.deepEqual(context.target.emojiObservation.tokens.map((token:any)=>token.value),['[微笑]','😅']);
    assert.match(body.messages[0].content,/表情符号.*表达形式/);return response();
  }});
  target.kind='emoji';target.text='[表情，待人工查看]';target.mediaStatus='recognized';
  target.imageRecognition={summary:'猫咪举着写有早安的牌子',visibleText:'早安',facts:['猫咪图形','牌子上写早安'],provider:'qwen',modelName:'vision',recognizedAt:''};
  const result=await analyzeContactMessage(state,'A','a2',undefined,{fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.equal(context.targetHasAnalyzableUtterance,true);assert.equal(context.target.imageObservation.isSticker,true);
    assert.equal(context.target.imageObservation.visibleText,'早安');return response();
  }});
  assert.deepEqual(result.intents,valid.intents);assert.equal(target.text,'[表情，待人工查看]');
  target.mediaStatus='pending';delete target.imageRecognition;
  const unknown=await analyzeContactMessage(state,'A','a2',undefined,{fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    assert.equal(context.targetHasAnalyzableUtterance,false);assert.equal(context.target.imageObservation,undefined);return response();
  }});
  assert.deepEqual(unknown.intents,[{label:'其他',percentage:100}]);
});

test('long utterance analysis reads every preceding long utterance while bounding each request and excluding later messages', async () => {
  const state = insightState(); state.messages = Array.from({length: 30}, (_, index) => message(`a${index + 1}`, 'A', index + 1, '很长的合成发言'.repeat(1000)));
  state.messages.push(message('later','A',31,'FUTURE-SENTENCE-MUST-NOT-APPEAR'));
  const readIds=new Set<string>();let finalCalls=0,summaryCalls=0;
  await analyzeContactMessage(state, 'A', 'a30', undefined, {fetch: async (_url, init) => {
    const body = JSON.parse(String(init!.body)); const context = JSON.parse(body.messages[1].content);
    assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) < 128_000);assert.doesNotMatch(String(init!.body),/FUTURE-SENTENCE/);
    if(context.level!==undefined){summaryCalls++;for(const item of context.messages??[])readIds.add(item.id);return response({summary:'已读取本段全部发言'});}
    finalCalls++;
    assert.equal(context.priorMessages.at(-1).id, 'a29'); assert.ok(context.priorMessages.length < 19);
    assert.equal(context.fullHistory.mode,'hierarchical');assert.equal(context.fullHistory.coveredMessages,30);return response();
  }});
  assert.ok(summaryCalls>1);assert.equal(finalCalls,1);assert.deepEqual(readIds,new Set(Array.from({length:30},(_,index)=>`a${index+1}`)));
});

test('analysis input revision includes the oldest message and long-message tails outside the recent preview',()=>{
  const state=insightState();state.messages=Array.from({length:40},(_,index)=>message(`a${index+1}`,'A',index+1,`原发言 ${index+1} ${'字'.repeat(2000)}`));
  const first=insightsInputDigest(state,'A','a40');state.messages[0].text+='尾部修正';assert.notEqual(insightsInputDigest(state,'A','a40'),first);
  const second=insightsInputDigest(state,'A','a40');state.messages.push(message('future','A',41,'后来的发言'));assert.equal(insightsInputDigest(state,'A','a40'),second);
  state.messages[0].kind='voice';state.messages[0].mediaStatus='recognized';state.messages[0].audioRecognition={text:'很早语音已补充的完整转写',provider:'qwen',modelName:'voice',recognizedAt:''};
  assert.notEqual(insightsInputDigest(state,'A','a40'),second);
});

test('complete history plus a full reviewed memory and manual basis still fits each analysis request',async()=>{
  const state=insightState();state.conversations[0].processing!.memoryEnabled=true;
  state.messages=Array.from({length:40},(_,index)=>message(`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,'A',index+1,'合成发言'.repeat(500)));
  const sourceIds=state.messages.slice(0,12).map(row=>row.id),hashes=Object.fromEntries(state.messages.map(row=>[row.id,messageEvidenceHash(row)]));
  state.conversations[0].memory={summary:'记'.repeat(1200),openTopics:Array.from({length:8},()=> '题'.repeat(200)),throughSequence:39,
    sourceDigest:'synthetic',provider:'qwen',modelName:'memory',updatedAt:'',compressedMessageHashes:Object.fromEntries(state.messages.slice(0,39).map(row=>[row.id,messageEvidenceHash(row)])),
    entries:Array.from({length:24},(_,index)=>({id:`entry-${index}`,kind:'event',text:`${index} ${'忆'.repeat(300)}`,sourceMessageIds:sourceIds,sourceMessageHashes:hashes,status:'approved',createdAt:''}))};
  state.conversations[0].basisFacts=Array.from({length:12},(_,index)=>({id:`basis-${index}`,category:'fact',content:'资'.repeat(300),sourceNote:'源'.repeat(160),createdAt:'',updatedAt:''}));
  let finalCalls=0;
  await analyzeContactMessage(state,'A',state.messages.at(-1)!.id,undefined,{fetch:async(_url,init)=>{
    const body=JSON.parse(String(init!.body)),context=JSON.parse(body.messages[1].content);assert.ok(Buffer.byteLength(JSON.stringify(body.messages))<=128_000);
    if(context.level!==undefined)return response({summary:'有来源的合成摘要'});
    finalCalls++;assert.equal(context.fullHistory.coveredMessages,40);return response(valid,state.messages.at(-1)!.id);
  }});
  assert.equal(finalCalls,1);
});
