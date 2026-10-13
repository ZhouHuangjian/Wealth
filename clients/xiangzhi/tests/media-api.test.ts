import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';
import type { ImageRecognition, AudioRecognition, Draft } from '../shared/types.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXv0AAAAASUVORK5CYII=','base64');
const upload={dataUrl:`data:image/png;base64,${png.toString('base64')}`,filename:'test.png'};
const observation:ImageRecognition={summary:'一张测试图片',visibleText:'TEST',facts:['白色背景'],provider:'qwen',modelName:'qwen3.8-flash',recognizedAt:'2026-10-13T00:00:00Z'};
const transcript:AudioRecognition={text:'测试语音',provider:'qwen',modelName:'qwen3.8-omni-flash',recognizedAt:'2026-10-13T00:00:00Z'};
type Options=Parameters<typeof createApplication>[0];
async function harness(overrides:Partial<Options>={}) {
  const dir=mkdtempSync(join(tmpdir(),'xiangzhi-media-api-')),databasePath=join(dir,'test.sqlite');
  const calls={image:0,voice:0,send:0};
  const instance=createApplication({databasePath,seed:false,profileManifestPath:null,
    inspectCodex:async()=>({available:false,version:null,message:'测试'}),inspectWechat:()=>({available:true,message:'测试'}),
    recognizeImage:async()=>{calls.image++;return observation;},transcribeAudio:async()=>{calls.voice++;return transcript;},
    readWechatImage:async()=>({bytes:png,mimeType:'image/png',filename:'wechat.png'}),
    readWechatVoice:async()=>({bytes:Buffer.from('RIFF0000WAVEdata'),mimeType:'audio/wav',filename:'wechat.wav'}),
    send:async()=>{calls.send++;},...overrides});
  const server=instance.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session=await fetch(base+'/api/session'),{token}=await session.json() as {token:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const request=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(base+'/api'+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':token,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const c=await(await request('/conversations','POST',{name:'测试',channel:'simulator'})).json();
  return {...instance,cid:c.id as string,calls,dir,databasePath,request,base,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));instance.close();rmSync(dir,{recursive:true,force:true});}};
}
test('independent image and voice secrets are hidden, retained on blank omission and protected by CSRF',async()=>{
  const h=await harness();
  try{
    const vision={provider:'qwen',modelUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',modelName:'qwen3.8-flash',apiKey:'private-image-key',useReplyApiKey:false,allowRemoteModel:true};
    const audio={...vision,modelName:'qwen3.8-omni-flash',apiKey:'private-audio-key'};
    assert.equal((await h.request('/settings','PATCH',{vision,audio})).status,200);
    const state=await(await h.request('/state')).json();
    assert.equal(state.settings.vision.hasApiKey,true);assert.equal(state.settings.audio.hasApiKey,true);
    assert.ok(!JSON.stringify(state).includes('private-image-key'));assert.ok(!JSON.stringify(state).includes('private-audio-key'));
    const {apiKey:_key,...noKey}=vision;
    assert.equal((await h.request('/settings','PATCH',{vision:noKey})).status,200);
    assert.equal(h.store.read().settings.vision?.apiKey,'private-image-key');
    assert.equal((await h.request('/images/test','POST',upload,{'X-CSRF-Token':''})).status,403);
    assert.equal((await h.request('/images/test','POST',{...upload,dataUrl:'data:image/png;base64,bm90LWEtcGljdHVyZQ=='})).status,400);
    assert.equal(h.calls.image,0);
  }finally{await h.close();}
});
test('image upload, recognition and local cache are scoped to a message and never send or queue replies',async()=>{
  const h=await harness();
  try{
    const m=await(await h.request(`/conversations/${h.cid}/images`,'POST',upload)).json();
    assert.equal(m.source,'manual');assert.equal(m.mediaStatus,'pending');
    const image=await h.request(`/messages/${m.id}/image`);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    assert.equal((await h.request(`/messages/${m.id}/recognize-image`,'POST',{})).status,200);
    const current=h.store.read().messages.find(x=>x.id===m.id)!;
    assert.equal(current.mediaStatus,'recognized');assert.deepEqual(current.imageRecognition,observation);
    assert.equal(h.calls.image,1);assert.equal(h.store.read().jobs.length,0);assert.equal(h.calls.send,0);
    assert.equal(readdirSync(h.databasePath+'.media').length,1);
    assert.equal((await h.request(`/conversations/${h.cid}`,'DELETE')).status,200);
    assert.equal(readdirSync(h.databasePath+'.media').length,0);
    assert.equal((await h.request(`/messages/${m.id}/image`)).status,404);
  }finally{await h.close();}
});
test('replacement discards in-flight recognition rather than attaching stale observations',async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  const h=await harness({recognizeImage:async()=>{entered();await hold;return observation;}});
  try{
    const m=await(await h.request(`/conversations/${h.cid}/images`,'POST',upload)).json();
    const pending=h.request(`/messages/${m.id}/recognize-image`,'POST',{});await ready;
    assert.equal((await h.request(`/messages/${m.id}/image`,'POST',{...upload,filename:'replacement.png'})).status,200);
    release();assert.equal((await pending).status,400);
    const current=h.store.read().messages.find(x=>x.id===m.id)!;assert.equal(current.imageRecognition,undefined);assert.equal(current.mediaStatus,'pending');
    assert.equal(readdirSync(h.databasePath+'.media').length,1);
  }finally{release();await h.close();}
});
test('rereading downloaded WeChat media replaces its cached attachment and clears old observations',async()=>{
  const h=await harness();
  try{
    h.store.update(s=>{const c=s.conversations.find(x=>x.id===h.cid)!;c.channel='wechat';c.externalId='filehelper';c.wechat={enabled:false,initialized:true,cursor:'1',accountFingerprint:'account',lastCheckedAt:null,status:'paused',detail:''};s.messages.push({id:'wx-image',conversationId:h.cid,role:'peer',text:'图片',sequence:1,sentAt:null,source:'wechat',externalId:'1',aiAssisted:false,kind:'image',mediaStatus:'pending'});});
    await h.request('/messages/wx-image/read-image','POST',{});await h.request('/messages/wx-image/recognize-image','POST',{});
    const first=h.store.read().messages.find(x=>x.id==='wx-image')!.imageAttachment!.id;
    assert.equal((await h.request('/messages/wx-image/read-image','POST',{})).status,200);
    const current=h.store.read().messages.find(x=>x.id==='wx-image')!;assert.notEqual(current.imageAttachment!.id,first);assert.equal(current.imageRecognition,undefined);assert.equal(current.mediaStatus,'pending');assert.equal(readdirSync(h.databasePath+'.media').length,1);
  }finally{await h.close();}
});
test('automatic media switches are independent and process only eligible live messages',async()=>{
  const h=await harness();
  try{
    h.store.update(s=>{
      const c=s.conversations.find(x=>x.id===h.cid)!;c.processing={autoRecognizeImages:true,autoTranscribeVoice:false};c.channel='wechat';c.externalId='filehelper';c.wechat={enabled:true,initialized:true,cursor:'1',accountFingerprint:'account',lastCheckedAt:null,status:'ready',detail:''};
      s.messages.push(...(['old-image','new-image','new-voice'] as const).map((id,i)=>({id,conversationId:h.cid,role:'peer' as const,text:'媒体',sequence:i+1,sentAt:null,source:'wechat' as const,externalId:String(i+1),aiAssisted:false,kind:id==='new-voice'?'voice' as const:'image' as const,mediaStatus:'pending' as const,autoMediaEligible:id!=='old-image'})));
    });
    await h.mediaAutomation.tick();assert.equal(h.calls.image,1);assert.equal(h.calls.voice,0);
    assert.equal(h.store.read().messages.find(x=>x.id==='old-image')?.imageRecognition,undefined);
    await h.mediaAutomation.tick();assert.equal(h.calls.image,1);
    h.store.update(s=>{s.conversations.find(c=>c.id===h.cid)!.processing!.autoTranscribeVoice=true;});await h.mediaAutomation.tick();assert.equal(h.calls.voice,1);
    assert.equal(h.store.read().messages.find(x=>x.id==='new-voice')?.audioRecognition?.text,'测试语音');assert.equal(h.calls.send,0);
  }finally{await h.close();}
});

