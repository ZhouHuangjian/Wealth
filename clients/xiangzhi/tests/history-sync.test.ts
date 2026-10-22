import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {HistorySync,historyProjection} from '../server/history-sync.js';
import type {Conversation,Message} from '../shared/types.js';

const at='2026-10-20T00:00:00.000Z';
const config={url:'https://synthetic.example/api/v1/chat/ingest',token:'synthetic-binding-token-'.repeat(3),inboxToken:''};
const deviceId=randomUUID();
const contact=():Conversation=>({id:randomUUID(),name:'合成测试联系人',note:'',avatar:'合',color:'green',channel:'wechat',externalId:'wxid-private',autoReplyEnabled:false,createdAt:at,updatedAt:at,
  processing:{intentEnabled:true,affinityEnabled:true},
  wechat:{enabled:true,initialized:true,cursor:'private-cursor',accountFingerprint:'private-account',status:'ready',detail:'',lastCheckedAt:at,
    history:{status:'complete',cursor:'private-history-cursor',offset:0,scanned:1,added:1,lastCheckedAt:at,detail:'已完成'}}});
const message=(cid:string,seq:number):Message=>({id:randomUUID(),conversationId:cid,role:'peer',kind:'text',text:`合成历史消息 ${seq}`,sequence:seq,sentAt:at,source:'wechat',externalId:'private-source-id',sourceSequence:String(seq),aiAssisted:false});
function setup(n=1,people=1,path=':memory:'){
  const store=new Store(path);
  const contacts=Array.from({length:people},contact);
  store.update(s=>{s.settings.remoteManagementEnabled=true;s.conversations=contacts;s.messages=contacts.flatMap(c=>Array.from({length:n},(_,i)=>message(c.id,i+1)));});
  return store;
}
type Packet={version:number;streamId:string;batchId:string;baseSeq:number;events:{seq:number;type:string;conversationId?:string;messageId?:string;message?:Record<string,unknown>;conversation?:Record<string,unknown>}[];progress:{phase:string;totalMessages:number;totalConversations:number}};
const response=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
function server(hook?:(packet:Packet)=>Promise<Response>|Response){
  const packets:Packet[]=[];let checks=0;
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(options?.redirect,'error');assert.equal(options?.method,'POST');assert.ok(options?.signal);
    const path=new URL(String(url)).pathname;
    if(path==='/api/v1/chat/device/check'){checks++;return response({ok:true,device:{id:deviceId,name:'测试设备'},checkedAt:at});}
    assert.equal(path,'/api/v1/chat/device/history');
    const packet=JSON.parse(String(options?.body)) as Packet;assert.equal(new Headers(options?.headers).get('Idempotency-Key'),packet.batchId);packets.push(packet);
    return hook?hook(packet):ack(packet);
  };
  return {packets,fetcher,get checks(){return checks;}};
}
const ack=(p:Packet,extra:Record<string,unknown>={})=>response({ok:true,version:1,streamId:p.streamId,batchId:p.batchId,ackSeq:p.events.at(-1)!.seq,lastSyncedAt:at,duplicate:false,...extra});
const sync=(store:Store,f:typeof fetch,extra:Partial<ConstructorParameters<typeof HistorySync>[1]>={})=>new HistorySync(store,{config:()=>config,enabled:()=>true,fetch:f,...extra});

test('all contacts and all messages upload in bounded batches without repeated unchanged uploads',async()=>{
  const store=setup(221,10),remote=server(),client=sync(store,remote.fetcher);
  try{
    for(let i=0;i<8;i++)await client.tick();
    const events=remote.packets.flatMap(p=>p.events);
    assert.equal(events.filter(e=>e.type==='conversation.upsert').length,10);
    assert.equal(events.filter(e=>e.type==='message.upsert').length,2210);
    assert.deepEqual(events.map(e=>e.seq),Array.from({length:2220},(_,i)=>i+1));
    for(const p of remote.packets){assert.ok(p.events.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(p))<1024*1024);assert.equal(p.progress.totalMessages,2210);assert.equal(p.progress.phase,'live');}
    const count=remote.packets.length;await client.tick();assert.equal(remote.packets.length,count);assert.equal(client.status().status,'connected');
  }finally{client.stop();store.close();}
});

