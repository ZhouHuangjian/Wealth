import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';
import type { Draft } from '../shared/types.js';

type TestGenerator = NonNullable<Parameters<typeof createApplication>[0]['generate']>;
const mockGenerate: TestGenerator = async (state,cid)=> [{id:'test-draft',conversationId:cid,basedOnMessageId:state.messages.filter(m=>m.conversationId===cid).at(-1)!.id,text:'我明白了，我们慢慢聊。',label:'自然回应',reason:'测试候选',createdAt:new Date().toISOString(),provider:state.settings.provider} satisfies Draft];

async function harness(bridge: boolean | 'receive' = false, customSend?: (text:string,key:string)=>Promise<string|void>, customGenerate?: TestGenerator) {
  const dir = mkdtempSync(join(tmpdir(), 'xiangzhi-api-'));
  const sent: string[] = [];
  const instance = createApplication({ databasePath: join(dir, 'test.db'), seed: true, profileManifestPath: null,
    inspectCodex:async()=>({available:false,version:null,message:'测试中未调用 Codex。'}),
    bridge: bridge ? { inboundToken:'a'.repeat(40),outboundUrl:bridge==='receive'?'':'http://127.0.0.1:12345/send',outboundToken:'test' } : {inboundToken:'',outboundUrl:'',outboundToken:''},
    send:async (_conversation,text,key)=>{sent.push(text);return customSend?.(text,key);},
    generate:customGenerate??mockGenerate,
  });
  const server=instance.app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session=await fetch(`${base}/api/session`);const {token}=await session.json() as {token:string};
  const cookie=session.headers.get('set-cookie')!.split(';')[0];
  const request=(path:string,method='GET',body?:unknown,extra:Record<string,string>={})=>fetch(`${base}${path}`,{method,headers:{Cookie:cookie,'X-CSRF-Token':token,'Content-Type':'application/json',...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return { ...instance, base, request, cookie, token, sent, close:async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));instance.close();rmSync(dir,{recursive:true,force:true});} };
}

test('Mac and forwarded cloud sessions coexist on one hostname without overwriting or accepting each other',async()=>{
  const mac=await harness();
  const cloud=await harness();
  try {
    assert.notEqual(mac.cookie.split('=')[0],cloud.cookie.split('=')[0]);
    const cookies=`${mac.cookie}; ${cloud.cookie}; xz_session=legacy-session`;
    for (const [current,other] of [[mac,cloud],[cloud,mac]]) {
      assert.equal((await current.request('/api/state','GET',undefined,{Cookie:cookies})).status,200);
      assert.equal((await current.request('/api/settings','PATCH',{syncDraftsEnabled:false},{Cookie:cookies})).status,200);
      assert.equal((await current.request('/api/state','GET',undefined,{Cookie:other.cookie})).status,401);
      assert.equal((await current.request('/api/settings','PATCH',{}, {Cookie:cookies,'X-CSRF-Token':other.token})).status,403);
    }
  } finally {await mac.close();await cloud.close();}
});

test('local API rejects missing session, cross-origin requests and missing CSRF; secrets stay server-side',async()=>{
  const h=await harness();
  try {
    assert.equal((await fetch(`${h.base}/api/state`)).status,401);
    assert.equal((await h.request('/api/settings','PATCH',{autoReplyEnabled:true},{'X-CSRF-Token':''})).status,403);
    assert.equal((await h.request('/api/session','GET',undefined,{Origin:'https://untrusted.example'})).status,403);
    assert.equal((await h.request('/api/settings','PATCH',{apiKey:'private-test-key'})).status,200);
    const state=await (await h.request('/api/state')).json();
    assert.equal(state.settings.apiKey,undefined);assert.equal(state.settings.hasApiKey,true);
    assert.equal(state.settings.autoReplyEnabled,false);
    assert.equal(state.settings.autoReplyMode,'draft');
    assert.equal(state.learnedProfile,undefined);
  } finally {await h.close();}
});

