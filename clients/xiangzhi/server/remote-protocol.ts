/** Versioned, explicit projections for the Wealth remote control surface. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ContactBasisFact, ContactMemoryEntry, Conversation, Message, Settings} from '../shared/types.js';
import {contactProcessingPatchSchema, replyModelsSchema} from './contact-processing-schema.js';

export const remoteCommandTypes = [
  'settings.patch', 'contacts.search', 'conversation.add', 'conversation.patch',
  'conversation.profile.get', 'conversation.basis.add', 'conversation.basis.patch',
  'conversation.basis.delete', 'conversation.basis.generate', 'conversation.memory.patch',
  'conversation.memory.entry.add', 'conversation.memory.entry.patch',
  'conversation.memory.entry.delete', 'conversation.memory.compress',
] as const;
export const profileRemoteCommandTypes = remoteCommandTypes.slice(4) as readonly RemoteCommandType[];
export type RemoteCommandType = typeof remoteCommandTypes[number];
export const remoteCommandSchema = z.object({id:z.uuid(),type:z.enum(remoteCommandTypes),payload:z.record(z.string(),z.unknown()),expires_at:z.iso.datetime({offset:true})});
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export const MAX_REMOTE_POLL_BYTES=1024*1024;
export const MAX_REMOTE_PROFILE_BYTES=768*1024;
export const MAX_REMOTE_SNAPSHOT_BYTES=200*1024;

const sensitive=/(?:\bsk-[A-Za-z0-9._-]{10,}|\bBearer\s+\S+|data:(?:image|audio)\/)/i;
const validUnicode=(value:string)=>!value.includes('\0')&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const text=(max:number,nonempty=false)=>z.string().max(max).refine(validUnicode).refine(value=>!sensitive.test(value)).refine(value=>!nonempty||value.trim().length>0);
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const remoteRevisionSchema=z.string().regex(/^[a-f0-9]{64}$/);
const remoteConversationPatchSchema=z.object({name:text(80,true).optional(),note:text(2000).optional(),autoReplyEnabled:z.boolean().optional()}).strict();
const safeChoice=(value:{id:string;modelName:string;label?:string})=>[value.id,value.modelName,value.label??''].every(part=>validUnicode(part)&&!sensitive.test(part));
const safeReplyModelsSchema=replyModelsSchema.refine(items=>items.every(safeChoice),'模型选择包含无效内容。');
const remoteProcessingSchema=contactProcessingPatchSchema.refine(value=>(value.replyModels??[]).every(safeChoice)&&(!value.analysisModel||safeChoice(value.analysisModel))&&(!value.memoryModel||safeChoice(value.memoryModel)),'模型选择包含无效内容。');
// The local editor has the same processing schema; credentials are never in it.
export const conversationPatchSchema=remoteConversationPatchSchema.extend({processing:contactProcessingPatchSchema.optional()}).strict();
export const wechatAddSchema=z.object({name:text(80,true),externalId:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_@.-]{0,199}$/)}).strict();
export const searchCommandSchema=z.object({query:text(100,true),limit:z.number().int().min(1).max(30).default(20)}).strict();
const moduleModel=z.object({provider:z.enum(['qwen','compatible','codex','disabled']),modelName:text(200),thinkingEnabled:z.boolean().optional()}).strict();
const audioModuleModel=moduleModel.extend({provider:z.enum(['qwen','compatible','disabled'])}).strict();
const settingsShape={
  provider:z.enum(['demo','codex','ollama','compatible']).optional(),modelName:text(200).optional(),
  replyDelaySeconds:z.number().int().min(1).max(300).optional(),cooldownSeconds:z.number().int().min(0).max(3600).optional(),dailyLimit:z.number().int().min(1).max(200).optional(),
  quietHoursEnabled:z.boolean().optional(),quietStart:time.optional(),quietEnd:time.optional(),autoReplyEnabled:z.boolean().optional(),syncDraftsEnabled:z.boolean().optional(),
};
export const legacyRemoteSettingsSchema=z.object(settingsShape).strict().refine(value=>Object.keys(value).length>0);
export const remoteSettingsSchema=z.object({...settingsShape,modelPreset:z.enum(['custom','qwen']).optional(),replyModels:safeReplyModelsSchema.optional(),
  vision:moduleModel.optional(),audio:audioModuleModel.optional(),analysis:moduleModel.optional(),memory:moduleModel.optional(),expectedRevision:remoteRevisionSchema.optional(),
}).strict().superRefine((value,ctx)=>{
  if(!Object.keys(value).some(key=>key!=='expectedRevision'))ctx.addIssue({code:'custom',message:'没有配置变更。'});
  if(['modelPreset','replyModels','vision','audio','analysis','memory'].some(key=>key in value)&&!value.expectedRevision)ctx.addIssue({code:'custom',message:'请刷新当前本地配置后再保存。'});
});
export const patchCommandSchema=remoteConversationPatchSchema.extend({id:z.uuid(),enabled:z.boolean().optional(),processing:remoteProcessingSchema.optional(),expectedRevision:remoteRevisionSchema.optional()}).strict().superRefine((value,ctx)=>{
  if(!Object.keys(value).some(key=>!['id','expectedRevision'].includes(key)))ctx.addIssue({code:'custom',message:'没有会话变更。'});
  if(value.processing&&!value.expectedRevision)ctx.addIssue({code:'custom',message:'请刷新此人的当前配置后再保存。'});
});

const profileId=z.object({id:z.uuid()}).strict();
const profileMutation=profileId.extend({expectedRevision:remoteRevisionSchema}).strict();
const basisShape={category:z.enum(['current_status','interest','preference','fact','boundary','plan']),content:text(1000,true),sourceNote:text(500)};
const entryShape={kind:z.enum(['fact','event','preference','openTopic']),text:text(600,true)};
const hasChanges=(keys:readonly string[])=>(value:Record<string,unknown>)=>keys.some(key=>key in value);
export const remoteProfileCommandSchemas={
  'conversation.profile.get':profileId,
  'conversation.basis.generate':profileId,
  'conversation.memory.compress':profileId,
  'conversation.basis.add':profileMutation.extend({...basisShape,sourceNote:basisShape.sourceNote.optional()}).strict(),
  'conversation.basis.patch':profileMutation.extend({factId:z.uuid(),category:basisShape.category.optional(),content:basisShape.content.optional(),sourceNote:basisShape.sourceNote.optional()}).strict().refine(hasChanges(['category','content','sourceNote'])),
  'conversation.basis.delete':profileMutation.extend({factId:z.uuid()}).strict(),
  'conversation.memory.patch':profileMutation.extend({summary:text(1600).optional(),openTopics:z.array(text(200,true)).max(10).optional()}).strict().refine(hasChanges(['summary','openTopics'])),
  'conversation.memory.entry.add':profileMutation.extend(entryShape).strict(),
  'conversation.memory.entry.patch':profileMutation.extend({entryId:z.uuid(),kind:entryShape.kind.optional(),text:entryShape.text.optional(),status:z.enum(['pending','approved','rejected']).optional()}).strict().refine(hasChanges(['kind','text','status'])),
  'conversation.memory.entry.delete':profileMutation.extend({entryId:z.uuid()}).strict(),
};
export type RemoteProfilePayload={id:string;expectedRevision?:string;factId?:string;entryId?:string;category?:ContactBasisFact['category'];content?:string;sourceNote?:string;kind?:ContactMemoryEntry['kind'];text?:string;status?:ContactMemoryEntry['status'];summary?:string;openTopics?:string[]};
export function parseRemoteProfilePayload(kind:RemoteCommandType,payload:unknown):RemoteProfilePayload {
  const schema=remoteProfileCommandSchemas[kind as keyof typeof remoteProfileCommandSchemas];
  if(!schema)throw new Error('不支持此远程操作。');
  return schema.parse(payload);
}
export const parseProfileCommand=parseRemoteProfilePayload;

/** All revisions are opaque hashes; underlying private data never leaves this module. */
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const settingsRevisionInput=(s:Settings)=>({provider:s.provider,modelUrl:s.modelUrl,modelName:s.modelName,apiKey:s.apiKey,modelPreset:s.modelPreset,modelThinkingEnabled:s.modelThinkingEnabled,
  allowRemoteModel:s.allowRemoteModel,vision:s.vision,audio:s.audio,analysis:s.analysis,memory:s.memory,replyModels:s.replyModels,
  autoReplyEnabled:s.autoReplyEnabled,autoReplyMode:s.autoReplyMode,syncDraftsEnabled:s.syncDraftsEnabled,replyDelaySeconds:s.replyDelaySeconds,cooldownSeconds:s.cooldownSeconds,
  dailyLimit:s.dailyLimit,quietHoursEnabled:s.quietHoursEnabled,quietStart:s.quietStart,quietEnd:s.quietEnd});
