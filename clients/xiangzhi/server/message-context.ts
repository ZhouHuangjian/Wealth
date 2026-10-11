import type { AppState, Message } from '../shared/types.js';

// Use exactly the same ordered window for generation, media checks and invalidation.
export function recentConversationMessages(state: AppState, conversationId: string): Message[] {
  return state.messages.filter(message => message.conversationId === conversationId)
    .sort((a, b) => a.sequence - b.sequence).slice(-20);
}

export function pendingMediaMessages(state: AppState, conversationId: string): Message[] {
  return recentConversationMessages(state, conversationId).filter(message => message.mediaStatus === 'pending');
}

export function assertReplyContextReady(state: AppState, conversationId: string): void {
  // Drafts remain reviewable with media placeholders; only sending needs this gate.
  if (state.settings.autoReplyMode !== 'send') return;
  const pending = pendingMediaMessages(state, conversationId);
  if (pending.length) throw new Error(`最近的对话中有 ${pending.length} 条图片、语音或其他内容尚未查看。请先在微信中查看，必要时补充文字说明，并标记为已查看后再生成回复。`);
}
