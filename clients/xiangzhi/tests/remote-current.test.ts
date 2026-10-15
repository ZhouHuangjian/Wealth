import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AppState,ContactBasisFact,ContactMemoryEntry,Conversation,Message} from '../shared/types.js';
import {Store} from '../server/store.js';
import {insightsInputDigest} from '../server/contact-insights.js';
import {MAX_REMOTE_SNAPSHOT_BYTES,remoteProfileRevision,remoteSnapshotV2} from '../server/remote-protocol.js';
import {remoteCurrentConversation,remoteMessageRevision,withRemoteCurrentView} from '../server/remote-current.js';

const at='2026-10-15T00:00:00.000Z';
const fact=():ContactBasisFact=>({id:randomUUID(),category:'interest',content:'对方提到骑车',sourceNote:'用户补充',origin:'manual',createdAt:at,updatedAt:at,sourceMessageIds:['private-source-id'],sourceMessageHashes:{'private-source-id':'private-source-hash'}});
const entry=():ContactMemoryEntry=>({id:randomUUID(),kind:'openTopic',text:'下周确认时间',status:'approved',origin:'manual',createdAt:at,updatedAt:at,sourceMessageIds:['private-source-id'],sourceMessageHashes:{'private-source-id':'private-source-hash'}});
const conversation=():Conversation=>({id:randomUUID(),name:'测试好友',avatar:'测',color:'green',note:'测试',channel:'wechat',externalId:'wxid_synthetic',autoReplyEnabled:false,createdAt:at,updatedAt:at,
  processing:{intentEnabled:true,affinityEnabled:true,memoryEnabled:true},basisFacts:[fact()],
  memory:{summary:'确认下次见面时间',openTopics:['日期'],entries:[entry()],summaryOrigin:'manual',openTopicsOrigin:'manual',throughSequence:1,sourceDigest:'private-source-digest',compressedMessageHashes:{'private-source-id':'private-source-hash'},provider:'manual',modelName:'用户补充',updatedAt:at},
  wechat:{enabled:true,initialized:true,cursor:'private-cursor',accountFingerprint:'private-account-fingerprint',lastCheckedAt:at,status:'ready',detail:'/Users/private/account sk-THIS_IS_PRIVATE_KEY diagnostic'}});
function fixture():AppState{
  const store=new Store(':memory:');const state=store.read();store.close();const c=conversation();state.conversations=[c];
  state.settings.analysis={provider:'qwen',modelName:'analysis-synthetic',modelUrl:'https://synthetic.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',apiKey:'PRIVATE-MODEL-KEY-123',useReplyApiKey:false,allowRemoteModel:true};
  state.messages=[message(c.id,1,'你好[微笑]😂')];return state;
}
function message(cid:string,sequence:number,text='合成消息',overrides:Partial<Message>={}):Message{
  return {id:randomUUID(),conversationId:cid,sequence,text,kind:'text',role:'peer',sentAt:at,source:'wechat',externalId:'private-wechat-server-id',sourceSequence:'private-sort-sequence',sourceFingerprint:'private-message-hash',aiAssisted:false,...overrides};
}
function saveAnalysis(state:AppState,message:Message,score=0){
  message.insights={conversationId:message.conversationId,messageId:message.id,inputDigest:insightsInputDigest(state,message.conversationId,message.id),
    intents:[{label:'关心',percentage:80},{label:'询问',percentage:20}],affinity:{score,confidence:30,evidence:['private-analysis-evidence']},uncertainty:'private-uncertainty',provider:'qwen',modelName:'analysis-synthetic',analyzedAt:at,usage:{promptTokens:1,completionTokens:1,totalTokens:2}};
}

