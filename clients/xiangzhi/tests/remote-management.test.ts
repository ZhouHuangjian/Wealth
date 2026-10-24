import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';
import { RemoteManagement,remoteCommandTimeout, type RemoteCommand } from '../server/remote-management.js';
import {remoteSnapshotV2,remoteProfile,MAX_REMOTE_POLL_BYTES} from '../server/remote-protocol.js';
import type {Conversation} from '../shared/types.js';
import { Store } from '../server/store.js';

const config={url:'http://127.0.0.1:9876/api/v1/chat/ingest',token:'synthetic-token-'.repeat(3),inboxToken:''};
const command=(type:RemoteCommand['type'],payload:Record<string,unknown>,expires=Date.now()+60_000):RemoteCommand=>({id:randomUUID(),type,payload,expires_at:new Date(expires).toISOString()});
const response=(commands:RemoteCommand[]=[])=>new Response(JSON.stringify({ok:true,commands,server_time:new Date().toISOString()}),{headers:{'Content-Type':'application/json'}});
const baseOptions={seed:false,profileManifestPath:null,inspectCodex:async()=>({available:false,version:null,message:'synthetic'}),inspectWechat:()=>({available:true,message:'synthetic'}),draftSync:config};

test('remote management uses local validation, limits contacts, never sends or leaks settings',async t=>{
  let next:RemoteCommand|null=null;const requests:any[]=[];let sends=0,searches=0;
  const app=createApplication({...baseOptions,databasePath:':memory:',send:async()=>{sends++;},
    queryWechat:async()=>{throw new Error('No reading during management');},
    searchWechatContacts:async()=>{searches++;return {contacts:Array.from({length:35},(_,i)=>({externalId:`wxid_${i}`,name:`虚构${i}`,secret:'hidden'})),hasMore:false};},
    remoteFetch:async(input,init)=>{assert.equal(String(input),'http://127.0.0.1:9876/api/v1/chat/device/poll');assert.equal(init?.redirect,'error');requests.push(JSON.parse(String(init?.body)));const c=next;next=null;return response(c?[c]:[]);},
  });t.after(()=>app.close());
  app.store.update(s=>{s.settings.apiKey='must-not-leak';s.settings.modelUrl='https://private-model.invalid';s.settings.allowRemoteModel=true;});
  next=command('conversation.add',{externalId:'wxid_test',name:'虚构朋友'});await app.remote.tick();
  const cid=app.store.read().conversations[0].id;
  const at=new Date().toISOString(),mid=randomUUID(),simulator=randomUUID();
  app.store.update(state=>{
    state.messages.push({id:mid,conversationId:cid,role:'peer',text:'AUTHORIZED-CURRENT-TEXT',kind:'text',source:'wechat',externalId:'PRIVATE-WECHAT-MESSAGE-ID',sourceFingerprint:'PRIVATE-SOURCE-FINGERPRINT',sentAt:at,sequence:1,aiAssisted:false});
    state.conversations.push({id:simulator,name:'本机演练',avatar:'演',color:'',note:'',autoReplyEnabled:false,channel:'simulator',externalId:null,createdAt:at,updatedAt:at});
    state.messages.push({id:randomUUID(),conversationId:simulator,role:'peer',text:'SIMULATOR-PRIVATE-TEXT',kind:'text',source:'demo',externalId:null,sentAt:at,sequence:1,aiAssisted:false});
  });
  assert.equal(app.store.read().conversations[0].wechat?.enabled,false);
  assert.equal(app.store.read().conversations[0].autoReplyEnabled,false);
  await app.remote.tick();assert.equal(requests.at(-1).completed[0].status,'succeeded');
  next=command('contacts.search',{query:'虚构',limit:30});await app.remote.tick();await app.remote.tick();
  const contacts=requests.at(-1).completed[0].result;
  assert.equal(contacts.contacts.length,30);assert.equal(contacts.hasMore,true);assert.equal(searches,1);
  assert.deepEqual(Object.keys(contacts.contacts[0]).sort(),['externalId','name']);
  next=command('settings.patch',{replyDelaySeconds:9});await app.remote.tick();assert.equal(app.store.read().settings.replyDelaySeconds,9);
  next=command('settings.patch',{modelUrl:'https://attacker.invalid'});await app.remote.tick();await app.remote.tick();
  assert.equal(requests.at(-1).completed[0].status,'failed');assert.equal(app.store.read().settings.modelUrl,'https://private-model.invalid');
  next=command('conversation.patch',{id:cid,note:'虚构备注',enabled:true,autoReplyEnabled:true});await app.remote.tick();
  assert.equal(app.store.read().conversations[0].wechat?.enabled,true);assert.equal(app.store.read().conversations[0].autoReplyEnabled,true);
  next=command('conversation.patch',{id:cid,enabled:false});await app.remote.tick();assert.equal(app.store.read().conversations[0].wechat?.enabled,false);
  const wire=JSON.stringify(requests);
  for(const secret of ['must-not-leak','private-model.invalid','SIMULATOR-PRIVATE-TEXT','PRIVATE-WECHAT-MESSAGE-ID','PRIVATE-SOURCE-FINGERPRINT','hidden',config.token])assert.ok(!wire.includes(secret),secret);
  const snapshots=requests.filter(request=>request.snapshot.currentView?.conversations.length);
  assert.ok(snapshots.length>0);assert.ok(snapshots.every(request=>request.snapshot.remoteEnabled===true));
  const shown=snapshots.at(-1).snapshot.currentView.conversations.find((view:any)=>view.conversationId===cid);
  assert.deepEqual(shown.messages.map((message:any)=>({id:message.id,text:message.text})),[{id:mid,text:'AUTHORIZED-CURRENT-TEXT'}]);
  const configurationOnly=requests.map(request=>{const copy=structuredClone(request);delete copy.snapshot.currentView;return copy;});
  assert.doesNotMatch(JSON.stringify(configurationOnly),/"messages"\s*:|AUTHORIZED-CURRENT-TEXT/);
  assert.doesNotMatch(wire,/"(?:sourceFingerprint|sourceSequence|accountFingerprint|imageAttachment|audioAttachment|modelUrl|apiKey)"\s*:/);
  assert.equal(sends,0);assert.equal(app.store.read().jobs.length,0);assert.equal(app.store.read().messages.length,2);
});