test('drafts are bound to latest message and cannot be sent twice',async()=>{
  const h=await harness();
  try {
    const cid=h.store.read().conversations[0].id;
    assert.equal((await h.request(`/api/conversations/${cid}/suggest`,'POST',{intent:'自然回应'})).status,200);
    await h.request(`/api/conversations/${cid}/messages`,'POST',{role:'peer',text:'补充一条新消息'});
    assert.equal((await h.request(`/api/conversations/${cid}/send`,'POST',{draftId:'test-draft',text:'旧回复'})).status,409);
    await h.request(`/api/conversations/${cid}/suggest`,'POST',{});
    assert.equal((await h.request(`/api/conversations/${cid}/send`,'POST',{draftId:'test-draft',text:'现在的回复'})).status,200);
    const repeated=await (await h.request(`/api/conversations/${cid}/send`,'POST',{draftId:'test-draft',text:'现在的回复'})).json();
    assert.equal(repeated.duplicate,true);
    assert.deepEqual(h.sent,['现在的回复']);
  } finally {await h.close();}
});

test('historical import is idempotent and never queues replies',async()=>{
  const h=await harness();
  try {
    const input={filename:'sample.txt',text:'我：我喜欢安静的咖啡店。\n对方：周末可以聊聊吗？',name:'导入测试',format:'text'};
    const preview=await h.request('/api/import/preview','POST',input);assert.equal(preview.status,200);
    const first=await (await h.request('/api/import/commit','POST',input)).json();assert.equal(first.added,2);
    const second=await (await h.request('/api/import/commit','POST',input)).json();assert.equal(second.added,0);
    assert.equal(h.store.read().jobs.length,0);
    await h.request(`/api/conversations/${first.conversationId}/extract`,'POST',{});
    assert.equal((await h.request(`/api/conversations/${first.conversationId}`,'DELETE')).status,200);
    const state=h.store.read();assert.ok(!state.messages.some(m=>m.conversationId===first.conversationId));assert.ok(!state.claims.some(c=>c.scope===first.conversationId));
  } finally {await h.close();}
});

test('bridge is authenticated, contact-bound and event-idempotent; demo cannot enable external auto sending',async()=>{
  const h=await harness(true);
  try {
    const body={eventId:'event-1',conversationId:'external-a',text:'你好'};
    assert.equal((await h.request('/api/bridge/incoming','POST',body)).status,401);
    const c=await (await h.request('/api/conversations','POST',{name:'测试桥接',channel:'webhook',externalId:'external-a'})).json();
    assert.equal((await h.request('/api/settings','PATCH',{autoReplyMode:'send'})).status,200);
    assert.equal((await h.request(`/api/conversations/${c.id}`,'PATCH',{autoReplyEnabled:true})).status,400);
    assert.equal((await h.request('/api/bridge/incoming','POST',body,{Authorization:`Bearer ${'a'.repeat(40)}`})).status,202);
    assert.equal((await h.request('/api/bridge/incoming','POST',body,{Authorization:`Bearer ${'a'.repeat(40)}`})).status,200);
    assert.equal((await h.request('/api/bridge/incoming','POST',{...body,text:'冲突内容'},{Authorization:`Bearer ${'a'.repeat(40)}`})).status,409);
    assert.equal(h.store.read().messages.filter(m=>m.conversationId===c.id).length,1);
    assert.equal(h.store.read().jobs.length,0);
  } finally {await h.close();}
});

test('external model cannot be enabled without choosing remote processing',async()=>{
  const h=await harness();
  try {
    assert.equal((await h.request('/api/settings','PATCH',{provider:'compatible',modelUrl:'https://example.com/v1',modelName:'example',allowRemoteModel:false})).status,200);
    assert.equal((await h.request('/api/settings','PATCH',{autoReplyEnabled:true})).status,400);
    assert.equal(h.store.read().settings.autoReplyEnabled,false);
    assert.equal((await h.request('/api/settings','PATCH',{provider:'compatible',modelUrl:'http://example.com/v1',modelName:'example',allowRemoteModel:true})).status,400);
  } finally {await h.close();}
});

test('revoking remote processing always saves and stops auto replies',async()=>{
  const h=await harness();
  try {
    assert.equal((await h.request('/api/settings','PATCH',{provider:'compatible',modelUrl:'https://example.com/v1',modelName:'example',allowRemoteModel:true,autoReplyEnabled:true})).status,200);
    assert.equal(h.store.read().settings.autoReplyEnabled,true);
    assert.equal((await h.request('/api/settings','PATCH',{allowRemoteModel:false})).status,200);
    assert.equal(h.store.read().settings.allowRemoteModel,false);assert.equal(h.store.read().settings.autoReplyEnabled,false);
  }finally{await h.close();}
});

