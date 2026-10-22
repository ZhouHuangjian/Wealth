import {createHash,randomUUID} from 'node:crypto';
import type {AppState,Conversation,Message} from '../shared/types.js';
import {contactAutoMediaEnabled} from '../shared/contact-processing.js';
import {queryWechat,type WechatPage,type WechatQuery,type WechatRecord} from './wechat-cli.js';
import {insightsInputDigest} from './contact-insights.js';

interface StateStore{read():AppState;update(fn:(state:AppState)=>void):unknown}
interface CollectorOptions{
  query?:WechatQuery;intervalMs?:number;now?:()=>number;
  onMessages?:(conversationId:string,latestMessageId:string|null,live:boolean)=>void;
  onContextInvalidated?:(conversationId:string)=>void;
}
type History=NonNullable<NonNullable<Conversation['wechat']>['history']>;
type Checkpoint={cursor:string;offset:number};
type ReadResult={added:number;baseline:boolean};
const PAGE_SIZE=200,PAGES_PER_POLL=3;
const compareSeq=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const fingerprint=(record:WechatRecord)=>createHash('sha256').update(JSON.stringify([record.text,record.role,record.kind,record.sentAt])).digest('hex');
const binding=(state:AppState,cid:string):Conversation=>{
  const c=state.conversations.find(item=>item.id===cid&&item.channel==='wechat');
  if(!c?.wechat||!c.externalId)throw new Error('找不到已绑定的微信会话。');return c;
};
const newHistory=():History=>({status:'pending',cursor:'0',offset:0,scanned:0,added:0,lastCheckedAt:null,detail:'等待分批读取全部历史。'});

/** A sequence boundary plus a tie offset handles arbitrarily many equal sort_seq rows. */
function advance(checkpoint:Checkpoint,records:readonly WechatRecord[]):Checkpoint{
  if(!records.length)return {...checkpoint};
  const last=records.reduce((max,row)=>compareSeq(row.sortSeq,max)>0?row.sortSeq:max,'0');
  const tail=records.filter(row=>row.sortSeq===last).length,cursor=(BigInt(last)-1n).toString();
  const offset=(cursor===checkpoint.cursor?checkpoint.offset:0)+tail;
  if(!Number.isSafeInteger(offset))throw new Error('微信分页位置异常，请重新读取历史。');return {cursor,offset};
}

