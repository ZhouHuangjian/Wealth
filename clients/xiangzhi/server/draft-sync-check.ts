import { z } from 'zod';
import { validateEndpoint } from './bridge.js';
import { isDraftSyncConfigured, type DraftSyncConfig } from './draft-sync.js';

const MAX_CHECK_BYTES = 4096;
const checkReceipt = z.object({
  ok: z.literal(true),
  device: z.object({id: z.uuid(), name: z.string().min(1).max(80).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value))}).strict(),
  checkedAt: z.iso.datetime({offset: true}).max(100),
}).strict();
export type DraftConnectionReceipt = z.infer<typeof checkReceipt>;
export class DraftConnectionCheckError extends Error {}

export function draftConnectionCheckUrl(config: DraftSyncConfig): URL | null {
  if (!isDraftSyncConfigured(config)) return null;
  const url = validateEndpoint(config.url);
  if (url.pathname !== '/api/v1/chat/ingest') return null;
  return new URL('/api/v1/chat/device/check', url.origin);
}

/** Explicit metadata-only check. Never uploads conversation or draft content. */
export async function checkDraftConnection(config: DraftSyncConfig, signal?: AbortSignal): Promise<DraftConnectionReceipt> {
  const url = draftConnectionCheckUrl(config);
  if (!url) throw new DraftConnectionCheckError('此同步地址不支持 Wealth 设备验证，请通过手动同步草稿确认。');
  const timeout = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(url, {method: 'POST', redirect: 'error',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`}, body: '{}',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    if (!response.ok) {
      await response.body?.cancel();
      throw new DraftConnectionCheckError(response.status === 401 || response.status === 403
        ? '设备验证未通过，请检查设备是否被撤销或账号聊天功能是否开启。配置仍保留。'
        : `服务器返回 HTTP ${response.status}，连接尚未验证。配置仍保留，可稍后重试。`);
    }
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) {
      await response.body?.cancel();
      throw new DraftConnectionCheckError('服务器未返回有效的设备验证结果。配置仍保留。');
    }
    if (Number(response.headers.get('content-length')) > MAX_CHECK_BYTES) {
      await response.body.cancel();
      throw new DraftConnectionCheckError('设备验证响应过大，未确认连接。配置仍保留。');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CHECK_BYTES) {
          await reader.cancel();
          throw new DraftConnectionCheckError('设备验证响应过大，未确认连接。配置仍保留。');
        }
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    let parsed: unknown;
    try {parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch { /* Validated below without echoing the body. */ }
    const receipt = checkReceipt.safeParse(parsed);
    if (!receipt.success || JSON.stringify(receipt.data).includes(config.token)) {
      throw new DraftConnectionCheckError('服务器未返回有效的设备验证结果。配置仍保留。');
    }
    return receipt.data;
  } catch (error) {
    if (error instanceof DraftConnectionCheckError) throw error;
    if (signal?.aborted) throw new DraftConnectionCheckError('连接验证已取消。');
    if (timeout.aborted) throw new DraftConnectionCheckError('连接验证超时，配置仍保留，可稍后重试。');
    throw new DraftConnectionCheckError('无法验证服务器连接，请检查网络与服务器地址。配置仍保留。');
  }
}
