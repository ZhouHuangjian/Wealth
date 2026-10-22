import {createHash} from 'node:crypto';
import type {AppState,ContactInsights,Conversation,Draft,Message,MessageKind} from '../shared/types.js';
import {messageEmojiRecognition} from '../shared/emoji.js';
import {messageEvidenceHash} from './contact-evidence.js';
import {insightsInputDigest} from './contact-insights.js';
import {knownRemoteSecrets,MAX_REMOTE_SNAPSHOT_BYTES,remoteProfile,remoteProfileRevision,sanitizeRemoteText} from './remote-protocol.js';

export interface RemoteCurrentMessage {
  id:string;revision:string;role:'self'|'peer';text:string;kind:MessageKind;sentAt:string|null;sequence:number;
  mediaSummary?:string;recognition?:{provider:'local'|'qwen'|'compatible'|'codex';modelName:string;recognizedAt:string};
  analysis?:{intents:ContactInsights['intents'];affinity:{score:number|null;confidence:number}|null;provider:ContactInsights['provider'];modelName:string;analyzedAt:string};
  truncated?:boolean;
}
export interface RemoteCurrentDraft {
  id:string;basedOnMessageId:string;text:string;label:string;reason:string;createdAt:string;provider:Draft['provider'];
  modelName?:string;modelChoiceId?:string;profileVersion?:string|null;
}
export interface RemoteCurrentConversation {
  conversationId:string;revision:string;syncedAt:string;messages:RemoteCurrentMessage[];drafts:RemoteCurrentDraft[];
  profile?:ReturnType<typeof remoteProfile>;profileTruncated?:boolean;truncated?:boolean;
  wechat?:{enabled:boolean;status:NonNullable<Conversation['wechat']>['status'];lastCheckedAt:string|null;detail:string};
}
export interface RemoteCurrentView {syncedAt:string;conversations:RemoteCurrentConversation[]}
const LIMITATION='当前内容过大，请先在 Mac 缩短会话备注或档案后再同步。';
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const iso=(value:unknown):string|null=>{
  if(typeof value!=='string'||!value||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
  const at=Date.parse(value);return Number.isFinite(at)?new Date(at).toISOString():null;
};
const unicode=(value:string)=>value.replace(/\0/g,'').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,'\uFFFD');
function clip(value:string,maximum:number):string{
  let result=value.slice(0,maximum);if(/[\uD800-\uDBFF]$/.test(result))result=result.slice(0,-1);return result;
}
const safe=(value:string,maximum:number,secrets:readonly string[])=>clip(unicode(sanitizeRemoteText(value,secrets)),maximum);

/** Opaque raw-evidence revision, independent of saved analysis and cloud truncation. */
export const remoteMessageRevision=(message:Message):string=>messageEvidenceHash(message);

function currentAnalysis(state:AppState,conversation:Conversation,message:Message,secrets:readonly string[]):RemoteCurrentMessage['analysis']{
  const result=message.insights;
  if(message.role==='system'||!result||result.conversationId!==conversation.id||result.messageId!==message.id||!result.inputDigest||!iso(result.analyzedAt))return;
  try{if(result.inputDigest!==insightsInputDigest(state,conversation.id,message.id))return;}catch{return;}
  return {intents:conversation.processing?.intentEnabled?result.intents.map(item=>({label:item.label,percentage:item.percentage})):[],
    affinity:conversation.processing?.affinityEnabled&&result.affinity?{score:result.affinity.score,confidence:result.affinity.confidence}:null,
    provider:result.provider,modelName:safe(result.modelName,200,secrets),analyzedAt:iso(result.analyzedAt)!};
}

