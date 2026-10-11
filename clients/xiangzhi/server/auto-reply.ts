import { randomUUID } from 'node:crypto';
import type { AppState, AutoJob, Conversation, Settings } from '../shared/types.js';
import { generateDrafts, hasStopContactRequest, latestConversationMessage } from './generation.js';
import { assertReplyContextReady, recentConversationMessages } from './message-context.js';

interface StateStore { read(): AppState; update(fn: (state: AppState) => void): unknown }
interface Sender { send(conversation: Conversation, text: string, idempotencyKey: string, signal: AbortSignal): Promise<void | string> }
interface EngineOptions { now?: () => number; generate?: typeof generateDrafts; intervalMs?: number; onDrafts?: (conversationId: string) => Promise<void> }
const ACTIVE = new Set<AutoJob['status']>(['queued', 'generating']);
const LIVE_SOURCES = new Set(['manual', 'bridge', 'demo', 'wechat']);
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;

function shanghaiDay(timestamp: number): string { return new Date(timestamp + SHANGHAI_OFFSET).toISOString().slice(0, 10); }
function nextMidnight(timestamp: number): number {
  const local = new Date(timestamp + SHANGHAI_OFFSET);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - SHANGHAI_OFFSET;
}
function quietEndAt(settings: Settings, timestamp: number): number | null {
  if (!settings.quietHoursEnabled) return null;
  const parse = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match || +match[1] > 23 || +match[2] > 59) return null;
    return +match[1] * 60 + +match[2];
  };
  const start = parse(settings.quietStart), end = parse(settings.quietEnd);
  if (start === null || end === null || start === end) return timestamp + 24 * 60 * 60 * 1000;
  const local = new Date(timestamp + SHANGHAI_OFFSET);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const quiet = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!quiet) return null;
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - SHANGHAI_OFFSET;
  return midnight + end * 60_000 + (start > end && minutes >= start ? 86_400_000 : 0);
}
function modelFingerprint(settings: Settings): string {
  return JSON.stringify([settings.provider, settings.modelUrl, settings.modelName, settings.apiKey, settings.allowRemoteModel]);
}
// Any reviewed context change invalidates a response still being generated.
export function replyContextFingerprint(state: AppState, conversationId: string): string {
  const conversation = state.conversations.find(item => item.id === conversationId);
  // Poll status and timestamps change without changing the context a reply uses.
  const configuration = conversation ? {
    id: conversation.id, name: conversation.name, note: conversation.note, channel: conversation.channel,
    externalId: conversation.externalId, autoReplyEnabled: conversation.autoReplyEnabled,
    wechat: conversation.wechat ? {enabled: conversation.wechat.enabled, accountFingerprint: conversation.wechat.accountFingerprint} : null,
  } : null;
  return JSON.stringify([modelFingerprint(state.settings), state.learnedProfile?.digest ?? null,
    state.claims, state.feedback?.filter(item => item.conversationId === conversationId) ?? [],
    configuration,
    recentConversationMessages(state, conversationId).map(message => [message.id, message.sequence, message.role, message.text,
      message.kind ?? 'text', message.mediaStatus ?? null])]);
}

function mediaBlockReason(state: AppState, conversationId: string): string | null {
  try { assertReplyContextReady(state, conversationId); return null; }
  catch (error) { return error instanceof Error ? error.message : '请先查看待确认消息，再生成回复。'; }
}

