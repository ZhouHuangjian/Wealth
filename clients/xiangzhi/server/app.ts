import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { seedDemo, previewImport, commitImport, extractClaims, deleteConversation, addActivity } from './domain.js';
import { KNOWLEDGE } from './knowledge.js';
import { generateDrafts, testModel } from './generation.js';
import { AutoReplyEngine, replyContextFingerprint } from './auto-reply.js';
import { loadLearnedProfile } from './learned-profile.js';
import { recordDraftFeedback } from './feedback.js';
import { inspectCodex } from './codex-provider.js';
import { inspectWechat, searchWechatContacts, type WechatQuery, type WechatContactSearch } from './wechat-cli.js';
import { WechatCollector } from './wechat-collector.js';
import { assertReplyContextReady } from './message-context.js';
import { draftSyncConfig, isDraftSyncConfigured, isDraftInboxConfigured, buildDraftBatch, uploadDraftBatch, cloudDraftBatchSchema, type DraftSyncConfig } from './draft-sync.js';
import { DraftSyncConnection } from './draft-sync-connection.js';
import { checkDraftConnection, draftConnectionCheckUrl, DraftConnectionCheckError } from './draft-sync-check.js';
import { recognizeImage } from './image-recognition.js';
import { transcribeAudio } from './audio-recognition.js';
import { readWechatImage, readWechatVoice } from './wechat-images.js';
import { MediaFiles, parseImageUpload, parseAudioUpload, MAX_MEDIA_BYTES } from './media-files.js';
import { MediaAutomation } from './media-automation.js';
import { bridgeConfig, createSender, isBridgeConfigured, isBridgeReceiveConfigured, secureEqual, validateEndpoint, type BridgeConfig } from './bridge.js';
import { RemoteManagement, remoteSettingsSchema, remoteSettings, remoteConversation, wechatAddSchema, conversationPatchSchema, searchCommandSchema, patchCommandSchema } from './remote-management.js';
import type { AppState, Conversation, Message, PublicState, Settings, ImageAttachment } from '../shared/types.js';
import { contactAutoMediaEnabled, contactUsesDemo, effectiveContactSettings } from '../shared/contact-processing.js';
import { replyModelsSchema } from './contact-processing-schema.js';
import { findImageRecognition, imageRecognitionIdentity, imageSha256, saveImageRecognition } from './image-recognition-cache.js';

const text = z.string().trim().min(1).max(10000);
const id = z.string().min(1).max(300);
const importSchema = z.object({ text: z.string().min(1).max(5 * 1024 * 1024), filename: z.string().max(255).default('粘贴的记录.txt'), selfId: id.optional(), name: z.string().trim().min(1).max(80).optional(), format: z.enum(['auto','chatlab','json','csv','text']).optional() });
const settingsSchema = z.object({
  autoReplyEnabled: z.boolean().optional(),
  autoReplyMode: z.enum(['draft','send']).optional(),
  syncDraftsEnabled: z.boolean().optional(),
  remoteManagementEnabled: z.boolean().optional(),
  provider: z.enum(['demo','ollama','compatible','codex']).optional(),
  modelUrl: z.string().trim().max(2048).optional(), modelName: z.string().trim().max(200).optional(),
  apiKey: z.string().max(4096).optional(), allowRemoteModel: z.boolean().optional(),
  modelPreset:z.enum(['custom','qwen']).optional(), modelThinkingEnabled:z.boolean().optional(),
  autoRecognizeImages:z.boolean().optional(),autoTranscribeVoice:z.boolean().optional(),
  replyModels:replyModelsSchema.optional(),
  vision:z.object({provider:z.enum(['qwen','compatible','codex','disabled']),modelUrl:z.string().trim().max(2048),modelName:z.string().trim().max(200),apiKey:z.string().max(4096).optional(),useReplyApiKey:z.boolean(),allowRemoteModel:z.boolean(),thinkingEnabled:z.boolean().optional()}).strict().optional(),
  audio:z.object({provider:z.enum(['qwen','compatible','disabled']),modelUrl:z.string().trim().max(2048),modelName:z.string().trim().max(200),apiKey:z.string().max(4096).optional(),useReplyApiKey:z.boolean(),allowRemoteModel:z.boolean()}).strict().optional(),
  replyDelaySeconds: z.number().int().min(1).max(300).optional(),
  cooldownSeconds: z.number().int().min(0).max(3600).optional(), dailyLimit: z.number().int().min(1).max(200).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  quietEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
}).strict();

export function checkModelReady(settings: Settings): void {
  if(settings.replyModels?.length){for(const model of settings.replyModels)checkModelReady({...settings,...model,replyModels:[]});return;}
  if (settings.provider === 'demo') return;
  if (settings.provider === 'codex') {
    if (!settings.allowRemoteModel) throw new Error('Codex 会调用模型服务，请先允许发送必要的对话片段。');
    return;
  }
  if (!settings.modelName.trim()) throw new Error('请先在设置中填写模型名称。');
  const url = validateEndpoint(settings.modelUrl);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) && !settings.allowRemoteModel) throw new Error('该模型在远端运行。请先在设置中确认允许发送必要的对话片段。');
}

function conversationOf(s: AppState, value: string): Conversation {
  const conversation = s.conversations.find(c => c.id === value);
  if (!conversation) throw Object.assign(new Error('找不到这段对话。'), { status: 404 });
  return conversation;
}
const param = (req: Request, name = 'id') => String(req.params[name]);
// Browsers share cookies across ports; keep the Mac and SSH-forwarded cloud sessions distinct.
const sessionCookieName = (req: Request) => `xz_session_${new URL(`http://${req.headers.host}`).port || '80'}`;

