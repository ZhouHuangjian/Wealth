import test from 'node:test';
import assert from 'node:assert/strict';
import type {AppState,Conversation} from '../shared/types.js';
import {generateDrafts} from '../server/generation.js';
import {analyzeContactMessage} from '../server/contact-insights.js';
import {generateContactBasis} from '../server/contact-basis.js';
import {compressContactMemory} from '../server/contact-memory.js';

type History=NonNullable<NonNullable<Conversation['wechat']>['history']>;
function state(status?:History['status']):AppState{
  return {version:1,settings:{provider:'compatible',modelUrl:'http://127.0.0.1:11435/v1',modelName:'reply-fixture',apiKey:'',allowRemoteModel:false,
    autoReplyEnabled:false,autoReplyMode:'draft',replyDelaySeconds:0,cooldownSeconds:0,dailyLimit:20,quietHoursEnabled:false,quietStart:'23:00',quietEnd:'08:00',
    analysis:{provider:'compatible',modelUrl:'http://127.0.0.1:11435/v1',modelName:'analysis-fixture',useReplyApiKey:false,allowRemoteModel:false},
    memory:{provider:'compatible',modelUrl:'http://127.0.0.1:11435/v1',modelName:'memory-fixture',useReplyApiKey:false,allowRemoteModel:false}},
    conversations:[{id:'contact',name:'合成联系人',avatar:'',color:'',note:'',autoReplyEnabled:false,channel:'wechat',externalId:'synthetic-peer',createdAt:'',updatedAt:'',
      processing:{intentEnabled:true,memoryEnabled:true},wechat:{enabled:true,initialized:true,cursor:'100',accountFingerprint:'synthetic-account',lastCheckedAt:null,status:'ready',detail:'',
        ...(status?{history:{status,cursor:'50',offset:1,scanned:51,added:51,lastCheckedAt:null,detail:'合成读取状态'}}:{})}}],
    messages:[{id:'m1',conversationId:'contact',sequence:1,role:'self',text:'你好',kind:'text',source:'wechat',externalId:'opaque-1',sentAt:null,aiAssisted:false},
      {id:'m2',conversationId:'contact',sequence:2,role:'peer',text:'今天忙吗',kind:'text',source:'wechat',externalId:'opaque-2',sentAt:null,aiAssisted:false}],
    claims:[],drafts:[],jobs:[],activity:[]};
}
function response(request:RequestInit){
  const body=JSON.parse(String(request.body)),system=body.messages[0].content as string;
  const content=body.model==='reply-fixture'?{replies:Array.from({length:3},()=>({text:'合成回复',label:'自然',reason:'依据合成上下文'}))}
    :body.model==='analysis-fixture'?{emotions:[],replyReview:null,intents:[{label:'询问',percentage:100}],affinity:null,uncertainty:'合成测试'}
      :system.includes('基础资料整理助手')?{facts:[]}:{summary:'合成记忆',entries:[],openTopics:[]};
  return Response.json({choices:[{message:{content:JSON.stringify(content)}}]});
}

test('known incomplete historical reads cannot silently generate replies, intent, basis or memory from a partial conversation',async t=>{
  let calls=0;const fake=async(_url:unknown,init?:RequestInit)=>{calls++;return response(init!);};t.mock.method(globalThis,'fetch',fake);
  const catchingUp=state('complete');catchingUp.conversations[0].wechat!.history!.tail={cursor:'100',offset:1};
  for(const app of [...(['pending','running','error'] as const).map(status=>state(status)),catchingUp]){
    await assert.rejects(generateDrafts(app,'contact'),/历史|补齐|读取/);
    await assert.rejects(analyzeContactMessage(app,'contact','m2',undefined,{fetch:fake}),/历史|补齐|读取/);
    await assert.rejects(generateContactBasis(app,'contact',undefined,{fetch:fake}),/历史|补齐|读取/);
    await assert.rejects(compressContactMemory(app,'contact',undefined,{fetch:fake}),/历史|补齐|读取/);
  }
  assert.equal(calls,0,'readiness failures do not consume model tokens');
});

test('completed history and legacy bindings without a history checkpoint keep all four explicit features usable',async t=>{
  let calls=0;const fake=async(_url:unknown,init?:RequestInit)=>{calls++;return response(init!);};t.mock.method(globalThis,'fetch',fake);
  for(const status of [undefined,'complete'] as const){const app=state(status);
    assert.equal((await generateDrafts(app,'contact')).length,3);
    assert.equal((await analyzeContactMessage(app,'contact','m2',undefined,{fetch:fake})).intents[0].label,'询问');
    assert.deepEqual((await generateContactBasis(app,'contact',undefined,{fetch:fake})).facts,[]);
    assert.equal((await compressContactMemory(app,'contact',undefined,{fetch:fake})).summary,'合成记忆');
  }
  assert.equal(calls,8);
});
