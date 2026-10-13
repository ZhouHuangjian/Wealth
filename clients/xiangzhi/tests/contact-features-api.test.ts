import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import type {AppState,ContactInsights,ContactMemory,Draft} from '../shared/types.js';
import {createApplication} from '../server/app.js';
import {messageEvidenceHash} from '../server/contact-evidence.js';
import {memoryInputDigest} from '../server/contact-memory.js';
import {effectiveContactModelSettings} from '../server/contact-model.js';

type Options=Parameters<typeof createApplication>[0];
const model={provider:'compatible' as const,modelUrl:'http://127.0.0.1:11435/v1',modelName:'analysis-default',
  apiKey:'PRIVATE-ANALYSIS-KEY',useReplyApiKey:false,allowRemoteModel:false};
function analysisResult(state:AppState,cid:string,messageId:string):ContactInsights {
  return {conversationId:cid,messageId,intents:[{label:'质问',percentage:80},{label:'关心',percentage:20}],
    affinity:{score:55,confidence:20,evidence:['合成沟通线索']},uncertainty:'合成模型估计，未经校准。',provider:'compatible',
    modelName:effectiveContactModelSettings(state.settings,state.conversations.find(c=>c.id===cid)!,'analysis')!.modelName,analyzedAt:new Date().toISOString()};
}
function memoryResult(state:AppState,cid:string):ContactMemory {
  const source=state.messages.filter(m=>m.conversationId===cid&&m.role!=='system').sort((a,b)=>a.sequence-b.sequence).at(-1)!;
  return {summary:'合成对话摘要',entries:[{id:`memory-${source.id}`,kind:'event',text:'对方发来一条合成消息',sourceMessageIds:[source.id],
    sourceMessageHashes:{[source.id]:messageEvidenceHash(source)},status:'pending',createdAt:new Date().toISOString()}],openTopics:['合成待确认事项'],
    throughSequence:source.sequence,sourceDigest:memoryInputDigest(state,cid),provider:'compatible',modelName:'memory-default',updatedAt:new Date().toISOString()};
}
function gate(){let entered!:()=>void,release!:()=>void;return {ready:new Promise<void>(r=>entered=r),wait:new Promise<void>(r=>release=r),enter:()=>entered(),release:()=>release()};}

