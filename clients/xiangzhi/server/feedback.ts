import { randomUUID } from 'node:crypto';
import type { AppState, Draft, DraftFeedback } from '../shared/types.js';

export function recordDraftFeedback(state: AppState, draft: Draft, input: {
  requestId: string; text: string; reason?: string; source: DraftFeedback['source'];
}): {feedback: DraftFeedback; duplicate: boolean} {
  const entries = state.feedback ??= [];
  const reason = input.reason ?? '';
  const prior = entries.find(item => item.requestId === input.requestId && item.source === input.source);
  if (prior) {
    if (prior.conversationId !== draft.conversationId || prior.draftId !== draft.id || prior.revisedText !== input.text || prior.reason !== reason) {
      throw Object.assign(new Error('同一反馈标识不能用于不同的内容。'), {status:409});
    }
    return {feedback:prior, duplicate:true};
  }
  const feedback: DraftFeedback = {id:randomUUID(), requestId:input.requestId, conversationId:draft.conversationId,
    draftId:draft.id, basedOnMessageId:draft.basedOnMessageId, originalText:draft.text, revisedText:input.text,
    kind:draft.text === input.text ? 'kept' : 'edited', reason, source:input.source,
    createdAt:new Date().toISOString(), profileVersion:draft.profileVersion ?? null};
  entries.push(feedback);
  return {feedback, duplicate:false};
}