function currentMessage(state:AppState,conversation:Conversation,message:Message,secrets:readonly string[],syncedAt:string):RemoteCurrentMessage{
  const text=safe(message.text,2000,secrets);
  const result:RemoteCurrentMessage={id:message.id,revision:remoteMessageRevision(message),role:message.role as 'self'|'peer',text,
    kind:message.kind??'text',sentAt:iso(message.sentAt),sequence:message.sequence};
  if(unicode(sanitizeRemoteText(message.text,secrets)).length>text.length)result.truncated=true;
  let mediaText:string|undefined,recognition:RemoteCurrentMessage['recognition'];
  if((message.kind==='image'||message.kind==='emoji')&&message.mediaStatus==='recognized'&&message.imageRecognition){
    const observed=message.imageRecognition,at=iso(observed.recognizedAt);
    if(at){mediaText=`${message.kind==='emoji'?'表情解析':'图片解析'}：${observed.summary}${observed.visibleText?`\n可见文字：${observed.visibleText}`:''}`;
      recognition={provider:observed.provider,modelName:safe(observed.modelName,200,secrets),recognizedAt:at};}
  }else if(message.kind==='voice'&&message.mediaStatus==='recognized'&&message.audioRecognition){
    const observed=message.audioRecognition,at=iso(observed.recognizedAt);
    if(at){mediaText=`语音转写：${observed.text}`;recognition={provider:observed.provider,modelName:safe(observed.modelName,200,secrets),recognizedAt:at};}
  }else{
    const parsed=messageEmojiRecognition(message);
    if(parsed){mediaText=`表情解析：${parsed.tokens.slice(0,8).map(token=>`${token.value} ${token.description}`).join('\n')}${parsed.tokens.length>8?`\n另有 ${parsed.tokens.length-8} 个表情。`:''}`;
      if(parsed.tokens.length>8)result.truncated=true;
      recognition={provider:'local',modelName:'微信表情解析',recognizedAt:iso(parsed.recognizedAt)??syncedAt};}
  }
  if(mediaText!==undefined){result.mediaSummary=safe(mediaText,2000,secrets);result.recognition=recognition;
    if(unicode(sanitizeRemoteText(mediaText,secrets)).length>result.mediaSummary.length)result.truncated=true;}
  const analysis=currentAnalysis(state,conversation,message,secrets);if(analysis)result.analysis=analysis;
  return result;
}

function currentDraft(draft:Draft,secrets:readonly string[]):RemoteCurrentDraft|undefined{
  const createdAt=iso(draft.createdAt),text=safe(draft.text,2000,secrets);if(!createdAt||!text.trim())return;
  return {id:draft.id,basedOnMessageId:draft.basedOnMessageId,text,label:safe(draft.label,80,secrets),reason:safe(draft.reason,600,secrets),createdAt,provider:draft.provider,
    ...(draft.modelName!==undefined?{modelName:safe(draft.modelName,200,secrets)}:{}),
    ...(draft.modelChoiceId&&sanitizeRemoteText(draft.modelChoiceId,secrets)===draft.modelChoiceId?{modelChoiceId:draft.modelChoiceId}:{}),
    ...(draft.profileVersion!==undefined?{profileVersion:draft.profileVersion===null?null:safe(draft.profileVersion,100,secrets)}:{})};
}

function currentProfile(conversation:Conversation,secrets:readonly string[]){
  const facts=conversation.basisFacts??[],memory=conversation.memory,entries=memory?.entries.filter(entry=>entry.status!=='rejected')??[];
  const limited={...conversation,basisFacts:facts.slice(-20),memory:memory?{...memory,entries:entries.slice(-20),summary:clip(unicode(memory.summary),1600),openTopics:memory.openTopics.slice(0,10).map(value=>clip(unicode(value),200))}:undefined};
  const projected=remoteProfile(limited,secrets);projected.revision=remoteProfileRevision(conversation);
  const invalidFactTimes=projected.basisFacts.some(fact=>!iso(fact.createdAt)||!iso(fact.updatedAt));
  projected.basisFacts=projected.basisFacts.filter(fact=>iso(fact.createdAt)&&iso(fact.updatedAt)).map(fact=>({...fact,
    content:safe(fact.content,1000,secrets),sourceNote:safe(fact.sourceNote,500,secrets),createdAt:iso(fact.createdAt)!,updatedAt:iso(fact.updatedAt)!}));
  let invalidMemoryTimes=false;
  if(projected.memory){
    if(!iso(projected.memory.updatedAt)){projected.memory=null;invalidMemoryTimes=true;}
    else{const saved=projected.memory;invalidMemoryTimes=saved.entries.some(entry=>!iso(entry.createdAt)||entry.updatedAt&&!iso(entry.updatedAt));
      saved.summary=safe(saved.summary,1600,secrets);saved.openTopics=saved.openTopics.map(topic=>safe(topic,200,secrets)).filter(topic=>topic.trim());
      saved.modelName=safe(saved.modelName,200,secrets);saved.updatedAt=iso(saved.updatedAt)!;
      saved.entries=saved.entries.filter(entry=>iso(entry.createdAt)&&(!entry.updatedAt||iso(entry.updatedAt))).map(entry=>({...entry,text:safe(entry.text,600,secrets),createdAt:iso(entry.createdAt)!,...(entry.updatedAt?{updatedAt:iso(entry.updatedAt)!}:{})}));
    }
  }
  return {profile:projected,profileTruncated:facts.length>20||entries.length>20||invalidFactTimes||invalidMemoryTimes
    ||!!memory&&(memory.summary.length>1600||memory.openTopics.length>10||memory.openTopics.some(topic=>topic.length>200))};
}

