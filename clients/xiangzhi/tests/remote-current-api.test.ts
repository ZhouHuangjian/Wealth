import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import type {AddressInfo} from 'node:net';
import {createApplication} from '../server/app.js';
import {Store} from '../server/store.js';
import {remoteMessageRevision} from '../server/remote-current.js';
import type {RemoteCommand} from '../server/remote-protocol.js';
import {unavailableModelCatalog} from '../shared/model-catalog.js';
import type {AppState,ContactInsights,Draft,Message} from '../shared/types.js';
import type {WechatQuery,WechatRecord} from '../server/wechat-cli.js';

type Options=Parameters<typeof createApplication>[0];
const connection={url:'http://127.0.0.1:9876/api/v1/chat/ingest',token:'PRIVATE-SYNTHETIC-DEVICE-TOKEN'.repeat(2),inboxToken:''};
const keys=['PRIVATE-REPLY-KEY','PRIVATE-VISION-KEY','PRIVATE-AUDIO-KEY','PRIVATE-ANALYSIS-KEY','PRIVATE-MEMORY-KEY'];
const account='synthetic-only-private-account';
const at='2026-10-14T02:00:00.000Z';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXv0AAAAASUVORK5CYII=','base64');
const upload={dataUrl:`data:image/png;base64,${png.toString('base64')}`,filename:'synthetic.png'};
const wireFixtures={snapshots:[] as unknown[],views:[] as unknown[],commands:[] as {type:string;payload:Record<string,unknown>}[]};
after(()=>{const path=resolve(import.meta.dirname,'../../../.runtime/current-info-release/actual-wire-fixtures.json');mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify(wireFixtures,null,2),{mode:0o600});});
const moduleConfig=(modelName:string,apiKey:string)=>({provider:'compatible' as const,modelUrl:'http://127.0.0.1:11435/v1',modelName,apiKey,useReplyApiKey:false,allowRemoteModel:true});
const record=(sequence:number,overrides:Partial<WechatRecord>={}):WechatRecord=>({id:`synthetic-external-${sequence}`,sortSeq:String(sequence),sentAt:at,role:'peer',kind:'text',text:`合成来信 ${sequence}`,...overrides});
const command=(type:RemoteCommand['type'],payload:Record<string,unknown>):RemoteCommand=>({id:randomUUID(),type,payload,expires_at:new Date(Date.now()+900_000).toISOString()});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function analysisResult(state:AppState,cid:string,mid:string):ContactInsights{
  return {conversationId:cid,messageId:mid,intents:[{label:'关心',percentage:80},{label:'询问',percentage:20}],
    affinity:{score:0,confidence:20,evidence:['合成对话线索']},uncertainty:'合成测试，仅为表达线索估计。',
    provider:'compatible',modelName:state.settings.analysis!.modelName,analyzedAt:new Date().toISOString()};
}
function generated(state:AppState,cid:string):Draft[]{
  const latest=state.messages.filter(m=>m.conversationId===cid).at(-1)!;
  return (state.settings.replyModels?.length?state.settings.replyModels:[{id:'default',provider:state.settings.provider,modelName:state.settings.modelName}]).map((choice,index)=>({
    id:randomUUID(),conversationId:cid,basedOnMessageId:latest.id,text:`合成回复 ${index}`,label:'自然',reason:'合成习惯档案已参考',createdAt:new Date().toISOString(),
    provider:choice.provider,modelName:choice.modelName,modelChoiceId:choice.id,profileVersion:state.learnedProfile?.version??null,
  }));
}

