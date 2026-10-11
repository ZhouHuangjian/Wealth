import { timingSafeEqual } from 'node:crypto';
import type { Conversation } from '../shared/types.js';

export interface BridgeConfig { inboundToken: string; outboundUrl: string; outboundToken: string }
export const bridgeConfig = (): BridgeConfig => ({
  inboundToken: process.env.BRIDGE_TOKEN ?? '',
  outboundUrl: process.env.OUTBOUND_WEBHOOK_URL ?? '',
  outboundToken: process.env.OUTBOUND_WEBHOOK_TOKEN ?? '',
});

export function secureEqual(a: string, b: string): boolean {
  return a.length > 0 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function validateEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入完整的接口地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search) throw new Error('接口地址不能包含密码、查询参数或片段。');
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('远程接口必须使用 HTTPS；HTTP 仅允许本机地址。');
  return url;
}

export function isBridgeReceiveConfigured(config: BridgeConfig): boolean {
  return config.inboundToken.length >= 32;
}

export function isBridgeConfigured(config: BridgeConfig): boolean {
  if (!isBridgeReceiveConfigured(config) || !config.outboundUrl) return false;
  try { validateEndpoint(config.outboundUrl); return true; } catch { return false; }
}

export function createSender(config: BridgeConfig) {
  return async (conversation: Conversation, text: string, idempotencyKey: string, signal?: AbortSignal): Promise<void|string> => {
    if (conversation.channel === 'simulator') return;
    if (conversation.channel === 'wechat') throw new Error('微信采集通道仅接收，不支持发送消息。');
    if (!isBridgeConfigured(config) || !conversation.externalId) throw new Error('消息桥接尚未配置，无法发送到外部会话。');
    const url = validateEndpoint(config.outboundUrl);
    const response = await fetch(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
        ...(config.outboundToken ? { Authorization: `Bearer ${config.outboundToken}` } : {}) },
      body: JSON.stringify({ version: '1', conversationId: conversation.externalId, text, idempotencyKey }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`发送接口返回 ${response.status}。结果可能不确定，请核对接收端，系统不会自动重试。`);
    const body = await response.json() as { ok?: unknown; messageId?: unknown };
    if (body.ok !== true || typeof body.messageId !== 'string' || !body.messageId.trim()) {
      throw new Error('接口未返回有效发送凭据。请核对接收端，系统不会自动重试。');
    }
    return body.messageId;
  };
}