test('contact media permissions isolate A from B and ignore old global automatic switches',async()=>{
  const h=await harness();
  try{
    const other=await(await h.request('/conversations','POST',{name:'B'})).json();
    h.store.update(s=>{
      s.settings.autoRecognizeImages=true;s.settings.autoTranscribeVoice=true;
      for(const c of s.conversations){c.channel='wechat';c.externalId=c.id;c.wechat={enabled:true,initialized:true,cursor:'1',accountFingerprint:'account',lastCheckedAt:null,status:'ready',detail:''};}
      s.conversations.find(c=>c.id===h.cid)!.processing={autoRecognizeImages:true};
      for(const cid of [h.cid,other.id])for(const kind of ['image','voice'] as const)s.messages.push({
        id:`${cid}-${kind}`,conversationId:cid,role:'peer',text:'媒体',sequence:s.messages.length+1,sentAt:null,
        source:'wechat',externalId:String(s.messages.length+1),aiAssisted:false,kind,mediaStatus:'pending',autoMediaEligible:true,
      });
    });
    await h.mediaAutomation.tick();await h.mediaAutomation.tick();
    assert.equal(h.calls.image,1);assert.equal(h.calls.voice,0);
    assert.ok(h.store.read().messages.find(m=>m.id===`${h.cid}-image`)?.imageRecognition);
    assert.ok(h.store.read().messages.filter(m=>m.conversationId===other.id).every(m=>!m.imageRecognition&&!m.audioRecognition));
  }finally{await h.close();}
});

