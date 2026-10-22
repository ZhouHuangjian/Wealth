import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Store} from './store.js';
import type {AppState} from '../shared/types.js';
import type {DraftSyncConfig} from './draft-sync.js';
import {draftConnectionCheckUrl} from './draft-sync-check.js';
import {remoteHistoryMessage} from './remote-current.js';
import {knownRemoteSecrets,sanitizeRemoteText} from './remote-protocol.js';
import {readModelResponse} from './model-config.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Event={seq:number;type:'conversation.upsert'|'conversation.delete'|'message.upsert'|'message.delete';conversation?:Record<string,unknown>;conversationId?:string;messageId?:string;message?:ReturnType<typeof remoteHistoryMessage>};
type Change={key:string;hash:string|null;event:Omit<Event,'seq'>};
type Progress={phase:'backfill'|'live';totalConversations:number;totalMessages:number};
type Packet={version:1;streamId:string;batchId:string;baseSeq:number;events:Event[];progress:Progress};
type Saved={streamId:string;accountFingerprint:string|null;seq:number;hashes:Record<string,string>;pending?:{packet:Packet;changes:Change[]}};
const receiptSchema=z.object({ok:z.literal(true),version:z.literal(1),streamId:z.uuid(),batchId:z.uuid(),ackSeq:z.number().int().nonnegative(),lastSyncedAt:z.iso.datetime({offset:true}),duplicate:z.boolean()}).strict();
const checkSchema=z.object({ok:z.literal(true),device:z.object({id:z.uuid(),name:z.string()}),checkedAt:z.string()});
const MAX_PACKET=900*1024;

export function historyProjection(state:AppState,secrets:readonly string[]=[]):{changes:Change[];progress:Progress;accountFingerprint:string|null}{
  const people=state.conversations.filter(c=>c.channel==='wechat'&&c.externalId&&c.wechat);
  const accounts=[...new Set(people.map(c=>c.wechat!.accountFingerprint).filter((x):x is string=>!!x))];
  if(accounts.length>1)throw new Error('当前联系人包含不同微信账号，请分别绑定设备后同步历史。');
  const allSecrets=[...knownRemoteSecrets(state.settings),...secrets];
  const changes:Change[]=[];let totalMessages=0;
  for(const c of people){
    const h=c.wechat!.history;
    const conversation={id:c.id,name:sanitizeRemoteText(c.name,allSecrets),note:sanitizeRemoteText(c.note,allSecrets),enabled:!!c.wechat!.enabled,autoReplyEnabled:c.autoReplyEnabled,processing:{intentEnabled:!!c.processing?.intentEnabled,affinityEnabled:!!c.processing?.affinityEnabled},...(h?{history:{status:h.tail?'running':h.status,scanned:h.scanned,added:h.added,lastCheckedAt:h.lastCheckedAt,detail:sanitizeRemoteText(h.detail,allSecrets).slice(0,300)}}:{})};
    const event={type:'conversation.upsert' as const,conversation};changes.push({key:`c:${c.id}`,hash:digest(conversation),event});
  }
  for(const c of people)for(const m of state.messages.filter(m=>m.conversationId===c.id&&m.role!=='system').sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id))){
    const message=remoteHistoryMessage(state,c,m,allSecrets);totalMessages++;
    const event={type:'message.upsert' as const,conversationId:c.id,message};changes.push({key:`m:${c.id}:${m.id}`,hash:digest(message),event});
  }
  return {changes,accountFingerprint:accounts[0]??null,progress:{phase:people.every(c=>c.wechat?.history?.status==='complete'&&!c.wechat.history.tail)?'live':'backfill',totalConversations:people.length,totalMessages}};
}