test('duplicate delivery and interrupted receipt survive restart; expired commands never run',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xiangzhi-remote-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'state.sqlite'),id=command('settings.patch',{replyDelaySeconds:11});let executions=0;
  let store=new Store(path),next:RemoteCommand|null=id;
  const options={config:()=>config,enabled:()=>true,snapshot:()=>({}),execute:async()=>{executions++;return {done:true};},fetch:async()=>response(next?[next]:[])};
  let worker=new RemoteManagement(store,options);await worker.tick();worker.stop();store.close();
  store=new Store(path);worker=new RemoteManagement(store,options);await worker.tick();assert.equal(executions,1);
  const scope=createHash('sha256').update(JSON.stringify([config.url,config.token])).digest('hex');
  assert.equal(store.remoteReceipts(scope)[0].id,id.id);
  next=command('settings.patch',{replyDelaySeconds:12},Date.now()-1000);await worker.tick();assert.equal(executions,1);assert.equal(store.remoteReceipts(scope).at(-1)?.status,'failed');
  const interrupted=command('contacts.search',{query:'synthetic'});store.remoteClaim(scope,interrupted.id,Date.parse(interrupted.expires_at));worker.stop();store.close();
  store=new Store(path);next=interrupted;worker=new RemoteManagement(store,options);await worker.tick();assert.equal(executions,1);assert.equal(store.remoteReceipts(scope).find(r=>r.id===interrupted.id)?.status,'failed');
  const obsolete=command('settings.patch',{},Date.now()-30*86400_000);store.remoteClaim(scope,obsolete.id,Date.parse(obsolete.expires_at));store.remoteFinish(scope,{id:obsolete.id,status:'failed',result:{},error:''});
  assert.equal(store.remoteReceipts(scope).some(r=>r.id===obsolete.id),false);worker.stop();store.close();
});

test('inflight response cannot apply after rebind or disable and polling never overlaps',async t=>{
  const store=new Store(':memory:');let enabled=true,current=config,executions=0,calls=0,release!:(response:Response)=>void;
  const worker=new RemoteManagement(store,{config:()=>current,enabled:()=>enabled,snapshot:()=>({}),execute:async()=>{executions++;return {};},fetch:async()=>{calls++;return new Promise<Response>(resolve=>{release=resolve;});}});
  t.after(()=>{worker.stop();store.close();});
  const pending=worker.tick();assert.equal(worker.tick(),pending);assert.equal(calls,1);
  current={...config,token:'new-token'.repeat(8)};worker.invalidate();release(response([command('settings.patch',{dailyLimit:99})]));await pending;assert.equal(executions,0);
  const second=worker.tick();enabled=false;worker.invalidate(true);release(response([command('settings.patch',{dailyLimit:99})]));await second;assert.equal(executions,0);
});

