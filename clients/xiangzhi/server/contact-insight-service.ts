import {eventSchema} from './event-schema.js';
import {analysisEnabled} from '../shared/analysis-rubric.js';
import {randomUUID} from 'node:crypto';
import {messageEvidenceHash} from './contact-evidence.js';
import type {Express,Request} from 'express';
import {z} from 'zod';
import type {AppState,ContactInsights,ContactMemory,Conversation,Settings} from '../shared/types.js';
import {analyzeContactMessage,insightsInputDigest} from './contact-insights.js';
import {compressContactMemory,memoryInputDigest,memoryRemainingCount} from './contact-memory.js';
import {effectiveContactModelSettings} from './contact-model.js';
import {basisInputDigest,generateContactBasis} from './contact-basis.js';
import {assertFullHistoryReady,type HistoryDependencies} from './full-history-context.js';
import type {Store} from './store.js';

const basisSchema=z.object({category:z.enum(['current_status','interest','preference','fact','boundary','plan']),content:z.string().trim().min(1).max(1000),sourceNote:z.string().trim().max(500).default('')}).strict();
const basisPatchSchema=basisSchema.omit({sourceNote:true}).partial().extend({sourceNote:z.string().trim().max(500).optional()}).strict().refine(v=>Object.keys(v).length>0);
const memoryKind=z.enum(['fact','event','preference','openTopic']);
const memoryEntrySchema=z.object({kind:memoryKind,text:z.string().trim().min(1).max(600),event:eventSchema.nullable().optional()}).strict();
const memoryPatchSchema=z.object({summary:z.string().trim().max(1600).optional(),openTopics:z.array(z.string().trim().min(1).max(200)).max(10).optional()}).strict().refine(v=>Object.keys(v).length>0);
const memoryEntryPatchSchema=memoryEntrySchema.partial().extend({status:z.enum(['pending','approved','rejected']).optional()}).strict().refine(v=>Object.keys(v).length>0);
const cid=(req:Request)=>String(req.params.id);
function linkAbort(controller:AbortController,signal?:AbortSignal):()=>void {
  signal?.throwIfAborted();
  const abort=()=>controller.abort(signal?.reason);
  signal?.addEventListener('abort',abort,{once:true});
  return ()=>signal?.removeEventListener('abort',abort);
}
const missing=()=>Object.assign(new Error('找不到这段对话。'),{status:404});
function conversation(state:AppState,id:string):Conversation {const c=state.conversations.find(c=>c.id===id);if(!c)throw missing();return c;}
function modelConfiguration(state:AppState,cid:string,kind:'analysis'|'memory'):string {
  const c=conversation(state,cid);
  return JSON.stringify([effectiveContactModelSettings(state.settings,c,kind),state.settings.apiKey,state.settings.modelUrl,state.settings.provider,c.channel,c.externalId,c.wechat?.accountFingerprint,c.wechat?.enabled]);
}
export function validateContactFeatures(settings:Settings,c:Conversation,scope:{analysis?:boolean;memory?:boolean}={analysis:true,memory:true}):void {
  if(scope.analysis&&(analysisEnabled(c.processing))){
    const model=effectiveContactModelSettings(settings,c,'analysis');
    if(!model||model.provider==='disabled')throw new Error('请先在设置中配置意图与好感分析模型。');
  }
  if(c.processing?.autoAnalyzeMessages&&!analysisEnabled(c.processing))throw new Error('请先为此人开启意图或好感分析。');
  if(c.processing?.autoCompressMemory&&!c.processing.memoryEnabled)throw new Error('请先为此人开启记忆功能。');
  if(scope.memory&&c.processing?.autoCompressMemory){
    const model=effectiveContactModelSettings(settings,c,'memory');
    if(!model||model.provider==='disabled')throw new Error('请先在设置中配置记忆整理模型。');
  }
}