test('manual sends retain a stable idempotency key, receipt and late echo deduplication',async()=>{
  const h=await harness(true,async()=> 'platform-message-1');
  try{
    const c=await (await h.request('/api/conversations','POST',{name:'桥接测试',channel:'webhook',externalId:'ext-1'})).json();
    const body={text:'人工回复',requestId:'manual-request-1'};
    assert.equal((await h.request(`/api/conversations/${c.id}/send`,'POST',body)).status,200);
    assert.equal((await (await h.request(`/api/conversations/${c.id}/send`,'POST',body)).json()).duplicate,true);
    assert.equal((await h.request(`/api/conversations/${c.id}/send`,'POST',{...body,text:'不同内容'})).status,409);
    const echo=await h.request('/api/bridge/incoming','POST',{eventId:'platform-message-1',conversationId:'ext-1',text:'人工回复',direction:'outgoing'},{Authorization:`Bearer ${'a'.repeat(40)}`});
    assert.equal((await echo.json()).duplicate,true);
    assert.equal(h.sent.length,1);assert.equal(h.store.read().messages.filter(m=>m.conversationId===c.id).length,1);
  }finally{await h.close();}
});

test('manual takeover and deletion cannot race an automatic send awaiting acknowledgement',async()=>{
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  let release!:()=>void;const hold=new Promise<void>(r=>release=r);
  const h=await harness(true,async()=>{entered();await hold;return 'receipt-in-flight';});
  let ticking:Promise<void>|undefined;
  try{
    const c=await (await h.request('/api/conversations','POST',{name:'并发测试',channel:'webhook',externalId:'ext-race'})).json();
    h.store.update(s=>{s.settings.autoReplyMode='send';s.settings.provider='compatible';s.settings.modelUrl='http://127.0.0.1:12345/v1';s.settings.modelName='stub';s.settings.autoReplyEnabled=true;s.settings.replyDelaySeconds=0;s.conversations.find(x=>x.id===c.id)!.autoReplyEnabled=true;});
    await h.request('/api/bridge/incoming','POST',{eventId:'incoming-race',conversationId:'ext-race',text:'收到消息'},{Authorization:`Bearer ${'a'.repeat(40)}`});
    ticking=h.engine.tick();await ready;
    assert.equal((await h.request(`/api/conversations/${c.id}/send`,'POST',{text:'抢先发出',requestId:'race-manual'})).status,409);
    assert.equal((await h.request(`/api/conversations/${c.id}`,'DELETE')).status,409);
    release();await ticking;assert.equal(h.sent.length,1);
  }finally{release();await ticking;await h.close();}
});

test('uncertain manual attempts are not retried on repeated requests',async()=>{
  const h=await harness(true,async()=>{throw new Error('network result unknown');});
  try{
    const c=await (await h.request('/api/conversations','POST',{name:'未知结果',channel:'webhook',externalId:'ext-unknown'})).json();
    const body={text:'一次发送',requestId:'request-uncertain'};
    assert.equal((await h.request(`/api/conversations/${c.id}/send`,'POST',body)).status,502);
    assert.equal((await h.request(`/api/conversations/${c.id}/send`,'POST',body)).status,409);
    assert.equal(h.sent.length,1);
  }finally{await h.close();}
});

test('changing automatic mode pauses the global switch even when enabling is requested in the same payload',async()=>{
  const h=await harness();
  try{
    const cid=h.store.read().conversations[0].id;
    await h.request(`/api/conversations/${cid}`,'PATCH',{autoReplyEnabled:true});
    await h.request('/api/settings','PATCH',{autoReplyEnabled:true});
    await h.request(`/api/conversations/${cid}/messages`,'POST',{role:'peer',text:'模式切换前的新消息'});
    assert.equal(h.store.read().jobs.at(-1)!.status,'queued');
    const switched=await h.request('/api/settings','PATCH',{autoReplyMode:'send',autoReplyEnabled:true});
    assert.equal(switched.status,200);
    assert.equal(h.store.read().settings.autoReplyMode,'send');
    assert.equal(h.store.read().settings.autoReplyEnabled,false);
    assert.equal(h.store.read().jobs.at(-1)!.status,'cancelled');
    await h.engine.tick();assert.equal(h.sent.length,0);
  }finally{await h.close();}
});

