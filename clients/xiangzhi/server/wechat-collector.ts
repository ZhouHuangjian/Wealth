import { createHash, randomUUID } from 'node:crypto';
import type { AppState, Conversation, Message } from '../shared/types.js';
import { contactAutoMediaEnabled } from '../shared/contact-processing.js';
import { queryWechat, type WechatQuery, type WechatRecord } from './wechat-cli.js';
import { insightsInputDigest } from './contact-insights.js';

interface StateStore { read(): AppState; update(fn: (state: AppState) => void): unknown }
interface CollectorOptions {
  query?: WechatQuery; intervalMs?: number; now?: () => number;
  onMessages?: (conversationId: string, latestMessageId: string | null, live: boolean) => void;
  onContextInvalidated?: (conversationId: string) => void;
}
const compareSeq = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const fingerprint = (record: WechatRecord) => createHash('sha256').update(JSON.stringify([record.text, record.role, record.kind, record.sentAt])).digest('hex');
const binding = (state: AppState, cid: string): Conversation => {
  const c = state.conversations.find(item => item.id === cid && item.channel === 'wechat');
  if (!c?.wechat || !c.externalId) throw new Error('找不到已绑定的微信会话。');
  return c;
};

/** Poll only explicit bindings. Initial and resumed catch-up never enqueue replies. */
export class WechatCollector {
  private readonly query: WechatQuery;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private inflight = new Map<string, {controller: AbortController; promise: Promise<{added: number; baseline: boolean}>}>();
  private catchup = new Set<string>();
  private backoff = new Map<string, {failures: number; next: number}>();
  private tickPromise: Promise<void> | null = null;
  constructor(private readonly store: StateStore, private readonly options: CollectorOptions = {}) {
    this.query = options.query ?? queryWechat; this.now = options.now ?? Date.now;
    this.intervalMs = Math.max(1000, options.intervalMs ?? 15000);
    for (const c of store.read().conversations.filter(c => c.channel === 'wechat')) this.catchup.add(c.id);
  }
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.inflight.values()) entry.controller.abort();
  }
  cancel(cid: string): void {
    this.inflight.get(cid)?.controller.abort(); this.catchup.add(cid); this.backoff.delete(cid);
  }
  setEnabled(cid: string, enabled: boolean): void {
    binding(this.store.read(), cid); this.cancel(cid);
    this.store.update(state => {
      const c = binding(state, cid);
      c.wechat!.enabled = enabled; c.wechat!.status = 'paused';
      c.wechat!.detail = enabled ? '等待读取；首次读取或恢复采集只补齐上下文，不触发自动草稿。' : '采集已暂停，不再读取新消息。';
    });
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = (async () => {
      for (const c of this.store.read().conversations.filter(c => c.channel === 'wechat' && c.wechat?.enabled)) {
        if (this.closed) break;
        // An earlier query may have awaited while a later binding was paused or
        // deleted. Manual polling permits paused bindings; background polling must not.
        const current = this.store.read().conversations.find(item => item.id === c.id);
        if (current?.channel !== 'wechat' || !current.wechat?.enabled) continue;
        if ((this.backoff.get(c.id)?.next ?? 0) > this.now()) continue;
        try { await this.poll(c.id); } catch { /* The reader records query failures; keep other bindings independent. */ }
      }
    })().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
  poll(cid: string): Promise<{added: number; baseline: boolean}> {
    if (this.closed) return Promise.reject(new Error('微信采集服务已停止。'));
    const active = this.inflight.get(cid);
    if (active) return active.promise;
    const initial = this.store.read();
    const c = binding(initial, cid);
    const controller = new AbortController();
    const promise = this.read(cid, c, initial, controller.signal).finally(() => {
      if (this.inflight.get(cid)?.controller === controller) this.inflight.delete(cid);
    });
    this.inflight.set(cid, {controller, promise});
    return promise;
  }
  private async read(cid: string, c: Conversation, initial: AppState, signal: AbortSignal): Promise<{added: number; baseline: boolean}> {
    const baseline = !c.wechat!.initialized;
    const historyOnly = baseline || this.catchup.has(cid) || !c.wechat!.enabled;
    this.store.update(state => { const w = binding(state, cid).wechat!; w.status = 'reading'; w.detail = '正在读取选定会话的消息，媒体文件不会导出。'; });
    try {
      // Reread the last 50 sequences as overlap. This handles equal-sequence boundaries
      // and recent delayed updates, while paginating all records newer than that floor.
      const prior = initial.messages.filter(m => m.conversationId === cid && m.sourceSequence).map(m => m.sourceSequence!).sort(compareSeq);
      const cursor = c.wechat!.cursor ?? '0';
      const overlap = prior.slice(-50)[0] ?? cursor;
      const floor = BigInt(overlap) > 0n ? (BigInt(overlap) - 1n).toString() : '0';
      const records: WechatRecord[] = [];
      let account = c.wechat!.accountFingerprint;
      let offset = 0;
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await this.query({contact: c.externalId!, ...(baseline ? {} : {after: floor}),
          order: baseline ? 'desc' : 'asc', limit: baseline ? 50 : 200, offset}, boundedSignal);
        if (signal.aborted || this.closed) throw new Error('采集已暂停。');
        if (account && account !== page.accountFingerprint) {
          this.store.update(state => {
            const w = binding(state, cid).wechat!; w.enabled = false;
            w.status = 'error'; w.detail = '微信账号已变化，已停止采集；请核对账号后再读取，不能混入另一账号的消息。';
          });
          this.options.onContextInvalidated?.(cid);
          throw new Error('微信账号已变化，采集已停止。');
        }
        account = page.accountFingerprint;
        records.push(...page.records);
        if (baseline || !page.hasMore) break;
        if (!page.records.length || pageNumber === 9) throw new Error('待补读消息过多或分页异常，未推进游标；请缩小接入范围后重试。');
        offset += page.records.length;
      }
      if (signal.aborted || this.closed) throw new Error('采集已暂停。');
      const current = binding(this.store.read(), cid);
      if (current.externalId !== c.externalId || current.wechat!.enabled !== c.wechat!.enabled) throw new Error('采集设置已改变，请重新读取。');
      let added = 0, changed = false, sourceChanged = false, invalidatedInsights = false, latestId: string | null = null, latestIsNew = false;
      this.store.update(state => {
        const target = binding(state, cid), w = target.wechat!;
        const list = state.messages.filter(m => m.conversationId === cid);
        const byId = new Map(list.filter(m => m.externalId).map(m => [m.externalId!, m]));
        const newIds = new Set<string>();
        let high = cursor;
        for (const record of records) {
          if (compareSeq(record.sortSeq, high) > 0) high = record.sortSeq;
          // A local outgoing message can acquire its server ID after the first
          // read. Upgrade the provisional sequence ID without inserting it twice.
          const existing = byId.get(record.id) ?? byId.get(`seq:${record.sortSeq}`)
            ?? (record.id.startsWith('seq:') ? list.find(m=>m.sourceSequence===record.sortSeq) : undefined);
          const hash = fingerprint(record);
          if (existing) {
            if(existing.externalId?.startsWith('seq:') && !record.id.startsWith('seq:')) {
              byId.delete(existing.externalId); existing.externalId = record.id; byId.set(record.id,existing);
            }
            const imageChanged = existing.wechatImage?.md5 && record.wechatImage?.md5
              && existing.wechatImage.md5 !== record.wechatImage.md5;
            if (existing.sourceFingerprint !== hash || imageChanged) {
              Object.assign(existing, {text:record.text,role:record.role,kind:record.kind,mediaStatus:record.mediaStatus,
                sentAt:record.sentAt,sourceSequence:record.sortSeq,sourceFingerprint:hash,
                wechatImage: record.wechatImage, imageRecognition: undefined, imageAttachment: undefined,
                audioRecognition: undefined, audioAttachment: undefined,
                autoMediaEligible: false});
              delete existing.insights;
              changed = true; sourceChanged = true;
            } else if (record.wechatImage) {
              // Adding identifiers to a previously collected placeholder must not
              // replace a reviewed/recognized summary or invalidate its drafts.
              existing.wechatImage = {...existing.wechatImage, ...record.wechatImage};
            }
            continue;
          }
          const message: Message = {id:randomUUID(),conversationId:cid,role:record.role,text:record.text,sentAt:record.sentAt,
            sequence:0,source:'wechat',externalId:record.id,aiAssisted:false,kind:record.kind,mediaStatus:record.mediaStatus,
            sourceSequence:record.sortSeq,sourceFingerprint:hash,wechatImage:record.wechatImage,
            autoMediaEligible: !historyOnly && record.role === 'peer'
              && ((record.kind === 'image' && contactAutoMediaEnabled(target, 'image'))
                || (record.kind === 'voice' && contactAutoMediaEnabled(target, 'voice')))};
          list.push(message); byId.set(record.id,message); newIds.add(message.id); added++; changed = true;
        }
        // Uploaded context stays near its timestamp instead of moving ahead of
        // all WeChat messages merely because it has no sourceSequence.
        const manual = list.filter(m => m.source !== 'wechat');
        const ordered = list.filter(m => m.source === 'wechat').sort((a,b) => compareSeq(a.sourceSequence ?? '0', b.sourceSequence ?? '0') || a.id.localeCompare(b.id));
        for (const message of manual.sort((a,b) => a.sequence - b.sequence)) {
          const at = message.sentAt ? Date.parse(message.sentAt) : NaN;
          const index = Number.isFinite(at) ? ordered.findIndex(m => m.sentAt && Date.parse(m.sentAt) > at) : -1;
          ordered.splice(index < 0 ? ordered.length : index, 0, message);
        }
        list.splice(0, list.length, ...ordered);
        list.forEach((m,index) => {m.sequence = index + 1;});
        state.messages = [...state.messages.filter(m => m.conversationId !== cid), ...list];
        if (changed) {
          // Newer messages must not erase valid analysis of an earlier utterance.
          // Recheck only saved results in this binding against their scoped input.
          for (const message of list) if (message.insights) {
            let current = false;
            try {
              current = message.insights.conversationId === cid && message.insights.messageId === message.id
                && !!message.insights.inputDigest && message.insights.inputDigest === insightsInputDigest(state, cid, message.id);
            } catch { /* Disabled, missing or invalid model context cannot establish a current result. */ }
            if (!current) {delete message.insights; invalidatedInsights = true;}
          }
        }
        w.cursor = high; w.accountFingerprint = account; w.initialized = true;
        w.lastCheckedAt = new Date(this.now()).toISOString(); w.status = w.enabled ? 'ready' : 'paused';
        w.detail = historyOnly ? `已读取上下文（新增 ${added} 条），本次不会触发自动草稿。`
          : `本次新增 ${added} 条；图片与语音等内容需要人工查看。`;
        if (changed) {
          state.drafts = state.drafts.filter(d => d.conversationId !== cid); target.updatedAt = w.lastCheckedAt;
          latestId = list.at(-1)?.id ?? null; latestIsNew = !!latestId && newIds.has(latestId);
        }
      });
      this.catchup.delete(cid); this.backoff.delete(cid);
      if (sourceChanged || invalidatedInsights) this.options.onContextInvalidated?.(cid);
      if (changed) this.options.onMessages?.(cid,latestId,!historyOnly && latestIsNew);
      return {added,baseline};
    } catch (error) {
      if (!signal.aborted && !this.closed) {
        this.catchup.add(cid);
        const count = (this.backoff.get(cid)?.failures ?? 0) + 1;
        this.backoff.set(cid,{failures:count,next:this.now()+Math.min(60_000,this.intervalMs*2**Math.min(count,4))});
        this.store.update(state => {
          const target = state.conversations.find(item => item.id === cid);
          if (!target?.wechat) return;
          const w = target.wechat;
          if (w.detail.startsWith('微信账号已变化')) return;
          w.status = 'error';
          w.detail = '读取未完成，游标已保留。请检查微信登录状态和本机读取工具；后台读取将退避重试。';
        });
      }
      throw error;
    }
  }
}
