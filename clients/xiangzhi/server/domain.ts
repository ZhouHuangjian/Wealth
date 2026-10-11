import { randomUUID } from 'node:crypto';
import type { Activity, AppState, ImportInput, ImportPreview, Message, ProfileClaim } from '../shared/types.js';
import { hash, parseImport } from './import-parser.js';
import { Store } from './store.js';

export function addActivity(state: AppState, kind: Activity['kind'], title: string, detail: string, conversationId?: string): void {
  state.activity.unshift({ id: randomUUID(), kind, title, detail, conversationId: conversationId ?? null, createdAt: new Date().toISOString() });
  if (state.activity.length > 250) state.activity.length = 250;
}

export function seedDemo(store: Store): void {
  store.update((state) => {
    if (state.conversations.length || state.messages.length || state.claims.length || state.activity.some((item) => item.id === 'demo-seeded')) return;
    const now = new Date().toISOString();
    const chats = [
      {
        id: 'demo-lin', name: '林间', avatar: '林', color: '#b7c9b2', note: '完全虚构的演示联系人 · 聊聊日常与兴趣',
        lines: [
          ['peer', '今天走回家的路上，看到一片很好看的晚霞。'],
          ['self', '我喜欢散步时拍一些街景，尤其是傍晚。'],
          ['peer', '那你应该会喜欢我家附近那条小路。'],
          ['self', '我更喜欢安静一点的咖啡馆，可以慢慢聊天。'],
          ['peer', '记住了，那家店工作日还挺安静的。'],
          ['self', '我希望彼此有自己的节奏，不用每条消息都立刻回。'],
          ['peer', '最近工作有点忙，能这样慢慢聊天挺舒服的。'],
          ['self', '那就等你有空，我们再聊今天的小发现。'],
        ],
      },
      {
        id: 'demo-xia', name: '夏禾', avatar: '夏', color: '#d8bb9d', note: '完全虚构的演示联系人 · 练习倾听与回应',
        lines: [
          ['peer', '刚看完一部电影，结尾让我想了很久。'],
          ['self', '我喜欢听别人讲看完电影后的感受。'],
          ['peer', '不是很悲伤的故事，但有一点舍不得。'],
          ['self', '是故事里的人，还是结束以后那种安静的感觉？'],
          ['peer', '可能都有。我最近也在适应新的生活节奏。'],
          ['self', '我不喜欢急着给建议，更想先听明白。'],
          ['peer', '谢谢，先随便聊聊就好。'],
          ['self', '好，我在听。'],
        ],
      },
    ];
    for (const chat of chats) {
      state.conversations.push({ id: chat.id, name: chat.name, avatar: chat.avatar, color: chat.color, note: chat.note,
        autoReplyEnabled: false, channel: 'simulator', externalId: null, createdAt: now, updatedAt: now });
      chat.lines.forEach(([role, text], index) => state.messages.push({ id: `${chat.id}-${index + 1}`, conversationId: chat.id,
        role: role as Message['role'], text, sentAt: new Date(Date.now() - (chat.lines.length - index) * 3600000).toISOString(),
        sequence: index + 1, source: 'demo', externalId: null, aiAssisted: false }));
    }
    state.activity.unshift({ id: 'demo-seeded', conversationId: null, kind: 'info', title: '演示空间已准备',
      detail: '两位联系人与全部聊天均为虚构，未连接任何真实账号。', createdAt: now });
  });
}

export function previewImport(input: ImportInput): ImportPreview {
  const { conversationKey: _key, messages, ...preview } = parseImport(input);
  return { ...preview, messages: messages.map(({ aiAssisted: _assisted, ...message }) => message) };
}