function updateRevision(view:RemoteCurrentConversation):void{
  const {syncedAt:_at,revision:_revision,...content}=view;
  // Inline dictionary parsing is free and repeats while polling; its collection
  // timestamp must not turn unchanged glyphs into a configuration conflict.
  const messages=content.messages.map(message=>message.recognition?.provider==='local'?{...message,recognition:{provider:'local',modelName:message.recognition.modelName}}:message);
  view.revision=createHash('sha256').update(JSON.stringify({...content,messages})).digest('hex');
}

function buildCurrentConversation(state:AppState,cid:string,secrets:readonly string[],syncedAt:string,forceMessageId?:string):RemoteCurrentConversation{
  const conversation=state.conversations.find(value=>value.id===cid&&value.channel==='wechat'&&value.externalId&&value.wechat);
  if(!conversation)throw new Error('此人尚未绑定本机微信会话，无法同步当前信息。');
  const all=state.messages.filter(message=>message.conversationId===cid&&message.role!=='system').sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));
  let selected=all.slice(-30);
  if(forceMessageId&&!selected.some(message=>message.id===forceMessageId)){
    const target=all.find(message=>message.id===forceMessageId);if(!target)throw new Error('这条消息已不在本机当前会话中，请刷新后重试。');
    selected=[...all.slice(-29),target].sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));
  }
  const ids=new Set(selected.map(message=>message.id)),latest=all.at(-1);
  const matching=state.drafts.filter(draft=>draft.conversationId===cid&&draft.basedOnMessageId===latest?.id&&ids.has(draft.basedOnMessageId));
  const drafts=matching.slice(-12).map(draft=>currentDraft(draft,secrets)).filter((draft):draft is RemoteCurrentDraft=>!!draft);
  const profile=currentProfile(conversation,secrets);
  const view:RemoteCurrentConversation={conversationId:cid,revision:'',syncedAt,messages:selected.map(message=>currentMessage(state,conversation,message,secrets,syncedAt)),drafts,
    ...profile,...(all.length>selected.length||matching.length>drafts.length?{truncated:true}:{}),
    wechat:{enabled:!!conversation.wechat!.enabled,status:conversation.wechat!.status,lastCheckedAt:iso(conversation.wechat!.lastCheckedAt),
      detail:{paused:'微信读取已暂停。',reading:'正在读取最近消息。',ready:'已读取最近消息。',error:'读取未完成，请在 Mac 核对。'}[conversation.wechat!.status]}};
  updateRevision(view);return view;
}

function trimProfile(view:RemoteCurrentConversation):boolean{
  const profile=view.profile;if(!profile)return false;view.profileTruncated=true;
  if(profile.basisFacts.length>4){profile.basisFacts.shift();return true;}
  if(profile.memory?.entries.length&&profile.memory.entries.length>4){profile.memory.entries.shift();return true;}
  if(profile.memory&&profile.memory.summary.length>300){profile.memory.summary=clip(profile.memory.summary,300);return true;}
  if(profile.memory&&profile.memory.openTopics.length>3){profile.memory.openTopics=profile.memory.openTopics.slice(0,3);return true;}
  delete view.profile;return true;
}

