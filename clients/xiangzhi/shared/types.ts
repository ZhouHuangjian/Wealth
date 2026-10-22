export type Provider = 'demo' | 'ollama' | 'compatible' | 'codex';
export type AutoReplyMode = 'draft' | 'send';
export interface VisionSettings {
  provider: 'qwen' | 'compatible' | 'codex' | 'disabled';
  modelUrl: string; modelName: string; apiKey?: string;
  useReplyApiKey: boolean; allowRemoteModel: boolean; thinkingEnabled?: boolean;
}
export interface ImageRecognition {
  summary: string; visibleText: string; facts: string[];
  provider: 'qwen' | 'compatible' | 'codex'; modelName: string; recognizedAt: string;
  usage?: {promptTokens: number; completionTokens: number; totalTokens: number};
}
export interface ImageRecognitionCacheEntry {
  imageSha256: string;
  /** Hash of provider, selected model, normalized endpoint and prompt version. */
  modelIdentity: string;
  recognition: ImageRecognition;
}
export interface ImageAttachment {
  id: string; filename: string; mimeType: string; source: 'upload' | 'wechat';
}
export interface AudioSettings {
  provider: 'qwen' | 'compatible' | 'disabled';
  modelUrl: string; modelName: string; apiKey?: string;
  useReplyApiKey: boolean; allowRemoteModel: boolean;
}
export interface AudioRecognition {
  text: string; provider: 'qwen' | 'compatible'; modelName: string; recognizedAt: string;
  usage?: {promptTokens: number; completionTokens: number; totalTokens: number};
}
export interface ReplyModelChoice {
  id: string; provider: Provider; modelName: string; modelPreset?: 'custom' | 'qwen'; label?: string;
}
export interface ContactModelSettings {
  provider: 'qwen' | 'compatible' | 'codex' | 'disabled';
  modelUrl: string; modelName: string; apiKey?: string;
  useReplyApiKey: boolean; allowRemoteModel: boolean; thinkingEnabled?: boolean;
}
export interface ContactBasisFact {
  id: string; category: 'current_status' | 'interest' | 'preference' | 'fact' | 'boundary' | 'plan';
  content: string; sourceNote: string; createdAt: string; updatedAt: string;
  /** Older records without origin are treated as manually maintained. */
  origin?: 'manual' | 'model';
  provider?: 'qwen' | 'compatible' | 'codex'; modelName?: string;
  sourceMessageIds?: string[]; sourceMessageHashes?: Record<string,string>;
}
export interface ContactBasisGeneration {
  facts: ContactBasisFact[]; sourceDigest: string; modelIdentity: string;
  provider: 'qwen' | 'compatible' | 'codex'; modelName: string; generatedAt: string;
  sourceMessageCount: number;
  usage?: {promptTokens:number;completionTokens:number;totalTokens:number};
}
export type ContactBasisGenerationMetadata = Omit<ContactBasisGeneration,'facts'|'usage'>;
export interface ContactMemoryEntry {
  id: string; kind: 'fact' | 'event' | 'preference' | 'openTopic'; text: string;
  sourceMessageIds: string[]; status: 'pending' | 'approved' | 'rejected'; createdAt: string;
  sourceMessageHashes?: Record<string,string>;
  /** Manual notes need no message provenance; model notes do. */
  origin?: 'manual' | 'model'; updatedAt?: string;
}
export interface ContactMemory {
  summary: string; entries: ContactMemoryEntry[]; openTopics: string[];
  modelRecapInvalidated?: boolean;
  summaryOrigin?: 'manual' | 'model'; summaryUpdatedAt?: string;
  openTopicsOrigin?: 'manual' | 'model'; openTopicsUpdatedAt?: string;
  throughSequence: number; sourceDigest: string;
  compressedMessageHashes?: Record<string,string>;
  provider: 'qwen' | 'compatible' | 'codex' | 'manual'; modelName: string; updatedAt: string;
}
export interface ContactInsights {
  conversationId: string; messageId: string;
  intents: {label: string; percentage: number}[];
  affinity: {score: number | null; confidence: number; evidence: string[]} | null;
  uncertainty: string; provider: 'qwen' | 'compatible' | 'codex'; modelName: string; analyzedAt: string;
  inputDigest?: string;
  /** Derived UI flag; saved evidence is retained when context has changed. */
  stale?: boolean;
  usage?: {promptTokens: number; completionTokens: number; totalTokens: number};
}
export interface ContactProcessing {
  /** Missing inherits global choices; an empty list uses the global primary model. */
  replyModels?: ReplyModelChoice[];
  autoRecognizeImages?: boolean;
  autoTranscribeVoice?: boolean;
  intentEnabled?: boolean; affinityEnabled?: boolean; memoryEnabled?: boolean;
  autoAnalyzeMessages?: boolean; autoCompressMemory?: boolean;
  analysisModel?: ReplyModelChoice; memoryModel?: ReplyModelChoice;
}
export interface Settings {
  autoReplyEnabled: boolean;
  autoReplyMode: AutoReplyMode;
  syncDraftsEnabled?: boolean;
  remoteManagementEnabled?: boolean;
  provider: Provider;
  modelUrl: string;
  modelName: string;
  apiKey: string;
  modelPreset?: 'custom' | 'qwen';
  modelThinkingEnabled?: boolean;
  vision?: VisionSettings;
  audio?: AudioSettings;
  analysis?: ContactModelSettings; memory?: ContactModelSettings;
  autoRecognizeImages?: boolean; autoTranscribeVoice?: boolean;
  replyModels?: ReplyModelChoice[];
  allowRemoteModel: boolean;
  replyDelaySeconds: number;
  cooldownSeconds: number;
  dailyLimit: number;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}