export function createApplication(options: {
  databasePath: string; seed?: boolean; bridge?: BridgeConfig;
  profileManifestPath?: string | null;
  inspectCodex?: typeof inspectCodex;
  inspectWechat?: typeof inspectWechat;
  queryWechat?: WechatQuery;
  searchWechatContacts?: WechatContactSearch;
  draftSync?: DraftSyncConfig;
  uploadDrafts?: typeof uploadDraftBatch;
  checkDraftConnection?: typeof checkDraftConnection;
  remoteFetch?: typeof fetch;
  recognizeImage?:typeof recognizeImage;transcribeAudio?:typeof transcribeAudio;
  readWechatImage?:typeof readWechatImage;readWechatVoice?:typeof readWechatVoice;
  generate?: typeof generateDrafts; send?: ReturnType<typeof createSender>;
}) {
  const app = express();
  const newDatabase = options.databasePath === ':memory:' || !existsSync(options.databasePath);
  const store = new Store(options.databasePath);
  const mediaFiles=new MediaFiles(options.databasePath);
  mediaFiles.prune(store.read().messages.flatMap(m=>[m.imageAttachment,m.audioAttachment]));
  const mediaRequests=new Map<string,{kind:'image'|'voice';controller:AbortController;promise:Promise<{cached:boolean}>}>();
  const imageModelRequests=new Set<string>();
  if (options.seed !== false && newDatabase) seedDemo(store);
  const profileManifestPath = options.profileManifestPath === undefined ? resolve('private/learning/2026-10-10-v1/current-profile.json') : options.profileManifestPath;
  let learnedProfileError: string | null = null;
  const reloadProfile = () => {
    const loaded = profileManifestPath ? loadLearnedProfile(profileManifestPath) : {profile:null,error:null};
    learnedProfileError = loaded.error;
    store.update(state => {state.learnedProfile = loaded.profile ?? undefined; state.drafts = [];});
  };
  reloadProfile();
  const config = options.bridge ?? bridgeConfig();
  const syncConnection = new DraftSyncConnection(options.databasePath, options.draftSync ?? draftSyncConfig());
  // An explicit local remote-management choice survives rebinding.
  if(store.read().settings.remoteManagementEnabled===undefined) store.update(s=>{s.settings.remoteManagementEnabled=true;});
  let syncRevision = 0;
  let checkSequence = 0;
  let activeConnectionCheck: AbortController | null = null;
  let closed = false;
  let codexStatus = {available:false,version:null as string|null,message:'正在检查本机 Codex CLI。'};
  const checkCodex = async () => {
    try { codexStatus = await (options.inspectCodex ?? inspectCodex)(); }
    catch { codexStatus = {available:false,version:null,message:'无法检查 Codex CLI，请检查服务端配置。'}; }
  };
  void checkCodex();
  const rawSend = options.send ?? createSender(config);
  const activeSends = new Map<string,string>();
  const send: ReturnType<typeof createSender> = async (conversation, text, key, signal) => {
    if(conversation.channel==='wechat') throw new Error('微信采集通道仅接收消息，请复制回复后在微信手动发送。');
    if(conversation.channel==='webhook' && !isBridgeConfigured(config)) throw new Error('当前桥接仅接收消息，尚未配置发送接口。');
    if(activeSends.has(conversation.id)) throw new Error('该会话已有发送等待确认，请稍后再试。');
    activeSends.set(conversation.id,key);
    try {return await rawSend(conversation,text,key,signal);} finally {activeSends.delete(conversation.id);}
  };
  const generateModel = options.generate ?? ((state,cid,intent,signal)=>generateDrafts(state,cid,intent,signal,{onModelFailure:failure=>{
    store.update(s=>addActivity(s,'warning','部分模型未生成回复',`模型 ${failure.modelName||failure.provider} 未完成，其余候选仍可比较。`,cid));
  }}));
  const generate:typeof generateDrafts = (state,cid,intent,signal) => generateModel({...state,settings:effectiveContactSettings(state.settings,state.conversations.find(c=>c.id===cid))},cid,intent,signal);
  const engine = new AutoReplyEngine(store, { send }, { generate, onDrafts:async cid=>{ await syncDrafts(cid,true); },mediaPending:cid=>{
    const state=store.read(),conversation=state.conversations.find(c=>c.id===cid);return state.messages.some(m=>m.conversationId===cid&&m.mediaStatus==='pending'
      &&(m.autoMediaEligible||mediaRequests.has(m.id))&&(m.kind==='image'||m.kind==='voice')&&contactAutoMediaEnabled(conversation,m.kind));
  } });
  const session = randomBytes(32).toString('hex');
  const manualSending = new Set<string>();
  const suggestionRequests = new Map<string,string>();
  const uploads = new Map<string,{controller: AbortController; promise: Promise<{ok:true;id:string;duplicate:boolean}>}>();
  const wechatInspection = options.inspectWechat ?? inspectWechat;
  const collector = new WechatCollector(store,{query:options.queryWechat,onMessages:(cid,latestId,live)=>{
    engine.conversationChanged(cid); suggestionRequests.delete(cid);
    mediaFiles.prune(store.read().messages.flatMap(m=>[m.imageAttachment,m.audioAttachment]));
    if(live && latestId) engine.enqueue(cid,latestId);
    if(live) void mediaAutomation.tick();
  }});
  async function syncDrafts(cid: string, automatic = false, onlyDraftIds?:string[]):Promise<{ok:true;id:string;duplicate:boolean;batches?:{id:string;duplicate:boolean}[]}|undefined> {
    const state = store.read();
    if (automatic && !state.settings.syncDraftsEnabled) return;
    const conversation = conversationOf(state,cid);
    const syncConfig = syncConnection.config();
    const destinationId = syncConnection.status().bindingId!;
    const revision = syncRevision;
    if (!isDraftSyncConfigured(syncConfig)) throw new Error('请先在设置中保存草稿同步配置。');
    const latest = state.messages.filter(item=>item.conversationId===cid).at(-1);
    const drafts = state.drafts.filter(item=>item.conversationId===cid && item.basedOnMessageId===latest?.id&&(!onlyDraftIds||onlyDraftIds.includes(item.id)));
    if (!drafts.length) throw new Error('当前没有可同步的有效草稿，请先生成回复。');
    if(!onlyDraftIds){
      const groups=new Map<string,typeof drafts>();
      for(const draft of drafts){const key=JSON.stringify([draft.provider,draft.modelChoiceId??'',draft.modelName??'']);groups.set(key,[...(groups.get(key)??[]),draft]);}
      if(groups.size>1||drafts.length>3){
        if([...groups.values()].some(group=>group.length>3))throw new Error('单个模型的草稿批次过大，请重新生成。');
        const receipts=await Promise.all([...groups.values()].map(group=>syncDrafts(cid,automatic,group.map(d=>d.id))));
        const batches=receipts.filter((item):item is NonNullable<typeof item>=>!!item).map(({id,duplicate})=>({id,duplicate}));
        return {ok:true,id:batches[0].id,duplicate:batches.every(item=>item.duplicate),batches};
      }
    }
    const batch = buildDraftBatch(conversation,drafts);
    if (state.draftUploads?.some(item=>item.id===batch.id && item.destinationId===destinationId && item.status==='uploaded')) return {ok:true as const,id:batch.id,duplicate:true};
    const uploadKey = `${destinationId}:${batch.id}`;
    const existing = uploads.get(uploadKey);
    if (existing) return existing.promise;
    const controller = new AbortController();
    store.update(s=>{
      const list = s.draftUploads ??= [];
      const prior = list.find(item=>item.id===batch.id && item.destinationId===destinationId);
      if(prior) {prior.status='uploading';prior.detail='正在上传草稿，服务器确认前不会标为完成。';prior.finishedAt=null;}
      else list.push({id:batch.id,destinationId,conversationId:cid,draftIds:drafts.map(item=>item.id),status:'uploading',detail:'正在上传草稿，服务器确认前不会标为完成。',createdAt:new Date().toISOString(),finishedAt:null});
    });
    const pending = (async () => {
      try {
        const receipt = await (options.uploadDrafts ?? uploadDraftBatch)(syncConfig,batch,controller.signal);
        if (closed || revision !== syncRevision) throw new Error('同步连接已更改，旧连接结果不再更新当前状态。');
        store.update(s=>{
          const entry=s.draftUploads?.find(item=>item.id===batch.id && item.destinationId===destinationId);
          if(entry) {entry.status='uploaded';entry.detail='服务器已确认保存草稿；没有向微信联系人发送。';entry.finishedAt=new Date().toISOString();}
          if(s.conversations.some(c=>c.id===cid)) addActivity(s,'success','草稿已同步至服务器','仅保存候选回复，没有发送微信消息。',cid);
        });
        return {ok:true as const,...receipt};
      } catch {
        if (closed || revision !== syncRevision) throw Object.assign(new Error('同步连接已更改，旧上传结果未确认；请在原服务器核对。'),{status:409});
        store.update(s=>{
          const entry=s.draftUploads?.find(item=>item.id===batch.id && item.destinationId===destinationId);
          if(entry) {entry.status='failed';entry.detail='服务器保存结果未确认。本机草稿已保留，可重试同一批草稿，服务器会去重。';entry.finishedAt=new Date().toISOString();}
          if(s.conversations.some(c=>c.id===cid)) addActivity(s,'warning','草稿同步未确认','本机草稿已保留，可在当前对话手动重试。',cid);
        });
        throw Object.assign(new Error('草稿同步未确认，本机草稿仍可使用；可重试同一批草稿。'),{status:502});
      } finally {uploads.delete(uploadKey);}
    })();
    uploads.set(uploadKey,{controller,promise:pending});
    return pending;
  }
  store.update(s=>{for(const attempt of s.sendAttempts??[]) if(attempt.status==='sending') attempt.status='unknown';});
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    const host = req.headers.host ?? '';
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) return res.status(403).json({error:'只允许从本机访问。'});
    if (req.path !== '/api/bridge/incoming' && req.path !== '/api/sync/drafts') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({error:'不接受其他网站发起的请求。'});
    }
    next();
  });
  app.use('/api/sync/drafts',express.json({limit:'32kb'}));
  app.use(express.json({limit: '8mb'}));
  app.get('/api/health', (_req,res) => res.json({ok:true,version:'0.1.0'}));
  app.get('/api/session', (req,res) => {
    res.setHeader('Set-Cookie', `${sessionCookieName(req)}=${session}; Path=/; HttpOnly; SameSite=Strict`);
    res.json({ token: session });
  });
  app.use('/api', (req,res,next) => {
    if (req.path === '/bridge/incoming' || (req.path === '/sync/drafts' && req.method === 'POST')) return next();
    const prefix = `${sessionCookieName(req)}=`;
    const cookie = (req.headers.cookie ?? '').split(';').map(v=>v.trim()).find(v=>v.startsWith(prefix))?.slice(prefix.length) ?? '';
    if (!secureEqual(cookie, session)) return res.status(401).json({error:'本机会话已过期，请刷新页面。'});
    if (!['GET','HEAD'].includes(req.method) && !secureEqual(String(req.headers['x-csrf-token'] ?? ''), session)) return res.status(403).json({error:'请求校验失败，请刷新页面。'});
    next();
  });
  const publicState = (): PublicState => {
    const s = store.read();
    const {imageTestRecognitionHistory:_testHistory,messages,...state}=s;
    const { apiKey, vision, audio, ...settings } = s.settings;
    const publicVision=vision?(({apiKey:key,...rest})=>({...rest,hasApiKey:!!key}))(vision):undefined;
    const publicAudio=audio?(({apiKey:key,...rest})=>({...rest,hasApiKey:!!key}))(audio):undefined;
    return { ...state, messages:messages.map(({imageRecognitionHistory:_history,...message})=>message), settings:{...settings,hasApiKey:!!apiKey,...(publicVision?{vision:publicVision}:{}),...(publicAudio?{audio:publicAudio}:{})}, knowledge:KNOWLEDGE,
      runtime: { channel:isBridgeReceiveConfigured(config)?'webhook':'simulator',bridgeConfigured:isBridgeConfigured(config),bridgeReceiveConfigured:isBridgeReceiveConfigured(config),bridgeSendConfigured:isBridgeConfigured(config),learnedProfileError,
        codexAvailable:codexStatus.available,codexVersion:codexStatus.version,codexStatus:codexStatus.message,
        draftSyncConfigured:isDraftSyncConfigured(syncConnection.config()),draftInboxConfigured:isDraftInboxConfigured(syncConnection.config()),draftSyncConnection:syncConnection.status(),remoteManagement:remote.status(),
        wechatAvailable:wechatInspection().available,wechatStatus:wechatInspection().message,
        autoRunning:settings.autoReplyEnabled,modelLabel:settings.provider==='demo'?'本机规则演示':settings.provider==='codex'?`Codex · ${settings.modelName||'默认模型'}`:settings.modelName||'尚未设置模型' } };
  };
  app.get('/api/state', (_req,res)=>res.json(publicState()));
  app.get('/api/draft-sync/connection', (_req,res)=>res.json(syncConnection.status()));
  const verifySyncConnection = async () => {
    const configuration = syncConnection.config();
    if (!draftConnectionCheckUrl(configuration)) throw new Error('此同步地址不支持 Wealth 设备验证，请通过手动同步草稿确认。');
    const revision = syncRevision;
    const sequence = ++checkSequence;
    activeConnectionCheck?.abort();
    const controller = new AbortController();
    activeConnectionCheck = controller;
    syncConnection.checking();
    const current = () => !closed && revision === syncRevision && sequence === checkSequence;
    try {
      const receipt = await (options.checkDraftConnection ?? checkDraftConnection)(configuration, controller.signal);
      if (current()) syncConnection.checked(receipt);
    } catch (error) {
      if (current()) syncConnection.checkFailed(error instanceof DraftConnectionCheckError ? error.message : '连接验证失败，配置仍保留，请稍后重试。');
    } finally { if (activeConnectionCheck === controller) activeConnectionCheck = null; }
    if (!current()) throw Object.assign(new Error('同步连接或验证请求已更新，本次旧验证结果已忽略。'), {status: 409});
    return syncConnection.status();
  };
  const changeSyncConnection = (change: () => void) => {
    // Persist before changing runtime state. An I/O or validation failure preserves the active binding.
    change(); syncRevision++; remote.invalidate();
    checkSequence++; activeConnectionCheck?.abort(); activeConnectionCheck = null;
    for (const upload of uploads.values()) upload.controller.abort();
    uploads.clear();
    store.update(s=>{
      s.settings.syncDraftsEnabled=false;
      for (const upload of s.draftUploads ?? []) if (upload.status==='uploading') {
        upload.status='failed'; upload.finishedAt=new Date().toISOString();
        upload.detail='同步连接已更改，原服务器是否收到该批草稿尚未确认，请在原服务器核对。';
      }
      addActivity(s,'info','草稿同步连接已更新','自动同步已暂停。采集、生成与本地草稿保留；连接验证不上传聊天或草稿。');
    });
  };
  app.put('/api/draft-sync/connection', async (req,res)=>{
    changeSyncConnection(()=>syncConnection.save(req.body));
    if (draftConnectionCheckUrl(syncConnection.config())) await verifySyncConnection();
    res.json(syncConnection.status());
  });
  app.post('/api/draft-sync/connection/check', async (req,res)=>{z.object({}).strict().parse(req.body ?? {});res.json(await verifySyncConnection());});
  app.delete('/api/draft-sync/connection', (_req,res)=>{changeSyncConnection(()=>syncConnection.disable());res.json(syncConnection.status());});
  app.post('/api/draft-sync/connection/environment', (_req,res)=>{changeSyncConnection(()=>syncConnection.restoreEnvironment());res.json(syncConnection.status());});
  app.get('/api/wechat/contacts',async(req,res)=>{
    if(!wechatInspection().available) throw new Error('本机微信读取工具尚未配置。');
    const query=z.string().trim().min(1).max(100).parse(req.query.q);
    const controller=new AbortController();
    const abort=()=>{if(!res.writableEnded) controller.abort();};
    res.on('close',abort);
    try {res.json(await (options.searchWechatContacts??searchWechatContacts)(query,controller.signal));}
    finally {res.off('close',abort);}
  });
  const addWechatConversation = (input: unknown) => {
    if(!wechatInspection().available) throw new Error('本机微信读取工具尚未配置。');
    const body=wechatAddSchema.parse(input);
    const state=store.read();
    if(state.conversations.some(c=>c.channel==='wechat'&&c.externalId===body.externalId)) throw new Error('该微信会话已经绑定。');
    if(state.conversations.filter(c=>c.channel==='wechat').length>=8) throw new Error('本版最多接入八个微信会话。');
    const now=new Date().toISOString();
    const conversation:Conversation={id:randomUUID(),name:body.name,externalId:body.externalId,channel:'wechat',avatar:body.name.slice(0,1),
      color:'#e7eddf',note:'',autoReplyEnabled:false,createdAt:now,updatedAt:now,
      wechat:{enabled:false,initialized:false,cursor:null,accountFingerprint:null,lastCheckedAt:null,status:'paused',detail:'已绑定，尚未读取。首次只载入最近 50 条上下文。'}};
    store.update(s=>{s.conversations.push(conversation);addActivity(s,'info','微信会话已绑定','采集与自动草稿均未开启。',conversation.id);});
    return conversation;
  };
  app.post('/api/wechat/conversations',(req,res)=>res.status(201).json(addWechatConversation(req.body)));
  const setWechatEnabled = (cid:string, enabled:boolean) => {
    if(enabled&&!wechatInspection().available) throw new Error('本机微信读取工具尚未配置。');
    collector.setEnabled(cid,enabled);
    if(!enabled){for(const message of store.read().messages.filter(m=>m.conversationId===cid))cancelMedia(message.id);store.update(s=>{for(const message of s.messages.filter(m=>m.conversationId===cid))message.autoMediaEligible=false;});}
    engine.conversationChanged(cid);suggestionRequests.delete(cid);
    store.update(s=>{s.drafts=s.drafts.filter(d=>d.conversationId!==cid);});
  };
  app.patch('/api/conversations/:id/wechat',(req,res)=>{
    const {enabled}=z.object({enabled:z.boolean()}).strict().parse(req.body);
    setWechatEnabled(param(req),enabled);res.json(publicState());
  });
  app.post('/api/conversations/:id/wechat/poll',async(req,res)=>{
    if(!wechatInspection().available) throw new Error('本机微信读取工具尚未配置。');
    res.json(await collector.poll(param(req)));
  });
  app.post('/api/messages/:id/review-media',(req,res)=>{
    const {summary}=z.object({summary:z.string().trim().max(2000).default('')}).strict().parse(req.body??{});
    const message=store.read().messages.find(m=>m.id===param(req));
    if(!message?.mediaStatus) throw new Error('该消息不需要媒体确认。');
    if(message.mediaStatus==='reviewed') return res.json({ok:true,duplicate:true});
    cancelMedia(message.id);
    engine.conversationChanged(message.conversationId);suggestionRequests.delete(message.conversationId);
    store.update(s=>{
      const m=s.messages.find(m=>m.id===message.id)!;m.mediaStatus='reviewed';m.autoMediaEligible=false;
      if(summary){delete m.imageRecognition;delete m.audioRecognition;}
      if(summary) m.text=`${m.text}\n[本人查看后补充] ${summary}`;
      s.drafts=s.drafts.filter(d=>d.conversationId!==message.conversationId);
      addActivity(s,'info','媒体已由本人查看',summary?'已保存本人补充说明；未自动生成或发送回复。':'仅标记已查看，模型仍不知道媒体具体内容。',message.conversationId);
    });
    res.json({ok:true});
  });
  const uploadSchema=z.object({dataUrl:z.string().min(1).max(Math.ceil(MAX_MEDIA_BYTES*4/3)+200),filename:z.string().max(255).optional()}).strict();
  const messageOf=(mid:string)=>{const m=store.read().messages.find(m=>m.id===mid);if(!m)throw Object.assign(new Error('消息不存在。'),{status:404});return m;};
  const cachedImageRecognition=(state:AppState,identity:ReturnType<typeof imageRecognitionIdentity>)=>
    findImageRecognition(state.imageTestRecognitionHistory,identity)??state.messages.reduce<Message['imageRecognition']>((found,message)=>found??findImageRecognition(message.imageRecognitionHistory,identity),undefined);
  const mediaConfiguration=(s:Settings,kind:'image'|'voice')=>JSON.stringify([kind==='image'?s.vision:s.audio,s.apiKey,s.modelUrl]);
  const cancelMedia=(mid?:string,kind?:'image'|'voice')=>{for(const [key,entry] of mediaRequests)if((!mid||mid===key)&&(!kind||entry.kind===kind))entry.controller.abort();};
  const invalidateMediaContext=(cid:string)=>{engine.conversationChanged(cid);suggestionRequests.delete(cid);store.update(s=>{s.drafts=s.drafts.filter(d=>d.conversationId!==cid);});};
  async function readMessageMedia(mid:string,kind:'image'|'voice',signal?:AbortSignal,forceRead=false) {
    const message=messageOf(mid),attachment=kind==='image'?message.imageAttachment:message.audioAttachment;
    if(message.kind!==kind)throw new Error(kind==='image'?'该消息不是图片。':'该消息不是语音。');
    if(attachment&&(!forceRead||message.source!=='wechat'))return mediaFiles.read(attachment);
    const state=store.read(),c=conversationOf(state,message.conversationId);
    if(message.source!=='wechat'||c.channel!=='wechat'||!c.externalId)throw new Error('请先上传原始媒体文件。');
    const file=await (kind==='image'?(options.readWechatImage??readWechatImage):(options.readWechatVoice??readWechatVoice))({contact:c.externalId,message,accountFingerprint:c.wechat?.accountFingerprint??undefined},signal);
    signal?.throwIfAborted();
    const current=messageOf(mid),currentConversation=conversationOf(store.read(),message.conversationId);
    if(current.sourceFingerprint!==message.sourceFingerprint||currentConversation.externalId!==c.externalId||currentConversation.wechat?.accountFingerprint!==c.wechat?.accountFingerprint)throw Object.assign(new Error('微信消息或账号已变化，请重新读取。'),{status:409});
    const prior=kind==='image'?current.imageAttachment:current.audioAttachment;
    if(forceRead&&prior?.id!==attachment?.id)throw Object.assign(new Error('媒体附件已变化，请重新读取。'),{status:409});
    if(prior&&!forceRead)return mediaFiles.read(prior);
    const saved=mediaFiles.save(file,'wechat');
    let sameImage=false;
    if(forceRead&&kind==='image'&&prior){try{sameImage=imageSha256(mediaFiles.read(prior).bytes)===imageSha256(file.bytes);}catch{/* Missing old files cannot establish unchanged content. */}}
    if(forceRead&&prior){cancelMedia(mid);if(!sameImage)invalidateMediaContext(current.conversationId);}
    try{store.update(s=>{const m=s.messages.find(m=>m.id===mid)!;if(kind==='image'){m.imageAttachment=saved;if(file.wechatImage)m.wechatImage={...m.wechatImage,...file.wechatImage};if(forceRead&&!sameImage)delete m.imageRecognition;}else{m.audioAttachment=saved;if(forceRead)delete m.audioRecognition;}if(forceRead){if(!sameImage)m.mediaStatus='pending';m.autoMediaEligible=false;}});}
    catch(error){mediaFiles.delete(saved);throw error;}
    if(forceRead)mediaFiles.delete(prior);
    return file;
  }
  async function recognizeMessage(mid:string,kind:'image'|'voice',signal?:AbortSignal) {
    if(mediaRequests.has(mid))throw Object.assign(new Error('这条媒体正在处理中，请等待结果。'),{status:409});
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const pending=(async()=>{
      const before=store.read(),message=messageOf(mid),configuration=mediaConfiguration(before.settings,kind);
      const file=await readMessageMedia(mid,kind,combined);
      combined.throwIfAborted();
      const attachment=kind==='image'?messageOf(mid).imageAttachment:messageOf(mid).audioAttachment;
      const identity=kind==='image'?imageRecognitionIdentity(before.settings,file.bytes):null;
      const savedRecognition=kind==='image'?cachedImageRecognition(store.read(),identity):undefined;
      const requestKey=identity?JSON.stringify(identity):null;
      if(!savedRecognition&&requestKey&&imageModelRequests.has(requestKey))throw Object.assign(new Error('这张图片与模型正在识别中，请等待结果后重试。'),{status:409});
      if(!savedRecognition&&requestKey)imageModelRequests.add(requestKey);
      let result:NonNullable<Message['imageRecognition']>|NonNullable<Message['audioRecognition']>;
      try{result=savedRecognition??(kind==='image'?await (options.recognizeImage??recognizeImage)(before.settings,file,combined):await (options.transcribeAudio??transcribeAudio)(before.settings,file,combined));}
      finally{if(!savedRecognition&&requestKey)imageModelRequests.delete(requestKey);}
      combined.throwIfAborted();
      const state=store.read(),current=messageOf(mid),currentAttachment=kind==='image'?current.imageAttachment:current.audioAttachment;
      if(closed||mediaConfiguration(state.settings,kind)!==configuration||currentAttachment?.id!==attachment?.id||current.sourceFingerprint!==message.sourceFingerprint)throw Object.assign(new Error('媒体或模型配置已变化，旧识别结果已忽略。'),{status:409});
      const unchanged=kind==='image'&&current.mediaStatus==='recognized'&&JSON.stringify(current.imageRecognition)===JSON.stringify(result);
      if(!unchanged)invalidateMediaContext(current.conversationId);
      store.update(s=>{
        const m=s.messages.find(m=>m.id===mid)!;m.mediaStatus='recognized';m.autoMediaEligible=false;
        if(kind==='image'){
          m.imageRecognition=result as NonNullable<Message['imageRecognition']>;
          if(identity)m.imageRecognitionHistory=saveImageRecognition(m.imageRecognitionHistory,identity,m.imageRecognition);
        }else m.audioRecognition=result as Message['audioRecognition'];
        addActivity(s,'success',savedRecognition?'已使用本地图片识别结果':kind==='image'?'图片已识别':'语音已转写',savedRecognition?'同一图片与模型的结果已保存在本机；本次没有调用模型。':'识别内容已加入当前对话，可生成回复草稿。',m.conversationId);
      });
      return {cached:!!savedRecognition};
    })();
    mediaRequests.set(mid,{kind,controller,promise:pending});
    try{return await pending;}finally{if(mediaRequests.get(mid)?.controller===controller)mediaRequests.delete(mid);}
  }
  const mediaAutomation=new MediaAutomation(store,{
    recognize:async(...args)=>{await recognizeMessage(...args);},
    onComplete:cid=>{const latest=store.read().messages.filter(m=>m.conversationId===cid).at(-1);if(latest?.role==='peer')engine.enqueue(cid,latest.id,true);},
    onFailure:(cid,kind)=>store.update(s=>addActivity(s,'warning',kind==='image'?'图片自动识别未完成':'语音自动转写未完成','可在这条消息中手动重试或上传媒体文件。',cid)),
  });
  app.post('/api/images/test',async(req,res)=>{
    const before=store.read().settings,file=parseImageUpload(uploadSchema.parse(req.body));
    const identity=imageRecognitionIdentity(before,file.bytes),cached=cachedImageRecognition(store.read(),identity);
    if(cached){if(identity)store.update(s=>{s.imageTestRecognitionHistory=saveImageRecognition(s.imageTestRecognitionHistory,identity,cached);});return res.json({...cached,cached:true});}
    const requestKey=identity?JSON.stringify(identity):null;
    if(requestKey&&imageModelRequests.has(requestKey))throw Object.assign(new Error('这张图片与模型正在识别中，请等待结果。'),{status:409});
    if(requestKey)imageModelRequests.add(requestKey);
    try{
      const recognition=await (options.recognizeImage??recognizeImage)(before,file);
      if(closed||mediaConfiguration(store.read().settings,'image')!==mediaConfiguration(before,'image'))throw Object.assign(new Error('识图配置已变化，请重新测试。'),{status:409});
      if(identity)store.update(s=>{s.imageTestRecognitionHistory=saveImageRecognition(s.imageTestRecognitionHistory,identity,recognition);});
      res.json({...recognition,cached:false});
    }finally{if(requestKey)imageModelRequests.delete(requestKey);}
  });
  app.post('/api/audio/test',async(req,res)=>{
    const before=store.read().settings,file=parseAudioUpload(uploadSchema.parse(req.body));
    const recognition=await (options.transcribeAudio??transcribeAudio)(before,file);
    if(mediaConfiguration(store.read().settings,'voice')!==mediaConfiguration(before,'voice'))throw Object.assign(new Error('语音配置已变化，请重新测试。'),{status:409});
    res.json(recognition);
  });
  app.post('/api/conversations/:id/images',(req,res)=>{
    const {role,...input}=uploadSchema.extend({role:z.enum(['self','peer']).default('peer')}).parse(req.body);
    const cid=param(req);conversationOf(store.read(),cid);
    const attachment=mediaFiles.save(parseImageUpload(input),'upload'),now=new Date().toISOString();
    const message:Message={id:randomUUID(),conversationId:cid,role,text:'[上传图片，待识别]',kind:'image',mediaStatus:'pending',imageAttachment:attachment,sentAt:now,sequence:Math.max(0,...store.read().messages.filter(m=>m.conversationId===cid).map(m=>m.sequence))+1,source:'manual',externalId:null,aiAssisted:false};
    invalidateMediaContext(cid);
    try{store.update(s=>{s.messages.push(message);conversationOf(s,cid).updatedAt=now;});}catch(error){mediaFiles.delete(attachment);throw error;}
    res.status(201).json(message);
  });
  app.post('/api/messages/:id/image',(req,res)=>{
    const mid=param(req),message=messageOf(mid);if(message.kind!=='image')throw new Error('该消息不是图片。');
    const saved=mediaFiles.save(parseImageUpload(uploadSchema.parse(req.body)),'upload'),prior=message.imageAttachment;
    cancelMedia(mid);invalidateMediaContext(message.conversationId);
    try{store.update(s=>{const m=s.messages.find(m=>m.id===mid)!;m.imageAttachment=saved;delete m.imageRecognition;m.mediaStatus='pending';m.autoMediaEligible=false;});}
    catch(error){mediaFiles.delete(saved);throw error;}
    mediaFiles.delete(prior);res.json({image:saved});
  });
  for(const kind of ['image','voice'] as const){
    app.post(`/api/messages/:id/read-${kind}`,async(req,res)=>{z.object({}).strict().parse(req.body??{});await readMessageMedia(param(req),kind,undefined,true);res.json({ok:true});});
    app.post(`/api/messages/:id/${kind==='image'?'recognize-image':'transcribe-voice'}`,async(req,res)=>{z.object({}).strict().parse(req.body??{});const result=await recognizeMessage(param(req),kind);const message=messageOf(param(req));res.json({recognition:kind==='image'?message.imageRecognition:message.audioRecognition,...(kind==='image'?{cached:result.cached}:{})});});
    app.get(`/api/messages/:id/${kind==='image'?'image':'audio'}`,(req,res)=>{
      const message=messageOf(param(req)),attachment=kind==='image'?message.imageAttachment:message.audioAttachment;
      if(!attachment)throw Object.assign(new Error('本机媒体尚未读取。'),{status:404});
      const file=mediaFiles.read(attachment);res.type(file.mimeType).set('Content-Disposition','inline').send(file.bytes);
    });
  }
  app.post('/api/codex/check',async (_req,res)=>{await checkCodex();res.json(publicState());});
  app.post('/api/sync/drafts',(req,res)=>{
    if(!isDraftInboxConfigured(syncConnection.config()) || !secureEqual(req.headers.authorization??'',`Bearer ${syncConnection.config().inboxToken}`)) return res.status(401).json({error:'草稿接收凭据无效或尚未配置。'});
    const batch=cloudDraftBatchSchema.parse(req.body);
    if(req.headers['idempotency-key']!==batch.id) return res.status(400).json({error:'草稿批次与请求标识不一致。'});
    const existing=store.read().cloudDrafts?.find(item=>item.id===batch.id);
    if(existing) {
      const {receivedAt:_receivedAt,...original}=existing;
      return JSON.stringify(original)===JSON.stringify(batch)
        ? res.json({ok:true,id:batch.id,duplicate:true}) : res.status(409).json({error:'同一草稿批次不能包含不同的内容。'});
    }
    store.update(s=>{(s.cloudDrafts??=[]).push({...batch,receivedAt:new Date().toISOString()});addActivity(s,'success','收到同步草稿','已存入云端草稿箱，没有生成会话消息或发送任务。');});
    res.status(201).json({ok:true,id:batch.id,duplicate:false});
  });
  app.delete('/api/sync/drafts/:id',(req,res)=>{
    store.update(s=>{s.cloudDrafts=(s.cloudDrafts??[]).filter(item=>item.id!==param(req));});
    res.json({ok:true});
  });
  app.post('/api/conversations/:id/sync-drafts',async(req,res)=>{res.json(await syncDrafts(param(req)));});
  app.post('/api/profile/reload', (_req,res)=>{
    engine.pause(); suggestionRequests.clear(); reloadProfile();
    store.update(s=>addActivity(s,learnedProfileError?'warning':'info','习惯档案已重新读取',learnedProfileError ?? (s.learnedProfile ? `已载入 ${s.learnedProfile.version}，自动处理已暂停。` : '当前没有已校准档案。')));
    res.json(publicState());
  });

  const patchSettings = (input:unknown) => {
    const patch = settingsSchema.parse(input);
    const old = store.read().settings;
    const next = { ...old, ...patch,
      ...(patch.vision?{vision:{...old.vision,...patch.vision}}:{}),...(patch.audio?{audio:{...old.audio,...patch.audio}}:{}) };
    // Existing remote controls choose one primary model; honor that selection.
    if(patch.replyModels===undefined&&((patch.provider!==undefined&&patch.provider!==old.provider)||(patch.modelName!==undefined&&patch.modelName!==old.modelName)))next.replyModels=[];
    if((next.replyModels?.length??0)>1&&next.autoReplyMode==='send'){next.autoReplyMode='draft';next.autoReplyEnabled=false;}
    if (next.autoReplyMode !== old.autoReplyMode) next.autoReplyEnabled = false;
    if(patch.allowRemoteModel===false && old.allowRemoteModel) next.autoReplyEnabled=false;
    if(next.provider!=='demo' && next.provider!=='codex' && next.modelUrl.trim()) validateEndpoint(next.modelUrl);
    for(const item of [next.vision,next.audio])if(item&&item.provider!=='disabled'&&item.provider!=='codex'&&item.modelUrl.trim())validateEndpoint(item.modelUrl);
    // Legacy global media flags are accepted for old clients, but only contact
    // switches control automation and are validated when a contact enables them.
    if(next.syncDraftsEnabled && !isDraftSyncConfigured(syncConnection.config())) throw new Error('请先在设置中保存草稿同步配置。');
    if(next.autoReplyEnabled) {
      const active=store.read().conversations.filter(c=>c.autoReplyEnabled);
      for(const conversation of active)checkModelReady(effectiveContactSettings(next,conversation));
      if(!active.length)checkModelReady(next);
    }
    if(next.autoReplyEnabled && next.autoReplyMode==='send' && store.read().conversations.some(c=>c.channel==='wechat'&&c.autoReplyEnabled)) throw new Error('微信采集通道仅支持自动草稿，请先关闭这些会话的自动处理或切回草稿模式。');
    if (next.quietHoursEnabled && next.quietStart === next.quietEnd) throw new Error('免打扰的开始和结束时间不能相同。');
    if (next.autoReplyMode === 'send' && next.autoReplyEnabled && store.read().conversations.some(c=>c.channel==='webhook' && c.autoReplyEnabled)) {
      if(!isBridgeConfigured(config)) throw new Error('当前桥接仅接收消息，尚未配置发送接口。');
      if(store.read().conversations.some(c=>c.channel==='webhook'&&c.autoReplyEnabled&&contactUsesDemo(next,c))) throw new Error('规则演示不能自动发送到外部会话，请关闭自动回复或选择真实模型。');
    }
    if(next.autoReplyMode==='send'&&next.autoReplyEnabled&&store.read().conversations.some(c=>c.autoReplyEnabled&&(effectiveContactSettings(next,c).replyModels?.length??0)>1))throw new Error('部分联系人选择了多个回复模型，请使用草稿模式。');
    // Model or scheduling changes cancel pending work; newly arriving messages use the new settings.
    const needsCancel = Object.entries(patch).some(([key,value])=>key!=='autoReplyEnabled' && key!=='syncDraftsEnabled' && key!=='remoteManagementEnabled' && old[key as keyof Settings]!==value) || patch.autoReplyEnabled===false;
    if (needsCancel) {engine.pause(); suggestionRequests.clear();}
    if(mediaConfiguration(next,'image')!==mediaConfiguration(old,'image'))cancelMedia(undefined,'image');
    if(mediaConfiguration(next,'voice')!==mediaConfiguration(old,'voice'))cancelMedia(undefined,'voice');
    store.update(s=>{
      s.settings = next;
      if(needsCancel) s.drafts=[];
      addActivity(s,'info',next.autoReplyEnabled?'自动回复已开启':'设置已保存',next.autoReplyEnabled?'只对已开启的联系人生效。':'自动回复当前关闭。');
    });
    mediaAutomation.invalidate();
    if(patch.remoteManagementEnabled!==undefined && old.remoteManagementEnabled!==patch.remoteManagementEnabled)remote.invalidate(!patch.remoteManagementEnabled);
  };
  app.patch('/api/settings',(req,res)=>{patchSettings(req.body);res.json(publicState());});
  app.post('/api/auto/pause', (_req,res)=>{ engine.pause(); res.json(publicState()); });
  app.post('/api/model/test', async (_req,res)=>{ checkModelReady(store.read().settings); res.json(await testModel(store.read().settings)); });

  app.post('/api/conversations', (req,res)=>{
    const body = z.object({ name:z.string().trim().min(1).max(80), channel:z.enum(['simulator','webhook']).default('simulator'), externalId:id.optional() }).parse(req.body);
    if (body.channel==='webhook' && (!isBridgeReceiveConfigured(config)||!body.externalId)) throw new Error('请先配置消息接收凭据，并填写对方在该接口中的会话标识。');
    if (body.externalId && store.read().conversations.some(c=>c.channel===body.channel&&c.externalId===body.externalId)) throw new Error('该外部会话已经存在。');
    const now = new Date().toISOString();
    const c:Conversation={id:randomUUID(),name:body.name,avatar:body.name.slice(0,1),color:'#e7eddf',note:'',autoReplyEnabled:false,channel:body.channel,externalId:body.externalId??null,createdAt:now,updatedAt:now};
    store.update(s=>s.conversations.push(c)); res.status(201).json(c);
  });
  const patchConversation = (cid:string,input:unknown) => {
    const body=conversationPatchSchema.parse(input);
    const state=store.read(),c=conversationOf(state,cid),{processing,...information}=body;
    const next:Conversation={...c,...information};
    if(processing){
      const {replyModels,...media}=processing;
      next.processing={...c.processing,...media};
      if(replyModels===null)delete next.processing.replyModels;
      else if(replyModels!==undefined)next.processing.replyModels=replyModels;
    }
    const effective=effectiveContactSettings(state.settings,next);
    if(processing?.autoRecognizeImages===true&&(!state.settings.vision||state.settings.vision.provider==='disabled'))throw new Error('请先配置图片识别模型，再为此联系人开启自动识图。');
    if(processing?.autoTranscribeVoice===true&&(!state.settings.audio||state.settings.audio.provider==='disabled'))throw new Error('请先配置语音模型，再为此联系人开启自动转写。');
    if(next.autoReplyEnabled&&(body.autoReplyEnabled!==undefined||processing?.replyModels!==undefined))checkModelReady(effective);
    if(next.autoReplyEnabled&&(effective.replyModels?.length??0)>1&&state.settings.autoReplyMode==='send')throw new Error('此联系人选择了多个回复模型，请使用草稿模式。');
    if(body.autoReplyEnabled && c.channel==='wechat') {
      if(state.settings.autoReplyMode!=='draft') throw new Error('微信采集通道只支持自动草稿，请先切换为草稿模式。');
    }
    if(body.autoReplyEnabled && c.channel==='webhook') {
      if(!isBridgeReceiveConfigured(config)) throw new Error('消息接收接口尚未配置。');
      if(state.settings.autoReplyMode==='send') {
        if(!isBridgeConfigured(config)) throw new Error('当前桥接仅接收消息，尚未配置发送接口。');
        if(contactUsesDemo(state.settings,next)) throw new Error('外部自动回复需要真实模型；规则演示只能用于本机演练。');
      }
    }
    engine.conversationChanged(cid); suggestionRequests.delete(cid);
    store.update(s=>{
      Object.assign(conversationOf(s,cid),next);
      for(const message of s.messages.filter(m=>m.conversationId===cid&&(m.kind==='image'||m.kind==='voice'))) {
        if(!contactAutoMediaEnabled(next,message.kind as 'image'|'voice'))message.autoMediaEligible=false;
      }
      s.drafts=s.drafts.filter(d=>d.conversationId!==cid);addActivity(s,'info','对话设置已更新',body.autoReplyEnabled===true?'此联系人已加入自动处理范围。':body.autoReplyEnabled===false?'此联系人已暂停自动处理。':'已保存对话信息。',cid);
    });
    mediaAutomation.invalidate(cid);
    return conversationOf(store.read(),cid);
  };
  app.patch('/api/conversations/:id',(req,res)=>res.json(patchConversation(param(req),req.body)));
  app.delete('/api/conversations/:id', (req,res)=>{
    const cid=param(req); conversationOf(store.read(),cid);
    if(manualSending.has(cid)||activeSends.has(cid)) return res.status(409).json({error:'该会话有发送正在确认，请稍后删除。'});
    engine.conversationChanged(cid);
    collector.cancel(cid);
    const attachments=store.read().messages.filter(m=>m.conversationId===cid).flatMap(m=>[m.imageAttachment,m.audioAttachment]);
    for(const message of store.read().messages.filter(m=>m.conversationId===cid))cancelMedia(message.id);
    store.update(s=>{s.sendAttempts=(s.sendAttempts??[]).filter(a=>a.conversationId!==cid);});
    deleteConversation(store,cid);for(const attachment of attachments)mediaFiles.delete(attachment);res.json({ok:true});
  });

  app.post('/api/conversations/:id/messages', (req,res)=>{
    const body=z.object({text,role:z.enum(['self','peer'])}).parse(req.body);
    const cid=param(req); const c=conversationOf(store.read(),cid);
    if(c.channel!=='simulator') throw new Error('外部会话只能通过已配置的消息桥接接收消息。');
    const m:Message={id:randomUUID(),conversationId:cid,role:body.role,text:body.text,sentAt:new Date().toISOString(),sequence:store.read().messages.filter(m=>m.conversationId===cid).length+1,source:'manual',externalId:null,aiAssisted:false};
    engine.conversationChanged(cid);
    store.update(s=>{s.messages.push(m);conversationOf(s,cid).updatedAt=m.sentAt!;s.drafts=s.drafts.filter(d=>d.conversationId!==cid);});
    if(body.role==='peer') engine.enqueue(cid,m.id);
    res.status(201).json(m);
  });

  app.post('/api/conversations/:id/suggest', async (req,res)=>{
    const {intent}=z.object({intent:z.string().trim().max(2000).default('')}).parse(req.body??{});
    const cid=param(req); const before=store.read(); const conversation=conversationOf(before,cid); checkModelReady(effectiveContactSettings(before.settings,conversation));
    assertReplyContextReady(before,cid);
    const latest=before.messages.filter(m=>m.conversationId===cid).at(-1);
    if(!latest) throw new Error('先添加一条对话消息，再生成建议。');
    if(activeSends.has(cid)) return res.status(409).json({error:'该会话已有发送等待确认，请稍后生成。'});
    engine.conversationChanged(cid);
    const requestId=randomUUID(); suggestionRequests.set(cid,requestId);
    const drafts=await generate(before,cid,intent);
    const current=store.read();
    if(!current.conversations.some(c=>c.id===cid)||current.messages.filter(m=>m.conversationId===cid).at(-1)?.id!==latest.id) return res.status(409).json({error:'对话已有新消息，请重新生成建议。'});
    if(suggestionRequests.get(cid)!==requestId || JSON.stringify(current.settings)!==JSON.stringify(before.settings) || replyContextFingerprint(current,cid)!==replyContextFingerprint(before,cid)) return res.status(409).json({error:'设置、个人档案、反馈或生成请求已更新，请重新生成建议。'});
    if(!drafts.length || drafts.some(d=>d.conversationId!==cid || d.basedOnMessageId!==latest.id || !d.text.trim() || d.text.length>500)) throw new Error('生成结果无效，请重新生成建议。');
    store.update(s=>{s.drafts=s.drafts.filter(d=>d.conversationId!==cid);s.drafts.push(...drafts);});
    await syncDrafts(cid,true).catch(()=>{});
    res.json({drafts});
  });
  app.post('/api/conversations/:id/feedback', (req,res)=>{
    const body=z.object({draftId:id,text,reason:z.string().trim().max(1000).default(''),requestId:id}).strict().parse(req.body);
    const cid=param(req);const state=store.read();conversationOf(state,cid);
    const prior=state.feedback?.find(item=>item.source==='review' && item.requestId===body.requestId);
    if(prior) {
      if(prior.conversationId!==cid || prior.draftId!==body.draftId || prior.revisedText!==body.text || prior.reason!==body.reason) return res.status(409).json({error:'同一反馈标识不能用于不同的内容。'});
      return res.json({feedback:prior,duplicate:true});
    }
    if(activeSends.has(cid)) return res.status(409).json({error:'该会话已有发送等待确认，请稍后保存反馈。'});
    const draft=state.drafts.find(item=>item.id===body.draftId && item.conversationId===cid);
    if(!draft || state.messages.filter(m=>m.conversationId===cid).at(-1)?.id!==draft.basedOnMessageId) return res.status(409).json({error:'这条草稿已失效，请重新生成。'});
    engine.conversationChanged(cid);suggestionRequests.delete(cid);
    store.update(s=>{
      recordDraftFeedback(s,draft,{requestId:body.requestId,text:body.text,reason:body.reason,source:'review'});
      addActivity(s,'success','回复反馈已保存','仅保存本机反馈，没有发送消息；后续仅在当前会话参考。',cid);
    });
    res.json({feedback:store.read().feedback!.find(item=>item.source==='review' && item.requestId===body.requestId),duplicate:false});
  });
  app.delete('/api/feedback/:id', (req,res)=>{
    const entry=store.read().feedback?.find(item=>item.id===param(req));
    if(!entry) return res.status(404).json({error:'反馈不存在。'});
    engine.conversationChanged(entry.conversationId);suggestionRequests.delete(entry.conversationId);
    store.update(s=>{s.feedback=(s.feedback??[]).filter(item=>item.id!==entry.id);s.drafts=s.drafts.filter(item=>item.conversationId!==entry.conversationId);});
    res.json({ok:true});
  });
  app.post('/api/conversations/:id/send', async (req,res)=>{
    const body=z.object({text,draftId:id.optional(),requestId:id.optional(),reason:z.string().trim().max(1000).default('')}).parse(req.body);
    const cid=param(req);const s=store.read();const c=conversationOf(s,cid);
    if(c.channel==='wechat') throw new Error('微信采集通道仅接收消息，请复制回复后在微信手动发送。');
    if(c.channel==='webhook'&&!isBridgeConfigured(config)) throw new Error('当前桥接仅接收消息，尚未配置发送接口。');
    if(manualSending.has(cid)||activeSends.has(cid)) return res.status(409).json({error:'该会话已有发送等待确认，请勿重复发送。'});
    if(c.channel==='webhook'&&!body.requestId&&!body.draftId) throw new Error('外部发送必须带稳定的 requestId，防止重复提交。');
    const sendId=body.requestId??body.draftId??randomUUID();
    const fingerprint=createHash('sha256').update(JSON.stringify([cid,body.text,body.draftId??null])).digest('hex');
    const prior=s.sendAttempts?.find(a=>a.id===sendId);
    if(prior){
      if(prior.fingerprint!==fingerprint) return res.status(409).json({error:'同一发送标识不能用于不同的内容。'});
      if(prior.status==='sent') return res.json({ok:true,duplicate:true});
      return res.status(409).json({error:'这次发送的结果尚未确认，请先核对接收端，不会重复提交。'});
    }
    const draft=body.draftId?s.drafts.find(d=>d.id===body.draftId&&d.conversationId===cid):undefined;
    if(body.draftId&&!draft) return res.status(409).json({error:'这条草稿已失效，请重新生成。'});
    if(draft&&s.messages.filter(m=>m.conversationId===cid).at(-1)?.id!==draft.basedOnMessageId) return res.status(409).json({error:'对话已更新，这条草稿已过期。'});
    if(c.channel==='webhook'&&draft?.provider==='demo') throw new Error('规则演示内容不用于外部发送，请配置真实模型或自己填写回复。');
    engine.conversationChanged(cid); suggestionRequests.delete(cid); manualSending.add(cid);
    // Claim this draft before I/O: an uncertain external result must never make it retryable.
    store.update(state=>{state.drafts=state.drafts.filter(d=>d.conversationId!==cid);(state.sendAttempts??=[]).push({id:sendId,conversationId:cid,fingerprint,status:'sending',createdAt:new Date().toISOString()});});
    try {
      const receipt=await send(c,body.text,sendId);
      const now=new Date().toISOString();
      store.update(state=>{
        const externalId=typeof receipt==='string'?receipt:null;
        if(!externalId||!state.messages.some(m=>m.conversationId===cid&&m.externalId===externalId&&m.role==='self')) state.messages.push({id:sendId,conversationId:cid,role:'self',text:body.text,sentAt:now,sequence:state.messages.filter(m=>m.conversationId===cid).length+1,source:'manual',externalId,aiAssisted:!!draft});
        const attempt=state.sendAttempts?.find(a=>a.id===sendId);if(attempt)attempt.status='sent';
        if(draft) recordDraftFeedback(state,draft,{requestId:sendId,text:body.text,reason:body.reason,source:'send'});
        conversationOf(state,cid).updatedAt=now;state.drafts=state.drafts.filter(d=>d.conversationId!==cid);addActivity(state,'success',c.channel==='simulator'?'回复已加入本机演练':'发送接口已确认',c.channel==='simulator'?'没有发送到微信。':'外部接口返回了发送凭据；送达状态以接收端为准。',cid);
      });
      res.json({ok:true});
    } catch {
      store.update(state=>{const attempt=state.sendAttempts?.find(a=>a.id===sendId);if(attempt)attempt.status='unknown';addActivity(state,'error','发送未确认','请核对接收端；为避免重复发送，未自动重试。',cid);});
      res.status(502).json({error:'发送结果未确认。请先核对接收端，系统没有自动重试。'});
    } finally {manualSending.delete(cid);}
  });

  app.post('/api/conversations/:id/extract', (req,res)=>{ const cid=param(req);conversationOf(store.read(),cid);res.json({claims:extractClaims(store,cid)}); });
  app.post('/api/claims', (req,res)=>{
    const body=z.object({category:z.enum(['preference','style','fact','boundary']),statement:z.string().trim().min(1).max(1000),scope:z.string().nullable().optional()}).parse(req.body);
    if(body.scope) conversationOf(store.read(),body.scope);
    const claim={id:randomUUID(),category:body.category,statement:body.statement,status:'approved' as const,evidenceIds:[],scope:body.scope??null,createdAt:new Date().toISOString()};
    engine.pause();
    store.update(s=>{s.claims.push(claim);s.drafts=[];});res.status(201).json(claim);
  });
  app.patch('/api/claims/:id', (req,res)=>{
    const body=z.object({status:z.enum(['pending','approved','rejected']).optional(),statement:z.string().trim().min(1).max(1000).optional()}).strict().parse(req.body);
    if(!store.read().claims.some(c=>c.id===param(req))) return res.status(404).json({error:'档案条目不存在。'});
    engine.pause();
    store.update(s=>{Object.assign(s.claims.find(c=>c.id===param(req))!,body);s.drafts=[];});res.json({ok:true});
  });
  app.delete('/api/claims/:id', (req,res)=>{
    engine.pause(); store.update(s=>{s.claims=s.claims.filter(c=>c.id!==param(req));s.drafts=[];});res.json({ok:true});
  });
  app.post('/api/import/preview', (req,res)=>res.json(previewImport(importSchema.parse(req.body))));
  app.post('/api/import/commit', (req,res)=>{
    const body=importSchema.parse(req.body); const preview=previewImport(body);
    if(preview.needsSelfId) throw new Error('请先选择哪一位是你。');
    engine.pause();const result=commitImport(store,body);store.update(s=>{s.drafts=[];});res.json(result);
  });
  app.post('/api/demo', (_req,res)=>{const attachments=store.read().messages.flatMap(m=>[m.imageAttachment,m.audioAttachment]);cancelMedia();seedDemo(store);for(const attachment of attachments)mediaFiles.delete(attachment);res.json(publicState());});
  app.post('/api/bridge/incoming', (req,res)=>{
    if(!isBridgeReceiveConfigured(config)||!secureEqual(req.headers.authorization??'',`Bearer ${config.inboundToken}`)) return res.status(401).json({error:'消息桥接未配置或凭据无效。'});
    const body=z.object({eventId:id,conversationId:id,text,direction:z.enum(['incoming','outgoing']).default('incoming'),timestamp:z.string().datetime({offset:true}).optional(),idempotencyKey:id.optional()}).parse(req.body);
    const state=store.read(); const c=state.conversations.find(c=>c.channel==='webhook'&&c.externalId===body.conversationId);
    if(!c) return res.status(404).json({error:'该会话未添加至接入列表。'});
    const role=body.direction==='incoming'?'peer':'self';
    const exists=state.messages.find(m=>m.conversationId===c.id&&m.externalId===body.eventId);
    if(exists) return exists.text===body.text&&exists.role===role?res.json({ok:true,duplicate:true}):res.status(409).json({error:'同一事件标识的内容不一致。'});
    const m:Message={id:randomUUID(),conversationId:c.id,role,text:body.text,sentAt:body.timestamp??new Date().toISOString(),sequence:state.messages.filter(m=>m.conversationId===c.id).length+1,source:'bridge',externalId:body.eventId,aiAssisted:role==='self'};
    const ownEcho=role==='self'&&body.idempotencyKey&&activeSends.get(c.id)===body.idempotencyKey;
    if(!ownEcho) engine.conversationChanged(c.id);
    store.update(s=>{s.messages.push(m);conversationOf(s,c.id).updatedAt=new Date().toISOString();s.drafts=s.drafts.filter(d=>d.conversationId!==c.id);});
    if(role==='peer') engine.enqueue(c.id,m.id);
    res.status(202).json({ok:true,messageId:m.id});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在。'}));
  app.use((error:unknown,req:Request,res:Response,_next:NextFunction)=>{
    if(error instanceof z.ZodError) return res.status(400).json({error:`输入格式不正确：${error.issues[0]?.path.join('.')||'字段'}。`});
    const e=error as Error & {status?:number;type?:string};
    if(e.type==='entity.too.large') return res.status(413).json({error:req.path==='/api/sync/drafts'?'草稿批次过大，每批不超过 32 KiB。':'文件过大，请分批导入（每批不超过 5 MiB）。'});
    if(e instanceof SyntaxError) return res.status(400).json({error:'无法解析输入，请检查文件内容。'});
    // Do not echo fetch/provider bodies, keys, database paths or imported text.
    const safe=typeof e.message==='string'&&/^[\u4e00-\u9fff]/.test(e.message)&&e.message.length<240;
    res.status(e.status??400).json({error:safe?e.message:'操作未完成，请检查输入或模型设置后重试。'});
  });
  const remote = new RemoteManagement(store, {
    config:()=>syncConnection.config(),enabled:()=>store.read().settings.remoteManagementEnabled===true,
    fetch:options.remoteFetch,
    onFailure:error=>{
      const message=error instanceof Error?error.message:'';
      const safe=/^[\u4e00-\u9fff]/.test(message)&&message.length<240&&!message.includes(syncConnection.config().token||'\0');
      store.update(s=>addActivity(s,'warning','网页远程操作未完成',safe?message:'请检查远程操作的输入格式与本机配置后重试。'));
    },
    snapshot:()=>{const state=store.read();return {version:1,remoteEnabled:true,settings:remoteSettings(state.settings),
      conversations:state.conversations.filter(c=>c.channel==='wechat').slice(0,8).map(remoteConversation),
      capabilities:{wechatAvailable:wechatInspection().available,codexAvailable:codexStatus.available}};},
    execute:async(command,signal)=>{
      if(signal.aborted)throw new Error('远程操作已取消。');
      if(command.type==='settings.patch') {
        const patch=remoteSettingsSchema.parse(command.payload);
        patchSettings({...patch,autoReplyMode:'draft'});return {};
      }
      if(command.type==='contacts.search') {
        if(!wechatInspection().available)throw new Error('本机微信读取工具尚未配置。');
        const {query,limit}=searchCommandSchema.parse(command.payload);
        const page=await (options.searchWechatContacts??searchWechatContacts)(query,signal);
        if(signal.aborted)throw new Error('远程操作已取消。');
        // Only explicit search results leave the Mac; no message or account fields.
        const contacts=page.contacts.slice(0,limit).map(({externalId,name})=>wechatAddSchema.parse({externalId,name}));
        return {contacts,hasMore:page.hasMore||page.contacts.length>limit};
      }
      if(command.type==='conversation.add')return {conversation:remoteConversation(addWechatConversation(command.payload))};
      const {id:cid,enabled,...patch}=patchCommandSchema.parse(command.payload);
      const target=conversationOf(store.read(),cid);
      if(target.channel!=='wechat')throw new Error('远程管理只支持微信会话。');
      if(enabled&&!wechatInspection().available)throw new Error('本机微信读取工具尚未配置。');
      if(Object.keys(patch).length)patchConversation(cid,patch);
      if(enabled!==undefined)setWechatEnabled(cid,enabled);
      return {conversation:remoteConversation(conversationOf(store.read(),cid))};
    },
  });
  return {app,store,engine,collector,remote,mediaAutomation,publicState,close:()=>{mediaAutomation.stop();cancelMedia();remote.stop();closed=true;syncRevision++;checkSequence++;activeConnectionCheck?.abort();for(const upload of uploads.values()) upload.controller.abort();collector.stop();engine.stop();store.close();}};
}