async function harness(overrides:Partial<Options>={}) {
  const dir=mkdtempSync(join(tmpdir(),'xiangzhi-contact-api-'));
  const calls={analysis:0,memory:0,send:0};
  const instance=createApplication({databasePath:join(dir,'test.sqlite'),seed:false,profileManifestPath:null,
    inspectCodex:async()=>({available:false,version:null,message:'合成测试'}),inspectWechat:()=>({available:true,message:'合成测试'}),
    queryWechat:async()=>{throw new Error('本测试不读取微信');},
    analyzeContactMessage:async(state,cid,mid)=>{calls.analysis++;return analysisResult(state,cid,mid);},
    compressContactMemory:async(state,cid)=>{calls.memory++;return memoryResult(state,cid);},
    send:async()=>{calls.send++;},...overrides});
  instance.store.update(s=>{s.settings.analysis=model;s.settings.memory={...model,modelName:'memory-default',apiKey:'PRIVATE-MEMORY-KEY'};});
  const server=instance.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session=await fetch(base+'/api/session'),{token}=await session.json() as {token:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const request=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(base+'/api'+path,{method,
    headers:{Cookie:cookie,'X-CSRF-Token':token,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const create=async(name:string)=>{const response=await request('/conversations','POST',{name,channel:'simulator'});assert.equal(response.status,201);return (await response.json()).id as string;};
  const a=await create('甲'),b=await create('乙');
  const add=async(cid:string,text='合成发言')=>{const response=await request(`/conversations/${cid}/messages`,'POST',{role:'peer',text});assert.equal(response.status,201);return (await response.json()).id as string;};
  return {...instance,a,b,calls,dir,databasePath:overrides.databasePath??join(dir,'test.sqlite'),request,base,add,
    close:async(remove=true)=>{await new Promise<void>(r=>server.close(()=>r()));instance.close();if(remove)rmSync(dir,{recursive:true,force:true});}};
}

test('contact basics CRUD is scoped, strict, protected by CSRF, and model credentials are redacted',async()=>{
  const h=await harness();
  try{
    const input={category:'interest',content:'喜欢游泳',sourceNote:'本人补充'};
    assert.equal((await h.request(`/conversations/${h.a}/basis`,'POST',input,{'X-CSRF-Token':''})).status,403);
    assert.equal((await h.request(`/conversations/${h.a}/basis`,'POST',input,{Cookie:''})).status,401);
    assert.equal((await h.request(`/conversations/${h.a}/basis`,'POST',{...input,unrequested:'x'})).status,400);
    assert.equal((await h.request(`/conversations/${h.a}/basis`,'POST',{...input,content:' '})).status,400);
    assert.equal((await h.request(`/conversations/${h.a}/basis`,'POST',{...input,category:'diagnosis'})).status,400);
    const response=await h.request(`/conversations/${h.a}/basis`,'POST',input);assert.equal(response.status,201);
    const fact=await response.json();assert.equal(fact.content,'喜欢游泳');assert.ok(fact.id);assert.ok(fact.createdAt);
    assert.equal((await h.request(`/conversations/${h.b}/basis/${fact.id}`,'PATCH',{content:'偷改'})).status,404);
    assert.equal((await h.request(`/conversations/${h.a}/basis/${fact.id}`,'PATCH',{content:'喜欢散步'})).status,200);
    assert.equal(h.store.read().conversations.find(c=>c.id===h.a)!.basisFacts![0].content,'喜欢散步');
    assert.equal(h.store.read().conversations.find(c=>c.id===h.b)!.basisFacts,undefined);
    const publicState=await(await h.request('/state')).json();
    assert.equal(publicState.settings.analysis.hasApiKey,true);assert.equal(publicState.settings.memory.hasApiKey,true);
    assert.doesNotMatch(JSON.stringify(publicState),/PRIVATE-ANALYSIS-KEY|PRIVATE-MEMORY-KEY/);
    const {apiKey:_key,...withoutKey}=model;
    assert.equal((await h.request('/settings','PATCH',{analysis:withoutKey})).status,200);
    assert.equal(h.store.read().settings.analysis!.apiKey,'PRIVATE-ANALYSIS-KEY');
    assert.equal((await h.request(`/conversations/${h.a}/basis/${fact.id}`,'DELETE')).status,200);
    assert.equal(h.store.read().conversations.find(c=>c.id===h.a)!.basisFacts!.length,0);assert.equal(h.calls.send,0);
  }finally{await h.close();}
});

test('analysis is enabled and cached per person, selected independently, invalidated by relevant facts and persisted',async()=>{
  const h=await harness();let reopened:Awaited<ReturnType<typeof harness>>|undefined,closed=false;
  try{
    const aMessage=await h.add(h.a,'怎么这么晚还在加班？'),bMessage=await h.add(h.b,'另一人的消息');
    assert.equal((await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:aMessage})).status,400);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:true,affinityEnabled:true,
      analysisModel:{id:'selected',provider:'compatible',modelName:'analysis-contact-A'}}})).status,200);
    assert.equal((await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:aMessage}, {'X-CSRF-Token':''})).status,403);
    assert.equal((await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:bMessage})).status,400);
    assert.equal((await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:aMessage,unrequested:true})).status,400);
    const first=await(await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:aMessage})).json();
    assert.equal(first.cached,false);assert.equal(first.insights.modelName,'analysis-contact-A');assert.equal(first.insights.intents[0].percentage,80);
    const second=await(await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:aMessage})).json();assert.equal(second.cached,true);assert.equal(h.calls.analysis,1);
    assert.equal(h.store.read().messages.find(m=>m.id===bMessage)!.insights,undefined);
    assert.equal((await h.request(`/conversations/${h.b}/analyze`,'POST',{messageId:bMessage})).status,400);
    await h.request(`/conversations/${h.a}/basis`,'POST',{category:'current_status',content:'近期工作繁忙'});
    const afterBasis=await(await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:aMessage})).json();assert.equal(afterBasis.cached,false);assert.equal(h.calls.analysis,2);
    await h.close(false);closed=true;reopened=await harness({databasePath:h.databasePath});
    const reloaded=await(await reopened.request(`/conversations/${h.a}/analyze`,'POST',{messageId:aMessage})).json();assert.equal(reloaded.cached,true);assert.equal(reopened.calls.analysis,0);
    assert.equal(reopened.store.read().messages.find(m=>m.id===aMessage)!.insights!.intents[0].percentage,80);
  }finally{if(reopened)await reopened.close();if(!closed)await h.close();else rmSync(h.dir,{recursive:true,force:true});}
});

