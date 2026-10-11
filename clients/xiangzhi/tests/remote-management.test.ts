import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';
import { RemoteManagement, type RemoteCommand } from '../server/remote-management.js';
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
  const wire=JSON.stringify(requests);assert.ok(!wire.includes('must-not-leak'));assert.ok(!wire.includes('private-model.invalid'));assert.ok(!wire.includes('messages'));assert.ok(!wire.includes('hidden'));
  assert.equal(sends,0);assert.equal(app.store.read().jobs.length,0);assert.equal(app.store.read().messages.length,0);
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
  let worker=new RemoteManagement(store,{config:()=>config,enabled:()=>enabled,snapshot:()=>({remoteEnabled:true}),execute:async()=>{executions++;return {};},fetch:async()=>{calls++;throw new Error('offline');}});
  worker.invalidate(true);await worker.tick();await worker.tick();assert.equal(calls,1);assert.equal(store.remotePausePending(),true);worker.stop();store.close();
  store=new Store(path);enabled=true;const enabledValues:boolean[]=[];
  worker=new RemoteManagement(store,{config:()=>config,enabled:()=>enabled,snapshot:()=>({remoteEnabled:true}),execute:async()=>{executions++;return {};},fetch:async(_url,init)=>{enabledValues.push(JSON.parse(String(init?.body)).snapshot.remoteEnabled);return response([command('settings.patch',{dailyLimit:10})]);}});
  await worker.tick();assert.equal(executions,0);assert.equal(store.remotePausePending(),false);await worker.tick();assert.equal(executions,1);assert.deepEqual(enabledValues,[false,true]);worker.stop();store.close();
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