export const remoteSettingsRevision=(s:Settings)=>hash(settingsRevisionInput(s));
export const remoteConversationRevision=(c:Conversation)=>hash({id:c.id,name:c.name,note:c.note,autoReplyEnabled:c.autoReplyEnabled,processing:c.processing,channel:c.channel,externalId:c.externalId,enabled:!!c.wechat?.enabled,accountFingerprint:c.wechat?.accountFingerprint});
export const remoteProfileRevision=(c:Conversation)=>hash({id:c.id,basisFacts:c.basisFacts??[],memory:c.memory??null});
function remoteText(value:string,secrets:readonly string[]=[]):string {
  let result=value.replace(/\bsk-[A-Za-z0-9._-]{10,}|\bBearer\s+\S+/gi,'[凭据已隐藏]').replace(/data:(?:image|audio)\/\S*/gi,'[媒体内容已隐藏]');
  for(const secret of secrets)if(secret.length>=8)result=result.split(secret).join('[凭据已隐藏]');
  return result;
}
const knownSettingsSecrets=(s:Settings)=>[s.apiKey,s.vision?.apiKey,s.audio?.apiKey,s.analysis?.apiKey,s.memory?.apiKey].filter((value):value is string=>!!value);
const projectChoice=(value:NonNullable<Settings['replyModels']>[number],secrets:readonly string[]=[])=>({id:remoteText(value.id,secrets)===value.id?value.id:`redacted-${hash(value.id).slice(0,20)}`,provider:value.provider,modelName:remoteText(value.modelName,secrets),
  ...(value.modelPreset===undefined?{}:{modelPreset:value.modelPreset}),...(value.label===undefined?{}:{label:remoteText(value.label,secrets)})});