test('analyzing with one feature off strips unrequested metrics and requires a supported model choice',async()=>{
  const h=await harness();
  try{
    const mid=await h.add(h.a);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:true,analysisModel:{id:'bad',provider:'demo',modelName:''}}})).status,400);
    await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:true,affinityEnabled:false}});
    const intentOnly=await(await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:mid})).json();assert.equal(intentOnly.insights.affinity,null);
    await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:false,affinityEnabled:true}});
    const affinityOnly=await(await h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:mid})).json();assert.deepEqual(affinityOnly.insights.intents,[]);assert.equal(affinityOnly.insights.affinity.score,55);
    assert.equal(h.calls.analysis,2);
  }finally{await h.close();}
});

test('stale source or disabling analysis prevents delayed results from being saved',async()=>{
  const delayed=gate();let observed:AbortSignal|undefined,calls=0;
  const h=await harness({analyzeContactMessage:async(s,cid,mid,signal)=>{calls++;observed=signal;delayed.enter();await delayed.wait;return analysisResult(s,cid,mid);}});
  try{
    const mid=await h.add(h.a);await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:true}});
    const pending=h.request(`/conversations/${h.a}/analyze`,'POST',{messageId:mid});await delayed.ready;
    h.store.update(s=>{s.messages.find(m=>m.id===mid)!.text='同一句话已更新';});
    delayed.release();assert.equal((await pending).status,409);assert.equal(h.store.read().messages.find(m=>m.id===mid)!.insights,undefined);assert.equal(observed!.aborted,false);assert.equal(calls,1);
  }finally{delayed.release();await h.close();}
  const disabled=gate();let cancelSignal:AbortSignal|undefined;
  const h2=await harness({analyzeContactMessage:async(s,cid,mid,signal)=>{cancelSignal=signal;disabled.enter();await disabled.wait;return analysisResult(s,cid,mid);}});
  try{
    const mid=await h2.add(h2.a);await h2.request(`/conversations/${h2.a}`,'PATCH',{processing:{intentEnabled:true}});
    const pending=h2.request(`/conversations/${h2.a}/analyze`,'POST',{messageId:mid});await disabled.ready;
    await h2.request(`/conversations/${h2.a}`,'PATCH',{processing:{intentEnabled:false}});assert.equal(cancelSignal!.aborted,true);
    disabled.release();assert.notEqual((await pending).status,200);assert.equal(h2.store.read().messages.find(m=>m.id===mid)!.insights,undefined);
  }finally{disabled.release();await h2.close();}
});

