import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Conversation, Settings } from '../shared/types.js';
import { draftConnectionCheckUrl } from './draft-sync-check.js';
import type { DraftSyncConfig } from './draft-sync.js';
import type { Store } from './store.js';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const remoteSettingsSchema = z.object({
  provider:z.enum(['demo','codex','ollama','compatible']).optional(), modelName:z.string().trim().max(200).optional(),
  replyDelaySeconds:z.number().int().min(1).max(300).optional(), cooldownSeconds:z.number().int().min(0).max(3600).optional(),
  dailyLimit:z.number().int().min(1).max(200).optional(), quietHoursEnabled:z.boolean().optional(),
  quietStart:time.optional(),quietEnd:time.optional(),autoReplyEnabled:z.boolean().optional(),syncDraftsEnabled:z.boolean().optional(),
}).strict().refine(value=>Object.keys(value).length>0);
export const wechatAddSchema = z.object({name:z.string().trim().min(1).max(80),externalId:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_@.-]{0,199}$/)}).strict();
export const conversationPatchSchema = z.object({name:z.string().trim().min(1).max(80).optional(),note:z.string().max(2000).optional(),autoReplyEnabled:z.boolean().optional()}).strict();
const commandSchema = z.object({id:z.uuid(),type:z.enum(['settings.patch','contacts.search','conversation.add','conversation.patch']),payload:z.record(z.string(),z.unknown()),expires_at:z.iso.datetime({offset:true})});
export type RemoteCommand = z.infer<typeof commandSchema>;
export const remoteConversation = (c:Conversation) => ({id:c.id,externalId:c.externalId!,name:c.name,note:c.note,autoReplyEnabled:c.autoReplyEnabled,enabled:!!c.wechat?.enabled});
export function remoteSettings(s:Settings) {
  return {provider:s.provider,modelName:s.modelName,replyDelaySeconds:s.replyDelaySeconds,cooldownSeconds:s.cooldownSeconds,
    dailyLimit:s.dailyLimit,quietHoursEnabled:s.quietHoursEnabled,quietStart:s.quietStart,quietEnd:s.quietEnd,
    autoReplyEnabled:s.autoReplyEnabled,syncDraftsEnabled:!!s.syncDraftsEnabled};
}
export const searchCommandSchema = z.object({query:z.string().trim().min(1).max(100),limit:z.number().int().min(1).max(30).default(20)}).strict();
export const patchCommandSchema = conversationPatchSchema.extend({id:z.uuid(),enabled:z.boolean().optional()}).strict()
  .refine(value=>Object.keys(value).length>1);

type Options = {
  config:()=>DraftSyncConfig; enabled:()=>boolean; snapshot:()=>Record<string,unknown>;
  execute:(command:RemoteCommand,signal:AbortSignal)=>Promise<Record<string,unknown>>;
  onFailure?:(error:unknown)=>void;
  fetch?:typeof fetch; now?:()=>number; intervalMs?:number;
};
const MAX_RESPONSE = 64*1024;
/** Outbound polling uses only the bound Wealth origin. Receipts survive process restarts. */
export class RemoteManagement {
  private timer:ReturnType<typeof setInterval>|null=null;
  private closed=false;
  private revision=0;
  private active:AbortController|null=null;
  private pending:Promise<void>|null=null;
  private lastConnectedAt:string|null=null;
  private error=false;
  private disabledReportAttempted=false;
  constructor(private readonly store:Store,private readonly options:Options) {}
  status() {
    const enabled=this.options.enabled(), supported=!!draftConnectionCheckUrl(this.options.config());
    return {status:!enabled?'disabled' as const:!supported?'waiting' as const:this.error?'error' as const:this.lastConnectedAt?'connected' as const:'waiting' as const,
      lastConnectedAt:this.lastConnectedAt,detail:!enabled?'网页远程管理已关闭。':!supported?'请先绑定 Wealth 设备。':this.error?'暂时无法连接服务器，将自动重试。':this.lastConnectedAt?'已连接，等待网页操作。':'正在等待连接服务器。'};
  }
  start() {if(this.timer||this.closed)return;if(!this.options.enabled())this.store.remoteRequestPause();void this.tick();this.timer=setInterval(()=>void this.tick(),this.options.intervalMs??5000);this.timer.unref();}
  invalidate(paused=false) {this.revision++;this.active?.abort();this.lastConnectedAt=null;this.error=false;if(paused){this.store.remoteRequestPause();this.disabledReportAttempted=false;}}
  stop() {this.closed=true;this.invalidate();if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick():Promise<void> {
    if(this.pending)return this.pending;
    if(this.closed)return Promise.resolve();
    const enabled=this.options.enabled(), reportDisabled=this.store.remotePausePending();
    if(!enabled&&(!reportDisabled||this.disabledReportAttempted))return Promise.resolve();
    const config=this.options.config(), check=draftConnectionCheckUrl(config);
    if(!check)return Promise.resolve();
    const revision=this.revision, controller=new AbortController();this.active=controller;
    const scope=createHash('sha256').update(JSON.stringify([config.url,config.token])).digest('hex');
    const current=()=>!this.closed&&!controller.signal.aborted&&revision===this.revision&&this.options.enabled()===enabled
      &&this.options.config().url===config.url&&this.options.config().token===config.token;
    this.pending=(async()=>{
      try {
        if(reportDisabled)this.disabledReportAttempted=true;
        const completed=this.store.remoteReceipts(scope,this.options.now?.()??Date.now());
        const response=await (this.options.fetch??fetch)(new URL('/api/v1/chat/device/poll',check.origin),{
          method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`},
          body:JSON.stringify({snapshot:{...this.options.snapshot(),remoteEnabled:!reportDisabled&&enabled},completed}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});
        if(!response.ok||!response.body||!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')||Number(response.headers.get('content-length'))>MAX_RESPONSE) {
          await response.body?.cancel();throw new Error('连接失败');
        }
        const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
        try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_RESPONSE){await reader.cancel();throw new Error('响应过大');}chunks.push(value);}}
        finally {reader.releaseLock();}
        const receipt=z.object({ok:z.literal(true),commands:z.array(commandSchema).max(1),server_time:z.iso.datetime({offset:true})}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if(!current())return;
        const now=this.options.now?.()??Date.now();
        this.store.remoteAcknowledge(scope,completed.map(item=>item.id),now);
        this.lastConnectedAt=new Date(now).toISOString();this.error=false;
        if(reportDisabled){this.store.remotePauseReported();return;}
        for(const command of receipt.commands) {
          if(!current())return;
          const expires=Date.parse(command.expires_at);
          if(!this.store.remoteClaim(scope,command.id,expires)){this.store.remoteReplay(scope,command.id);continue;}
          let result:Record<string,unknown>={},error='',status:'succeeded'|'failed'='succeeded';
          try {
            if(expires<=now||expires<=Date.parse(receipt.server_time))throw new Error('远程操作已过期。');
            result=await this.options.execute(command,AbortSignal.any([controller.signal,AbortSignal.timeout(Math.min(30_000,Math.max(1,expires-now)))]));
            if(!current())throw new Error('连接或远程管理设置已更改。');
          } catch (cause) {status='failed';result={};error='本地执行未完成，请核对当前配置后重试。';if(!this.closed)this.options.onFailure?.(cause);}
          if(this.closed)return;
          this.store.remoteFinish(scope,{id:command.id,status,result,error});
        }
      } catch {if(current())this.error=true;}
      finally {if(this.active===controller)this.active=null;}
    })().finally(()=>{this.pending=null;});
    return this.pending;
  }
}
