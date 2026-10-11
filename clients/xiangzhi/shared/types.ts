export type Provider = 'demo' | 'ollama' | 'compatible' | 'codex';
export type AutoReplyMode = 'draft' | 'send';
export interface Settings {
  autoReplyEnabled: boolean;
  autoReplyMode: AutoReplyMode;
  syncDraftsEnabled?: boolean;
  remoteManagementEnabled?: boolean;
  provider: Provider;
  modelUrl: string;
  modelName: string;
  apiKey: string;
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
  wechat?: {
    enabled: boolean; initialized: boolean; cursor: string | null; accountFingerprint: string | null;
    lastCheckedAt: string | null; status: 'paused' | 'reading' | 'ready' | 'error'; detail: string;
  };
}
export type MessageKind = 'text' | 'image' | 'voice' | 'video' | 'emoji' | 'file' | 'link' | 'system' | 'unknown';
export interface Message {
  id: string; conversationId: string; role: 'self' | 'peer' | 'system'; text: string;
  sentAt: string | null; sequence: number; source: 'demo' | 'import' | 'manual' | 'bridge' | 'auto' | 'wechat';
  externalId: string | null; aiAssisted: boolean;
  kind?: MessageKind; mediaStatus?: 'pending' | 'reviewed'; sourceSequence?: string; sourceFingerprint?: string;
}
export interface ProfileClaim {
  id: string; category: 'preference' | 'style' | 'fact' | 'boundary';
  statement: string; status: 'pending' | 'approved' | 'rejected';
  evidenceIds: string[]; scope: string | null; createdAt: string;
}
export interface Draft {
  id: string; conversationId: string; basedOnMessageId: string; text: string;
  label: string; reason: string; createdAt: string; provider: Provider;
  profileVersion?: string | null; profileDigest?: string | null;
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
}
export interface PublicState extends Omit<AppState, 'settings'> {
  settings: Omit<Settings, 'apiKey'> & { hasApiKey: boolean };
  knowledge: Knowledge[];
  runtime: {
    channel: 'simulator' | 'webhook'; bridgeConfigured: boolean; autoRunning: boolean; modelLabel: string;
    bridgeReceiveConfigured: boolean; bridgeSendConfigured: boolean; learnedProfileError: string | null;
    codexAvailable: boolean; codexVersion: string | null; codexStatus: string;
    draftSyncConfigured: boolean; draftInboxConfigured: boolean;
    draftSyncConnection?: DraftSyncConnectionStatus;
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
