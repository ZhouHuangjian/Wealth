import test from 'node:test';
import assert from 'node:assert/strict';
import type {AppState,Message} from '../shared/types.js';
import {basisInputDigest,generateContactBasis} from '../server/contact-basis.js';
import {messageEvidenceHash} from '../server/contact-evidence.js';

function message(id:string,cid:string,sequence:number,text:string,role:Message['role']='peer'):Message {
  return {id,conversationId:cid,sequence,text,role,kind:'text',sentAt:null,source:'manual',externalId:null,aiAssisted:false};
}
function state():AppState {
  return {version:1,settings:{provider:'demo',modelUrl:'http://localhost:11434',modelName:'',apiKey:'',allowRemoteModel:false,
    autoReplyEnabled:false,autoReplyMode:'draft',replyDelaySeconds:0,cooldownSeconds:0,dailyLimit:20,quietHoursEnabled:false,quietStart:'23:00',quietEnd:'08:00',
    memory:{provider:'compatible',modelUrl:'http://127.0.0.1:11435/v1',modelName:'basis-default',useReplyApiKey:false,allowRemoteModel:false}},
    conversations:['A','B'].map(id=>({id,name:id,avatar:id,color:'',note:'',autoReplyEnabled:false,channel:'simulator',externalId:null,createdAt:'',updatedAt:''})),
    messages:[message('a1','A',1,'我喜欢游泳'),message('b1','B',2,'OTHER-PERSON-PRIVATE'),message('a2','A',3,'我喜欢登山','self'),
      {...message('a3','A',4,'[图片]'),kind:'image',mediaStatus:'recognized',imageRecognition:{summary:'图片中的文字：我想结婚',visibleText:'我想结婚',facts:[],provider:'qwen',modelName:'vision',recognizedAt:''}}],
    claims:[],drafts:[],jobs:[],activity:[]};
}
const facts={facts:[{category:'interest',content:'对方提到喜欢游泳。',sourceMessageIds:['a1']}]};
function response(value:unknown=facts){return Response.json({choices:[{message:{content:JSON.stringify(value)}}]});}

test('opponent basis generation uses selected memory model, peer speech evidence and scoped stable provenance',async()=>{
  const app=state();app.conversations[0].processing={memoryModel:{id:'basis-model',provider:'compatible',modelName:'picked-basis'}};
  const before=JSON.stringify(app);
  const generated=await generateContactBasis(app,'A',undefined,{fetch:async(_url,init)=>{
    const body=JSON.parse(String(init!.body));assert.equal(body.model,'picked-basis');assert.doesNotMatch(String(init!.body),/OTHER-PERSON-PRIVATE|我想结婚/);
    const context=JSON.parse(body.messages[1].content);assert.deepEqual(context.allowedSourceMessageIds,['a1']);
    assert.deepEqual(context.messages.map((item:any)=>item.speaker),['peer','self']);
    assert.match(body.messages[0].content,/不得推断人格/);assert.match(body.messages[0].content,/manualFacts/);return response();
  }});
  assert.equal(generated.facts.length,1);assert.equal(generated.facts[0].origin,'model');assert.equal(generated.modelName,'picked-basis');
  assert.deepEqual(generated.facts[0].sourceMessageHashes,{a1:messageEvidenceHash(app.messages[0])});
  assert.match(generated.facts[0].sourceNote,/对方/);assert.equal(generated.sourceDigest,basisInputDigest(app,'A'));assert.equal(generated.sourceMessageCount,1);
  assert.equal(JSON.stringify(app),before);
});

test('existing manual and edited model facts remain untouched and exact duplicates are not proposed',async()=>{
  const app=state();app.conversations[0].basisFacts=[{id:'legacy-manual',category:'interest',content:'对方提到喜欢游泳。',sourceNote:'用户维护',createdAt:'old',updatedAt:'old'},
    {id:'edited-model',category:'fact',content:'用户已修正的信息',sourceNote:'改正',origin:'manual',createdAt:'old',updatedAt:'later',sourceMessageIds:['a1']}];
  const before=JSON.stringify(app.conversations[0].basisFacts);
  const generated=await generateContactBasis(app,'A',undefined,{fetch:async()=>response()});assert.deepEqual(generated.facts,[]);
  assert.equal(JSON.stringify(app.conversations[0].basisFacts),before);
});

test('foundation schema rejects self, other-contact, picture and fabricated sources, traits and extra fields',async()=>{
  const invalid=[...['a2','b1','a3','missing'].map(id=>({facts:[{...facts.facts[0],sourceMessageIds:[id]}]})),
    {facts:[{...facts.facts[0],category:'personality'}]},{facts:[{...facts.facts[0],reason:'extra'}]},
    {facts:[{...facts.facts[0],sourceMessageIds:['a1','a1']}]},{facts:Array.from({length:21},()=>facts.facts[0])},
    {...facts,hidden:'extra'}];
  for(const value of invalid)await assert.rejects(generateContactBasis(state(),'A',undefined,{fetch:async()=>response(value)}),/无效|对方实际/);
});