/** Explicit bindings, durable full-history checkpoints, and a fast current-message preview. */
export class WechatCollector{
  private readonly query:WechatQuery;
  private readonly now:()=>number;
  private readonly intervalMs:number;
  private timer:ReturnType<typeof setInterval>|null=null;
  private historyTimer:ReturnType<typeof setTimeout>|null=null;
  private closed=false;
  private inflight=new Map<string,{controller:AbortController;promise:Promise<ReadResult>}>();
  private catchup=new Set<string>();
  private oneShot=new Set<string>();
  private backoff=new Map<string,{failures:number;next:number}>();
  private tickPromise:Promise<void>|null=null;
  constructor(private readonly store:StateStore,private readonly options:CollectorOptions={}){
    this.query=options.query??queryWechat;this.now=options.now??Date.now;this.intervalMs=Math.max(1000,options.intervalMs??15000);
    for(const c of store.read().conversations.filter(c=>c.channel==='wechat'))this.catchup.add(c.id);
  }
  start():void{
    if(this.timer||this.closed)return;
    this.timer=setInterval(()=>{void this.tick();},this.intervalMs);this.timer.unref?.();this.scheduleHistory();
  }
  stop():void{
    this.closed=true;this.oneShot.clear();if(this.timer)clearInterval(this.timer);if(this.historyTimer)clearTimeout(this.historyTimer);
    this.timer=null;this.historyTimer=null;for(const active of this.inflight.values())active.controller.abort();
  }
  cancel(cid:string):void{this.oneShot.delete(cid);this.inflight.get(cid)?.controller.abort();this.catchup.add(cid);this.backoff.delete(cid);}
  setEnabled(cid:string,enabled:boolean):void{
    binding(this.store.read(),cid);this.cancel(cid);
    this.store.update(state=>{const w=binding(state,cid).wechat!;w.enabled=enabled;w.status='paused';
      w.history??=newHistory();if(w.history.status==='running')w.history.status='pending';
      w.detail=enabled?'等待读取；将分批补齐全部历史，不为历史消息触发自动草稿。':'采集已暂停，历史进度已保留。';
      if(!enabled&&w.history.status!=='complete')w.history.detail='历史读取已暂停，恢复后从已保存的位置继续。';
    });this.scheduleHistory();
  }
  resetHistory(cid:string):void{
    binding(this.store.read(),cid);this.cancel(cid);this.store.update(state=>{binding(state,cid).wechat!.history=newHistory();});this.scheduleHistory();
  }
  /** One manual read finishes its full backfill without enabling future monitoring. */
  async readHistory(cid:string,externalSignal?:AbortSignal,rescan=false):Promise<ReadResult>{
    externalSignal?.throwIfAborted();binding(this.store.read(),cid);
    if(rescan){const active=this.inflight.get(cid);this.cancel(cid);await active?.promise.catch(()=>{});this.resetHistory(cid);}
    this.oneShot.add(cid);
    try{return await this.poll(cid,externalSignal);}finally{this.scheduleHistory();}
  }
  private scheduleHistory():void{
    if(!this.timer||this.closed||this.historyTimer)return;
    const pending=this.store.read().conversations.some(c=>c.channel==='wechat'&&c.wechat&&(c.wechat.enabled||this.oneShot.has(c.id))
      &&(c.wechat.history?.status!=='complete'||c.wechat.history.tail)
      &&(this.backoff.get(c.id)?.next??0)<=this.now());
    if(!pending)return;
    this.historyTimer=setTimeout(()=>{this.historyTimer=null;void this.tick().finally(()=>this.scheduleHistory());},1000);this.historyTimer.unref?.();
  }
  tick():Promise<void>{
    if(this.closed)return Promise.resolve();if(this.tickPromise)return this.tickPromise;
    this.tickPromise=(async()=>{for(const c of this.store.read().conversations.filter(c=>c.channel==='wechat'&&c.wechat&&(c.wechat.enabled||this.oneShot.has(c.id)))){
      if(this.closed)break;const current=this.store.read().conversations.find(item=>item.id===c.id);
      if(current?.channel!=='wechat'||(!current.wechat?.enabled&&!this.oneShot.has(c.id))||(this.backoff.get(c.id)?.next??0)>this.now())continue;
      try{await this.poll(c.id);}catch{/* Each binding preserves its own checkpoint and backoff. */}
    }})().finally(()=>{this.tickPromise=null;this.scheduleHistory();});return this.tickPromise;
  }
  poll(cid:string,externalSignal?:AbortSignal):Promise<ReadResult>{
    externalSignal?.throwIfAborted();if(this.closed)return Promise.reject(new Error('微信采集服务已停止。'));
    const active=this.inflight.get(cid);if(active)return active.promise;
    const initial=this.store.read(),c=binding(initial,cid),controller=new AbortController();
    const abort=()=>{this.oneShot.delete(cid);controller.abort(externalSignal?.reason);};externalSignal?.addEventListener('abort',abort,{once:true});
    const promise=this.read(cid,c,initial,controller.signal).finally(()=>{externalSignal?.removeEventListener('abort',abort);
      if(this.inflight.get(cid)?.controller===controller)this.inflight.delete(cid);
      if(!this.closed){const current=this.store.read().conversations.find(c=>c.id===cid);if(!current||current.wechat?.history?.status==='complete'&&!current.wechat.history.tail)this.oneShot.delete(cid);}
      this.scheduleHistory();});
    this.inflight.set(cid,{controller,promise});return promise;
  }
  private assertCurrent(cid:string,original:Conversation,signal:AbortSignal):Conversation{
    if(signal.aborted||this.closed)throw new Error('采集已暂停或停止。');const current=binding(this.store.read(),cid);
    if(current.externalId!==original.externalId||current.wechat!.enabled!==original.wechat!.enabled)throw new Error('采集设置已改变，请重新读取。');return current;
  }
  private validatePage(cid:string,original:Conversation,page:WechatPage,signal:AbortSignal,checkpoint?:Checkpoint):void{
    const current=this.assertCurrent(cid,original,signal),account=current.wechat!.accountFingerprint;
    if(account&&account!==page.accountFingerprint){
      this.oneShot.delete(cid);
      this.store.update(state=>{const w=binding(state,cid).wechat!;w.enabled=false;w.status='error';
        w.detail='微信账号已变化，已停止采集；请核对账号后再读取，不能混入另一账号的消息。';
        if(w.history){w.history.status='error';w.history.detail='账号已变化，历史进度保留，未混入其他账号的数据。';}});
      throw new Error('微信账号已变化，采集已停止。');
    }
    if(page.records.length>PAGE_SIZE||page.hasMore&&!page.records.length
      ||checkpoint&&page.records.some(record=>compareSeq(record.sortSeq,checkpoint.cursor)<=0))throw new Error('微信分页异常，已保存的读取进度保留。');
  }
  private merge(state:AppState,cid:string,records:readonly WechatRecord[],account:string,historyOnly:boolean){
    const target=binding(state,cid),w=target.wechat!,list=state.messages.filter(m=>m.conversationId===cid);
    const byId=new Map(list.filter(m=>m.externalId).map(m=>[m.externalId!,m])),newIds=new Set<string>();
    let added=0,changed=false,sourceChanged=false,invalidatedInsights=false,high=w.cursor??'0';
    for(const record of records){
      if(compareSeq(record.sortSeq,high)>0)high=record.sortSeq;
      const existing=byId.get(record.id)??byId.get(`seq:${record.sortSeq}`)
        ??(record.id.startsWith('seq:')?list.find(m=>m.sourceSequence===record.sortSeq):undefined);
      const hash=fingerprint(record);
      if(existing){
        if(existing.externalId?.startsWith('seq:')&&!record.id.startsWith('seq:')){byId.delete(existing.externalId);existing.externalId=record.id;byId.set(record.id,existing);}
        const imageChanged=existing.wechatImage?.md5&&record.wechatImage?.md5&&existing.wechatImage.md5!==record.wechatImage.md5;
        const emojiChanged=existing.wechatEmoji?.md5&&record.wechatEmoji?.md5&&existing.wechatEmoji.md5!==record.wechatEmoji.md5;
        const legacySame=!existing.sourceFingerprint&&existing.role===record.role&&existing.kind===record.kind&&existing.sentAt===record.sentAt
          &&(existing.text===record.text||existing.kind!=='text'&&['reviewed','recognized'].includes(existing.mediaStatus??''));
        if(existing.sourceFingerprint!==hash&&!legacySame||imageChanged||emojiChanged){
          Object.assign(existing,{text:record.text,role:record.role,kind:record.kind,mediaStatus:record.mediaStatus,sentAt:record.sentAt,
            sourceSequence:record.sortSeq,sourceFingerprint:hash,wechatImage:record.wechatImage,wechatEmoji:record.wechatEmoji,
            emojiRecognition:record.emojiRecognition,imageRecognition:undefined,imageAttachment:undefined,audioRecognition:undefined,audioAttachment:undefined,autoMediaEligible:false});
          delete existing.insights;changed=true;sourceChanged=true;
        }else{
          if(!existing.sourceFingerprint)existing.sourceFingerprint=hash;
          if(existing.sourceSequence!==record.sortSeq){existing.sourceSequence=record.sortSeq;changed=true;}
        }
        if(record.wechatImage)existing.wechatImage={...existing.wechatImage,...record.wechatImage};
        if(record.wechatEmoji)existing.wechatEmoji={...existing.wechatEmoji,...record.wechatEmoji};
        if(record.emojiRecognition)existing.emojiRecognition=record.emojiRecognition;
        continue;
      }
      const message:Message={id:randomUUID(),conversationId:cid,role:record.role,text:record.text,sentAt:record.sentAt,sequence:0,source:'wechat',externalId:record.id,aiAssisted:false,
        kind:record.kind,mediaStatus:record.mediaStatus,sourceSequence:record.sortSeq,sourceFingerprint:hash,wechatImage:record.wechatImage,wechatEmoji:record.wechatEmoji,emojiRecognition:record.emojiRecognition,
        autoMediaEligible:!historyOnly&&record.role==='peer'&&((record.kind==='image'||record.kind==='emoji')&&contactAutoMediaEnabled(target,'image')||record.kind==='voice'&&contactAutoMediaEnabled(target,'voice'))};
      list.push(message);byId.set(record.id,message);newIds.add(message.id);added++;changed=true;
    }
    if(changed){
      const manual=list.filter(m=>m.source!=='wechat'),ordered=list.filter(m=>m.source==='wechat').sort((a,b)=>compareSeq(a.sourceSequence??'0',b.sourceSequence??'0')||a.id.localeCompare(b.id));
      for(const message of manual.sort((a,b)=>a.sequence-b.sequence)){const at=message.sentAt?Date.parse(message.sentAt):NaN;
        const index=Number.isFinite(at)?ordered.findIndex(m=>m.sentAt&&Date.parse(m.sentAt)>at):-1;ordered.splice(index<0?ordered.length:index,0,message);}
      ordered.forEach((message,index)=>{message.sequence=index+1;});state.messages=[...state.messages.filter(m=>m.conversationId!==cid),...ordered];
      // Backfill may renumber a known utterance. Keep the user's saved result;
      // its input digest continues to indicate whether its context is current.
      if(!historyOnly)for(const message of ordered)if(message.insights){let current=false;
        try{current=message.insights.conversationId===cid&&message.insights.messageId===message.id&&!!message.insights.inputDigest&&message.insights.inputDigest===insightsInputDigest(state,cid,message.id);}catch{/* Not a current estimate. */}
        if(!current){delete message.insights;invalidatedInsights=true;}}
      state.drafts=state.drafts.filter(d=>d.conversationId!==cid);target.updatedAt=new Date(this.now()).toISOString();
    }
    w.cursor=high;w.accountFingerprint=account;w.initialized=true;w.lastCheckedAt=new Date(this.now()).toISOString();
    return {added,changed,sourceChanged,invalidatedInsights,newIds};
  }
  private async read(cid:string,original:Conversation,initial:AppState,signal:AbortSignal):Promise<ReadResult>{
    const baseline=!original.wechat!.initialized,incomplete=original.wechat!.history?.status!=='complete';
    const historyOnly=incomplete||baseline||this.catchup.has(cid)||!original.wechat!.enabled||!!original.wechat!.history?.tail;
    let added=0,changed=false,invalidated=false,normalFinished=false,backlog=false;const newIds=new Set<string>();
    const boundedSignal=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
    this.store.update(state=>{const w=binding(state,cid).wechat!;w.history??=newHistory();w.status='reading';w.detail='正在分批读取微信消息，媒体文件不会批量导出。';});
    const consume=(page:WechatPage,backfill:boolean,progress:(history:History,result:ReturnType<WechatCollector['merge']>)=>void)=>{
      this.assertCurrent(cid,original,boundedSignal);
      this.store.update(state=>{const result=this.merge(state,cid,page.records,page.accountFingerprint,backfill);
        progress(binding(state,cid).wechat!.history!,result);added+=result.added;changed=changed||result.changed;
        invalidated=invalidated||result.sourceChanged||result.invalidatedInsights;for(const id of result.newIds)newIds.add(id);});
    };
    try{
      if(incomplete){
        // Immediate preview is not a history limit. Older records are imported
        // with durable ASC checkpoints below and never trigger paid work.
        const preview=await this.query({contact:original.externalId!,order:'desc',limit:PAGE_SIZE,offset:0},boundedSignal);
        this.validatePage(cid,original,preview,boundedSignal);
        consume(preview,true,(history,result)=>{history.lastCheckedAt=new Date(this.now()).toISOString();history.added+=result.added;
          if(!preview.hasMore){Object.assign(history,advance({cursor:'0',offset:0},preview.records));history.status='complete';history.scanned=Math.max(history.scanned,preview.records.length);history.detail='已读取本机当前可用的全部历史。';}
          else{history.status='running';history.detail='最新消息已同步，正在继续补齐全部历史。';}});
        for(let pageNumber=0;pageNumber<PAGES_PER_POLL;pageNumber++){
          const history=binding(this.store.read(),cid).wechat!.history!;if(history.status==='complete')break;
          const checkpoint={cursor:history.cursor,offset:history.offset};
          const page=await this.query({contact:original.externalId!,after:checkpoint.cursor,order:'asc',limit:PAGE_SIZE,offset:checkpoint.offset},boundedSignal);
          this.validatePage(cid,original,page,boundedSignal,checkpoint);
          consume(page,true,(progress,result)=>{Object.assign(progress,advance(checkpoint,page.records));progress.scanned+=page.records.length;progress.added+=result.added;
            progress.lastCheckedAt=new Date(this.now()).toISOString();progress.status=page.hasMore?'running':'complete';
            progress.detail=page.hasMore?'本批历史已保存，将从此位置继续读取。':'已读取本机当前可用的全部历史。';});
          if(!page.hasMore)break;
        }
      }else{
        const prior=initial.messages.filter(m=>m.conversationId===cid&&m.sourceSequence).map(m=>m.sourceSequence!).sort(compareSeq);
        const overlap=prior.slice(-50)[0]??original.wechat!.cursor??'0';
        let checkpoint:Checkpoint=original.wechat!.history!.tail??{cursor:BigInt(overlap)>0n?(BigInt(overlap)-1n).toString():'0',offset:0};
        for(let pageNumber=0;pageNumber<PAGES_PER_POLL;pageNumber++){
          const page=await this.query({contact:original.externalId!,after:checkpoint.cursor,order:'asc',limit:PAGE_SIZE,offset:checkpoint.offset},boundedSignal);
          this.validatePage(cid,original,page,boundedSignal,checkpoint);const next=advance(checkpoint,page.records);
          backlog=backlog||page.hasMore;
          consume(page,historyOnly||backlog,history=>{if(page.hasMore)history.tail=next;else delete history.tail;});
          checkpoint=next;if(!page.hasMore){normalFinished=true;break;}
        }
      }
      this.assertCurrent(cid,original,boundedSignal);
      const state=this.store.read(),history=binding(state,cid).wechat!.history!;
      if(history.status==='complete'&&!history.tail)this.catchup.delete(cid);else this.catchup.add(cid);this.backoff.delete(cid);
      this.store.update(state=>{const w=binding(state,cid).wechat!;w.status=w.enabled?'ready':'paused';
        w.detail=w.history!.status==='complete'&&!w.history!.tail?`本次新增 ${added} 条，历史读取已完成。`:`本次新增 ${added} 条；全部历史正在后台续读，已扫描 ${w.history!.scanned} 条。`;});
      const latest=state.messages.filter(m=>m.conversationId===cid).at(-1),live=!historyOnly&&!backlog&&normalFinished&&!!latest&&newIds.has(latest.id);
      if(invalidated)this.options.onContextInvalidated?.(cid);if(changed)this.options.onMessages?.(cid,latest?.id??null,live);
      return {added,baseline};
    }catch(error){
      const current=this.closed?undefined:this.store.read().conversations.find(c=>c.id===cid);
      if(current?.wechat){
        if(current.wechat.detail.startsWith('微信账号已变化'))invalidated=true;
        else if(!signal.aborted&&!this.closed){this.catchup.add(cid);const failures=(this.backoff.get(cid)?.failures??0)+1;
          this.backoff.set(cid,{failures,next:this.now()+Math.min(60000,this.intervalMs*2**Math.min(failures,4))});
          this.store.update(state=>{const w=binding(state,cid).wechat!;w.status='error';w.detail='读取未完成，已保存的历史和断点均已保留；后台将退避重试。';
            if(w.history?.status!=='complete'){w.history!.status='error';w.history!.detail='本批读取未完成，恢复后从已保存断点继续。';}});
        }
        if(invalidated)this.options.onContextInvalidated?.(cid);
        if(changed)this.options.onMessages?.(cid,this.store.read().messages.filter(m=>m.conversationId===cid).at(-1)?.id??null,false);
      }
      throw error;
    }
  }
}