test('disable heartbeat and durable pause barrier clear old queued work before enabling',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xiangzhi-pause-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'state.sqlite');
  let store=new Store(path),enabled=false,calls=0,executions=0;
  const snapshot=()=>({remoteEnabled:true,currentView:{conversations:[{messages:[{text:'PAUSED-CURRENT-PRIVATE-TEXT'}]}]}});
  let worker=new RemoteManagement(store,{config:()=>config,enabled:()=>enabled,snapshot,execute:async()=>{executions++;return {};},fetch:async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.ok(!('currentView'in body.snapshot));assert.doesNotMatch(JSON.stringify(body),/PAUSED-CURRENT-PRIVATE-TEXT|"messages"\s*:/);throw new Error('offline');}});
  worker.invalidate(true);await worker.tick();await worker.tick();assert.equal(calls,1);assert.equal(store.remotePausePending(),true);worker.stop();store.close();
  store=new Store(path);enabled=true;const enabledValues:boolean[]=[],requests:any[]=[];
  worker=new RemoteManagement(store,{config:()=>config,enabled:()=>enabled,snapshot,execute:async()=>{executions++;return {};},fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);enabledValues.push(body.snapshot.remoteEnabled);return response([command('settings.patch',{dailyLimit:10})]);}});
  await worker.tick();assert.equal(executions,0);assert.equal(store.remotePausePending(),false);await worker.tick();assert.equal(executions,1);assert.deepEqual(enabledValues,[false,true]);
  assert.ok(!('currentView'in requests[0].snapshot));assert.doesNotMatch(JSON.stringify(requests[0]),/PAUSED-CURRENT-PRIVATE-TEXT|"messages"\s*:/);
  assert.match(JSON.stringify(requests[1].snapshot.currentView),/PAUSED-CURRENT-PRIVATE-TEXT/);worker.stop();store.close();
});

test('bounded JSON response and unsupported endpoint fail without executing',async t=>{
  const store=new Store(':memory:');let executions=0,calls=0,current={...config,url:'https://example.invalid/custom-upload'};
  const worker=new RemoteManagement(store,{config:()=>current,enabled:()=>true,snapshot:()=>({}),execute:async()=>{executions++;return {};},fetch:async()=>{calls++;return new Response('x'.repeat(70*1024),{headers:{'Content-Type':'application/json'}});}});
  t.after(()=>{worker.stop();store.close();});await worker.tick();assert.equal(calls,0);current=config;await worker.tick();assert.equal(executions,0);assert.equal(worker.status().status,'error');
});