test('lost acknowledgements retry the same durable batch after a real SQLite restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'xiangzhi-history-test-')),path=join(directory,'state.sqlite');
  let store=setup(3,1,path),remote=server(()=>{throw new Error('response lost');}),client=sync(store,remote.fetcher);
  try{
    await client.tick();assert.equal(client.status().status,'error');const failed=remote.packets[0];
    client.stop();store.close();store=new Store(path);
    remote=server(p=>ack(p,{duplicate:true}));client=sync(store,remote.fetcher);await client.tick();
    assert.deepEqual(remote.packets[0],failed);
    const onlyMessages=remote.packets.flatMap(p=>p.events).filter(e=>e.type==='message.upsert');
    assert.equal(onlyMessages.length,3);
    assert.equal(remote.packets.at(-1)!.streamId,failed.streamId);
  }finally{client.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('ordering changes and deletion synchronize without replaying unchanged messages',async()=>{
  const store=setup(3),remote=server(),client=sync(store,remote.fetcher);
  try{
    await client.tick();const old=store.read(),cid=old.conversations[0].id;
    store.update(s=>{s.messages[0].sequence=4;s.messages=s.messages.filter(m=>m.id!==old.messages[1].id);});
    await client.tick();const later=remote.packets.slice(1).flatMap(p=>p.events);
    assert.equal(later.filter(e=>e.type==='message.upsert').length,1);
    assert.equal(later.find(e=>e.type==='message.upsert')!.message!.sequence,4);
    assert.equal(later.find(e=>e.type==='message.delete')!.messageId,old.messages[1].id);
    const count=remote.packets.length;store.update(s=>{s.conversations=[];s.messages=[];});await client.tick();
    const deletes=remote.packets.slice(count).flatMap(p=>p.events);
    assert.equal(deletes.at(-1)!.type,'conversation.delete');assert.equal(deletes.at(-1)!.conversationId,cid);
    assert.equal(deletes.filter(e=>e.type==='message.delete').length,2);
  }finally{client.stop();store.close();}
});

test('long text, descriptions and saved stale intent survive projection; credentials and private provenance do not',async()=>{
  const store=setup(),remote=server(),client=sync(store,remote.fetcher);
  try{
    store.update(s=>{const m=s.messages[0];m.text='完整原文'.repeat(3000)+'末尾文字 '+config.token;m.kind='image';m.mediaStatus='recognized';
      m.imageAttachment={id:randomUUID(),filename:'/private/not-uploaded.png',mimeType:'image/png',source:'wechat'};
      m.imageRecognition={provider:'codex',modelName:'synthetic-vision',summary:'完整图片摘要'.repeat(1000),visibleText:'尾部图片文字',facts:[],recognizedAt:at};
      m.insights={messageId:m.id,conversationId:m.conversationId,inputDigest:'obsolete',intents:[{label:'分享',percentage:100}],affinity:null,uncertainty:'private-evidence',provider:'codex',modelName:'synthetic-analysis',analyzedAt:at};
    });
    await client.tick();const event=remote.packets.flatMap(p=>p.events).find(e=>e.type==='message.upsert')!;
    assert.ok(String(event.message!.text).includes('末尾文字'));assert.ok(String(event.message!.mediaSummary).endsWith('尾部图片文字'));
    assert.equal((event.message!.analysis as {stale:boolean}).stale,true);assert.equal(event.message!.truncated,undefined);
    const wire=JSON.stringify(remote.packets);
    for(const value of [config.token,'private-source-id','wxid-private','private-cursor','private-account','private-history-cursor','/private/not-uploaded.png','private-evidence'])assert.ok(!wire.includes(value),value);
    if(process.env.HISTORY_WIRE_FIXTURE)writeFileSync(process.env.HISTORY_WIRE_FIXTURE,JSON.stringify({packets:remote.packets}),{mode:0o600});
  }finally{client.stop();store.close();}
});

test('incomplete tail remains backfill and account changes cannot enter the previous stream',async()=>{
  const store=setup(),remote=server(),client=sync(store,remote.fetcher);
  try{
    store.update(s=>{s.conversations[0].wechat!.history!.tail={cursor:'private-tail',offset:10};});
    const projected=historyProjection(store.read());assert.equal(projected.progress.phase,'backfill');
    assert.equal((projected.changes[0].event.conversation!.history as {status:string}).status,'running');
    await client.tick();const count=remote.packets.length;
    store.update(s=>{s.conversations[0].wechat!.accountFingerprint='different-account';});await client.tick();
    assert.equal(remote.packets.length,count);assert.equal(client.status().status,'error');assert.match(client.status().detail,/账号已变化/);
    store.update(s=>{s.conversations.push(contact());});assert.throws(()=>historyProjection(store.read()),/不同微信账号/);
  }finally{client.stop();store.close();}
});

test('credential rotation for the same verified device preserves stream and already acknowledged messages',async()=>{
  const store=setup(2),remote=server();let current={...config};const client=sync(store,remote.fetcher,{config:()=>current});
  try{
    await client.tick();current={...current,token:'new-synthetic-token-'.repeat(4)};client.invalidate();await client.tick();
    assert.equal(remote.checks,2);assert.equal(remote.packets.length,1);
    store.update(s=>{s.messages.push(message(s.conversations[0].id,3));});await client.tick();
    assert.equal(remote.packets[1].streamId,remote.packets[0].streamId);assert.equal(remote.packets[1].baseSeq,3);assert.equal(remote.packets[1].events.length,1);
  }finally{client.stop();store.close();}
});

test('disabled or changed configuration never accepts a late acknowledgement',async()=>{
  const store=setup();let enabled=false,release:((r:Response)=>void)|undefined;
  const remote=server(()=>new Promise<Response>(r=>{release=r;})),client=sync(store,remote.fetcher,{enabled:()=>enabled});
  try{
    await client.tick();assert.equal(remote.checks,0);assert.equal(client.status().status,'disabled');
    enabled=true;const running=client.tick();while(!release)await new Promise(r=>setImmediate(r));
    enabled=false;client.invalidate();release(ack(remote.packets[0]));await running;
    enabled=true;const retry=client.tick();while(remote.packets.length<2)await new Promise(r=>setImmediate(r));
    assert.deepEqual(remote.packets[1],remote.packets[0]);release!(ack(remote.packets[1]));await retry;
  }finally{client.stop();store.close();}
});

test('mismatched or hostile acknowledgement is not committed or exposed',async()=>{
  for(const extra of [{ackSeq:900},{batchId:randomUUID()},{streamId:randomUUID()},{unexpected:'private-server-error'}]){
    const store=setup(),remote=server(p=>ack(p,extra)),client=sync(store,remote.fetcher);
    try{
      await client.tick();assert.equal(client.status().status,'error');assert.ok(!client.status().detail.includes('private-server-error'));
      await client.tick();assert.deepEqual(remote.packets[0],remote.packets[1]);
    }finally{client.stop();store.close();}
  }
});

test('oversized single messages remain local and block completion rather than being truncated or skipped',async()=>{
  const store=setup(2),remote=server(),client=sync(store,remote.fetcher);
  try{
    store.update(s=>{s.messages[0].text='超长消息'.repeat(100000);});await client.tick();
    assert.equal(client.status().status,'error');assert.match(client.status().detail,/单条消息超过/);
    assert.equal(remote.packets.flatMap(p=>p.events).filter(e=>e.type==='message.upsert').length,0);
    assert.equal(store.read().messages.length,2);assert.equal(store.read().messages[0].text.length,400000);
  }finally{client.stop();store.close();}
});