test('memory persists locally with explicit approvals, per-contact scope, CSRF and no-new-message cache',async()=>{
  const h=await harness();let reopened:Awaited<ReturnType<typeof harness>>|undefined,closed=false;
  try{
    const mid=await h.add(h.a,'合成行程');await h.add(h.b,'他人的消息');
    assert.equal((await h.request(`/conversations/${h.a}/memory/compress`,'POST',{})).status,400);
    await h.request(`/conversations/${h.a}`,'PATCH',{processing:{memoryEnabled:true}});
    assert.equal((await h.request(`/conversations/${h.a}/memory/compress`,'POST',{}, {'X-CSRF-Token':''})).status,403);
    assert.equal((await h.request(`/conversations/${h.a}/memory/compress`,'POST',{unrequested:true})).status,400);
    const first=await(await h.request(`/conversations/${h.a}/memory/compress`,'POST',{})).json();assert.equal(first.cached,false);assert.equal(first.remaining,0);assert.equal(h.calls.memory,1);
    const entry=first.memory.entries[0];assert.equal(entry.status,'pending');assert.deepEqual(entry.sourceMessageIds,[mid]);
    assert.equal((await h.request(`/conversations/${h.b}/memory/entries/${entry.id}`,'PATCH',{status:'approved'})).status,404);
    assert.equal((await h.request(`/conversations/${h.a}/memory/entries/${entry.id}`,'PATCH',{status:'approved'}, {'X-CSRF-Token':''})).status,403);
    assert.equal((await h.request(`/conversations/${h.a}/memory/entries/${entry.id}`,'PATCH',{status:'approved',unrequested:true})).status,400);
    assert.equal((await h.request(`/conversations/${h.a}/memory/entries/${entry.id}`,'PATCH',{status:'approved'})).status,200);
    const second=await(await h.request(`/conversations/${h.a}/memory/compress`,'POST',{})).json();assert.equal(second.cached,true);assert.equal(second.memory.entries[0].status,'approved');assert.equal(h.calls.memory,1);
    assert.equal(h.store.read().conversations.find(c=>c.id===h.b)!.memory,undefined);
    await h.close(false);closed=true;reopened=await harness({databasePath:h.databasePath});
    const persisted=await(await reopened.request(`/conversations/${h.a}/memory/compress`,'POST',{})).json();assert.equal(persisted.cached,true);assert.equal(persisted.memory.entries[0].status,'approved');assert.equal(reopened.calls.memory,0);
    await reopened.request(`/conversations/${h.a}/memory/entries/${entry.id}`,'PATCH',{status:'rejected'});
    assert.equal(reopened.store.read().conversations.find(c=>c.id===h.a)!.memory!.entries[0].status,'rejected');
    assert.equal((await reopened.request(`/conversations/${h.a}/memory`,'DELETE',undefined,{'X-CSRF-Token':''})).status,403);
    assert.equal((await reopened.request(`/conversations/${h.a}/memory`,'DELETE')).status,200);
    assert.equal(reopened.store.read().conversations.find(c=>c.id===h.a)!.memory,undefined);assert.equal(reopened.calls.send,0);
  }finally{if(reopened)await reopened.close();if(!closed)await h.close();else rmSync(h.dir,{recursive:true,force:true});}
});

test('new facts or disabling memory cancels stale compression and preserves the previous memory',async()=>{
  for(const action of ['basis','disable']){
    const delayed=gate();let signal:AbortSignal|undefined;
    const h=await harness({compressContactMemory:async(state,cid,chosen)=>{signal=chosen;delayed.enter();await delayed.wait;return memoryResult(state,cid);}});
    try{
      await h.add(h.a);await h.request(`/conversations/${h.a}`,'PATCH',{processing:{memoryEnabled:true}});
      h.store.update(s=>{s.conversations.find(c=>c.id===h.a)!.memory={summary:'保留之前的本地记忆',entries:[],openTopics:[],throughSequence:0,
        compressedMessageHashes:{},sourceDigest:'old',provider:'compatible',modelName:'old',updatedAt:''};});
      const pending=h.request(`/conversations/${h.a}/memory/compress`,'POST',{});await delayed.ready;
      if(action==='basis')await h.request(`/conversations/${h.a}/basis`,'POST',{category:'fact',content:'新资料'});
      else await h.request(`/conversations/${h.a}`,'PATCH',{processing:{memoryEnabled:false}});
      assert.equal(signal!.aborted,true);
      delayed.release();assert.notEqual((await pending).status,200);assert.equal(h.store.read().conversations.find(c=>c.id===h.a)!.memory!.summary,'保留之前的本地记忆');
    }finally{delayed.release();await h.close();}
  }
});