test('saving feedback preserves original and revised text, is idempotent and never sends',async()=>{
  const h=await harness();
  try{
    const [conversation,other]=h.store.read().conversations;
    await h.request(`/api/conversations/${conversation.id}/suggest`,'POST',{});
    const body={draftId:'test-draft',text:'我觉得这句更顺口',reason:'保留自己的表达',requestId:'feedback-request-1'};
    const first=await h.request(`/api/conversations/${conversation.id}/feedback`,'POST',body);
    assert.equal(first.ok,true);const {feedback}=await first.json();
    assert.equal(feedback.originalText,'我明白了，我们慢慢聊。');assert.equal(feedback.revisedText,body.text);
    assert.equal(feedback.kind,'edited');assert.equal(feedback.reason,body.reason);assert.equal(feedback.source,'review');
    const repeated=await h.request(`/api/conversations/${conversation.id}/feedback`,'POST',body);
    assert.equal(repeated.status,200);assert.equal((await repeated.json()).duplicate,true);
    assert.equal((await h.request(`/api/conversations/${conversation.id}/feedback`,'POST',{...body,text:'同一个请求的不同内容'})).status,409);
    assert.equal((await h.request(`/api/conversations/${other.id}/feedback`,'POST',{...body,requestId:'wrong-conversation'})).status,409);
    assert.equal(h.store.read().feedback!.length,1);assert.equal(h.store.read().feedback![0].conversationId,conversation.id);
    assert.equal(h.sent.length,0);assert.ok(h.store.read().drafts.some(d=>d.id==='test-draft'));
  }finally{await h.close();}
});

test('retained feedback is inspectable and deleting feedback or a conversation removes its examples',async()=>{
  const h=await harness();
  try{
    const cid=h.store.read().conversations[0].id;
    await h.request(`/api/conversations/${cid}/suggest`,'POST',{});
    const body={draftId:'test-draft',text:'我明白了，我们慢慢聊。',requestId:'retained-request-1'};
    const first=await (await h.request(`/api/conversations/${cid}/feedback`,'POST',body)).json();
    assert.equal(first.feedback.kind,'kept');
    const visible=await (await h.request('/api/state')).json();
    assert.equal(visible.feedback[0].id,first.feedback.id);
    assert.equal((await h.request(`/api/feedback/${first.feedback.id}`,'DELETE')).status,200);
    assert.equal(h.store.read().feedback!.length,0);
    await h.request(`/api/conversations/${cid}/suggest`,'POST',{});
    assert.equal((await h.request(`/api/conversations/${cid}/feedback`,'POST',{...body,requestId:'retained-request-2'})).ok,true);
    assert.equal((await h.request(`/api/conversations/${cid}`,'DELETE')).status,200);
    assert.equal(h.store.read().feedback!.length,0);
  }finally{await h.close();}
});

test('only a confirmed manual draft send records send feedback and duplicate requests do not add examples',async()=>{
  const h=await harness();
  try{
    const cid=h.store.read().conversations[0].id;
    await h.request(`/api/conversations/${cid}/suggest`,'POST',{});
    const body={draftId:'test-draft',text:'发送前改了一句',requestId:'draft-send-review'};
    assert.equal((await h.request(`/api/conversations/${cid}/send`,'POST',body)).status,200);
    assert.equal((await h.request(`/api/conversations/${cid}/send`,'POST',body)).status,200);
    const feedback=h.store.read().feedback!;
    assert.equal(feedback.length,1);assert.equal(feedback[0].source,'send');
    assert.equal(feedback[0].originalText,'我明白了，我们慢慢聊。');assert.equal(feedback[0].revisedText,body.text);
    assert.equal((await h.request(`/api/conversations/${cid}/send`,'POST',{text:'纯手工输入',requestId:'manual-no-draft'})).status,200);
    assert.equal(h.store.read().feedback!.length,1);assert.equal(h.sent.length,2);
  }finally{await h.close();}
  const failed=await harness(false,async()=>{throw new Error('simulated delivery uncertainty');});
  try{
    const cid=failed.store.read().conversations[0].id;
    await failed.request(`/api/conversations/${cid}/suggest`,'POST',{});
    assert.equal((await failed.request(`/api/conversations/${cid}/send`,'POST',{draftId:'test-draft',text:'结果不确定的候选',requestId:'uncertain-draft'})).status,502);
    assert.equal(failed.store.read().feedback!.length,0);
  }finally{await failed.close();}
});