export const remoteConversation=(c:Conversation)=>({id:c.id,externalId:c.externalId!,name:remoteText(c.name),note:remoteText(c.note),autoReplyEnabled:c.autoReplyEnabled,enabled:!!c.wechat?.enabled});
export function remoteSettings(s:Settings){const secrets=knownSettingsSecrets(s);return {provider:s.provider,modelName:remoteText(s.modelName,secrets),replyDelaySeconds:s.replyDelaySeconds,cooldownSeconds:s.cooldownSeconds,
  dailyLimit:s.dailyLimit,quietHoursEnabled:s.quietHoursEnabled,quietStart:s.quietStart,quietEnd:s.quietEnd,autoReplyEnabled:s.autoReplyEnabled,syncDraftsEnabled:!!s.syncDraftsEnabled};}
export function remoteSettingsV2(s:Settings){
  const secrets=knownSettingsSecrets(s);
  const module=(value:Settings['vision']|Settings['audio']|Settings['analysis'])=>({provider:value?.provider??'disabled',modelName:remoteText(value?.modelName??'',secrets),...((value&&'thinkingEnabled'in value&&value.thinkingEnabled!==undefined)?{thinkingEnabled:value.thinkingEnabled}:{})});
  return {...remoteSettings(s),revision:remoteSettingsRevision(s),modelPreset:s.modelPreset??'custom',replyModels:(s.replyModels??[]).map(value=>projectChoice(value,secrets)),
    vision:module(s.vision),audio:module(s.audio),analysis:module(s.analysis),memory:module(s.memory)};
}
export function remoteConversationV2(c:Conversation,messages:readonly Message[]=[],secrets:readonly string[]=[]){
  const p=c.processing??{};
  const latest=c.processing?.affinityEnabled?messages.filter(m=>m.conversationId===c.id&&m.role==='peer'&&m.insights?.conversationId===c.id&&m.insights.messageId===m.id&&m.insights.affinity)
    .sort((a,b)=>b.sequence-a.sequence)[0]?.insights:undefined;
  return {...remoteConversation(c),name:remoteText(c.name,secrets),note:remoteText(c.note,secrets),revision:remoteConversationRevision(c),
    processing:{replyModels:p.replyModels===undefined?null:p.replyModels.map(value=>projectChoice(value,secrets)),autoRecognizeImages:!!p.autoRecognizeImages,autoTranscribeVoice:!!p.autoTranscribeVoice,
      intentEnabled:!!p.intentEnabled,affinityEnabled:!!p.affinityEnabled,memoryEnabled:!!p.memoryEnabled,autoAnalyzeMessages:!!p.autoAnalyzeMessages,autoCompressMemory:!!p.autoCompressMemory,
      analysisModel:p.analysisModel?projectChoice(p.analysisModel,secrets):null,memoryModel:p.memoryModel?projectChoice(p.memoryModel,secrets):null},
    affinity:latest?.affinity?.score??null,affinityUpdatedAt:latest?.analyzedAt??null,basisCount:c.basisFacts?.length??0,memoryCount:c.memory?.entries.filter(e=>e.status!=='rejected').length??0};
}
export function remoteProfile(c:Conversation,secrets:readonly string[]=[]){
  const memory=c.memory;
  const profile={id:c.id,revision:remoteProfileRevision(c),basisFacts:(c.basisFacts??[]).map(f=>({id:f.id,category:f.category,content:remoteText(f.content,secrets),sourceNote:remoteText(f.sourceNote,secrets),origin:f.origin??'manual',createdAt:f.createdAt,updatedAt:f.updatedAt})),
    memory:memory?{summary:remoteText(memory.summary,secrets),openTopics:memory.openTopics.map(value=>remoteText(value,secrets)),entries:memory.entries.filter(e=>e.status!=='rejected').map(e=>({id:e.id,kind:e.kind,text:remoteText(e.text,secrets),status:e.status,origin:e.origin??'model',createdAt:e.createdAt,...(e.updatedAt?{updatedAt:e.updatedAt}:{})})),
      provider:memory.provider,modelName:remoteText(memory.modelName,secrets),updatedAt:memory.updatedAt,...(memory.summaryOrigin?{summaryOrigin:memory.summaryOrigin}:{}),...(memory.openTopicsOrigin?{openTopicsOrigin:memory.openTopicsOrigin}:{})}:null};
  if(profile.basisFacts.length>100||(profile.memory?.entries.length??0)>132||Buffer.byteLength(JSON.stringify(profile))>MAX_REMOTE_PROFILE_BYTES)throw new Error('此人的档案与记忆过大，请先在 Mac 整理后再远程读取。');
  return profile;
}
export function legacyRemoteSnapshot(snapshot:Record<string,unknown>):Record<string,unknown>{
  const settings=snapshot.settings as ReturnType<typeof remoteSettingsV2>,caps=snapshot.capabilities as {wechatAvailable:boolean;codexAvailable:boolean};
  return {version:1,remoteEnabled:snapshot.remoteEnabled,settings:Object.fromEntries(Object.keys(settingsShape).map(key=>[key,settings[key as keyof typeof settings]])),
    conversations:(snapshot.conversations as ReturnType<typeof remoteConversationV2>[]).map(c=>({id:c.id,externalId:c.externalId,name:c.name,note:c.note,autoReplyEnabled:c.autoReplyEnabled,enabled:c.enabled})),
    capabilities:{wechatAvailable:caps.wechatAvailable,codexAvailable:caps.codexAvailable}};
}
export type RemoteCodexModel={id:string;label:string;inputModalities:('text'|'image')[]};
const codexModelsSchema=z.array(z.object({id:text(200,true),label:text(200,true),inputModalities:z.array(z.enum(['text','image'])).min(1).max(2).refine(items=>new Set(items).size===items.length)}).strict()).max(100).refine(items=>new Set(items.map(item=>item.id)).size===items.length);
export function remoteSnapshotV2(settings:Settings,conversations:readonly Conversation[],messages:readonly Message[],capabilities:{wechatAvailable:boolean;codexAvailable:boolean;codexModels?:readonly RemoteCodexModel[]},secrets:readonly string[]=[]){
  const models=capabilities.codexModels?.map(model=>({id:model.id,label:model.label,inputModalities:[...model.inputModalities]}));
  const allSecrets=[...knownSettingsSecrets(settings),...secrets];
  const snapshot={version:2 as const,remoteEnabled:true,settings:remoteSettingsV2(settings),conversations:conversations.map(c=>remoteConversationV2(c,messages,allSecrets)),capabilities:{wechatAvailable:capabilities.wechatAvailable,codexAvailable:capabilities.codexAvailable,commandTypes:[...remoteCommandTypes],...(models?{codexModels:codexModelsSchema.parse(models)}:{})}};
  if(conversations.length>100||Buffer.byteLength(JSON.stringify(snapshot))>MAX_REMOTE_SNAPSHOT_BYTES)throw new Error('远程配置内容过大，请先在 Mac 整理会话备注。');
  return snapshot;
}
