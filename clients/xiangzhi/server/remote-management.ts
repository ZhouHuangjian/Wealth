import { createHash } from 'node:crypto';
import { z } from 'zod';
import {draftConnectionCheckUrl} from './draft-sync-check.js';
import type {DraftSyncConfig} from './draft-sync.js';
import type {Store} from './store.js';
import {remoteCommandSchema,legacyRemoteSnapshot,MAX_REMOTE_POLL_BYTES,type RemoteCommand} from './remote-protocol.js';
export * from './remote-protocol.js';

type Options = {
  config:()=>DraftSyncConfig; enabled:()=>boolean; snapshot:()=>Record<string,unknown>;
  execute:(command:RemoteCommand,signal:AbortSignal)=>Promise<Record<string,unknown>>;
  onFailure?:(error:unknown)=>void;
  fetch?:typeof fetch; now?:()=>number; intervalMs?:number;
};
const MAX_RESPONSE = 64*1024;
type Receipt=ReturnType<Store['remoteReceipts']>[number];
/** Keep unsent receipts durable; only the prefix acknowledged by this poll is removed. */
export function batchRemoteReceipts(snapshot:Record<string,unknown>,receipts:readonly Receipt[]):Receipt[]{
  const selected:Receipt[]=[];
  if(Buffer.byteLength(JSON.stringify({snapshot,completed:[]}))>MAX_REMOTE_POLL_BYTES)throw new Error('远程配置内容过大，暂时无法同步。');
  for(const receipt of receipts.slice(0,20)){
    if(Buffer.byteLength(JSON.stringify({snapshot,completed:[...selected,receipt]}))>MAX_REMOTE_POLL_BYTES){
      if(!selected.length)throw new Error('待同步档案过大，请先在 Mac 整理。');
      break;
    }
    selected.push(receipt);
  }
  return selected;
}
export function remoteCommandTimeout(command:RemoteCommand,now:number,serverTime:number):number{
  const modelJob=['conversation.basis.generate','conversation.memory.compress'].includes(command.type);
  return Math.min(modelJob?120_000:30_000,Math.max(1,Date.parse(command.expires_at)-now),Math.max(1,Date.parse(command.expires_at)-serverTime));
}
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
  private legacyScope:string|null=null;
  private legacyUntil=0;
  constructor(private readonly store:Store,private readonly options:Options) {}
  status() {
    const enabled=this.options.enabled(), supported=!!draftConnectionCheckUrl(this.options.config());
    return {status:!enabled?'disabled' as const:!supported?'waiting' as const:this.error?'error' as const:this.lastConnectedAt?'connected' as const:'waiting' as const,
      lastConnectedAt:this.lastConnectedAt,detail:!enabled?'网页远程管理已关闭。':!supported?'请先绑定 Wealth 设备。':this.error?'暂时无法连接服务器，将自动重试。':this.lastConnectedAt?(this.legacyUntil>(this.options.now?.()??Date.now())?'已连接；服务器尚未更新，暂时使用基础远程配置。':'已连接，等待网页操作。'):'正在等待连接服务器。'};
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
        const nowBefore=this.options.now?.()??Date.now();
        const allCompleted=this.store.remoteReceipts(scope,nowBefore);
        const originalSnapshot:Record<string,unknown>={...this.options.snapshot(),remoteEnabled:!reportDisabled&&enabled};
        let legacyMode=this.legacyScope===scope&&this.legacyUntil>nowBefore&&originalSnapshot.version===2;
        let snapshot=legacyMode?legacyRemoteSnapshot(originalSnapshot):originalSnapshot;
        let completed=batchRemoteReceipts(snapshot,legacyMode?allCompleted.filter(receipt=>!('profile'in receipt.result)):allCompleted);
        const sendPoll=()=> (this.options.fetch??fetch)(new URL('/api/v1/chat/device/poll',check.origin),{
          method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`},
          body:JSON.stringify({snapshot,completed}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});
        let response=await sendPoll();
        if(response.status===422&&originalSnapshot.version===2&&!legacyMode&&current()){
          await response.body?.cancel();
          legacyMode=true;snapshot=legacyRemoteSnapshot(originalSnapshot);
          completed=batchRemoteReceipts(snapshot,allCompleted.filter(receipt=>!('profile'in receipt.result)));
          response=await sendPoll();
          if(response.ok){this.legacyScope=scope;this.legacyUntil=nowBefore+60_000;}
        }else if(response.ok&&!legacyMode){this.legacyScope=null;this.legacyUntil=0;}
        if(!response.ok||!response.body||!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')||Number(response.headers.get('content-length'))>MAX_RESPONSE) {
          await response.body?.cancel();throw new Error('连接失败');
        }
        const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
        try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_RESPONSE){await reader.cancel();throw new Error('响应过大');}chunks.push(value);}}
        finally {reader.releaseLock();}
        const receipt=z.object({ok:z.literal(true),commands:z.array(remoteCommandSchema).max(1),server_time:z.iso.datetime({offset:true})}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
            if(legacyMode&&!['settings.patch','contacts.search','conversation.add','conversation.patch'].includes(command.type))throw new Error('服务器尚未更新，请稍后重试此功能。');
            const commandSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(remoteCommandTimeout(command,now,Date.parse(receipt.server_time)))]);
            result=await this.options.execute(command,commandSignal);
            commandSignal.throwIfAborted();
            if(Buffer.byteLength(JSON.stringify({snapshot,completed:[{id:command.id,status:'succeeded',result,error:''}]}))>MAX_REMOTE_POLL_BYTES)throw new Error('远程结果过大，请先在 Mac 整理。');
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