async function harness(overrides:Partial<Options>={}){
  const directory=mkdtempSync(join(tmpdir(),'xiangzhi-remote-current-')),databasePath=join(directory,'test.sqlite');
  const rows=new Map<string,WechatRecord[]>(),queries:Parameters<WechatQuery>[0][]=[],polls:any[]=[],signals:AbortSignal[]=[];
  let next:RemoteCommand|null=null,legacy=false,sends=0,imageCalls=0,imageReads=0,voiceCalls=0,voiceReads=0,analysisCalls=0,generationCalls=0;
  const catalog={...unavailableModelCatalog(),codex:{source:'local-cache' as const,fetchedAt:null,audioSupported:false as const,
    models:[{id:'gpt-synthetic',label:'Synthetic GPT',inputModalities:['text','image'] as ('text'|'image')[]}]}};
  const application=createApplication({databasePath,seed:false,profileManifestPath:null,draftSync:connection,
    bridge:{inboundToken:'',outboundToken:'',outboundUrl:''},inspectCodex:async()=>({available:true,version:'synthetic',message:'合成测试'}),
    inspectWechat:()=>({available:true,message:'合成测试'}),readModelCatalog:async()=>catalog,
    queryWechat:async(input,signal)=>{queries.push(structuredClone(input));assert.ok(signal);signals.push(signal);return {records:rows.get(input.contact)??[],hasMore:false,accountFingerprint:account};},
    send:async()=>{sends++;},generate:async(state,cid,_intent,signal)=>{generationCalls++;assert.ok(signal);signals.push(signal);return generated(state,cid);},
    analyzeContactMessage:async(state,cid,mid,signal)=>{analysisCalls++;assert.ok(signal);signals.push(signal);return analysisResult(state,cid,mid);},
    readWechatImage:async(_input,signal)=>{imageReads++;if(signal)signals.push(signal);return {bytes:png,mimeType:'image/png',filename:'synthetic-sticker.png'};},
    readWechatVoice:async(_input,signal)=>{voiceReads++;assert.ok(signal);signals.push(signal);return {bytes:Buffer.from('RIFF0000WAVEdata'),mimeType:'audio/wav',filename:'synthetic-voice.wav'};},
    transcribeAudio:async(settings,_file,signal)=>{voiceCalls++;assert.ok(signal);signals.push(signal);return {text:'合成语音：晚点见',provider:'compatible',modelName:settings.audio!.modelName,recognizedAt:new Date().toISOString()};},
    recognizeImage:async(settings,_file,signal)=>{imageCalls++;assert.ok(signal);signals.push(signal);return {summary:'合成表情包：小猫挥手',visibleText:'你好',facts:['一只小猫'],
      provider:'compatible',modelName:settings.vision!.modelName,recognizedAt:new Date().toISOString()};},
    remoteFetch:async(input,init)=>{assert.equal(String(input),'http://127.0.0.1:9876/api/v1/chat/device/poll');assert.equal(init?.redirect,'error');
      const body=JSON.parse(String(init?.body));polls.push(body);wireFixtures.snapshots.push(body.snapshot);
      wireFixtures.views.push(...body.completed.flatMap((completed:any)=>completed.result.currentView?[completed.result.currentView]:[]));
      if(legacy&&body.snapshot.version===2)return new Response('{}',{status:422,headers:{'Content-Type':'application/json'}});
      const pending=next;next=null;return Response.json({ok:true,commands:pending?[pending]:[],server_time:new Date().toISOString()});},...overrides,
  });
  application.store.update(state=>{Object.assign(state.settings,{provider:'compatible',modelName:'reply-default',modelPreset:'custom',modelUrl:'http://127.0.0.1:11435/v1',apiKey:keys[0],allowRemoteModel:true,
    vision:moduleConfig('vision-synthetic',keys[1]),audio:moduleConfig('audio-synthetic',keys[2]),analysis:moduleConfig('analysis-synthetic',keys[3]),memory:moduleConfig('memory-synthetic',keys[4])});
    state.learnedProfile={version:'v1.8-synthetic',digest:'private-habit-digest',title:'合成习惯档案',loadedAt:at,rules:[{id:'synthetic-rule',rule:'短句自然',limitation:'合成演示',evidenceIds:[]}],examples:[],limitations:[]};});
  const server=application.app.listen(0,'127.0.0.1');await new Promise<void>(yes=>server.once('listening',yes));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,session=await fetch(base+'/api/session');
  const {token}=await session.json() as {token:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const request=(path:string,method='GET',body?:unknown,extra:Record<string,string>={})=>fetch(base+'/api'+path,{method,
    headers:{Cookie:cookie,'X-CSRF-Token':token,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const add=async(name:string)=>{const result=await request('/wechat/conversations','POST',{name,externalId:`wxid_${randomUUID().replaceAll('-','')}`});assert.equal(result.status,201);return (await result.json()).id as string;};
  const a=await add('合成甲'),b=await add('合成乙');
  application.store.update(state=>{for(const c of state.conversations)c.processing={intentEnabled:true,affinityEnabled:true,memoryEnabled:true,autoAnalyzeMessages:false,autoCompressMemory:false};});
  const conversation=(cid:string)=>application.store.read().conversations.find(c=>c.id===cid)!;
  const message=(mid:string)=>application.store.read().messages.find(m=>m.id===mid)!;
  const queue=(type:RemoteCommand['type'],payload:Record<string,unknown>)=>{const value=command(type,payload);next=value;wireFixtures.commands.push({type,payload});return value;};
  const receipt=async(value:RemoteCommand)=>{await application.remote.tick();const found=polls.at(-1).completed.find((item:any)=>item.id===value.id);assert.ok(found,`Missing ${value.type} receipt`);return found;};
  const run=async(type:RemoteCommand['type'],payload:Record<string,unknown>)=>{const value=queue(type,payload);await application.remote.tick();return receipt(value);};
  const invoke=(type:RemoteCommand['type'],cid:string,mid:string,extra:Record<string,unknown>={})=>run(type,{id:cid,messageId:mid,expectedMessageRevision:remoteMessageRevision(message(mid)),...extra});
  const setRows=(cid:string,values:WechatRecord[])=>rows.set(conversation(cid).externalId!,values);
  const latest=(cid:string)=>application.store.read().messages.filter(m=>m.conversationId===cid).at(-1)!;
  return {...application,a,b,base,request,run,invoke,queue,receipt,rows,queries,polls,signals,setRows,conversation,message,latest,directory,databasePath,
    legacy:(value:boolean)=>{legacy=value;},redeliver:(value:RemoteCommand)=>{next=value;},
    counters:()=>({sends,imageCalls,imageReads,voiceCalls,voiceReads,analysisCalls,generationCalls}),
    close:async()=>{application.close();await new Promise<void>(yes=>{server.close(()=>yes());server.closeAllConnections();});rmSync(directory,{recursive:true,force:true});}};
}

test('real current refresh reads only selected bindings and exports bounded descriptions without credentials or source identifiers',async()=>{
  const h=await harness();try{
    h.setRows(h.a,[record(1,{text:`你还好吗[拥抱] ${keys[0]} ${connection.token}`})]);
    h.setRows(h.b,[record(1,{text:'合成乙的独立消息'})]);
    const refreshed=await h.run('conversation.refresh',{id:h.a});assert.equal(refreshed.status,'succeeded');
    const view=refreshed.result.currentView;assert.equal(view.conversationId,h.a);assert.equal(view.messages.length,1);assert.equal(h.store.read().messages.length,1);
    assert.ok(view.messages[0].mediaSummary.includes('拥抱'));assert.equal(view.messages[0].recognition.provider,'local');
    assert.deepEqual(h.queries.map(query=>query.contact),[h.conversation(h.a).externalId]);
    const wire=JSON.stringify(h.polls);for(const secret of [...keys,connection.token,account])assert.ok(!wire.includes(secret));
    assert.doesNotMatch(wire,/sourceFingerprint|sourceSequence|sourceMessageHashes|imageAttachment|wechatEmoji|modelUrl|apiKey|private-habit-digest/);
    assert.equal(h.counters().sends,0);assert.equal(h.counters().analysisCalls,0);assert.equal(h.counters().generationCalls,0);
  }finally{await h.close();}
});

test('real message analysis targets the chosen utterance, caches it, and survives newer text while excluding another contact',async()=>{
  const h=await harness();try{
    h.setRows(h.a,[record(1,{text:'合成旧话：你最近还好吗'})]);await h.run('conversation.refresh',{id:h.a});const old=h.latest(h.a);
    const first=await h.invoke('conversation.message.analyze',h.a,old.id);assert.equal(first.status,'succeeded');
    assert.deepEqual(first.result.currentView.messages[0].analysis.intents,[{label:'关心',percentage:80},{label:'询问',percentage:20}]);
    assert.equal(first.result.currentView.messages[0].analysis.affinity.score,0);assert.equal(h.counters().analysisCalls,1);
    assert.equal((await h.invoke('conversation.message.analyze',h.a,old.id)).status,'succeeded');assert.equal(h.counters().analysisCalls,1);
    h.setRows(h.a,[record(1,{text:old.text}),record(2,{text:'合成新话'})]);const latest=await h.run('conversation.refresh',{id:h.a});
    assert.ok(latest.result.currentView.messages.find((m:any)=>m.id===old.id)?.analysis);
    assert.equal((await h.invoke('conversation.message.analyze',h.b,old.id)).status,'failed');assert.equal(h.counters().analysisCalls,1);
    h.store.update(s=>{s.conversations.find(c=>c.id===h.a)!.processing!.replyReviewEnabled=true;});
    h.setRows(h.a,[record(1,{text:old.text}),record(2,{role:'self',text:'合成自己的话'})]);await h.run('conversation.refresh',{id:h.a});
    assert.equal((await h.invoke('conversation.message.analyze',h.a,h.latest(h.a).id)).status,'succeeded');assert.equal(h.counters().analysisCalls,2);
    assert.doesNotMatch(JSON.stringify(h.polls),/inputDigest|evidence|uncertainty/);
  }finally{await h.close();}
});

test('real remote drafts use selected comparison models and habit profile, reject stale revisions, and replay without another model call',async()=>{
  const h=await harness();try{
    h.store.update(state=>{state.conversations.find(c=>c.id===h.a)!.processing!.replyModels=[{id:'first',provider:'compatible',modelName:'reply-one'},{id:'second',provider:'codex',modelName:'gpt-synthetic'}];});
    h.setRows(h.a,[record(1),record(2)]);await h.run('conversation.refresh',{id:h.a});const latest=h.latest(h.a),earlier=h.store.read().messages.find(m=>m.conversationId===h.a&&m.id!==latest.id)!;
    assert.equal((await h.run('conversation.drafts.generate',{id:h.a,messageId:latest.id,expectedMessageRevision:'0'.repeat(64)})).status,'failed');
    assert.equal((await h.invoke('conversation.drafts.generate',h.a,earlier.id)).status,'failed');assert.equal(h.counters().generationCalls,0);
    const value=h.queue('conversation.drafts.generate',{id:h.a,messageId:latest.id,expectedMessageRevision:remoteMessageRevision(latest),intent:'自然关心'});
    await h.remote.tick();const ack=await h.receipt(value);assert.equal(ack.status,'succeeded');
    assert.deepEqual(ack.result.currentView.drafts.map((d:any)=>d.modelName),['reply-one','gpt-synthetic']);
    assert.ok(ack.result.currentView.drafts.every((d:any)=>d.profileVersion==='v1.8-synthetic'&&d.basedOnMessageId===latest.id));
    assert.ok(h.signals.every(signal=>!signal.aborted));
    h.redeliver(value);await h.remote.tick();assert.equal((await h.receipt(value)).status,'succeeded');assert.equal(h.counters().generationCalls,1);assert.equal(h.counters().sends,0);
  }finally{await h.close();}
});

test('real custom emoji supports local reads, uploads, persistent cache and model-specific recognition',async()=>{
  const h=await harness();try{
    h.setRows(h.a,[record(1,{kind:'emoji',text:'[表情，未解析]',mediaStatus:'pending',wechatEmoji:{md5:'a'.repeat(32),cdnUrl:'https://synthetic.invalid/private-sticker'} as Message['wechatEmoji']})]);
    await h.run('conversation.refresh',{id:h.a});const mid=h.latest(h.a).id;
    const first=await h.invoke('conversation.message.recognize',h.a,mid);assert.equal(first.status,'succeeded');assert.match(first.result.currentView.messages[0].mediaSummary,/小猫挥手/);
    assert.equal(h.counters().imageReads,1);assert.equal(h.counters().imageCalls,1);
    assert.equal((await h.invoke('conversation.message.recognize',h.a,mid)).status,'succeeded');assert.equal(h.counters().imageCalls,1);
    assert.equal((await h.request(`/messages/${mid}/image`,'POST',upload)).status,200);
    assert.equal((await h.invoke('conversation.message.recognize',h.a,mid)).status,'succeeded');assert.equal(h.counters().imageCalls,1);
    assert.equal((await h.request(`/messages/${mid}/read-image`,'POST',{})).status,200);assert.equal(h.counters().imageReads,2);
    assert.equal((await h.invoke('conversation.message.recognize',h.a,mid)).status,'succeeded');assert.equal(h.counters().imageCalls,1);
    h.store.update(state=>{state.settings.vision!.modelName='vision-second';});
    assert.equal((await h.invoke('conversation.message.recognize',h.a,mid)).status,'succeeded');assert.equal(h.counters().imageCalls,2);
    h.store.update(state=>{state.settings.vision!.modelName='vision-synthetic';});
    assert.equal((await h.invoke('conversation.message.recognize',h.a,mid)).status,'succeeded');assert.equal(h.counters().imageCalls,2);
    const reopened=new Store(h.databasePath);try{assert.equal(reopened.read().messages.find(m=>m.id===mid)!.imageRecognitionHistory?.length,2);}finally{reopened.close();}
    assert.doesNotMatch(JSON.stringify(h.polls),/cdnUrl|private-sticker|imageSha256|modelIdentity|imageRecognitionHistory|data:image/);
    assert.equal(h.counters().sends,0);
    assert.equal((await h.request(`/messages/${mid}/image`,'POST',upload,{'X-CSRF-Token':''})).status,403);
    assert.equal((await fetch(h.base+`/api/messages/${mid}/image`)).status,401);
  }finally{await h.close();}
});

test('remote invalidation aborts analysis even if the model ignores cancellation, preventing a late local result',async()=>{
  const entered=deferred<void>(),pending=deferred<ContactInsights>();let observed:AbortSignal|undefined;
  const h=await harness({analyzeContactMessage:async(state,cid,mid,signal)=>{observed=signal;entered.resolve();await pending.promise;return analysisResult(state,cid,mid);}});
  try{
    h.setRows(h.a,[record(1)]);await h.run('conversation.refresh',{id:h.a});const mid=h.latest(h.a).id;
    const value=h.queue('conversation.message.analyze',{id:h.a,messageId:mid,expectedMessageRevision:remoteMessageRevision(h.message(mid))}),running=h.remote.tick();
    await entered.promise;h.remote.invalidate();assert.equal(observed?.aborted,true);pending.resolve(analysisResult(h.store.read(),h.a,mid));await running;
    assert.equal(h.message(mid).insights,undefined);assert.equal((await h.receipt(value)).status,'failed');assert.deepEqual(h.store.read().drafts,[]);
  }finally{await h.close();}
});

test('remote voice recognition exposes the saved transcript and its per-message intent without audio files or tokens',async()=>{
  const h=await harness();try{
    h.setRows(h.a,[record(1,{kind:'voice',text:'[语音，未解析]',mediaStatus:'pending'})]);await h.run('conversation.refresh',{id:h.a});const mid=h.latest(h.a).id;
    const recognized=await h.invoke('conversation.message.recognize',h.a,mid);assert.equal(recognized.status,'succeeded');
    assert.match(recognized.result.currentView.messages[0].mediaSummary,/合成语音：晚点见/);
    assert.equal(recognized.result.currentView.messages[0].recognition.modelName,'audio-synthetic');assert.equal(h.counters().voiceCalls,1);assert.equal(h.counters().voiceReads,1);
    const analyzed=await h.invoke('conversation.message.analyze',h.a,mid);assert.equal(analyzed.status,'succeeded');assert.equal(analyzed.result.currentView.messages[0].analysis.intents[0].percentage,80);
    assert.doesNotMatch(JSON.stringify(h.polls),/audioAttachment|RIFF|data:audio|usage|promptTokens/);
  }finally{await h.close();}
});

test('draft output is not saved after the target text changes during generation even if its message ID remains the same',async()=>{
  const entered=deferred<void>(),pending=deferred<void>();
  const h=await harness({generate:async(state,cid,_intent,signal)=>{assert.ok(signal);entered.resolve();await pending.promise;return generated(state,cid);}});
  try{
    h.setRows(h.a,[record(1)]);await h.run('conversation.refresh',{id:h.a});const mid=h.latest(h.a).id;
    const value=h.queue('conversation.drafts.generate',{id:h.a,messageId:mid,expectedMessageRevision:remoteMessageRevision(h.message(mid))}),running=h.remote.tick();
    await entered.promise;h.store.update(state=>{state.messages.find(m=>m.id===mid)!.text='合成内容已改，旧请求不再适用';});pending.resolve();await running;
    assert.deepEqual(h.store.read().drafts,[]);assert.equal((await h.receipt(value)).status,'failed');assert.equal(h.counters().sends,0);
  }finally{await h.close();}
});

test('a later local draft request supersedes the remote request nonce and preserves the chosen newer candidates',async()=>{
  const entered=deferred<void>(),pending=deferred<void>();
  const h=await harness({generate:async(state,cid,intent,signal)=>{if(intent==='old-remote'){assert.ok(signal);entered.resolve();await pending.promise;}
    return generated(state,cid).map(draft=>({...draft,text:`合成候选 ${intent}`}));}});
  try{
    h.setRows(h.a,[record(1)]);await h.run('conversation.refresh',{id:h.a});const mid=h.latest(h.a).id;
    const value=h.queue('conversation.drafts.generate',{id:h.a,messageId:mid,expectedMessageRevision:remoteMessageRevision(h.message(mid)),intent:'old-remote'}),running=h.remote.tick();
    await entered.promise;const local=await h.request(`/conversations/${h.a}/suggest`,'POST',{intent:'local-new'});assert.equal(local.status,200);
    const selected=h.store.read().drafts;assert.ok(selected.every(draft=>draft.text==='合成候选 local-new'));
    pending.resolve();await running;assert.equal((await h.receipt(value)).status,'failed');assert.deepEqual(h.store.read().drafts,selected);
  }finally{await h.close();}
});

test('an invalidated remote refresh cannot persist a late query from a collector that ignores its abort signal',async()=>{
  const entered=deferred<void>(),pending=deferred<void>();let observed:AbortSignal|undefined;
  const h=await harness({queryWechat:async(_input,signal)=>{observed=signal;entered.resolve();await pending.promise;return {records:[record(1)],hasMore:false,accountFingerprint:account};}});
  try{
    const value=h.queue('conversation.refresh',{id:h.a}),running=h.remote.tick();await entered.promise;h.remote.invalidate();assert.equal(observed?.aborted,true);
    pending.resolve();await running;assert.equal((await h.receipt(value)).status,'failed');assert.deepEqual(h.store.read().messages,[]);
    assert.equal(h.conversation(h.a).wechat!.cursor,null);
  }finally{await h.close();}
});

test('turning remote management off aborts ignored model drafts and strips current views from the persistent pause report',async()=>{
  const entered=deferred<void>(),pending=deferred<Draft[]>();let observed:AbortSignal|undefined;
  const h=await harness({generate:async(state,cid,_intent,signal)=>{observed=signal;entered.resolve();await pending.promise;return generated(state,cid);}});
  try{
    h.setRows(h.a,[record(1)]);await h.run('conversation.refresh',{id:h.a});const mid=h.latest(h.a).id;
    const value=h.queue('conversation.drafts.generate',{id:h.a,messageId:mid,expectedMessageRevision:remoteMessageRevision(h.message(mid))}),running=h.remote.tick();
    await entered.promise;assert.equal((await h.request('/settings','PATCH',{remoteManagementEnabled:false})).status,200);assert.equal(observed?.aborted,true);
    pending.resolve([]);await running;assert.deepEqual(h.store.read().drafts,[]);
    await h.remote.tick();assert.equal(h.polls.at(-1).snapshot.remoteEnabled,false);assert.ok(!('currentView'in h.polls.at(-1).snapshot));
    assert.equal(h.polls.at(-1).completed.find((entry:any)=>entry.id===value.id)?.status,'failed');assert.equal(h.counters().sends,0);
  }finally{await h.close();}
});

test('remote invalidation prevents a late sticker recognition and changed WeChat accounts cannot mix messages',async()=>{
  const entered=deferred<void>(),pending=deferred<void>();let observed:AbortSignal|undefined;
  const h=await harness({recognizeImage:async(settings,_file,signal)=>{observed=signal;entered.resolve();await pending.promise;return {summary:'应被忽略的表情',visibleText:'',facts:[],provider:'compatible',modelName:settings.vision!.modelName,recognizedAt:at};}});
  try{
    h.setRows(h.a,[record(1,{kind:'emoji',text:'[表情，未解析]',mediaStatus:'pending'})]);await h.run('conversation.refresh',{id:h.a});const mid=h.latest(h.a).id;
    const value=h.queue('conversation.message.recognize',{id:h.a,messageId:mid,expectedMessageRevision:remoteMessageRevision(h.message(mid))}),running=h.remote.tick();
    await entered.promise;h.remote.invalidate();assert.equal(observed?.aborted,true);pending.resolve();await running;
    assert.equal(h.message(mid).imageRecognition,undefined);assert.equal((await h.receipt(value)).status,'failed');
  }finally{await h.close();}
  let returnedAccount=account;
  const changed=await harness({queryWechat:async()=>({records:[record(1)],hasMore:false,accountFingerprint:returnedAccount})});
  try{
    assert.equal((await changed.run('conversation.refresh',{id:changed.a})).status,'succeeded');returnedAccount='another-synthetic-account';
    assert.equal((await changed.run('conversation.refresh',{id:changed.a})).status,'failed');assert.equal(changed.store.read().messages.length,1);
    assert.equal(changed.conversation(changed.a).wechat!.enabled,false);assert.equal(changed.conversation(changed.a).wechat!.status,'error');
  }finally{await changed.close();}
});

test('legacy fallback omits current fields and defers receipts until the server supports them',async()=>{
  const h=await harness();const originalNow=Date.now;try{
    h.setRows(h.a,[record(1)]);const value=h.queue('conversation.refresh',{id:h.a});await h.remote.tick();
    const scope=createHash('sha256').update(JSON.stringify([connection.url,connection.token])).digest('hex');assert.equal(h.store.remoteReceipts(scope).length,1);
    h.legacy(true);await h.remote.tick();const downgraded=h.polls.at(-1);assert.equal(downgraded.snapshot.version,1);assert.ok(!('currentView'in downgraded.snapshot));
    assert.deepEqual(downgraded.completed,[]);assert.equal(h.store.remoteReceipts(scope).length,1);
    const future=originalNow()+60_001;Date.now=()=>future;h.legacy(false);await h.remote.tick();const upgraded=h.polls.at(-1);
    assert.equal(upgraded.snapshot.version,2);assert.equal(upgraded.completed[0].id,value.id);assert.ok(upgraded.completed[0].result.currentView);assert.equal(h.store.remoteReceipts(scope).length,0);
  }finally{Date.now=originalNow;await h.close();}
});