test('contact processing updates merge, reset inherited choices, reject secrets and preserve other contacts',async()=>{
  const h=await harness();
  try{
    const other=await(await h.request('/conversations','POST',{name:'B'})).json();
    const choice={id:'a-model',provider:'demo',modelName:''};
    assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{processing:{replyModels:[choice],autoTranscribeVoice:false}})).status,200);
    assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{processing:{autoRecognizeImages:false}})).status,200);
    const current=h.store.read().conversations.find(c=>c.id===h.cid)!;
    assert.deepEqual(current.processing,{replyModels:[choice],autoTranscribeVoice:false,autoRecognizeImages:false});
    assert.equal(h.store.read().conversations.find(c=>c.id===other.id)!.processing,undefined);
    assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{processing:{replyModels:null}})).status,200);
    assert.equal(h.store.read().conversations.find(c=>c.id===h.cid)!.processing!.replyModels,undefined);
    for(const invalid of [{apiKey:'not-allowed'},{autoRecognizeImages:'true'},{replyModels:[choice,choice]},
      {replyModels:[{...choice,id:'bad id'}]},{replyModels:Array.from({length:5},(_,i)=>({...choice,id:`m${i}`}))}]) {
      assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{processing:invalid})).status,400);
    }
    assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{processing:{autoRecognizeImages:true}})).status,400);
  }finally{await h.close();}
});

test('deprecated global media flags do not prevent disabling media providers',async()=>{
  const h=await harness();
  try{
    h.store.update(s=>{s.settings.autoRecognizeImages=true;s.settings.autoTranscribeVoice=true;});
    const disabled={provider:'disabled',modelUrl:'',modelName:'',useReplyApiKey:false,allowRemoteModel:false};
    assert.equal((await h.request('/settings','PATCH',{vision:disabled,audio:disabled})).status,200);
    assert.equal(h.store.read().settings.vision?.provider,'disabled');assert.equal(h.store.read().settings.audio?.provider,'disabled');
  }finally{await h.close();}
});

test('changing voice configuration preserves an independent in-flight image recognition',async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  let imageSignal:AbortSignal|undefined;
  const h=await harness({recognizeImage:async(_settings,_file,signal)=>{imageSignal=signal;entered();await hold;return observation;}});
  try{
    const message=await(await h.request(`/conversations/${h.cid}/images`,'POST',upload)).json();
    const pending=h.request(`/messages/${message.id}/recognize-image`,'POST',{});await ready;
    assert.equal((await h.request('/settings','PATCH',{audio:{provider:'disabled',modelUrl:'',modelName:'changed-voice-model',useReplyApiKey:false,allowRemoteModel:false}})).status,200);
    assert.equal(imageSignal!.aborted,false);release();assert.equal((await pending).status,200);
    assert.deepEqual(h.store.read().messages.find(m=>m.id===message.id)?.imageRecognition,observation);
  }finally{release();await h.close();}
});

