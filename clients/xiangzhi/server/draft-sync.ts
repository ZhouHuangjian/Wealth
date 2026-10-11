import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloudDraftBatch, Conversation, Draft } from '../shared/types.js';
import { validateEndpoint } from './bridge.js';

export interface DraftSyncConfig { url: string; token: string; inboxToken: string }
export const draftSyncConfig = (): DraftSyncConfig => ({
  url: process.env.DRAFT_SYNC_URL ?? '',
  token: process.env.DRAFT_SYNC_TOKEN ?? '',
  inboxToken: process.env.DRAFT_INBOX_TOKEN ?? '',
});

export function isDraftSyncConfigured(config: DraftSyncConfig): boolean {
  if (config.token.length < 32 || !config.url) return false;
  try { validateEndpoint(config.url); return true; } catch { return false; }
}
export function isDraftInboxConfigured(config: DraftSyncConfig): boolean {
  return config.inboxToken.length >= 32;
}

const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);
const identifier = boundedText(300).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const cloudDraftBatchSchema = z.object({
  id: z.string().min(1).max(300).regex(/^[A-Za-z0-9_-]+$/),
  conversationKey: identifier,
  conversationName: boundedText(80),
  basedOnMessageId: identifier,
  createdAt: z.iso.datetime({offset: true}),
  provider: z.enum(['demo', 'ollama', 'compatible', 'codex']),
  profileVersion: boundedText(32).nullable(),
  drafts: z.array(z.object({text: boundedText(500), label: boundedText(40), reason: boundedText(300)}).strict()).min(1).max(3),
}).strict();

export type DraftBatchPayload = Omit<CloudDraftBatch, 'receivedAt'>;

export function buildDraftBatch(conversation: Conversation, drafts: Draft[]): DraftBatchPayload {
  const first = drafts[0];
  if (!first || drafts.length > 3 || new Set(drafts.map(draft => draft.id)).size !== drafts.length || drafts.some(draft =>
    !draft.id || draft.conversationId !== conversation.id || draft.basedOnMessageId !== first.basedOnMessageId ||
    draft.provider !== first.provider || (draft.profileVersion ?? null) !== (first.profileVersion ?? null) ||
    (draft.profileDigest ?? null) !== (first.profileDigest ?? null) || !z.iso.datetime({offset: true}).safeParse(draft.createdAt).success)) {
    throw new Error('草稿必须来自同一会话、同一条来信和同一次档案配置，每批最多三条。');
  }
  // Select only the delivery fields: no source messages, profile contents or connection credentials.
  const packet = {
    conversationKey: conversation.id,
    conversationName: conversation.name,
    basedOnMessageId: first.basedOnMessageId,
    createdAt: new Date(Math.min(...drafts.map(draft => Date.parse(draft.createdAt)))).toISOString(),
    provider: first.provider,
    profileVersion: first.profileVersion ?? null,
    drafts: drafts.map(({text, label, reason}) => ({text, label, reason})),
  };
  const id = createHash('sha256').update(JSON.stringify({packet, draftIds: drafts.map(draft => draft.id)})).digest('hex');
  const parsed = cloudDraftBatchSchema.safeParse({id, ...packet});
  if (!parsed.success) throw new Error('草稿批次内容不完整或超出同步长度限制。');
  return parsed.data;
}

class DraftSyncError extends Error {}
const MAX_ACK_BYTES = 8 * 1024;

async function readAcknowledgement(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > MAX_ACK_BYTES) {
    await response.body?.cancel();
    throw new DraftSyncError('服务器确认内容过大，未能确认草稿同步结果。');
  }
  if (!response.body) throw new DraftSyncError('服务器未返回有效的草稿同步确认。');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ACK_BYTES) {
        await reader.cancel();
        throw new DraftSyncError('服务器确认内容过大，未能确认草稿同步结果。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DraftSyncError('服务器未返回有效的草稿同步确认。'); }
}

export async function uploadDraftBatch(config: DraftSyncConfig, batch: DraftBatchPayload, signal?: AbortSignal): Promise<{id: string; duplicate: boolean}> {
  if (!isDraftSyncConfigured(config)) throw new Error('草稿同步尚未配置，请检查 HTTPS 地址和同步令牌。');
  const parsed = cloudDraftBatchSchema.safeParse(batch);
  if (!parsed.success) throw new Error('草稿批次格式不正确，未发送至服务器。');
  const timeoutSignal = AbortSignal.timeout(10_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await fetch(validateEndpoint(config.url), {
      method: 'POST', redirect: 'error',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`, 'Idempotency-Key': parsed.data.id},
      body: JSON.stringify(parsed.data), signal: combinedSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DraftSyncError(`服务器返回 HTTP ${response.status}，未能确认草稿同步结果。`);
    }
    const acknowledgement = await readAcknowledgement(response);
    if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
      throw new DraftSyncError('服务器未返回有效的草稿同步确认。');
    }
    const ack = acknowledgement as Record<string, unknown>;
    if (ack.ok !== true || ack.id !== parsed.data.id || (ack.duplicate !== undefined && typeof ack.duplicate !== 'boolean')) {
      throw new DraftSyncError('服务器未确认对应的草稿批次，请核对服务器记录。');
    }
    return {id: parsed.data.id, duplicate: ack.duplicate === true};
  } catch (error) {
    if (error instanceof DraftSyncError) throw error;
    if (signal?.aborted) throw new Error('草稿同步已取消；如请求已经发出，请核对服务器记录。');
    if (timeoutSignal.aborted) throw new Error('草稿同步超时，请核对服务器记录，系统不会自动重试。');
    throw new Error('草稿同步连接失败，请核对服务器记录，系统不会自动重试。');
  }
}