/** Shared 200 KiB budget, with explicit truncation and the latest message retained. */
function fitViews(views:RemoteCurrentConversation[],measure:()=>number,forceMessageId?:string):void{
  let size=measure();
  const change=(view:RemoteCurrentConversation,mutate:()=>void)=>{const before=bytes(view);mutate();size+=bytes(view)-before;};
  while(size>MAX_REMOTE_SNAPSHOT_BYTES){
    const profileView=views.filter(view=>view.profile).sort((a,b)=>bytes(b.profile)-bytes(a.profile))[0];
    if(profileView){change(profileView,()=>{trimProfile(profileView);});continue;}
    const historyView=views.filter(view=>view.messages.some((message,index)=>index<view.messages.length-1&&message.id!==forceMessageId)).sort((a,b)=>bytes(b.messages)-bytes(a.messages))[0];
    if(historyView){change(historyView,()=>{const index=historyView.messages.findIndex((message,index)=>index<historyView.messages.length-1&&message.id!==forceMessageId);historyView.messages.splice(index,1);historyView.truncated=true;});continue;}
    const draftView=views.filter(view=>view.drafts.length).sort((a,b)=>bytes(b.drafts)-bytes(a.drafts))[0];
    if(draftView){change(draftView,()=>{draftView.drafts.shift();draftView.truncated=true;});continue;}
    const longMessage=views.flatMap(view=>view.messages).filter(message=>message.text.length>160||(message.mediaSummary?.length??0)>160).sort((a,b)=>bytes(b)-bytes(a))[0];
    if(longMessage){const view=views.find(view=>view.messages.includes(longMessage))!;change(view,()=>{longMessage.text=clip(longMessage.text,160);if(longMessage.mediaSummary)longMessage.mediaSummary=clip(longMessage.mediaSummary,160);longMessage.truncated=true;});continue;}
    const detail=views.find(view=>view.wechat&&view.wechat.detail.length>0);
    if(detail){change(detail,()=>{detail.wechat!.detail='';detail.truncated=true;});continue;}
    throw new Error(LIMITATION);
  }
  for(const view of views)updateRevision(view);
  if(measure()>MAX_REMOTE_SNAPSHOT_BYTES)throw new Error(LIMITATION);
}

export function remoteCurrentConversation(state:AppState,cid:string,secrets:readonly string[]=[],forceMessageId?:string):RemoteCurrentConversation{
  const view=buildCurrentConversation(state,cid,[...knownRemoteSecrets(state.settings),...secrets],new Date().toISOString(),forceMessageId);
  fitViews([view],()=>bytes(view),forceMessageId);return view;
}

/** Archive transport retains the full text; pagination bounds each request, not the history. */
export function remoteHistoryMessage(state:AppState,conversation:Conversation,message:Message,secrets:readonly string[]=[]){
  const allSecrets=[...knownRemoteSecrets(state.settings),...secrets];
  const result=currentMessage(state,conversation,message,allSecrets,'1970-01-01T00:00:00.000Z');
  result.text=unicode(sanitizeRemoteText(message.text,allSecrets));delete result.truncated;
  const observed=message.imageRecognition;
  if(observed&&message.mediaStatus==='recognized'&&(message.kind==='image'||message.kind==='emoji'))result.mediaSummary=unicode(sanitizeRemoteText(`${message.kind==='emoji'?'表情解析':'图片解析'}：${observed.summary}${observed.visibleText?`\n可见文字：${observed.visibleText}`:''}`,allSecrets));
  else if(message.kind==='voice'&&message.mediaStatus==='recognized'&&message.audioRecognition)result.mediaSummary=unicode(sanitizeRemoteText(`语音转写：${message.audioRecognition.text}`,allSecrets));
  else {const emoji=messageEmojiRecognition(message);if(emoji)result.mediaSummary=unicode(sanitizeRemoteText(`表情解析：${emoji.tokens.map(token=>`${token.value} ${token.description}`).join('\n')}`,allSecrets));}
  if(!result.analysis&&message.insights?.conversationId===conversation.id&&message.insights.messageId===message.id&&iso(message.insights.analyzedAt)){
    const saved=message.insights;
    return {...result,analysis:{intents:conversation.processing?.intentEnabled?saved.intents:[],affinity:conversation.processing?.affinityEnabled&&saved.affinity?{score:saved.affinity.score,confidence:saved.affinity.confidence}:null,
      provider:saved.provider,modelName:safe(saved.modelName,200,allSecrets),analyzedAt:iso(saved.analyzedAt)!,stale:true}};
  }
  return result;
}

export function withRemoteCurrentView(baseSnapshotRecord:Record<string,unknown>,state:AppState,secrets:readonly string[]=[]):Record<string,unknown>{
  const syncedAt=new Date().toISOString(),allSecrets=[...knownRemoteSecrets(state.settings),...secrets];
  const configured=Array.isArray(baseSnapshotRecord.conversations)?baseSnapshotRecord.conversations as {id?:unknown}[]:[];
  const ids=baseSnapshotRecord.remoteEnabled===false?[]:configured.map(value=>value.id).filter((id):id is string=>typeof id==='string').slice(0,8);
  const currentView:RemoteCurrentView={syncedAt,conversations:ids.map(id=>buildCurrentConversation(state,id,allSecrets,syncedAt))};
  const snapshot={...baseSnapshotRecord,currentView};fitViews(currentView.conversations,()=>bytes(snapshot));return snapshot;
}
