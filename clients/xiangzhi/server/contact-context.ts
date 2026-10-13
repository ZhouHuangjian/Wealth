import type { AppState, ContactMemoryEntry, Conversation, Message } from '../shared/types.js';
import { safeContextText } from './contact-model.js';
import { messageEvidenceHash } from './contact-evidence.js';

export function scopedConversation(state: AppState, conversationId: string): Conversation {
  const conversation = state.conversations.find(value => value.id === conversationId);
  if (!conversation) throw new Error('会话不存在。');
  return conversation;
}

export function scopedMessages(state: AppState, conversationId: string): Message[] {
  return state.messages.filter(message => message.conversationId === conversationId && message.role !== 'system')
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export function messageObservation(message: Message, maximum = 1400) {
  return {id: message.id, sequence: message.sequence, speaker: message.role, sentAt: message.sentAt,
    text: safeContextText(message.text, maximum), kind: message.kind ?? 'text',
    ...(message.kind === 'image' && message.mediaStatus === 'recognized' && message.imageRecognition ? {imageObservation: {
      summary: safeContextText(message.imageRecognition.summary, 600),
      visibleText: safeContextText(message.imageRecognition.visibleText, 600),
      facts: message.imageRecognition.facts.slice(0, 6).map(value => safeContextText(value, 200)),
      uncertain: true,
    }} : {}),
    ...(message.kind === 'voice' && message.mediaStatus === 'recognized' && message.audioRecognition ? {
      voiceTranscript: safeContextText(message.audioRecognition.text, 1000), uncertain: true,
    } : {}),
  };
}

export function contactBasisContext(conversation: Conversation) {
  return (conversation.basisFacts ?? []).slice(-12).map(fact => ({id: fact.id, category: fact.category,
    content: safeContextText(fact.content, 300), sourceNote: safeContextText(fact.sourceNote, 160),
    source: '用户手动提供，仅是沟通背景，不是已核实的人格或心理特征'}));
}

export function validMemoryEntries(state: AppState, conversation: Conversation, throughSequence: number): ContactMemoryEntry[] {
  const allowed = new Map(scopedMessages(state, conversation.id).filter(message => message.sequence <= throughSequence).map(message => [message.id, message]));
  return (conversation.memory?.entries ?? []).filter(entry => entry.status !== 'rejected'
    && entry.sourceMessageIds.length > 0 && entry.sourceMessageIds.every(id => {
      const message = allowed.get(id);
      return message && entry.sourceMessageHashes?.[id] === messageEvidenceHash(message);
    }));
}

export function memoryContext(state: AppState, conversation: Conversation, throughSequence: number) {
  const memory = conversation.memory;
  // A later compressed summary must never leak into an earlier sentence analysis.
  if (conversation.processing?.memoryEnabled !== true || !memory || memory.throughSequence > throughSequence) return null;
  const all = new Map(scopedMessages(state, conversation.id).map(message => [message.id, message]));
  const processed = Object.entries(memory.compressedMessageHashes ?? {});
  // Sequence numbers may shift after an older WeChat message arrives. Stable
  // source IDs still identify which later facts must stay out of an earlier view.
  if (processed.some(([id]) => (all.get(id)?.sequence ?? 0) > throughSequence)) return null;
  const entries = validMemoryEntries(state, conversation, throughSequence);
  // A summary has no per-clause provenance; omit it if any retained source is invalid.
  const validSummary = memory.entries.length === entries.length && processed.every(([id,hash]) => {
    const message = all.get(id); return message && messageEvidenceHash(message) === hash;
  });
  return {summary: validSummary ? safeContextText(memory.summary, 1200) : '',
    entries: entries.slice(-24).map(entry => ({kind: entry.kind, text: safeContextText(entry.text, 300),
      sourceMessageIds: entry.sourceMessageIds.slice(0, 12), confirmedByUser: entry.status === 'approved'})),
    openTopics: validSummary ? memory.openTopics.slice(0, 8).map(value => safeContextText(value, 200)) : [],
    throughSequence: memory.throughSequence, uncertain: true};
}

/** Keep chronological continuity while imposing a byte limit, rather than skipping older uncompressed messages. */
export function boundedMessageBatch(messages: Message[], count: number, bytes = 55_000): Message[] {
  const selected: Message[] = [];
  let totalBytes = 0;
  for (const message of messages.slice(0, count)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(messageObservation(message))) + 1;
    if (selected.length && totalBytes + itemBytes > bytes) break;
    selected.push(message); totalBytes += itemBytes;
  }
  return selected;
}
