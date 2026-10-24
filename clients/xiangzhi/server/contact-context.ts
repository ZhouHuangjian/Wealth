import type { AppState, ContactMemoryEntry, Conversation, Message } from '../shared/types.js';
import { safeContextText } from './contact-model.js';
import { messageEvidenceHash } from './contact-evidence.js';
import {messageEmojiRecognition} from '../shared/emoji.js';

function recentContextPriority<T extends {origin?: 'manual' | 'model'; createdAt: string; updatedAt?: string}>(
  items: T[], legacyOrigin: 'manual' | 'model',
): T[] {
  const time = (item: T) => {const timestamp = Date.parse(item.updatedAt || item.createdAt); return Number.isFinite(timestamp) ? timestamp : 0;};
  // Return a new list: automatic generation must not reorder the user's stored library.
  return items.slice().sort((a, b) => Number((a.origin ?? legacyOrigin) === 'manual') - Number((b.origin ?? legacyOrigin) === 'manual')
    || time(a) - time(b));
}

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
  const emoji=messageEmojiRecognition(message);
  return {id: message.id, sequence: message.sequence, speaker: message.role, sentAt: message.sentAt,
    text: safeContextText(message.text, maximum), kind: message.kind ?? 'text',
    ...(emoji?{emojiObservation:{tokens:emoji.tokens.slice(0,16),source:'本地图形字典，不是心理或意图推断',uncertain:true}}:{}),
    ...((message.kind === 'image'||message.kind==='emoji') && message.mediaStatus === 'recognized' && message.imageRecognition ? {imageObservation: {
      summary: safeContextText(message.imageRecognition.summary, 600),
      visibleText: safeContextText(message.imageRecognition.visibleText, 600),
      facts: message.imageRecognition.facts.slice(0, 6).map(value => safeContextText(value, 200)),
      uncertain: true,
      ...(message.kind==='emoji'?{isSticker:true,source:'表情包画面与文字，不能当作已确认事实或真实情绪'}:{}),
    }} : {}),
    ...(message.kind === 'voice' && message.mediaStatus === 'recognized' && message.audioRecognition ? {
      voiceTranscript: safeContextText(message.audioRecognition.text, 1000), uncertain: true,
    } : {}),
  };
}

/** Model extraction is only usable while its message evidence is current and scoped. */
export function validContactBasisFacts(conversation: Conversation, state?: AppState, throughSequence = Infinity) {
  const allowed = new Map((state ? scopedMessages(state, conversation.id) : [])
    .filter(message => message.sequence <= throughSequence).map(message => [message.id, message]));
  return recentContextPriority((conversation.basisFacts ?? []).filter(fact => fact.origin !== 'model' || !!fact.sourceMessageIds?.length
    && fact.sourceMessageIds.every(id => {
      const source = allowed.get(id);
      return source && fact.sourceMessageHashes?.[id] === messageEvidenceHash(source);
    })), 'manual');
}

export function contactBasisContext(conversation: Conversation, state?: AppState, throughSequence = Infinity) {
  return validContactBasisFacts(conversation, state, throughSequence).slice(-12).map(fact => ({id: fact.id, category: fact.category,
    content: safeContextText(fact.content, 300), sourceNote: safeContextText(fact.sourceNote, 160),
    origin: fact.origin === 'model' ? 'model' : 'manual',
    source: fact.origin === 'model' ? '模型从当前会话提取的未确认背景，可能误解，不是用户手动确认'
      : '用户手动提供，仅是沟通背景，不是已核实的人格或心理特征', uncertain: true}));
}

export function validMemoryEntries(state: AppState, conversation: Conversation, throughSequence: number): ContactMemoryEntry[] {
  const allowed = new Map(scopedMessages(state, conversation.id).filter(message => message.sequence <= throughSequence).map(message => [message.id, message]));
  return recentContextPriority((conversation.memory?.entries ?? []).filter(entry => entry.status !== 'rejected'
    && (entry.origin === 'manual' || entry.sourceMessageIds.length > 0 && [...entry.sourceMessageIds,...(entry.event?.resolvedByMessageIds??[])].every(id => {
      const message = allowed.get(id);
      return message && entry.sourceMessageHashes?.[id] === messageEvidenceHash(message);
    }))), 'model');
}

/** Manual notes cannot establish the provenance of an older model-generated recap. */
export function currentModelMemoryRecap(state: AppState, conversation: Conversation, throughSequence = Infinity): boolean {
  const memory = conversation.memory;
  if (!memory || memory.modelRecapInvalidated) return false;
  const processed = Object.entries(memory.compressedMessageHashes ?? {});
  const all = new Map(scopedMessages(state, conversation.id).filter(message => message.sequence <= throughSequence).map(message => [message.id, message]));
  const entries = validMemoryEntries(state, conversation, throughSequence);
  const validModelEntries = new Set(entries.filter(entry => entry.origin !== 'manual'));
  return !memory.entries.some(entry => entry.status === 'rejected'
    || entry.origin !== 'manual' && !validModelEntries.has(entry))
    && !(memory.entries.some(entry => entry.origin === 'manual') && !processed.length)
    && processed.every(([id, hash]) => {const source = all.get(id); return source && messageEvidenceHash(source) === hash;});
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
  const validSummary = currentModelMemoryRecap(state, conversation, throughSequence);
  const manualSummary = memory.summaryOrigin === 'manual', manualTopics = memory.openTopicsOrigin === 'manual';
  return {summary: manualSummary || validSummary ? safeContextText(memory.summary, 1200) : '',
    summarySource: manualSummary ? '用户补充回顾，作为沟通背景，不是已发生事实的认证' : '模型未确认回顾',
    entries: entries.slice(-24).map(entry => ({kind: entry.kind, text: safeContextText(entry.text, 300),
      sourceMessageIds: entry.origin === 'manual' ? [] : entry.sourceMessageIds.slice(0, 12), confirmedByUser: entry.status === 'approved',
      ...(entry.event?{event:entry.event}:{}),origin: entry.origin === 'manual' ? 'manual' : 'model', source: entry.origin === 'manual' ? '用户补充，仅作当前联系人背景' : '模型整理的会话记忆'})),
    openTopics: manualTopics || validSummary ? memory.openTopics.slice(0, 8).map(value => safeContextText(value, 200)) : [],
    openTopicsSource: manualTopics ? '用户补充的未完话题' : '模型未确认的未完话题',
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
