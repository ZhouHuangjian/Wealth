import type {Conversation,Settings} from '../shared/types.js';
import type {Store} from './store.js';
import type {ContactInsightService} from './contact-insight-service.js';
import {modelEndpoint,replyEndpoint,visionApiKey,assertModelName} from './model-config.js';
import {remoteSettingsSchema,patchCommandSchema,parseRemoteProfilePayload,remoteConversationV2,remoteSettingsRevision,remoteConversationRevision,remoteProfileRevision,remoteProfile,type RemoteCommand} from './remote-protocol.js';

const ensureRevision=(expected:string|undefined,current:string)=>{if(expected!==undefined&&expected!==current)throw Object.assign(new Error('本机配置已变化，请刷新后再保存。'),{status:409});};
const privateKeys=(s:Settings)=>[s.apiKey,s.vision?.apiKey,s.audio?.apiKey,s.analysis?.apiKey,s.memory?.apiKey].filter((value):value is string=>!!value);
/** Remote selections keep endpoints, permissions and credentials configured on this Mac. */
export function prepareRemoteSettings(settings:Settings,input:unknown):Partial<Settings>{
  const {expectedRevision,...patch}=remoteSettingsSchema.parse(input);
  ensureRevision(expectedRevision,remoteSettingsRevision(settings));
  const next:Partial<Settings>={...patch,autoReplyMode:'draft',vision:undefined,audio:undefined,analysis:undefined,memory:undefined};
  for(const key of ['vision','audio','analysis','memory'] as const){
    const choice=patch[key];delete next[key];if(!choice)continue;
    const base=settings[key];
    if(!base){if(choice.provider==='disabled')continue;throw new Error('请先在 Mac 设置中配置此功能的模型服务，再远程选择模型。');}
    const merged={...base,...choice};
    if(merged.provider==='codex'){
      if(!merged.allowRemoteModel)throw new Error('请先在 Mac 设置中允许此功能使用 Codex。');
      if(/^qwen/i.test(merged.modelName))throw new Error('Codex 请选择本机可用的 OpenAI 模型。');
    }else if(merged.provider!=='disabled'){
      assertModelName(merged.modelName);
      const endpoint=modelEndpoint(merged as Parameters<typeof modelEndpoint>[0]);
      const apiKey=visionApiKey(settings,merged,endpoint);
      if(merged.provider==='qwen'&&!apiKey)throw new Error('请先在 Mac 设置中保存此功能的千问密钥。');
    }
    Object.assign(next,{[key]:merged});
  }
  const reply={...settings,...next};
  const choices=patch.replyModels??(patch.provider!==undefined||patch.modelName!==undefined?[]:settings.replyModels);
  if(patch.provider!==undefined||patch.modelName!==undefined||patch.modelPreset!==undefined||patch.replyModels!==undefined){
    for(const choice of choices?.length?choices:[reply]){
      if(choice.provider==='codex'){
        if(!settings.allowRemoteModel)throw new Error('请先在 Mac 设置中允许 Codex 处理对话。');
        if(/^qwen/i.test(choice.modelName))throw new Error('Codex 请选择本机可用的 OpenAI 模型。');
      }else if(choice.provider!=='demo'){
        const effective={...reply,...choice};replyEndpoint(effective);assertModelName(effective.modelName);
        if(effective.modelPreset==='qwen'&&!settings.apiKey.trim())throw new Error('请先在 Mac 设置中保存千问回复密钥。');
      }
    }
  }
  return next;
}
type Dependencies={store:Store;insights:ContactInsightService;secrets?:()=>string[];patchSettings:(patch:unknown)=>void;patchConversation:(id:string,patch:unknown)=>Conversation;setWechatEnabled:(id:string,enabled:boolean)=>void;addWechatConversation:(input:unknown)=>Conversation;wechatAvailable:()=>boolean};
/** Existing WeChat contacts only; revisions are checked before any write. */
export async function executeRemoteEdit(command:RemoteCommand,signal:AbortSignal,d:Dependencies):Promise<Record<string,unknown>>{
  signal.throwIfAborted();
  const state=d.store.read(),secrets=[...privateKeys(state.settings),...(d.secrets?.()??[])];
  const projection=(c:Conversation)=>remoteConversationV2(c,d.store.read().messages,secrets);
  if(command.type==='settings.patch'){d.patchSettings(prepareRemoteSettings(state.settings,command.payload));return {};}
  if(command.type==='conversation.add')return {conversation:projection(d.addWechatConversation(command.payload))};
  if(command.type==='conversation.patch'){
    const {id,enabled,expectedRevision,...patch}=patchCommandSchema.parse(command.payload);
    const target=state.conversations.find(c=>c.id===id);
    if(!target||target.channel!=='wechat')throw new Error('远程管理只支持已有微信会话。');
    ensureRevision(expectedRevision,remoteConversationRevision(target));
    if(enabled&&!d.wechatAvailable())throw new Error('本机微信读取工具尚未配置。');
    if(Object.keys(patch).length)d.patchConversation(id,patch);
    if(enabled!==undefined)d.setWechatEnabled(id,enabled);
    return {conversation:projection(d.store.read().conversations.find(c=>c.id===id)!)};
  }
  const {id,expectedRevision,factId,entryId,...input}=parseRemoteProfilePayload(command.type,command.payload);
  const target=state.conversations.find(c=>c.id===id);
  if(!target||target.channel!=='wechat')throw new Error('远程管理只支持已有微信会话。');
  ensureRevision(expectedRevision,remoteProfileRevision(target));
  switch(command.type){
    case 'conversation.profile.get':return {profile:remoteProfile(target,secrets)};
    case 'conversation.basis.add':d.insights.addBasis(id,input);break;
    case 'conversation.basis.patch':d.insights.patchBasis(id,factId!,input);break;
    case 'conversation.basis.delete':d.insights.deleteBasis(id,factId!);break;
    case 'conversation.basis.generate':await d.insights.generateBasis(id,signal);break;
    case 'conversation.memory.patch':d.insights.patchMemory(id,input);break;
    case 'conversation.memory.entry.add':d.insights.addMemoryEntry(id,input);break;
    case 'conversation.memory.entry.patch':d.insights.patchMemoryEntry(id,entryId!,input);break;
    case 'conversation.memory.entry.delete':d.insights.deleteMemoryEntry(id,entryId!);break;
    case 'conversation.memory.compress':await d.insights.compress(id,signal);break;
    default:throw new Error('不支持此远程操作。');
  }
  signal.throwIfAborted();
  return {profile:remoteProfile(d.store.read().conversations.find(c=>c.id===id)!,secrets)};
}