/** Durable acknowledged projection and a persisted in-flight packet make lost responses retryable. */
export class HistorySync {
  private timer:ReturnType<typeof setInterval>|null=null;
  private closed=false;private controller:AbortController|null=null;private active:Promise<void>|null=null;
  private verified:{identity:string;deviceId:string}|null=null;
  private statusValue:{status:'waiting'|'syncing'|'connected'|'error'|'disabled';detail:string;syncedAt:string|null}={status:'waiting',detail:'等待同步完整历史。',syncedAt:null};
  constructor(private readonly store:Store,private readonly options:{config:()=>DraftSyncConfig;enabled:()=>boolean;fetch?:typeof fetch;intervalMs?:number}){}
  status(){return {...this.statusValue};}
  start(){if(this.timer||this.closed)return;void this.tick();this.timer=setInterval(()=>void this.tick(),this.options.intervalMs??5000);this.timer.unref();}
  invalidate(){this.controller?.abort();this.verified=null;}
  stop(){this.closed=true;this.invalidate();if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick():Promise<void>{
    if(this.closed)return Promise.resolve();if(this.active)return this.active;
    if(!this.options.enabled()){this.statusValue={...this.statusValue,status:'disabled',detail:'完整历史同步已暂停。'};return Promise.resolve();}
    const config=this.options.config(),check=draftConnectionCheckUrl(config);if(!check)return Promise.resolve();
    const controller=new AbortController();this.controller=controller;
    const current=()=>!this.closed&&!controller.signal.aborted&&this.options.enabled()&&this.options.config().url===config.url&&this.options.config().token===config.token;
    const request=async(url:URL,body:unknown)=>{
      if(!current())throw new Error('同步配置已改变。');
      const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)]);
      const response=await (this.options.fetch??fetch)(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`,...(url.pathname==='/api/v1/chat/device/history'?{'Idempotency-Key':(body as Packet).batchId}:{})},body:JSON.stringify(body),signal:combined});
      if(!response.ok){await response.body?.cancel();throw new Error(response.status===404?'服务器尚未支持完整历史同步。':response.status===409?'历史同步版本冲突，已保留本地记录和待重试批次，请核对设备绑定。':'历史同步未确认，将重试已保存的批次。');}
      return await readModelResponse(response,combined,32*1024);
    };
    this.active=(async()=>{
      try{
        this.statusValue={...this.statusValue,status:'syncing',detail:'正在分批同步完整历史。'};
        const identity=digest([check.origin,config.token]);
        if(this.verified?.identity!==identity){const verified=checkSchema.parse(await request(check,{}));if(!current())return;this.verified={identity,deviceId:verified.device.id};}
        const namespace='history-sync',key=digest([check.origin,this.verified!.deviceId]);
        let saved=this.store.cacheGet(namespace,key) as Saved|undefined;
        if(!saved){saved={streamId:randomUUID(),accountFingerprint:null,seq:0,hashes:{}};this.store.cacheSet(namespace,key,saved);}
        for(let turn=0;turn<4&&current();turn++){
          const projected=historyProjection(this.store.read(),[config.token]);
          if(saved.accountFingerprint&&projected.accountFingerprint&&saved.accountFingerprint!==projected.accountFingerprint)throw new Error('微信账号已变化，请新建独立设备绑定，旧账号历史不会混入。');
          if(!saved.accountFingerprint&&projected.accountFingerprint){saved.accountFingerprint=projected.accountFingerprint;this.store.cacheSet(namespace,key,saved);}
          if(!saved.pending){
            const present=new Set(projected.changes.map(c=>c.key));
            const removed=Object.keys(saved.hashes).filter(k=>!present.has(k)).sort((a,b)=>Number(b.startsWith('m:'))-Number(a.startsWith('m:'))).map(k=>{
              const [kind,conversationId,messageId]=k.split(':');return {key:k,hash:null,event:{type:kind==='m'?'message.delete' as const:'conversation.delete' as const,conversationId,...(messageId?{messageId}:{})}};
            });
            const changes=[...projected.changes.filter(c=>saved!.hashes[c.key]!==c.hash),...removed];
            if(!changes.length){this.statusValue={status:'connected',detail:'完整历史已按已读取范围同步，后续只上传新增和变化。',syncedAt:this.statusValue.syncedAt};break;}
            const packet:Packet={version:1,streamId:saved.streamId,batchId:randomUUID(),baseSeq:saved.seq,events:[],progress:projected.progress};const selected:Change[]=[];
            for(const change of changes.slice(0,100)){
              const event={...change.event,seq:saved.seq+selected.length+1} as Event;
              if(Buffer.byteLength(JSON.stringify({...packet,events:[...packet.events,event]}))>MAX_PACKET){if(!selected.length)throw new Error('单条消息超过服务器接收大小，原文仍完整保存在本机；未标记为已同步。');break;}
              selected.push(change);packet.events.push(event);
            }
            saved.pending={packet,changes:selected};this.store.cacheSet(namespace,key,saved);
          }
          const pending=saved.pending;
          const receipt=receiptSchema.parse(await request(new URL('/api/v1/chat/device/history',check.origin),pending.packet));
          if(!current())return;
          if(receipt.streamId!==saved.streamId||receipt.batchId!==pending.packet.batchId||receipt.ackSeq!==pending.packet.events.at(-1)!.seq)throw new Error('服务器历史同步确认不匹配，本地批次保留等待重试。');
          for(const change of pending.changes){if(change.hash===null)delete saved.hashes[change.key];else saved.hashes[change.key]=change.hash;}
          saved.seq=Math.max(saved.seq,receipt.ackSeq);delete saved.pending;this.store.cacheSet(namespace,key,saved);
          this.statusValue={status:'connected',detail:'历史批次已保存至服务器，继续同步剩余记录。',syncedAt:receipt.lastSyncedAt};
        }
      }catch(error){if(current())this.statusValue={...this.statusValue,status:'error',detail:error instanceof Error&&/^[\u4e00-\u9fff]/.test(error.message)&&error.message.length<160?error.message:'历史同步暂未完成，本地记录和已确认进度保留，稍后自动重试。'};}
      finally{if(this.controller===controller)this.controller=null;}
    })().finally(()=>{this.active=null;});return this.active;
  }
}