test('current projections expose selected messages and summaries, while omitting private media/provenance/credentials',()=>{
  const state=fixture(),cid=state.conversations[0].id;
  state.messages[0].text+=' PRIVATE-MODEL-KEY-123 Bearer private-bearer-token sk-long-private-secret data:image/png;base64,PRIVATE-MEDIA binding-token-123';
  state.messages.push(message(cid,2,'[表情，待人工查看]',{kind:'emoji',mediaStatus:'recognized',imageAttachment:{id:randomUUID(),filename:'/private/media.gif',mimeType:'image/gif',source:'wechat'},wechatEmoji:{md5:'a'.repeat(32)},
    imageRecognition:{summary:'猫咪举牌',visibleText:'好的',facts:['private-observation-fact'],provider:'codex',modelName:'vision-synthetic',recognizedAt:at},imageRecognitionHistory:[{imageSha256:'private-image-sha',modelIdentity:'private-model-identity',recognition:{summary:'old',visibleText:'',facts:[],provider:'codex',modelName:'old',recognizedAt:at}}]}));
  saveAnalysis(state,state.messages[1]);
  state.drafts=[{id:randomUUID(),conversationId:cid,basedOnMessageId:state.messages[1].id,text:'行，看看怎么安排',label:'自然',reason:'接着当前话题',provider:'codex',modelName:'reply-synthetic',createdAt:at}];
  const other=conversation();state.conversations.push(other);state.messages.push(message(other.id,1,'OTHER-CONTACT-PRIVATE'));
  const base=remoteSnapshotV2(state.settings,[state.conversations[0]],state.messages,{wechatAvailable:true,codexAvailable:true});
  const snapshot=withRemoteCurrentView(base,state,['binding-token-123']) as {currentView:{conversations:ReturnType<typeof remoteCurrentConversation>[]}};
  assert.equal(snapshot.currentView.conversations.length,1);const view=snapshot.currentView.conversations[0];
  assert.equal(view.messages[0].recognition?.provider,'local');assert.match(view.messages[0].mediaSummary!,/微笑[\s\S]*笑哭/);
  assert.match(view.messages[0].mediaSummary!,/礼貌回应[\s\S]*无奈或自嘲/);
  assert.equal(view.messages[1].kind,'emoji');assert.match(view.messages[1].mediaSummary!,/猫咪举牌.*\n可见文字：好的/);
  assert.deepEqual(view.messages[1].analysis?.intents,[{label:'关心',percentage:80},{label:'询问',percentage:20}]);assert.equal(view.messages[1].analysis?.affinity?.score,0);
  assert.equal(view.drafts.length,1);assert.equal(view.profile?.revision,remoteProfileRevision(state.conversations[0]));assert.equal(view.wechat?.detail,'已读取最近消息。');
  const wire=JSON.stringify(snapshot);
  for(const secret of ['PRIVATE-MODEL-KEY-123','private-bearer-token','sk-long-private-secret','PRIVATE-MEDIA','binding-token-123','OTHER-CONTACT-PRIVATE','/private/media.gif','private-wechat-server-id','private-sort-sequence','private-message-hash','private-source-id','private-source-hash','private-source-digest','private-cursor','private-account-fingerprint','private-analysis-evidence','private-uncertainty','private-observation-fact','private-image-sha','private-model-identity','compatible-mode/v1'])assert.ok(!wire.includes(secret),secret);
});

test('only current, scoped saved analysis is projected and self expressions remain analyzable',()=>{
  const state=fixture(),cid=state.conversations[0].id,target=state.messages[0];saveAnalysis(state,target);
  assert.equal(remoteCurrentConversation(state,cid).messages[0].analysis?.intents.length,2);
  const revision=remoteMessageRevision(target);target.insights!.affinity!.score=90;assert.equal(remoteMessageRevision(target),revision);
  target.text+='发生变化';assert.equal(remoteCurrentConversation(state,cid).messages[0].analysis,undefined);assert.notEqual(remoteMessageRevision(target),revision);
  saveAnalysis(state,target);target.insights!.conversationId=randomUUID();assert.equal(remoteCurrentConversation(state,cid).messages[0].analysis,undefined);
  target.role='self';saveAnalysis(state,target);assert.equal(remoteCurrentConversation(state,cid).messages[0].analysis?.intents.length,2);
  state.conversations[0].processing!.intentEnabled=false;state.conversations[0].processing!.affinityEnabled=false;
  assert.equal(remoteCurrentConversation(state,cid).messages[0].analysis,undefined);
});

test('view revisions ignore sync timestamps and reader diagnostics while message revisions preserve full evidence',()=>{
  const state=fixture(),cid=state.conversations[0].id;state.messages[0].sentAt=null;
  const one=remoteCurrentConversation(state,cid);state.conversations[0].wechat!.detail='different private diagnostic';
  const two=remoteCurrentConversation(state,cid);assert.equal(one.revision,two.revision);
  state.messages[0].text='😀'.repeat(1100);const clipped=remoteCurrentConversation(state,cid).messages[0];
  assert.ok(clipped.text.length<=2000);assert.equal(clipped.truncated,true);assert.doesNotMatch(clipped.text,/[\uD800-\uDBFF]$/u);
  const messageRevision=clipped.revision;state.messages[0].text+='原文尾部';assert.notEqual(remoteCurrentConversation(state,cid).messages[0].revision,messageRevision);
});