export function commitImport(store: Store, input: ImportInput): { conversationId: string; added: number; duplicates: number; warnings: string[] } {
  const parsed = parseImport(input);
  if (parsed.needsSelfId) throw new Error('请先选择本人 ID，再确认导入。');
  const conversationId = `import-${hash(parsed.conversationKey).slice(0, 32)}`;
  let added = 0, duplicates = 0;
  const warnings = [...parsed.warnings];
  store.update((state) => {
    const now = new Date().toISOString();
    let conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      conversation = { id: conversationId, name: parsed.name, avatar: Array.from(parsed.name)[0] || '聊', color: '#c9c0df',
        note: `从 ${parsed.format} 历史记录导入 · 不触发自动回复`, autoReplyEnabled: false, channel: 'simulator',
        externalId: null, createdAt: now, updatedAt: now };
      state.conversations.push(conversation);
    }
    const existing = new Map(state.messages.filter((item) => item.conversationId === conversationId).map((item) => [item.id, item]));
    const newlyAssisted = new Set<string>();
    let sequence = Math.max(0, ...[...existing.values()].map((item) => item.sequence));
    parsed.messages.forEach((message, index) => {
      const identity = message.externalId === null ? `${parsed.fingerprint}:row:${index}` : `external:${message.externalId}`;
      const id = `msg-${hash(`${conversationId}:${identity}`).slice(0, 40)}`;
      const previous = existing.get(id);
      if (previous) {
        if (previous.text !== message.text || previous.role !== message.role || previous.sentAt !== message.sentAt) {
          throw new Error(`第 ${index + 1} 条消息的原始 ID 已存在，但内容、身份或时间冲突；整批未导入。`);
        }
        if (!previous.aiAssisted && message.aiAssisted) newlyAssisted.add(previous.id);
        previous.aiAssisted = previous.aiAssisted || message.aiAssisted;
        duplicates++;
        return;
      }
      const saved: Message = { id, conversationId, role: message.role, text: message.text, sentAt: message.sentAt,
        sequence: ++sequence, source: 'import', externalId: message.externalId, aiAssisted: message.aiAssisted };
      state.messages.push(saved);
      existing.set(id, saved);
      added++;
    });
    if (newlyAssisted.size) {
      state.claims = state.claims.filter((claim) => !claim.evidenceIds.some((id) => newlyAssisted.has(id)));
      warnings.push('新确认的 AI 辅助消息已退出本人样本，其关联候选档案已清除。');
    }
    conversation.updatedAt = now;
    addActivity(state, 'success', '历史记录已导入', `新增 ${added} 条，重复 ${duplicates} 条；未创建自动回复任务。`, conversationId);
  });
  return { conversationId, added, duplicates, warnings };
}

export function extractClaims(store: Store, conversationId: string): ProfileClaim[] {
  const created: ProfileClaim[] = [];
  store.update((state) => {
    if (!state.conversations.some((item) => item.id === conversationId)) throw new Error('会话不存在。');
    const candidates = state.messages.filter((message) => message.conversationId === conversationId && message.role === 'self' && !message.aiAssisted
      && (!message.kind || message.kind === 'text'));
    for (const message of candidates) {
      // This is a conservative literal-pattern extractor, not a personality assessment.
      if (/[“”"「」『』<>]|转发|引用|他说|她说|你说|如果|假如|假设|开玩笑|才怪/.test(message.text)) continue;
      for (const part of message.text.split(/[。！？\n]+/)) {
        const sentence = part.trim();
        if (sentence.length < 5 || sentence.length > 120 || /也许|可能|以前|曾经|过去|不再/.test(sentence)) continue;
        let category: ProfileClaim['category'] | null = null;
        if (/^我(?:最|更)?(?:喜欢|不喜欢|偏爱|讨厌).+/.test(sentence)) category = 'preference';
        else if (/^我(?:希望|不接受|不愿意).+/.test(sentence)) category = 'boundary';
        else if (/^我(?:住在|在.+工作|的职业是|是一名).+/.test(sentence)) category = 'fact';
        if (!category) continue;
        const statement = `本人曾明确表达：${sentence}`;
        const existing = state.claims.find((claim) => claim.scope === conversationId && claim.category === category && claim.statement === statement);
        if (existing) {
          if (!existing.evidenceIds.includes(message.id)) existing.evidenceIds.push(message.id);
          continue;
        }
        const claim: ProfileClaim = { id: randomUUID(), category, statement, status: 'pending', evidenceIds: [message.id], scope: conversationId, createdAt: new Date().toISOString() };
        state.claims.push(claim);
        created.push(claim);
      }
    }
    addActivity(state, 'info', '候选档案已整理', `新增 ${created.length} 项，均需本人审核。这是原话规则摘取，不是完整人格模型。`, conversationId);
  });
  return structuredClone(created);
}

export function deleteConversation(store: Store, id: string): void {
  store.update((state) => {
    if (!state.conversations.some((item) => item.id === id)) throw new Error('会话不存在。');
    const messageIds = new Set(state.messages.filter((item) => item.conversationId === id).map((item) => item.id));
    state.conversations = state.conversations.filter((item) => item.id !== id);
    state.messages = state.messages.filter((item) => item.conversationId !== id);
    // Conservative deletion also removes mixed-source claims: their text may contain deleted evidence.
    state.claims = state.claims.filter((item) => item.scope !== id && !item.evidenceIds.some((evidence) => messageIds.has(evidence)));
    state.drafts = state.drafts.filter((item) => item.conversationId !== id && !messageIds.has(item.basedOnMessageId));
    state.feedback = (state.feedback ?? []).filter((item) => item.conversationId !== id && !messageIds.has(item.basedOnMessageId));
    state.draftUploads = (state.draftUploads ?? []).filter(item => item.conversationId !== id);
    state.jobs = state.jobs.filter((item) => item.conversationId !== id && !messageIds.has(item.messageId));
    state.activity = state.activity.filter((item) => item.conversationId !== id);
    addActivity(state, 'info', '会话已删除', '该会话的消息、关联档案、草稿与任务记录已清除。');
  });
}