test('undated or old facts cannot be presented as current status',async()=>{
  const app=state();const current={facts:[{category:'current_status',content:'对方近期工作繁忙。',sourceMessageIds:['a1']}]};
  await assert.rejects(generateContactBasis(app,'A',undefined,{fetch:async()=>response(current)}),/近期可核对/);
  app.messages[0].sentAt='2020-01-01T00:00:00Z';await assert.rejects(generateContactBasis(app,'A',undefined,{fetch:async()=>response(current)}),/近期可核对/);
  app.messages[0].text='我最近工作比较繁忙';app.messages[0].sentAt=new Date().toISOString();const generated=await generateContactBasis(app,'A',undefined,{fetch:async()=>response(current)});
  assert.equal(generated.facts[0].category,'current_status');assert.match(generated.facts[0].sourceNote,new RegExp(app.messages[0].sentAt.slice(0,10)));
});

test('empty information is an allowed outcome, while no actual peer speech avoids any model call',async()=>{
  const app=state();assert.deepEqual((await generateContactBasis(app,'A',undefined,{fetch:async()=>response({facts:[]})})).facts,[]);
  app.messages=app.messages.filter(message=>message.role==='self'||message.conversationId==='B'||message.kind==='image');let calls=0;
  await assert.rejects(generateContactBasis(app,'A',undefined,{fetch:async()=>{calls++;return response();}}),/没有可用于/);assert.equal(calls,0);
});

test('recognized voice can provide opponent evidence and digest changes with transcript, model and manual corrections',async()=>{
  const app=state();const before=basisInputDigest(app,'A');app.messages[1].text='OTHER-DIFFERENT';assert.equal(basisInputDigest(app,'A'),before);
  app.messages.push({...message('voice','A',5,'[语音]'),kind:'voice',mediaStatus:'recognized',audioRecognition:{text:'我一般周末游泳',provider:'qwen',modelName:'voice',recognizedAt:''}});
  const digest=basisInputDigest(app,'A');assert.notEqual(digest,before);
  const generated=await generateContactBasis(app,'A',undefined,{fetch:async()=>response({facts:[{...facts.facts[0],sourceMessageIds:['voice']}]})});
  assert.equal(generated.facts[0].sourceMessageHashes!.voice,messageEvidenceHash(app.messages.at(-1)!));
  app.messages.at(-1)!.audioRecognition!.text+='更新';assert.notEqual(basisInputDigest(app,'A'),digest);
  const next=basisInputDigest(app,'A');app.settings.memory!.modelName='different';assert.notEqual(basisInputDigest(app,'A'),next);
});

test('large basis histories cover every statement in bounded batches rather than dropping the oldest window',async()=>{
  const app=state();app.messages=Array.from({length:300},(_,index)=>message(`a-${index}`,'A',index+1,'很长的发言'.repeat(1000)));
  const readIds=new Set<string>(),evidenceIds=new Set<string>();let finalCalls=0,summaryCalls=0;
  const result=await generateContactBasis(app,'A',undefined,{fetch:async(_url,init)=>{
    const body=JSON.parse(String(init!.body)),context=JSON.parse(body.messages[1].content);
    assert.ok(Buffer.byteLength(JSON.stringify(body.messages))<128_000);
    if(context.level!==undefined){summaryCalls++;for(const item of context.messages??[])readIds.add(item.id);return response({summary:'完整读取本批合成资料'});}
    finalCalls++;for(const id of context.allowedSourceMessageIds)evidenceIds.add(id);for(const item of context.messages)readIds.add(item.id);
    assert.equal(context.fullHistory.coveredMessages,context.allowedSourceMessageIds.length);
    return response({facts:[{category:'fact',content:`对方在${context.allowedSourceMessageIds[0]}有合成发言。`,sourceMessageIds:[context.allowedSourceMessageIds[0]]}]});
  }});
  assert.ok(summaryCalls>1);assert.ok(finalCalls>1);assert.equal(result.sourceMessageCount,300);assert.equal(result.facts.length,finalCalls);
  const expected=new Set(app.messages.map(item=>item.id));assert.deepEqual(readIds,expected);assert.deepEqual(evidenceIds,expected);
});

test('basis extraction reuses completed batch results and rereads source changes beyond a displayed text prefix',async()=>{
  const app=state();app.messages=Array.from({length:260},(_,index)=>message(`a-${index}`,'A',index+1,`合成发言 ${index} ${'长'.repeat(1600)}`));
  const saved=new Map<string,unknown>();let calls=0;
  const dependencies={historyCache:{get:(ns:string,key:string)=>saved.get(`${ns}:${key}`),set:(ns:string,key:string,value:unknown)=>{saved.set(`${ns}:${key}`,value);}},fetch:async(_url:unknown,init?:RequestInit)=>{
    calls++;const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    return response(context.level!==undefined?{summary:'完整合成分段摘要'}:{facts:[]});
  }};
  await generateContactBasis(app,'A',undefined,dependencies);const afterFirst=calls;assert.ok(afterFirst>2);
  await generateContactBasis(app,'A',undefined,dependencies);assert.equal(calls,afterFirst);
  const before=basisInputDigest(app,'A');app.messages[0].text+='尾部真实源修正';assert.notEqual(basisInputDigest(app,'A'),before);
  await generateContactBasis(app,'A',undefined,dependencies);assert.ok(calls>afterFirst);
});