test('a reviewed draft remains available for manual confirmation and preserves the edit reason on send',async()=>{
  const h=await harness();
  try{
    const cid=h.store.read().conversations[0].id;
    await h.request(`/api/conversations/${cid}/suggest`,'POST',{});
    const body={draftId:'test-draft',text:'先按这句来',reason:'更贴近这段对话'};
    assert.equal((await h.request(`/api/conversations/${cid}/feedback`,'POST',{...body,requestId:'review-before-send'})).ok,true);
    assert.equal(h.sent.length,0);assert.equal(h.store.read().drafts.length,1);
    assert.equal((await h.request(`/api/conversations/${cid}/send`,'POST',{...body,requestId:'confirmed-reviewed-send'})).status,200);
    const feedback=h.store.read().feedback!;
    assert.deepEqual(feedback.map(f=>f.source),['review','send']);
    assert.equal(feedback[1].reason,body.reason);assert.equal(feedback[1].originalText,'我明白了，我们慢慢聊。');
    assert.deepEqual(h.sent,[body.text]);
  }finally{await h.close();}
});

test('saving feedback or reloading a disabled profile rejects a pending suggestion instead of storing stale output',async()=>{
  for(const change of ['feedback','reload'] as const){
    let started!:()=>void;const generating=new Promise<void>(resolve=>{started=resolve;});
    let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
    let calls=0;
    const h=await harness(false,undefined,async(state,cid,intent,signal)=>{
      const drafts=await mockGenerate(state,cid,intent,signal);
      if(++calls>1){started();await hold;drafts[0].id='late-draft';drafts[0].text='不应落库的旧结果';}
      return drafts;
    });
    let pending:Promise<Response>|undefined;
    try{
      const cid=h.store.read().conversations[0].id;
      assert.equal((await h.request(`/api/conversations/${cid}/suggest`,'POST',{})).status,200);
      pending=h.request(`/api/conversations/${cid}/suggest`,'POST',{});await generating;
      if(change==='feedback'){
        assert.equal((await h.request(`/api/conversations/${cid}/feedback`,'POST',{draftId:'test-draft',text:'这是人工确认过的改写',requestId:'during-generation'})).ok,true);
      }else{
        assert.equal((await h.request('/api/profile/reload','POST',{})).status,200);
        assert.equal(h.store.read().learnedProfile,undefined);
      }
      release();const response=await pending;
      assert.equal(response.status,409,change);
      assert.ok(!h.store.read().drafts.some(d=>d.id==='late-draft'),change);
      assert.equal(h.store.read().drafts.length,change==='feedback'?1:0,change);
      assert.equal(h.sent.length,0,change);
    }finally{release();await pending;await h.close();}
  }
});

test('receive-only bridge can ingest and draft but cannot send or enable external automatic sending',async()=>{
  const h=await harness('receive');
  try{
    const state=await (await h.request('/api/state')).json();
    assert.equal(state.runtime.bridgeReceiveConfigured,true);assert.equal(state.runtime.bridgeSendConfigured,false);
    const creation=await h.request('/api/conversations','POST',{name:'只收消息测试',channel:'webhook',externalId:'receive-only'});
    assert.equal(creation.status,201);const c=await creation.json();
    assert.equal((await h.request(`/api/conversations/${c.id}`,'PATCH',{autoReplyEnabled:true})).status,200);
    assert.equal((await h.request('/api/settings','PATCH',{autoReplyEnabled:true})).status,200);
    h.store.update(s=>{s.settings.replyDelaySeconds=0;});
    assert.equal((await h.request('/api/bridge/incoming','POST',{eventId:'receive-message',conversationId:'receive-only',text:'合成测试来信'},{Authorization:`Bearer ${'a'.repeat(40)}`})).status,202);
    await h.engine.tick();
    assert.equal(h.store.read().jobs.at(-1)!.status,'drafted');assert.equal(h.sent.length,0);
    assert.equal(h.store.read().messages.filter(m=>m.conversationId===c.id&&m.role==='self').length,0);
    const attempt=await h.request(`/api/conversations/${c.id}/send`,'POST',{text:'此通道不能发送',requestId:'receive-only-send'});
    assert.equal(attempt.status,400);assert.equal(h.sent.length,0);assert.equal(h.store.read().sendAttempts?.length??0,0);
    assert.equal((await h.request('/api/settings','PATCH',{autoReplyMode:'send',provider:'compatible',modelUrl:'http://127.0.0.1:12345/v1',modelName:'stub'})).status,200);
    assert.equal((await h.request('/api/settings','PATCH',{autoReplyEnabled:true})).status,400);
    assert.equal(h.store.read().settings.autoReplyEnabled,false);assert.equal(h.sent.length,0);
  }finally{await h.close();}
});