/** Bounded, opt-in analysis and local memory; it never sends a chat message. */
export interface ContactAnalysisProgress {
  conversationId:string;
  feature:'analysis'|'memory'|'basis';
  total:number;
  processed:number;
  stage:'reading'|'summarizing'|'generating';
  updatedAt:string;
}
export class ContactInsightService {
  private closed=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  private active=new Map<string,{controller:AbortController;kind:'analysis'|'memory';cid:string}>();
  private pending=new Map<string,string>();
  private progress=new Map<string,ContactAnalysisProgress>();
  private memoryRuns=new Set<string>();
  private running:Promise<void>|null=null;
  constructor(private readonly store:Store,private readonly options:{
    analyze?:typeof analyzeContactMessage;compress?:typeof compressContactMemory;
    generateBasis?:typeof generateContactBasis;
    onContextChanged:(conversationId:string)=>void;
  }){}
  status():ContactAnalysisProgress[]{return [...this.progress.values()].map(value=>({...value}));}
  private historyDependencies(key:string,id:string,feature:ContactAnalysisProgress['feature']):HistoryDependencies {
    return {
      historyCache:{get:(namespace,cacheKey)=>this.store.cacheGet(namespace,cacheKey),set:(namespace,cacheKey,value)=>this.store.cacheSet(namespace,cacheKey,value)},
      onHistoryProgress:progress=>{
        if(this.closed||this.active.get(key)?.controller.signal.aborted||!this.active.has(key))return;
        let total=progress.total,processed=progress.processed;
        if(feature==='memory'){
          const state=this.store.read();
          total=state.messages.filter(m=>m.conversationId===id&&m.role!=='system').length;
          processed=Math.min(total,total-memoryRemainingCount(state,id)+progress.processed);
        }
        this.progress.set(key,{conversationId:id,feature,total,processed,
          stage:progress.stage==='complete'?'generating':progress.stage,updatedAt:new Date().toISOString()});
      },
    };
  }
  private record(id:string,title:string,detail:string,kind:'info'|'success'|'warning'='success'){
    if(this.closed)return;
    this.store.update(s=>{s.activity.unshift({id:randomUUID(),conversationId:id,kind,title,detail,createdAt:new Date().toISOString()});s.activity=s.activity.slice(0,300);});
  }
  changed(id?:string,kind?:'analysis'|'memory'){
    for(const entry of this.active.values())if((!id||entry.cid===id)&&(!kind||entry.kind===kind))entry.controller.abort();
    for(const [key,value] of this.progress)if((!id||value.conversationId===id)&&(!kind||(value.feature==='analysis'?'analysis':'memory')===kind))this.progress.delete(key);
    if(id)this.pending.delete(id);else this.pending.clear();
  }
  invalidateCached(id?:string){
    const state=this.store.read(),stale:string[]=[];
    for(const m of state.messages)if(m.insights&&(!id||m.conversationId===id)){
      try{if(m.insights.inputDigest!==insightsInputDigest(state,m.conversationId,m.id))stale.push(m.id);}
      catch{stale.push(m.id);}
    }
    if(stale.length){const ids=new Set(stale);this.store.update(s=>{for(const m of s.messages)if(ids.has(m.id))delete m.insights;});}
  }
  observed(id:string,messageId:string|null,live:boolean){
    if(!live||!messageId||this.closed)return;
    const state=this.store.read(),c=state.conversations.find(c=>c.id===id),m=state.messages.find(m=>m.id===messageId&&m.conversationId===id);
    if(c&&m?.role==='peer'&&(c.processing?.autoAnalyzeMessages||c.processing?.autoCompressMemory))this.pending.set(id,messageId);
  }
  start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>void this.tick(),2000);this.timer.unref();}
  stop(){this.closed=true;this.changed();if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick():Promise<void>{
    if(this.running||this.closed)return this.running??Promise.resolve();
    const next=this.pending.entries().next().value as [string,string]|undefined;
    if(!next)return Promise.resolve();
    const [id,messageId]=next;this.pending.delete(id);
    this.running=(async()=>{
      const state=this.store.read(),c=state.conversations.find(c=>c.id===id);
      if(!c||(c.channel==='wechat'&&!c.wechat?.enabled))return;
      const target=state.messages.find(m=>m.id===messageId&&m.conversationId===id);
      const utterance=target&&(!target.kind||target.kind==='text'||(target.kind==='voice'&&target.mediaStatus==='recognized'&&target.audioRecognition)||(target.kind==='emoji'&&target.mediaStatus==='recognized'&&target.imageRecognition));
      if(utterance&&c.processing?.autoAnalyzeMessages&&(c.processing.intentEnabled||c.processing.emotionEnabled||c.processing.affinityEnabled)){
        try{await this.analyze(id,messageId);}catch{
          const current=this.closed?undefined:this.store.read().conversations.find(c=>c.id===id);
          if(current?.processing?.autoAnalyzeMessages&&(current.channel!=='wechat'||current.wechat?.enabled))this.record(id,'自动分析未完成','可在这句话旁手动分析。','warning');
        }
      }
      if(this.closed)return;
      const now=this.store.read(),current=now.conversations.find(c=>c.id===id);
      if(this.closed||!current||(current.channel==='wechat'&&!current.wechat?.enabled))return;
      if(current?.processing?.autoCompressMemory&&current.processing.memoryEnabled&&memoryRemainingCount(now,id)>=20){
        try{await this.compress(id);}catch{
          const latest=this.closed?undefined:this.store.read().conversations.find(c=>c.id===id);
          if(latest?.processing?.autoCompressMemory&&(latest.channel!=='wechat'||latest.wechat?.enabled))this.record(id,'自动记忆整理未完成','现有本地记忆已保留，可手动整理。','warning');
        }
      }
    })().finally(()=>{this.running=null;});
    return this.running;
  }
  async analyze(id:string,targetId?:string,signal?:AbortSignal):Promise<{insights:ContactInsights;cached:boolean}>{
    signal?.throwIfAborted();
    if(this.closed)throw new Error('分析服务已停止。');
    const before=this.store.read(),c=conversation(before,id);
    assertFullHistoryReady(before,id);
    if(!analysisEnabled(c.processing))throw new Error('请先为此人开启意图或好感分析。');
    const target=targetId?before.messages.find(m=>m.id===targetId&&m.conversationId===id):before.messages.filter(m=>m.conversationId===id&&m.role==='peer').sort((a,b)=>a.sequence-b.sequence).at(-1);
    if(!target)throw new Error('请先选择这段对话中的一句话。');
    const inputDigest=insightsInputDigest(before,id,target.id);
    if(target.insights?.inputDigest===inputDigest)return {insights:target.insights,cached:true};
    const key=`${id}:analysis`;
    if(this.active.has(key))throw Object.assign(new Error('此人的分析正在进行，请等待结果。'),{status:409});
    const controller=new AbortController(),configuration=modelConfiguration(before,id,'analysis'),unlink=linkAbort(controller,signal);
    this.active.set(key,{cid:id,kind:'analysis',controller});
    try{
      const result=await (this.options.analyze??analyzeContactMessage)(before,id,target.id,controller.signal,this.historyDependencies(key,id,'analysis'));
      controller.signal.throwIfAborted();
      const state=this.store.read();
      if(this.closed||modelConfiguration(state,id,'analysis')!==configuration||insightsInputDigest(state,id,target.id)!==inputDigest||result.conversationId!==id||result.messageId!==target.id)throw Object.assign(new Error('这句话或分析配置已变化，旧结果未保存。'),{status:409});
      const saved={...result,inputDigest,intents:c.processing?.intentEnabled?result.intents:[],emotions:c.processing?.emotionEnabled?result.emotions:[],
        affinity:c.processing?.affinityEnabled?result.affinity:null,replyReview:c.processing?.replyReviewEnabled?result.replyReview:null};
      this.store.update(s=>{const m=s.messages.find(m=>m.id===target.id&&m.conversationId===id);if(!m)throw missing();m.insights=saved;});
      this.record(id,'已保存交流分析','百分比是模型对语境的估计，原结果保存在本机。');
      return {insights:saved,cached:false};
    }finally{unlink();if(this.active.get(key)?.controller===controller){this.active.delete(key);this.progress.delete(key);}}
  }
  async compress(id:string,signal?:AbortSignal):Promise<{memory:ContactMemory;cached:boolean;remaining:number}>{
    // Persist each successful batch. A cancelled/restarted request resumes from
    // message hashes, and newly arriving messages cannot make this job endless.
    if(this.closed)throw new Error('记忆服务已停止。');
    assertFullHistoryReady(this.store.read(),id);
    if(this.memoryRuns.has(id))throw Object.assign(new Error('此人的记忆正在整理，请等待结果。'),{status:409});
    this.memoryRuns.add(id);
    try{
      const before=this.store.read();
      const pending=before.messages.filter(m=>m.conversationId===id&&m.role!=='system');
      let result=await this.compressBatch(id,signal);
      while(result.remaining>0){
        signal?.throwIfAborted();
        const state=this.store.read(),memory=conversation(state,id).memory;
        if(pending.every(m=>memory?.compressedMessageHashes?.[m.id]===messageEvidenceHash(m)))break;
        const previous=memory?.sourceDigest;
        result=await this.compressBatch(id,signal);
        if(result.memory.sourceDigest===previous)throw new Error('历史记忆整理没有继续推进，已完成的分段已保存，请重试。');
      }
      return result;
    }finally{this.memoryRuns.delete(id);}
  }
  private async compressBatch(id:string,signal?:AbortSignal):Promise<{memory:ContactMemory;cached:boolean;remaining:number}>{
    signal?.throwIfAborted();
    if(this.closed)throw new Error('记忆服务已停止。');
    const before=this.store.read(),c=conversation(before,id);
    if(!c.processing?.memoryEnabled)throw new Error('请先为此人开启记忆功能。');
    const remaining=memoryRemainingCount(before,id);
    if(!remaining&&c.memory)return {memory:c.memory,cached:true,remaining:0};
    if(!remaining)throw new Error('暂时没有可整理的对话。');
    const key=`${id}:memory`;
    if(this.active.has(key))throw Object.assign(new Error('此人的记忆正在整理，请等待结果。'),{status:409});
    const controller=new AbortController(),inputDigest=memoryInputDigest(before,id),configuration=modelConfiguration(before,id,'memory'),unlink=linkAbort(controller,signal);
    this.active.set(key,{cid:id,kind:'memory',controller});
    try{
      const result=await (this.options.compress??compressContactMemory)(before,id,controller.signal,this.historyDependencies(key,id,'memory'));
      controller.signal.throwIfAborted();
      const state=this.store.read();
      if(this.closed||modelConfiguration(state,id,'memory')!==configuration||memoryInputDigest(state,id)!==inputDigest)throw Object.assign(new Error('对话或记忆配置已变化，旧整理结果未保存。'),{status:409});
      this.options.onContextChanged(id);
      this.store.update(s=>{conversation(s,id).memory=result;});
      this.record(id,'对话记忆已保存在本机','新条目待你确认，后续草稿参考此人的资料和本地记忆。');
      return {memory:result,cached:false,remaining:memoryRemainingCount(this.store.read(),id)};
    }finally{unlink();if(this.active.get(key)?.controller===controller){this.active.delete(key);this.progress.delete(key);}}
  }
  async generateBasis(id:string,signal?:AbortSignal){
    signal?.throwIfAborted();
    if(this.closed)throw new Error('档案整理服务已停止。');
    const before=this.store.read(),c=conversation(before,id),inputDigest=basisInputDigest(before,id);
    assertFullHistoryReady(before,id);
    if(c.basisGeneration?.sourceDigest===inputDigest)return {facts:c.basisFacts??[],cached:true};
    const manual=(c.basisFacts??[]).filter(f=>f.origin!=='model');
    if(manual.length>=100)throw new Error('基础资料已达到上限，请先整理已有内容。');
    const key=`${id}:basis`;
    if(this.active.has(key))throw Object.assign(new Error('此人的档案正在整理，请等待结果。'),{status:409});
    const controller=new AbortController(),configuration=modelConfiguration(before,id,'memory'),unlink=linkAbort(controller,signal);
    this.active.set(key,{cid:id,kind:'memory',controller});
    try{
      const result=await (this.options.generateBasis??generateContactBasis)(before,id,controller.signal,this.historyDependencies(key,id,'basis'));
      controller.signal.throwIfAborted();
      const now=this.store.read();
      if(this.closed||modelConfiguration(now,id,'memory')!==configuration||basisInputDigest(now,id)!==inputDigest||result.sourceDigest!==inputDigest)
        throw Object.assign(new Error('聊天或档案配置已变化，旧整理结果未保存。'),{status:409});
      const {facts,usage:_usage,...metadata}=result;
      this.changed(id);this.options.onContextChanged(id);
      this.store.update(s=>{
        const current=conversation(s,id),preserved=(current.basisFacts??[]).filter(f=>f.origin!=='model');
        current.basisFacts=[...preserved,...facts.slice(0,100-preserved.length)];current.basisGeneration=metadata;
        for(const m of s.messages.filter(m=>m.conversationId===id))delete m.insights;
      });
      this.record(id,'模型已整理对方档案','基础资料已保存在本机，可逐条修改或补充；个人填写的信息已保留。');
      return {facts:conversation(this.store.read(),id).basisFacts??[],cached:false};
    }finally{unlink();if(this.active.get(key)?.controller===controller){this.active.delete(key);this.progress.delete(key);}}
  }
  private ensureMemory(s:AppState,id:string):ContactMemory{
    const c=conversation(s,id),at=new Date().toISOString();
    return c.memory??=( {summary:'',entries:[],openTopics:[],throughSequence:s.messages.reduce((max,m)=>m.conversationId===id?Math.max(max,m.sequence):max,0),
      sourceDigest:'manual',compressedMessageHashes:{},provider:'manual',modelName:'手动补充',updatedAt:at} );
  }
  private memoryChanged(id:string,mutate:(memory:ContactMemory,state:AppState)=>void){
    conversation(this.store.read(),id);this.changed(id);this.options.onContextChanged(id);
    this.store.update(s=>{const memory=this.ensureMemory(s,id);mutate(memory,s);memory.modelRecapInvalidated=true;memory.updatedAt=new Date().toISOString();for(const m of s.messages.filter(m=>m.conversationId===id))delete m.insights;});
    return conversation(this.store.read(),id).memory!;
  }
  addBasis(id:string,input:unknown){
    const body=basisSchema.parse(input),c=conversation(this.store.read(),id);
    if((c.basisFacts?.length??0)>=100)throw new Error('此人的基础资料已达到上限，请先整理已有内容。');
    this.changed(id);this.options.onContextChanged(id);
    const at=new Date().toISOString(),fact={id:randomUUID(),...body,origin:'manual' as const,createdAt:at,updatedAt:at};
    this.store.update(s=>{(conversation(s,id).basisFacts??=[]).push(fact);for(const m of s.messages.filter(m=>m.conversationId===id))delete m.insights;});
    this.record(id,'已更新联系人基础资料','已保存本人填写的信息。');return fact;
  }
  patchBasis(id:string,factId:string,input:unknown){
    const body=basisPatchSchema.parse(input);
    if(!conversation(this.store.read(),id).basisFacts?.some(f=>f.id===factId))throw Object.assign(new Error('找不到这条基础资料。'),{status:404});
    this.changed(id);this.options.onContextChanged(id);
    this.store.update(s=>{const fact=conversation(s,id).basisFacts!.find(f=>f.id===factId)!;
      Object.assign(fact,body,{origin:'manual',updatedAt:new Date().toISOString()});
      delete fact.provider;delete fact.modelName;delete fact.sourceMessageIds;delete fact.sourceMessageHashes;
      for(const m of s.messages.filter(m=>m.conversationId===id))delete m.insights;});
    return conversation(this.store.read(),id).basisFacts!.find(f=>f.id===factId)!;
  }
  deleteBasis(id:string,factId:string){
    conversation(this.store.read(),id);this.changed(id);this.options.onContextChanged(id);
    this.store.update(s=>{const c=conversation(s,id);c.basisFacts=(c.basisFacts??[]).filter(f=>f.id!==factId);for(const m of s.messages.filter(m=>m.conversationId===id))delete m.insights;});
  }
  private validateEvent(id:string,event:ContactMemory['entries'][number]['event']|null|undefined){
    if(event?.resolvedByMessageIds.some(mid=>!this.store.read().messages.some(m=>m.id===mid&&m.conversationId===id)))throw new Error('事件依据必须属于当前会话。');
  }
  addMemoryEntry(id:string,input:unknown){
    const body=memoryEntrySchema.parse(input);this.validateEvent(id,body.event);if(body.event&&body.kind!=='event')throw new Error('仅事件条目可设置事件状态。');const c=conversation(this.store.read(),id);
    if((c.memory?.entries.filter(e=>e.status!=='rejected').length??0)>=100)throw new Error('记忆条目已达到上限，请先整理已有内容。');
    const at=new Date().toISOString();return this.memoryChanged(id,memory=>memory.entries.push({id:randomUUID(),...body,event:body.event??undefined,origin:'manual',status:'approved',sourceMessageIds:[],sourceMessageHashes:{},createdAt:at,updatedAt:at}));
  }
  patchMemory(id:string,input:unknown){
    const body=memoryPatchSchema.parse(input);
    return this.memoryChanged(id,(memory,state)=>{
      const at=new Date().toISOString();
      if(body.summary!==undefined){memory.summary=body.summary;memory.summaryOrigin='manual';memory.summaryUpdatedAt=at;}
      if(body.openTopics!==undefined){memory.openTopics=body.openTopics;memory.openTopicsOrigin='manual';memory.openTopicsUpdatedAt=at;}
      memory.throughSequence=state.messages.reduce((max,m)=>m.conversationId===id?Math.max(max,m.sequence):max,memory.throughSequence);
    });
  }
  patchMemoryEntry(id:string,entryId:string,input:unknown){
    const body=memoryEntryPatchSchema.parse(input);this.validateEvent(id,body.event);
    const previous=conversation(this.store.read(),id).memory?.entries.find(e=>e.id===entryId);
    if(body.event&&(body.kind??previous?.kind)!=='event')throw new Error('仅事件条目可设置事件状态。');
    if(!conversation(this.store.read(),id).memory?.entries.some(e=>e.id===entryId))throw Object.assign(new Error('找不到这条记忆。'),{status:404});
    return this.memoryChanged(id,memory=>{
      const entry=memory.entries.find(e=>e.id===entryId)!;Object.assign(entry,body,{updatedAt:new Date().toISOString()});
      if(body.event===null||body.kind&&body.kind!=='event')delete entry.event;
      if(body.text!==undefined||body.kind!==undefined||body.event!==undefined){entry.origin='manual';entry.status=body.status??'approved';entry.sourceMessageIds=[];entry.sourceMessageHashes={};}
    });
  }
  deleteMemoryEntry(id:string,entryId:string){
    conversation(this.store.read(),id);return this.memoryChanged(id,memory=>{memory.entries=memory.entries.filter(e=>e.id!==entryId);});
  }
  register(app:Express){
    app.post('/api/conversations/:id/analyze',async(req,res)=>{
      const input=z.object({messageId:z.string().min(1).max(300).optional()}).strict().parse(req.body??{});
      res.json(await this.analyze(cid(req),input.messageId));
    });
    app.post('/api/conversations/:id/basis',(req,res)=>res.status(201).json(this.addBasis(cid(req),req.body)));
    app.patch('/api/conversations/:id/basis/:factId',(req,res)=>res.json(this.patchBasis(cid(req),String(req.params.factId),req.body)));
    app.delete('/api/conversations/:id/basis/:factId',(req,res)=>{this.deleteBasis(cid(req),String(req.params.factId));res.json({ok:true});});
    app.post('/api/conversations/:id/basis/generate',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await this.generateBasis(cid(req)));});
    app.post('/api/conversations/:id/memory/compress',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await this.compress(cid(req)));});
    app.post('/api/conversations/:id/memory/entries',(req,res)=>res.status(201).json(this.addMemoryEntry(cid(req),req.body)));
    app.patch('/api/conversations/:id/memory',(req,res)=>res.json(this.patchMemory(cid(req),req.body)));
    app.patch('/api/conversations/:id/memory/entries/:entryId',(req,res)=>res.json(this.patchMemoryEntry(cid(req),String(req.params.entryId),req.body)));
    app.delete('/api/conversations/:id/memory/entries/:entryId',(req,res)=>res.json(this.deleteMemoryEntry(cid(req),String(req.params.entryId))));
    app.delete('/api/conversations/:id/memory',(req,res)=>{
      const id=cid(req);conversation(this.store.read(),id);this.changed(id);this.options.onContextChanged(id);
      this.store.update(s=>{delete conversation(s,id).memory;for(const m of s.messages.filter(m=>m.conversationId===id))delete m.insights;});res.json({ok:true});
    });
  }
}