test('recent windows preserve a forced older target, exclude system messages and stale reply drafts',()=>{
  const state=fixture(),cid=state.conversations[0].id;state.messages=Array.from({length:45},(_,index)=>message(cid,index+1));
  state.messages.push(message(cid,46,'系统通知',{role:'system',kind:'system'}));
  const old=state.messages[0],latest=state.messages[44];
  state.drafts=[{id:randomUUID(),conversationId:cid,basedOnMessageId:old.id,text:'过时草稿',label:'测试',reason:'测试',createdAt:at,provider:'demo'},
    {id:randomUUID(),conversationId:cid,basedOnMessageId:latest.id,text:'当前草稿',label:'测试',reason:'测试',createdAt:at,provider:'demo'}];
  const view=remoteCurrentConversation(state,cid,[],old.id);
  assert.equal(view.messages.length,30);assert.equal(view.messages[0].id,old.id);assert.equal(view.messages.at(-1)?.id,latest.id);assert.equal(view.truncated,true);
  assert.equal(view.drafts.length,1);assert.equal(view.drafts[0].text,'当前草稿');
  assert.throws(()=>remoteCurrentConversation(state,cid,[],randomUUID()),/不在本机当前会话/);
  const other=conversation();other.channel='simulator';state.conversations.push(other);assert.throws(()=>remoteCurrentConversation(state,other.id),/尚未绑定/);
});

test('profile previews keep full editing revisions, and a shared byte budget retains the latest message for every configured contact',()=>{
  const state=fixture();state.conversations=Array.from({length:8},conversation);state.messages=[];
  for(const c of state.conversations){
    c.basisFacts=Array.from({length:80},()=>({...fact(),content:'基础资料'.repeat(250),sourceNote:'资料来源'.repeat(125)}));
    c.memory!.entries=Array.from({length:100},()=>({...entry(),text:'记忆内容'.repeat(150)}));
    c.memory!.summary='摘要内容'.repeat(400);
    const messages=Array.from({length:40},(_,index)=>message(c.id,index+1,'长消息内容'.repeat(400)));state.messages.push(...messages);
    state.drafts.push(...Array.from({length:12},()=>({id:randomUUID(),conversationId:c.id,basedOnMessageId:messages.at(-1)!.id,text:'草稿内容'.repeat(125),label:'模型候选',reason:'解释'.repeat(150),provider:'codex' as const,createdAt:at})));
  }
  const previewState={...state,messages:[state.messages[0]],drafts:[]};
  const single=remoteCurrentConversation(previewState,state.conversations[0].id);assert.equal(single.profile?.revision,remoteProfileRevision(state.conversations[0]));assert.equal(single.profileTruncated,true);
  assert.ok((single.profile?.basisFacts.length??0)<=20);assert.ok((single.profile?.memory?.entries.length??0)<=20);
  const base=remoteSnapshotV2(state.settings,state.conversations,state.messages,{wechatAvailable:true,codexAvailable:true});
  const snapshot=withRemoteCurrentView(base,state) as {currentView:{conversations:ReturnType<typeof remoteCurrentConversation>[]}};
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=MAX_REMOTE_SNAPSHOT_BYTES);assert.equal(snapshot.currentView.conversations.length,8);
  for(const view of snapshot.currentView.conversations){const latest=state.messages.filter(message=>message.conversationId===view.conversationId).at(-1)!;
    assert.ok(view.messages.some(message=>message.id===latest.id));assert.ok(view.truncated||view.profileTruncated);
    assert.ok(view.drafts.every(draft=>view.messages.some(message=>message.id===draft.basedOnMessageId)));
  }
});

test('disabled snapshots carry no current messages and an impossible base budget fails without silently dropping the latest message',()=>{
  const state=fixture(),base=remoteSnapshotV2(state.settings,state.conversations,state.messages,{wechatAvailable:true,codexAvailable:true});
  const disabled=withRemoteCurrentView({...base,remoteEnabled:false},state) as {currentView:{conversations:unknown[]}};assert.deepEqual(disabled.currentView.conversations,[]);
  assert.throws(()=>withRemoteCurrentView({...base,padding:'x'.repeat(MAX_REMOTE_SNAPSHOT_BYTES)},state),/内容过大/);
  const bad={...state.messages[0],sentAt:'invalid date',text:'broken\uD800unicode\0'};state.messages=[bad];const view=remoteCurrentConversation(state,state.conversations[0].id);
  assert.equal(view.messages[0].sentAt,null);assert.doesNotMatch(view.messages[0].text,/[\uD800-\uDFFF\0]/u);
});