export class AutoReplyEngine {
  private readonly now: () => number;
  private readonly generate: typeof generateDrafts;
  private readonly intervalMs: number;
  private readonly onDrafts?: EngineOptions['onDrafts'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningTick: Promise<void> | null = null;
  private controllers = new Map<string, AbortController>();
  private sending = new Set<string>();

  constructor(private readonly store: StateStore, private readonly sender: Sender, options: EngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.generate = options.generate ?? generateDrafts;
    this.intervalMs = options.intervalMs ?? 500;
    this.onDrafts = options.onDrafts;
    // A previous process may have submitted a send before stopping. Never retry it automatically.
    if (store.read().jobs.some(job => job.status === 'generating')) store.update(state => {
      for (const job of state.jobs.filter(job => job.status === 'generating')) {
        job.status = 'failed'; job.finishedAt = this.iso();
        job.detail = '上次运行中断，处理或发送结果未确认；不会自动重试。';
        this.activity(state, job.conversationId, 'warning', '任务中断', job.detail);
      }
    });
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
  private activity(state: AppState, conversationId: string | null, kind: 'info' | 'success' | 'warning' | 'error', title: string, detail: string): void {
    state.activity.unshift({id: randomUUID(), conversationId, kind, title, detail, createdAt: this.iso()});
    state.activity = state.activity.slice(0, 300);
  }
  private cancelJobs(detail: string, conversationId?: string): void {
    const matches = this.store.read().jobs.filter(job => ACTIVE.has(job.status) && (!conversationId || job.conversationId === conversationId));
    if (!matches.length) return;
    const ids = new Set(matches.map(job => job.id));
    for (const id of ids) this.controllers.get(id)?.abort();
    this.store.update(state => {
      for (const job of state.jobs.filter(job => ids.has(job.id) && ACTIVE.has(job.status))) {
        job.status = 'cancelled'; job.finishedAt = this.iso(); job.detail = detail;
        this.activity(state, job.conversationId, 'info', '自动回复已取消', detail);
      }
    });
  }

  enqueue(conversationId: string, messageId: string): void {
    const state = this.store.read();
    const latest = latestConversationMessage(state, conversationId);
    // An old duplicate delivery must not cancel the newer job already waiting.
    if (latest?.id !== messageId) return;
    if (state.jobs.some(job => job.conversationId === conversationId && job.messageId === messageId)) return;
    this.cancelJobs('会话出现更新，旧任务已撤销。', conversationId);
    const conversation = state.conversations.find(item => item.id === conversationId);
    if (!state.settings.autoReplyEnabled || !conversation?.autoReplyEnabled || latest.role !== 'peer' || !LIVE_SOURCES.has(latest.source)) return;
    const blocked = mediaBlockReason(state, conversationId)
      ?? (state.settings.autoReplyMode === 'send' && conversation.channel === 'wechat' ? '微信采集通道只接收消息，请使用生成草稿模式；不会自动发送。'
      : state.settings.autoReplyMode === 'send' && hasStopContactRequest(latest.text) ? '对方明确要求停止联系，自动回复已阻止。'
      : state.settings.autoReplyMode === 'send' && conversation.channel === 'webhook' && state.settings.provider === 'demo' ? '演示规则不能用于真实通道自动发送，请先配置真实模型。' : null);
    this.store.update(current => {
      current.jobs.push({id: randomUUID(), conversationId, messageId, mode: current.settings.autoReplyMode, status: blocked ? 'blocked' : 'queued',
        dueAt: new Date(this.now() + Math.max(0, current.settings.replyDelaySeconds) * 1000).toISOString(),
        createdAt: this.iso(), finishedAt: blocked ? this.iso() : null, detail: blocked ?? '等待回复延迟结束。', replyText: null});
      this.activity(current, conversationId, blocked ? 'warning' : 'info', blocked ? '自动回复已阻止' : '自动回复已排队', blocked ?? '仅处理当前联系人最新收到的实时消息。');
    });
  }

  pause(): void {
    this.store.update(state => { state.settings.autoReplyEnabled = false; });
    this.cancelJobs('全局自动回复已暂停。');
  }
  conversationChanged(id: string): void { this.cancelJobs('联系人设置或会话内容已更新，旧任务已撤销。', id); }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => { /* Job errors are recorded by runJob. */ }); }, this.intervalMs);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelJobs('自动回复引擎已停止。');
  }
  tick(): Promise<void> {
    if (this.runningTick) return this.runningTick;
    this.runningTick = this.runTick().finally(() => { this.runningTick = null; });
    return this.runningTick;
  }

  private finish(id: string, status: 'cancelled' | 'failed' | 'blocked', detail: string): void {
    this.store.update(state => {
      const job = state.jobs.find(item => item.id === id);
      if (!job || job.status === 'sent' || job.status === 'drafted' || (!ACTIVE.has(job.status) && status !== 'failed')) return;
      job.status = status; job.detail = detail; job.finishedAt = this.iso();
      this.activity(state, job.conversationId, status === 'failed' ? 'error' : status === 'blocked' ? 'warning' : 'info',
        status === 'failed' ? '自动回复失败' : status === 'blocked' ? '自动回复已阻止' : '自动回复已取消', detail);
    });
  }

  private check(jobId: string): {state: AppState; job: AutoJob; conversation: Conversation} | null {
    const state = this.store.read();
    const job = state.jobs.find(item => item.id === jobId);
    if (!job || !ACTIVE.has(job.status)) return null;
    const conversation = state.conversations.find(item => item.id === job.conversationId);
    if (!state.settings.autoReplyEnabled || !conversation?.autoReplyEnabled) {
      this.finish(jobId, 'cancelled', '全局或该联系人自动回复已关闭。'); return null;
    }
    if (job.mode !== state.settings.autoReplyMode) {
      this.finish(jobId, 'cancelled', '自动处理模式已改变，旧任务已撤销。'); return null;
    }
    const latest = latestConversationMessage(state, job.conversationId);
    if (latest?.id !== job.messageId || latest.role !== 'peer' || !LIVE_SOURCES.has(latest.source)) {
      this.finish(jobId, 'cancelled', '最新消息已经改变，旧回复不会发送。'); return null;
    }
    const mediaReason = mediaBlockReason(state, job.conversationId);
    if (mediaReason) {
      this.finish(jobId, 'blocked', mediaReason); return null;
    }
    if (job.mode === 'send' && conversation.channel === 'wechat') {
      this.finish(jobId, 'blocked', '微信采集通道只接收消息，请使用生成草稿模式；不会自动发送。'); return null;
    }
    if (job.mode === 'send' && hasStopContactRequest(latest.text)) {
      this.finish(jobId, 'blocked', '对方明确要求停止联系，自动回复已阻止。'); return null;
    }
    if (job.mode === 'send' && conversation.channel === 'webhook' && state.settings.provider === 'demo') {
      this.finish(jobId, 'blocked', '演示规则不能用于真实通道自动发送。'); return null;
    }
    // Draft generation does not contact anyone, so sending schedules and quotas
    // should not delay the user's review of a newly received message.
    if (job.mode === 'draft') return {state, job, conversation};
    const now = this.now();
    const sent = state.jobs.filter(item => item.conversationId === job.conversationId && item.status === 'sent' && item.finishedAt);
    const lastSent = sent.reduce((last, item) => Math.max(last, Date.parse(item.finishedAt!)), -Infinity);
    let due = now;
    let reason = '';
    const quiet = quietEndAt(state.settings, now);
    if (quiet !== null) { due = quiet; reason = '当前处于静默时间，等待结束后重新检查。'; }
    const cooldown = lastSent + Math.max(0, state.settings.cooldownSeconds) * 1000;
    if (cooldown > due) { due = cooldown; reason = '该联系人仍在冷却时间内。'; }
    const todayCount = sent.filter(item => shanghaiDay(Date.parse(item.finishedAt!)) === shanghaiDay(now)).length;
    if (todayCount >= state.settings.dailyLimit) {
      due = Math.max(due, nextMidnight(now)); reason = '该联系人今日自动回复已达上限，明天重新检查。';
    }
    if (due > now) {
      this.store.update(current => {
        const pending = current.jobs.find(item => item.id === jobId);
        if (pending && ACTIVE.has(pending.status)) { pending.status = 'queued'; pending.dueAt = new Date(due).toISOString(); pending.detail = reason; }
      });
      return null;
    }
    return {state, job, conversation};
  }

  private async runTick(): Promise<void> {
    if (!this.store.read().settings.autoReplyEnabled) { this.cancelJobs('全局自动回复已关闭。'); return; }
    // Drain due jobs serially; a cancelled generation can never race another send.
    while (true) {
      const job = this.store.read().jobs.filter(item => item.status === 'queued' && Date.parse(item.dueAt) <= this.now())
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
      if (!job) break;
      await this.runJob(job.id);
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const initial = this.check(jobId);
    if (!initial) return;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    this.store.update(state => {
      const job = state.jobs.find(item => item.id === jobId)!;
      job.status = 'generating'; job.detail = job.mode === 'draft' ? '正在生成草稿，完成后等待你确认。' : '正在生成回复，发送前会再次检查开关和最新消息。';
    });
    try {
      const drafts = await this.generate(initial.state, initial.conversation.id, '自然回应对方最新消息，尊重对方界限。', controller.signal);
      if (controller.signal.aborted) return;
      const current = this.check(jobId);
      if (!current) return;
      if (replyContextFingerprint(current.state, current.conversation.id) !== replyContextFingerprint(initial.state, initial.conversation.id)) {
        this.finish(jobId, 'cancelled', '对话内容、媒体查看状态、档案、反馈或配置已变化，请重新生成。'); return;
      }
      const draft = drafts[0];
      if (!draft || drafts.some(item => item.conversationId !== current.conversation.id || item.basedOnMessageId !== current.job.messageId
          || !item.text.trim() || item.text.length > 500) || (current.job.mode === 'send' && current.conversation.channel === 'webhook' && draft.provider === 'demo')) {
        this.finish(jobId, 'failed', '生成结果无效或不属于当前消息，没有发送。'); return;
      }
      this.store.update(state => {
        state.drafts = [...drafts, ...state.drafts.filter(item => item.conversationId !== current.conversation.id)].slice(0, 200);
        const job = state.jobs.find(item => item.id === jobId)!;
        job.replyText = draft.text;
        if (job.mode === 'draft') {
          job.status = 'drafted'; job.finishedAt = this.iso(); job.detail = '草稿已生成，等待你审阅并手动发送。';
          this.activity(state, job.conversationId, 'success', '自动草稿已就绪', job.detail);
        } else job.detail = current.conversation.channel === 'simulator' ? '正在写入模拟器。' : '正在提交真实桥接，结果确认前不会重试。';
      });
      // This branch must terminate before sender invocation or self-message insertion.
      if (current.job.mode === 'draft') {
        // Upload failures never discard local drafts or promote them to messages.
        await this.onDrafts?.(current.conversation.id).catch(() => {});
        return;
      }
      controller.signal.throwIfAborted();
      this.sending.add(jobId);
      const receipt = await this.sender.send(current.conversation, draft.text, `auto:${jobId}`, controller.signal);
      // Record an acknowledged send even if a pause arrived while the adapter was awaiting its response.
      this.store.update(state => {
        const job = state.jobs.find(item => item.id === jobId);
        if (!job || job.status === 'sent') return;
        job.status = 'sent'; job.finishedAt = this.iso();
        job.detail = current.conversation.channel === 'simulator'
          ? '模拟发送完成，仅写入本地会话，没有向微信发送。'
          : '真实桥接接口已确认接收；不代表对方已读。';
        const externalId = typeof receipt === 'string' && receipt.length > 0 ? receipt : null;
        const echoed = externalId ? state.messages.find(message => message.conversationId === job.conversationId
          && message.role === 'self' && message.externalId === externalId) : undefined;
        if (echoed) {
          // An inbound bridge echo can arrive before its outbound HTTP acknowledgement.
          // Reconcile its provenance so generated text never becomes a self-style sample.
          echoed.aiAssisted = true;
          echoed.source = 'auto';
        } else {
          const sequence = state.messages.reduce((max, message) => Math.max(max, message.sequence), 0) + 1;
          state.messages.push({id: randomUUID(), conversationId: job.conversationId, role: 'self', text: draft.text,
            sentAt: this.iso(), sequence, source: 'auto', externalId, aiAssisted: true});
        }
        const conversation = state.conversations.find(item => item.id === job.conversationId);
        if (conversation) conversation.updatedAt = this.iso();
        state.drafts = state.drafts.filter(item => item.conversationId !== job.conversationId);
        this.activity(state, job.conversationId, 'success', current.conversation.channel === 'simulator' ? '模拟自动回复完成' : '桥接已确认自动回复', job.detail);
      });
    } catch (error) {
      if (this.sending.has(jobId)) {
        this.finish(jobId, 'failed', '发送结果未确认，可能已经提交；为避免重复，不会自动重试。');
      } else if (!controller.signal.aborted) {
        // Provider errors are intentionally not logged with request headers, keys, or remote response bodies.
        this.finish(jobId, 'failed', error instanceof Error ? error.message : '生成失败，没有发送。');
      }
    } finally { this.controllers.delete(jobId); this.sending.delete(jobId); }
  }
}