export interface Conversation {
  id: string; name: string; avatar: string; color: string;
  note: string; autoReplyEnabled: boolean; channel: 'simulator' | 'webhook' | 'wechat';
  externalId: string | null; createdAt: string; updatedAt: string;
  processing?: ContactProcessing;
  basisFacts?: ContactBasisFact[];
  basisGeneration?: ContactBasisGenerationMetadata;
  memory?: ContactMemory;
  wechat?: {
    enabled: boolean; initialized: boolean; cursor: string | null; accountFingerprint: string | null;
    lastCheckedAt: string | null; status: 'paused' | 'reading' | 'ready' | 'error'; detail: string;
    history?: {
      status:'pending'|'running'|'complete'|'error';cursor:string;offset:number;
      scanned:number;added:number;lastCheckedAt:string|null;detail:string;
      /** Private continuation for incremental paging; not part of cloud snapshots. */
      tail?:{cursor:string;offset:number};
    };
  };
}
export type MessageKind = 'text' | 'image' | 'voice' | 'video' | 'emoji' | 'file' | 'link' | 'system' | 'unknown';
export interface EmojiRecognition {
  tokens: {value: string; name: string; description: string}[];
  parserVersion: 'wechat-emoji-v2';
  recognizedAt: string;
}
export interface Message {
  id: string; conversationId: string; role: 'self' | 'peer' | 'system'; text: string;
  sentAt: string | null; sequence: number; source: 'demo' | 'import' | 'manual' | 'bridge' | 'auto' | 'wechat';
  externalId: string | null; aiAssisted: boolean;
  kind?: MessageKind; mediaStatus?: 'pending' | 'reviewed' | 'recognized'; sourceSequence?: string; sourceFingerprint?: string;
  imageAttachment?: ImageAttachment; imageRecognition?: ImageRecognition;
  imageRecognitionHistory?: ImageRecognitionCacheEntry[];
  wechatImage?: {localId?: string; md5?: string};
  wechatEmoji?: {localId?: string; md5?: string};
  /** A local dictionary describes glyphs; it does not infer the sender's feelings. */
  emojiRecognition?: EmojiRecognition;
  audioAttachment?: ImageAttachment;
  audioRecognition?: AudioRecognition;
  autoMediaEligible?: boolean;
  insights?: ContactInsights;
}
export interface ProfileClaim {
  id: string; category: 'preference' | 'style' | 'fact' | 'boundary';
  statement: string; status: 'pending' | 'approved' | 'rejected';
  evidenceIds: string[]; scope: string | null; createdAt: string;
}
export interface Draft {
  id: string; conversationId: string; basedOnMessageId: string; text: string;
  label: string; reason: string; createdAt: string; provider: Provider;
  profileVersion?: string | null; profileDigest?: string | null; modelName?: string; modelChoiceId?: string;
}
export interface LearnedProfile {
  version: string; digest: string; title: string; loadedAt: string;
  rules: {id: string; rule: string; limitation: string; evidenceIds: string[]}[];
  examples: {id: string; situation: string; reply: string; feedbackType: 'choice' | 'rewrite' | 'retained'}[];
  limitations: string[];
}
export interface DraftFeedback {
  id: string; requestId: string; conversationId: string; draftId: string; basedOnMessageId: string;
  originalText: string; revisedText: string; kind: 'kept' | 'edited'; reason: string;
  source: 'review' | 'send'; createdAt: string; profileVersion: string | null;
}
export interface CloudDraftBatch {
  id: string; conversationKey: string; conversationName: string; basedOnMessageId: string;
  createdAt: string; receivedAt: string; provider: Provider; profileVersion: string | null;
  drafts: {text: string; label: string; reason: string}[];
}
export interface DraftUpload {
  id: string; conversationId: string; draftIds: string[];
  destinationId?: string;
  status: 'uploading' | 'uploaded' | 'failed'; detail: string; createdAt: string; finishedAt: string | null;
}
export interface DraftSyncConnectionStatus {
  configured: boolean; uploadUrl: string; bindingId: string | null;
  source: 'saved' | 'disabled' | 'environment' | 'error'; error: string | null;
  verification: {
    supported: boolean; status: 'not_checked' | 'checking' | 'verified' | 'failed';
    checkedAt: string | null; device: {id: string; name: string} | null; error: string | null;
  };
}
export interface AutoJob {
  id: string; conversationId: string; messageId: string;
  status: 'queued' | 'generating' | 'drafted' | 'sent' | 'cancelled' | 'failed' | 'blocked';
  mode?: AutoReplyMode;
  dueAt: string; createdAt: string; finishedAt: string | null;
  detail: string; replyText: string | null;
}
export interface Activity {
  id: string; conversationId: string | null; kind: 'info' | 'success' | 'warning' | 'error';
  title: string; detail: string; createdAt: string;
}
export interface Knowledge {
  id: string; title: string; summary: string; application: string; limitation: string;
  url: string; author: string; year: number; kind: 'research' | 'principle';
}
export interface AppState {
  version: 1; settings: Settings; conversations: Conversation[]; messages: Message[];
  claims: ProfileClaim[]; drafts: Draft[]; jobs: AutoJob[]; activity: Activity[];
  learnedProfile?: LearnedProfile;
  feedback?: DraftFeedback[];
  cloudDrafts?: CloudDraftBatch[];
  draftUploads?: DraftUpload[];
  sendAttempts?: {id:string; conversationId:string; fingerprint:string; status:'sending'|'sent'|'unknown'; createdAt:string}[];
  imageTestRecognitionHistory?: ImageRecognitionCacheEntry[];
}
export interface PublicState extends Omit<AppState, 'settings' | 'messages' | 'imageTestRecognitionHistory'> {
  messages: Omit<Message, 'imageRecognitionHistory'>[];
  settings: Omit<Settings, 'apiKey' | 'vision' | 'audio' | 'analysis' | 'memory'> & { hasApiKey: boolean; vision?: Omit<VisionSettings, 'apiKey'> & {hasApiKey: boolean}; audio?: Omit<AudioSettings, 'apiKey'> & {hasApiKey: boolean}; analysis?: Omit<ContactModelSettings, 'apiKey'> & {hasApiKey: boolean}; memory?: Omit<ContactModelSettings, 'apiKey'> & {hasApiKey: boolean} };
  knowledge: Knowledge[];
  runtime: {
    channel: 'simulator' | 'webhook'; bridgeConfigured: boolean; autoRunning: boolean; modelLabel: string;
    bridgeReceiveConfigured: boolean; bridgeSendConfigured: boolean; learnedProfileError: string | null;
    codexAvailable: boolean; codexVersion: string | null; codexStatus: string;
    draftSyncConfigured: boolean; draftInboxConfigured: boolean;
    draftSyncConnection?: DraftSyncConnectionStatus;
    contactAnalysis?:{conversationId:string;feature:'analysis'|'memory'|'basis';total:number;processed:number;stage:'reading'|'summarizing'|'generating';updatedAt:string}[];
    historySync?: {status:'waiting'|'syncing'|'connected'|'error'|'disabled';detail:string;syncedAt:string|null};
    remoteManagement?: {status: 'disabled' | 'waiting' | 'connected' | 'error'; lastConnectedAt: string | null; detail: string};
    wechatAvailable: boolean; wechatStatus: string;
  };
}
export interface ImportInput {
  text: string; filename: string; selfId?: string; name?: string;
  format?: 'auto' | 'chatlab' | 'json' | 'csv' | 'text';
}
export interface ImportPreview {
  format: string; name: string; members: {id: string; name: string}[];
  messages: {role: Message['role']; text: string; sentAt: string | null; externalId: string | null; senderId?: string}[];
  warnings: string[]; fingerprint: string; needsSelfId: boolean;
}