test('local switch requires session and CSRF; remote settings preserve draft-only mode',async t=>{
  let next:RemoteCommand|null=null;
  const app=createApplication({...baseOptions,databasePath:':memory:',remoteFetch:async()=>{const c=next;next=null;return response(c?[c]:[]);}});
  const server=app.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  t.after(async()=>{app.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/api/settings`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"remoteManagementEnabled":false}'})).status,401);
  const session=await fetch(`${base}/api/session`),cookie=session.headers.get('set-cookie')!.split(';')[0],{token}=await session.json() as {token:string};
  const request=async(body:unknown)=>fetch(`${base}/api/settings`,{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':token},body:JSON.stringify(body)});
  assert.equal((await request({remoteManagementEnabled:false})).status,200);assert.equal(app.publicState().runtime.remoteManagement?.status,'disabled');
  assert.equal((await request({remoteManagementEnabled:true,autoReplyMode:'send'})).status,200);
  await app.remote.tick(); // Persistent disabled barrier.
  next=command('settings.patch',{autoReplyEnabled:true});await app.remote.tick();
  assert.equal(app.store.read().settings.autoReplyMode,'draft');assert.equal(app.store.read().settings.autoReplyEnabled,false);
});

const largeProfileConversation=():Conversation=>{
  const at=new Date().toISOString(),cid=randomUUID();
  return {id:cid,name:'大档案测试',avatar:'测',color:'green',note:'',autoReplyEnabled:false,channel:'wechat',externalId:`wxid_${cid}`,createdAt:at,updatedAt:at,
    basisFacts:Array.from({length:100},()=>({id:randomUUID(),category:'fact' as const,content:'记'.repeat(1000),sourceNote:'注'.repeat(500),createdAt:at,updatedAt:at,origin:'manual' as const})),
    memory:{summary:'本地测试',openTopics:[],entries:Array.from({length:132},()=>({id:randomUUID(),kind:'fact' as const,text:'忆'.repeat(600),status:'approved' as const,origin:'manual' as const,createdAt:at,sourceMessageIds:[]})),
      throughSequence:0,sourceDigest:'',provider:'manual',modelName:'',updatedAt:at}};
};

test('large profile receipts are byte-batched and unsent results survive process restart without dropping entries',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xiangzhi-remote-batch-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'state.sqlite'),scope=createHash('sha256').update(JSON.stringify([config.url,config.token])).digest('hex');
  const profiles=[remoteProfile(largeProfileConversation()),remoteProfile(largeProfileConversation())];
  let store=new Store(path),worker:RemoteManagement;const requests:any[]=[];
  for(const profile of profiles){const cmd=command('conversation.profile.get',{id:profile.id});store.remoteClaim(scope,cmd.id,Date.parse(cmd.expires_at));store.remoteFinish(scope,{id:cmd.id,status:'succeeded',result:{profile},error:''});}
  const options={config:()=>config,enabled:()=>true,snapshot:()=>remoteSnapshotV2(store.read().settings,[],[],{wechatAvailable:true,codexAvailable:false}),execute:async()=>({}),fetch:async(_input:unknown,init?:RequestInit)=>{const body=String(init?.body);assert.ok(Buffer.byteLength(body)<=MAX_REMOTE_POLL_BYTES);requests.push(JSON.parse(body));return response();}};
  worker=new RemoteManagement(store,options);await worker.tick();assert.equal(requests[0].completed.length,1);assert.equal(requests[0].completed[0].result.profile.memory.entries.length,132);assert.equal(store.remoteReceipts(scope).length,1);
  worker.stop();store.close();store=new Store(path);worker=new RemoteManagement(store,options);await worker.tick();assert.equal(requests[1].completed.length,1);assert.equal(requests[1].completed[0].result.profile.memory.entries.length,132);assert.equal(store.remoteReceipts(scope).length,0);
  assert.notEqual(requests[0].completed[0].id,requests[1].completed[0].id);worker.stop();store.close();
});

test('old server falls back to v1 without losing new receipts and re-probes after upgrade',async t=>{
  const store=new Store(':memory:'),scope=createHash('sha256').update(JSON.stringify([config.url,config.token])).digest('hex');let now=Date.now(),updated=false;const requests:any[]=[];
  const cmd=command('conversation.profile.get',{id:randomUUID()},now+900_000),profile=remoteProfile({...largeProfileConversation(),basisFacts:[],memory:undefined});
  store.remoteClaim(scope,cmd.id,Date.parse(cmd.expires_at));store.remoteFinish(scope,{id:cmd.id,status:'succeeded',result:{profile},error:''});
  const snapshot=()=>({...remoteSnapshotV2(store.read().settings,[],[],{wechatAvailable:true,codexAvailable:false}),currentView:{syncedAt:new Date(now).toISOString(),conversations:[{messages:[{text:'V2-CURRENT-PRIVATE-TEXT'}]}]}});
  const worker=new RemoteManagement(store,{config:()=>config,enabled:()=>true,now:()=>now,snapshot,execute:async()=>({}),fetch:async(_input,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);return !updated&&body.snapshot.version===2?new Response('{}',{status:422,headers:{'Content-Type':'application/json'}}):response();}});
  t.after(()=>{worker.stop();store.close();});
  await worker.tick();assert.deepEqual(requests.map(body=>body.snapshot.version),[2,1]);assert.equal(requests[1].completed.length,0);assert.equal(store.remoteReceipts(scope).length,1);assert.ok(!('analysis'in requests[1].snapshot.settings));
  assert.ok(!('currentView'in requests[1].snapshot));assert.doesNotMatch(JSON.stringify(requests[1]),/V2-CURRENT-PRIVATE-TEXT|"messages"\s*:/);
  await worker.tick();assert.equal(requests.at(-1).snapshot.version,1);assert.equal(store.remoteReceipts(scope).length,1);
  now+=60_001;updated=true;await worker.tick();assert.equal(requests.at(-1).snapshot.version,2);assert.equal(requests.at(-1).completed.length,1);assert.equal(store.remoteReceipts(scope).length,0);
  assert.match(JSON.stringify(requests.at(-1).snapshot.currentView),/V2-CURRENT-PRIVATE-TEXT/);
});

test('legacy fallback never executes newly queued profile work from a reverted server',async t=>{
  const store=new Store(':memory:');let executions=0,calls=0;
  const worker=new RemoteManagement(store,{config:()=>config,enabled:()=>true,snapshot:()=>remoteSnapshotV2(store.read().settings,[],[],{wechatAvailable:true,codexAvailable:false}),execute:async()=>{executions++;return {};},fetch:async()=>++calls===1?new Response('{}',{status:422}):response([command('conversation.profile.get',{id:randomUUID()})])});
  t.after(()=>{worker.stop();store.close();});await worker.tick();assert.equal(executions,0);
  const scope=createHash('sha256').update(JSON.stringify([config.url,config.token])).digest('hex');assert.equal(store.remoteReceipts(scope)[0].status,'failed');
});

test('model operations receive longer timeouts while respecting client and server expiry',()=>{
  const now=Date.now(),model=command('conversation.basis.generate',{id:randomUUID()},now+900_000);
  assert.equal(remoteCommandTimeout(model,now,now),840_000);
  for(const type of ['conversation.message.analyze','conversation.memory.compress','conversation.drafts.generate'] as const)
    assert.equal(remoteCommandTimeout(command(type,{id:randomUUID()},now+900_000),now,now),840_000);
  assert.equal(remoteCommandTimeout(command('conversation.message.recognize',{},now+900_000),now,now),120_000);
  assert.equal(remoteCommandTimeout(command('settings.patch',{},now+900_000),now,now),30_000);
  const short=command('conversation.memory.compress',{id:randomUUID()},now+50_000);
  assert.equal(remoteCommandTimeout(short,now,now+10_000),40_000);
});

test('remote full-history work can span several model calls beyond two minutes without losing its receipt',async t=>{
  const store=new Store(':memory:');let now=Date.now();
  const timers:{at:number;controller:AbortController}[]=[];
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{const controller=new AbortController();timers.push({at:now+ms,controller});return controller.signal;});
  const queued=command('conversation.message.analyze',{id:randomUUID(),messageId:randomUUID()},now+900_000);
  let delivered=false;
  const worker=new RemoteManagement(store,{config:()=>config,enabled:()=>true,now:()=>now,snapshot:()=>({}),
    execute:async(_command,signal)=>{
      for(let segment=0;segment<3;segment++){
        now+=65_000;for(const timer of timers)if(timer.at<=now)timer.controller.abort();
        signal.throwIfAborted();
      }
      return {segments:3};
    },fetch:async()=>{const commands=delivered?[]:[queued];delivered=true;return response(commands);}});
  t.after(()=>{worker.stop();store.close();});
  await worker.tick();
  const scope=createHash('sha256').update(JSON.stringify([config.url,config.token])).digest('hex');
  const receipt=store.remoteReceipts(scope,now)[0];assert.equal(receipt.status,'succeeded');assert.deepEqual(receipt.result,{segments:3});
});

test('an executor that ignores its timeout cannot acknowledge a successful result',async t=>{
  const store=new Store(':memory:'),expires=Date.now()+90_000,queued=command('conversation.profile.get',{id:randomUUID()},expires);let executions=0;
  const worker=new RemoteManagement(store,{config:()=>config,enabled:()=>true,now:()=>expires-20,snapshot:()=>({}),execute:async()=>{executions++;await new Promise(resolve=>setTimeout(resolve,80));return {ignored_timeout:true};},fetch:async()=>response([queued])});
  t.after(()=>{worker.stop();store.close();});await worker.tick();assert.equal(executions,1);
  const scope=createHash('sha256').update(JSON.stringify([config.url,config.token])).digest('hex'),stored=store.remoteReceipts(scope,expires-20)[0];
  assert.equal(stored.status,'failed');assert.deepEqual(stored.result,{});
});

test('long task heartbeats update the snapshot without duplicating work or acknowledging an unfinished task',async t=>{
  const store=new Store(':memory:'),queued=command('conversation.message.analyze',{id:randomUUID(),messageId:randomUUID()},Date.now()+900_000);
  let pulse:(()=>void)|undefined,release!:()=>void,started!:()=>void,calls=0,executions=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const original=setInterval,requests:any[]=[];
  t.mock.method(globalThis,'setInterval',((callback:()=>void,ms:number)=>{if(ms===30_000)pulse=callback;return original(callback,ms);}) as typeof setInterval);
  const worker=new RemoteManagement(store,{config:()=>config,enabled:()=>true,snapshot:()=>({version:1}),
    execute:async()=>{executions++;started();await gate;return {done:true};},
    fetch:async(_url,init)=>{requests.push(JSON.parse(String(init!.body)));calls++;return response(calls<=2?[queued]:[]);}});
  t.after(()=>{release();worker.stop();store.close();});
  const work=worker.tick();await entered;assert.ok(pulse);pulse();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(calls,2);assert.equal(executions,1);assert.deepEqual(requests[1].completed,[]);
  assert.equal(requests[1].snapshot.remoteEnabled,true);assert.equal(worker.status().status,'connected');
  release();await work;await worker.tick();
  assert.equal(executions,1);assert.equal(requests[2].completed[0].id,queued.id);assert.equal(requests[2].completed[0].status,'succeeded');
});