test('automatic analysis is opt-in for live peer messages and pausing WeChat cancels active work',async()=>{
  const delayed=gate();let signal:AbortSignal|undefined,calls=0;
  const h=await harness({analyzeContactMessage:async(state,cid,mid,chosen)=>{signal=chosen;calls++;delayed.enter();await delayed.wait;return analysisResult(state,cid,mid);}});
  try{
    const created=await h.request('/wechat/conversations','POST',{externalId:'synthetic-peer',name:'微信合成联系人'});assert.equal(created.status,201);const cid=(await created.json()).id as string;
    await h.request(`/conversations/${cid}`,'PATCH',{processing:{intentEnabled:true,autoAnalyzeMessages:true}});
    const mid='live-test-message';
    h.store.update(s=>{const c=s.conversations.find(c=>c.id===cid)!;c.wechat!.enabled=true;c.wechat!.initialized=true;
      s.messages.push({id:mid,conversationId:cid,role:'peer',text:'仅用于本地模拟的新消息',sentAt:null,sequence:1,source:'wechat',externalId:'seq1',aiAssisted:false});});
    h.insights.observed(cid,mid,false);await h.insights.tick();assert.equal(calls,0);
    h.insights.observed(cid,mid,true);const running=h.insights.tick();await delayed.ready;assert.equal(calls,1);
    assert.equal((await h.request(`/conversations/${cid}/wechat`,'PATCH',{enabled:false})).status,200);assert.equal(signal!.aborted,true);
    delayed.release();await running;assert.equal(h.store.read().messages.find(m=>m.id===mid)!.insights,undefined);
    h.insights.observed(cid,mid,true);await h.insights.tick();assert.equal(calls,1);assert.equal(h.calls.send,0);
  }finally{delayed.release();await h.close();}
});

test('automatic memory compression waits for twenty fresh messages and cancels when contact reading pauses',async()=>{
  const delayed=gate();let signal:AbortSignal|undefined,calls=0;
  const h=await harness({compressContactMemory:async(state,cid,chosen)=>{signal=chosen;calls++;delayed.enter();await delayed.wait;return memoryResult(state,cid);}});
  try{
    const created=await h.request('/wechat/conversations','POST',{externalId:'synthetic-memory-peer',name:'合成记忆联系人'});const cid=(await created.json()).id as string;
    await h.request(`/conversations/${cid}`,'PATCH',{processing:{memoryEnabled:true,autoCompressMemory:true}});
    const insert=(count:number)=>h.store.update(s=>{const c=s.conversations.find(c=>c.id===cid)!;c.wechat!.enabled=true;c.wechat!.initialized=true;
      for(let index=0;index<count;index++)s.messages.push({id:`memory-message-${index}`,conversationId:cid,role:'peer',text:'本地模拟消息',sentAt:null,
        sequence:index+1,source:'wechat',externalId:`seq-${index}`,aiAssisted:false});});
    insert(19);h.insights.observed(cid,'memory-message-18',true);await h.insights.tick();assert.equal(calls,0);
    h.store.update(s=>{s.messages.push({id:'memory-message-19',conversationId:cid,role:'peer',text:'第二十条本地模拟消息',sentAt:null,sequence:20,source:'wechat',externalId:'seq-19',aiAssisted:false});});
    h.insights.observed(cid,'memory-message-19',true);const pending=h.insights.tick();await delayed.ready;assert.equal(calls,1);
    await h.request(`/conversations/${cid}/wechat`,'PATCH',{enabled:false});assert.equal(signal!.aborted,true);
    delayed.release();await pending;assert.equal(h.store.read().conversations.find(c=>c.id===cid)!.memory,undefined);assert.equal(h.calls.send,0);
  }finally{delayed.release();await h.close();}
});

test('turning off the last analysis feature also turns off automatic analysis, while another enabled feature keeps it on',async()=>{
  const h=await harness();
  try{
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:true,affinityEnabled:true,autoAnalyzeMessages:true}})).status,200);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:false}})).status,200);
    let processing=h.store.read().conversations.find(c=>c.id===h.a)!.processing!;
    assert.equal(processing.intentEnabled,false);assert.equal(processing.affinityEnabled,true);assert.equal(processing.autoAnalyzeMessages,true);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{affinityEnabled:false}})).status,200);
    processing=h.store.read().conversations.find(c=>c.id===h.a)!.processing!;
    assert.equal(processing.affinityEnabled,false);assert.equal(processing.autoAnalyzeMessages,false);
    const mid=await h.add(h.a);h.insights.observed(h.a,mid,true);await h.insights.tick();assert.equal(h.calls.analysis,0);
    // The same dependency applies when intent is the only feature still enabled.
    await h.request(`/conversations/${h.b}`,'PATCH',{processing:{intentEnabled:true,autoAnalyzeMessages:true}});
    assert.equal((await h.request(`/conversations/${h.b}`,'PATCH',{processing:{intentEnabled:false}})).status,200);
    assert.equal(h.store.read().conversations.find(c=>c.id===h.b)!.processing!.autoAnalyzeMessages,false);
  }finally{await h.close();}
});