test('global automatic draft enable validates only the selected models for active contacts',async()=>{
  const h=await harness();
  try{
    h.store.update(s=>{s.settings.replyModels=[{id:'unused',provider:'compatible',modelName:'unused-model'}];s.settings.modelUrl='';});
    assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{autoReplyEnabled:true,processing:{replyModels:[{id:'chosen',provider:'demo',modelName:''}]}})).status,200);
    assert.equal((await h.request('/settings','PATCH',{autoReplyEnabled:true})).status,200);
    assert.equal(h.store.read().settings.autoReplyEnabled,true);
    assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{processing:{replyModels:null}})).status,400);
  }finally{await h.close();}
});

test('disabling only A during local extraction cancels its upload while B settings leave it running',async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  let extractionSignal:AbortSignal|undefined;
  const h=await harness({readWechatImage:async(_input,signal)=>{extractionSignal=signal;entered();await hold;return{bytes:png,mimeType:'image/png',filename:'wechat.png'};}});
  try{
    const other=await(await h.request('/conversations','POST',{name:'B'})).json();
    h.store.update(s=>{
      const c=s.conversations.find(c=>c.id===h.cid)!;c.processing={autoRecognizeImages:true};c.channel='wechat';c.externalId='filehelper';
      c.wechat={enabled:true,initialized:true,cursor:'1',accountFingerprint:'account',lastCheckedAt:null,status:'ready',detail:''};
      s.messages.push({id:'extracting-a',conversationId:h.cid,role:'peer',text:'图片',sequence:1,sentAt:null,source:'wechat',externalId:'1',aiAssisted:false,kind:'image',mediaStatus:'pending',autoMediaEligible:true});
    });
    const pending=h.mediaAutomation.tick();await ready;
    assert.equal((await h.request(`/conversations/${other.id}`,'PATCH',{processing:{autoRecognizeImages:false}})).status,200);
    assert.equal(extractionSignal!.aborted,false);
    assert.equal((await h.request(`/conversations/${h.cid}`,'PATCH',{processing:{autoRecognizeImages:false}})).status,200);
    assert.equal(extractionSignal!.aborted,true);
    release();await pending;
    assert.equal(h.calls.image,0);assert.equal(h.store.read().messages.find(m=>m.id==='extracting-a')?.imageAttachment,undefined);
    assert.equal(h.store.read().messages.find(m=>m.id==='extracting-a')?.imageRecognition,undefined);
  }finally{release();await h.close();}
});
test('automatic image completion regenerates the queued draft with its recognized context',async()=>{
  const h=await harness();
  try{
    h.store.update(s=>{
      s.settings.autoReplyEnabled=true;s.settings.replyDelaySeconds=0;
      const c=s.conversations.find(x=>x.id===h.cid)!;c.processing={autoRecognizeImages:true};c.autoReplyEnabled=true;c.channel='wechat';c.externalId='filehelper';c.wechat={enabled:true,initialized:true,cursor:'1',accountFingerprint:'account',lastCheckedAt:null,status:'ready',detail:''};
      s.messages.push({id:'live-image',conversationId:h.cid,role:'peer',text:'[图片，待人工查看]',sequence:1,sentAt:null,source:'wechat',externalId:'1',aiAssisted:false,kind:'image',mediaStatus:'pending',autoMediaEligible:true});
    });
    h.engine.enqueue(h.cid,'live-image');await h.engine.tick();assert.equal(h.store.read().drafts.length,0);
    await h.mediaAutomation.tick();await h.engine.tick();
    assert.equal(h.store.read().drafts.length,3);assert.equal(h.store.read().jobs.at(-1)?.status,'drafted');assert.equal(h.calls.send,0);
  }finally{await h.close();}
});
test('manual review wins over a concurrent machine recognition and its summary remains authoritative',async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  const h=await harness({recognizeImage:async()=>{entered();await hold;return observation;}});
  try{
    const m=await(await h.request(`/conversations/${h.cid}/images`,'POST',upload)).json();
    const pending=h.request(`/messages/${m.id}/recognize-image`,'POST',{});await ready;
    assert.equal((await h.request(`/messages/${m.id}/review-media`,'POST',{summary:'人工确认的内容'})).status,200);
    release();assert.equal((await pending).status,400);
    const current=h.store.read().messages.find(x=>x.id===m.id)!;assert.equal(current.mediaStatus,'reviewed');assert.match(current.text,/人工确认的内容/);assert.equal(current.imageRecognition,undefined);
  }finally{release();await h.close();}
});
for(const action of ['switch','collection'] as const)test(`${action} pause cancels automatic media and discards an ignored-abort response`,async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  const h=await harness({recognizeImage:async()=>{entered();await hold;return observation;}});
  try{
    h.store.update(s=>{const c=s.conversations.find(x=>x.id===h.cid)!;c.processing={autoRecognizeImages:true};c.channel='wechat';c.externalId='filehelper';c.wechat={enabled:true,initialized:true,cursor:'1',accountFingerprint:'account',lastCheckedAt:null,status:'ready',detail:''};s.messages.push({id:'cancel-image',conversationId:h.cid,role:'peer',text:'图片',sequence:1,sentAt:null,source:'wechat',externalId:'1',aiAssisted:false,kind:'image',mediaStatus:'pending',autoMediaEligible:true});});
    const pending=h.mediaAutomation.tick();await ready;
    const response=action==='switch'?await h.request(`/conversations/${h.cid}`,'PATCH',{processing:{autoRecognizeImages:false}}):await h.request(`/conversations/${h.cid}/wechat`,'PATCH',{enabled:false});
    assert.equal(response.status,200);release();await pending;
    assert.equal(h.store.read().messages.find(x=>x.id==='cancel-image')?.imageRecognition,undefined);assert.equal(h.calls.send,0);
  }finally{release();await h.close();}
});
test('multi-model candidates stay draft-only and synchronize in separate three-candidate batches',async()=>{
  const batches:unknown[]=[];
  const h=await harness({draftSync:{url:'https://sync.example/api/v1/chat/ingest',token:'x'.repeat(40),inboxToken:''},
    generate:async(s,cid)=>['flash','max'].flatMap(model=>Array.from({length:3},(_,i):Draft=>({id:`${model}-${i}`,conversationId:cid,basedOnMessageId:s.messages.at(-1)!.id,text:`${model} 候选${i}`,label:'自然',reason:'测试',createdAt:new Date().toISOString(),provider:'compatible',modelName:`qwen3.8-${model}`,modelChoiceId:model}))),
    uploadDrafts:async(_config,batch)=>{batches.push(batch);return{id:batch.id,duplicate:false};}});
  try{
    const replyModels=['flash','max'].map(id=>({id,provider:'compatible',modelName:`qwen3.8-${id}`,modelPreset:'qwen'}));
    assert.equal((await h.request('/settings','PATCH',{provider:'codex',allowRemoteModel:true,replyModels,autoReplyMode:'send'})).status,200);
    assert.equal(h.store.read().settings.autoReplyMode,'draft');assert.equal(h.store.read().settings.autoReplyEnabled,false);
    await h.request(`/conversations/${h.cid}/messages`,'POST',{text:'你好',role:'peer'});
    const result=await(await h.request(`/conversations/${h.cid}/suggest`,'POST',{})).json();assert.equal(result.drafts.length,6);
    assert.equal((await h.request(`/conversations/${h.cid}/sync-drafts`,'POST',{})).status,200);
    assert.equal(batches.length,2);assert.ok(batches.every((x:any)=>x.drafts.length===3));assert.equal(h.calls.send,0);
  }finally{await h.close();}
});
test('a primary-model change without a comparison list replaces previous comparison choices',async()=>{
  const h=await harness();
  try{
    h.store.update(s=>{s.settings.provider='compatible';s.settings.modelName='qwen3.8-flash';s.settings.replyModels=[{id:'a',provider:'compatible',modelName:'qwen3.8-flash'},{id:'b',provider:'compatible',modelName:'qwen3.8-max'}];});
    assert.equal((await h.request('/settings','PATCH',{modelName:'qwen3.7-plus'})).status,200);
    assert.deepEqual(h.store.read().settings.replyModels,[]);assert.equal(h.store.read().settings.modelName,'qwen3.7-plus');
  }finally{await h.close();}
});
