import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {ContactInsightService} from '../server/contact-insight-service.js';
import {compressContactMemory,memoryRemainingCount} from '../server/contact-memory.js';
import {messageEvidenceHash} from '../server/contact-evidence.js';
import type {Message} from '../shared/types.js';

function seed(store:Store){store.update(state=>{
  state.settings.memory={provider:'compatible',modelUrl:'http://127.0.0.1:11435/v1',modelName:'synthetic-memory',useReplyApiKey:false,allowRemoteModel:false};
  state.conversations.push({id:'contact',name:'合成联系人',avatar:'',color:'',note:'',autoReplyEnabled:false,channel:'simulator',externalId:null,
    createdAt:'',updatedAt:'',processing:{memoryEnabled:true}});
  state.messages=Array.from({length:260},(_,index):Message=>({id:`m${index+1}`,conversationId:'contact',sequence:index+1,role:index%2?'self':'peer',
    text:`合成历史发言 ${index+1}`,sentAt:null,source:'manual',externalId:null,aiAssisted:false,kind:'text'}));
});}

test('one explicit memory request consumes every batch and saves a source hash for all 260 messages',async t=>{
  const store=new Store(':memory:');seed(store);const selected:string[][]=[];let changes=0;
  const service=new ContactInsightService(store,{onContextChanged:()=>{changes++;},compress:(state,cid,signal,deps)=>compressContactMemory(state,cid,signal,{...deps,fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content),ids=context.messages.map((row:{id:string})=>row.id);
    selected.push(ids);return Response.json({choices:[{message:{content:JSON.stringify({summary:`已读至${ids.at(-1)}`,entries:[],openTopics:[]})}}]});
  }})});
  t.after(()=>{service.stop();store.close();});
  const result=await service.compress('contact');assert.equal(result.remaining,0);assert.equal(memoryRemainingCount(store.read(),'contact'),0);
  assert.deepEqual(selected.map(ids=>ids.length),[120,120,20]);assert.deepEqual(selected.flat(),store.read().messages.map(row=>row.id));assert.equal(changes,3);
  const hashes=store.read().conversations[0].memory!.compressedMessageHashes!;assert.equal(Object.keys(hashes).length,260);
  for(const row of store.read().messages)assert.equal(hashes[row.id],messageEvidenceHash(row));
  assert.equal((await service.compress('contact')).cached,true);assert.equal(selected.length,3);
});

test('a failed later memory batch keeps its completed prefix and a retry resumes without repeating it',async t=>{
  const store=new Store(':memory:');seed(store);let fail=true;const selected:string[][]=[];
  const service=new ContactInsightService(store,{onContextChanged:()=>{},compress:(state,cid,signal,deps)=>compressContactMemory(state,cid,signal,{...deps,fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content),ids=context.messages.map((row:{id:string})=>row.id);selected.push(ids);
    if(fail&&ids[0]==='m121')throw new Error('synthetic interrupted batch');
    return Response.json({choices:[{message:{content:JSON.stringify({summary:`已读至${ids.at(-1)}`,entries:[],openTopics:[]})}}]});
  }})});
  t.after(()=>{service.stop();store.close();});
  await assert.rejects(service.compress('contact'),/无法连接/);assert.equal(memoryRemainingCount(store.read(),'contact'),140);
  assert.equal(Object.keys(store.read().conversations[0].memory!.compressedMessageHashes!).length,120);
  fail=false;assert.equal((await service.compress('contact')).remaining,0);
  assert.equal(selected.filter(ids=>ids[0]==='m1').length,1);assert.deepEqual(selected.at(-1),Array.from({length:20},(_,index)=>`m${index+241}`));
  store.update(state=>{state.messages[0].text+='改正后的原文';});assert.equal(memoryRemainingCount(store.read(),'contact'),1);
  await service.compress('contact');assert.deepEqual(selected.at(-1),['m1']);assert.equal(memoryRemainingCount(store.read(),'contact'),0);
});

test('legacy sequence-only memory cannot skip newly discovered old history after collector renumbering',async t=>{
  const store=new Store(':memory:');seed(store);
  store.update(state=>{state.conversations[0].memory={summary:'旧版只读最近50条时留下的摘要',entries:[],openTopics:[],throughSequence:50,
    sourceDigest:'legacy-window',provider:'qwen',modelName:'legacy',updatedAt:''};});
  const seen:string[]=[];
  const service=new ContactInsightService(store,{onContextChanged:()=>{},compress:(state,cid,signal,deps)=>compressContactMemory(state,cid,signal,{...deps,fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content);seen.push(...context.messages.map((row:{id:string})=>row.id));
    return Response.json({choices:[{message:{content:JSON.stringify({summary:'重读全部历史的合成摘要',entries:[],openTopics:[]})}}]});
  }})});
  t.after(()=>{service.stop();store.close();});
  assert.equal(memoryRemainingCount(store.read(),'contact'),260);await service.compress('contact');
  assert.deepEqual(seen,store.read().messages.map(row=>row.id));assert.equal(memoryRemainingCount(store.read(),'contact'),0);
});

test('active memory progress covers the whole conversation and concurrent requests cannot duplicate batch calls',async t=>{
  const store=new Store(':memory:');seed(store);let calls=0,release:(()=>void)|undefined,started:(()=>void)|undefined;
  const secondStarted=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const service=new ContactInsightService(store,{onContextChanged:()=>{},compress:(state,cid,signal,deps)=>compressContactMemory(state,cid,signal,{...deps,fetch:async(_url,init)=>{
    const context=JSON.parse(JSON.parse(String(init!.body)).messages[1].content),ids=context.messages.map((row:{id:string})=>row.id);
    if(++calls===2){started!();await gate;}
    return Response.json({choices:[{message:{content:JSON.stringify({summary:`读到${ids.at(-1)}`,entries:[],openTopics:[]})}}]});
  }})});
  t.after(()=>{release!();service.stop();store.close();});
  const work=service.compress('contact');await secondStarted;
  const progress=service.status();assert.equal(progress.length,1);
  assert.deepEqual({...progress[0],updatedAt:''},{conversationId:'contact',feature:'memory',total:260,processed:240,stage:'generating',updatedAt:''});
  progress[0].processed=0;assert.equal(service.status()[0].processed,240,'callers cannot mutate internal progress');
  await assert.rejects(service.compress('contact'),/正在整理/);assert.equal(calls,2);
  release!();assert.equal((await work).remaining,0);assert.equal(calls,3);assert.deepEqual(service.status(),[]);
});

test('a cancelled memory job removes active progress while retaining only completed prior batches',async t=>{
  const store=new Store(':memory:');seed(store);let started:(()=>void)|undefined,release:(()=>void)|undefined;
  const fetching=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const controller=new AbortController();
  const service=new ContactInsightService(store,{onContextChanged:()=>{},compress:(state,cid,signal,deps)=>compressContactMemory(state,cid,signal,{...deps,fetch:async()=>{
    started!();await gate;return Response.json({choices:[{message:{content:JSON.stringify({summary:'不应保存的迟到结果',entries:[],openTopics:[]})}}]});
  }})});
  t.after(()=>{release!();service.stop();store.close();});
  const work=service.compress('contact',controller.signal);await fetching;assert.equal(service.status().length,1);
  controller.abort();release!();await assert.rejects(work,/取消/);
  assert.equal(store.read().conversations[0].memory,undefined);assert.deepEqual(service.status(),[]);
});