test('turning off memory also disables automatic compression without requiring another switch',async()=>{
  const h=await harness();
  try{
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{memoryEnabled:true,autoCompressMemory:true}})).status,200);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{memoryEnabled:false}})).status,200);
    const processing=h.store.read().conversations.find(c=>c.id===h.a)!.processing!;
    assert.equal(processing.memoryEnabled,false);assert.equal(processing.autoCompressMemory,false);
    const mid=await h.add(h.a);h.insights.observed(h.a,mid,true);await h.insights.tick();assert.equal(h.calls.memory,0);
  }finally{await h.close();}
});

test('disabled analysis and memory models leave unrelated contact changes and local memory availability usable',async()=>{
  const h=await harness();
  try{
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{intentEnabled:true,affinityEnabled:true,memoryEnabled:true}})).status,200);
    const saved=h.store.read().settings;
    assert.equal((await h.request('/settings','PATCH',{analysis:{...saved.analysis!,provider:'disabled'},memory:{...saved.memory!,provider:'disabled'}})).status,200);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{name:'改名后的甲'})).status,200);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{note:'这是无关模型的备注',autoReplyEnabled:false})).status,200);
    assert.equal((await h.request(`/conversations/${h.a}`,'PATCH',{processing:{replyModels:[{id:'demo-reply',provider:'demo',modelName:''}]}})).status,200);
    assert.equal((await h.request(`/conversations/${h.b}`,'PATCH',{processing:{memoryEnabled:true}})).status,200);
    assert.equal(h.store.read().conversations.find(c=>c.id===h.b)!.processing!.memoryEnabled,true);
    assert.equal((await h.request(`/conversations/${h.b}`,'PATCH',{processing:{intentEnabled:true}})).status,400);
    assert.equal((await h.request(`/conversations/${h.b}`,'PATCH',{processing:{autoCompressMemory:true}})).status,400);
    assert.equal(h.calls.analysis,0);assert.equal(h.calls.memory,0);
  }finally{await h.close();}
});

test('full settings saves with only independent analysis changes preserve current drafts and pending manual reply suggestions',async()=>{
  const delayed=gate();let generationCalls=0;
  const h=await harness({generate:async(state,cid)=>{
    generationCalls++;delayed.enter();await delayed.wait;
    const latest=state.messages.filter(m=>m.conversationId===cid).at(-1)!;
    return [{id:'new-manual-draft',conversationId:cid,basedOnMessageId:latest.id,text:'这是合成回复',label:'自然回应',reason:'合成测试',
      createdAt:new Date().toISOString(),provider:'demo'} satisfies Draft];
  }});
  try{
    const mid=await h.add(h.a);
    h.store.update(s=>{
      s.settings.replyModels=[{id:'demo-comparison',provider:'demo',modelName:'',label:'本地测试'}];
      s.settings.vision={...model,provider:'disabled',modelName:'vision-existing'};
      s.settings.audio={...model,provider:'disabled',modelName:'audio-existing'};
      s.drafts.push({id:'existing-draft',conversationId:h.a,basedOnMessageId:mid,text:'保留既有草稿',label:'现有',reason:'已生成',createdAt:'2026-10-13T00:00:00Z',provider:'demo'});
    });
    const pending=h.request(`/conversations/${h.a}/suggest`,'POST',{});await delayed.ready;
    // The settings form sends the unchanged nested choices with its edited fields.
    const fullPayload=JSON.parse(JSON.stringify(h.store.read().settings));
    fullPayload.analysis.modelName='analysis-changed';fullPayload.memory.modelName='memory-changed';
    assert.equal((await h.request('/settings','PATCH',fullPayload)).status,200);
    assert.equal(h.store.read().drafts.find(d=>d.id==='existing-draft')?.text,'保留既有草稿');
    delayed.release();const response=await pending;const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));
    assert.equal(payload.drafts[0].id,'new-manual-draft');assert.equal(generationCalls,1);
    assert.equal(h.store.read().drafts[0].id,'new-manual-draft');assert.equal(h.calls.send,0);
  }finally{delayed.release();await h.close();}
});
