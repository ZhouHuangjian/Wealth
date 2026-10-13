import type { Settings } from '../shared/types.js';

export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function isQwenHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host)
    || /^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9][a-z0-9-]{0,62}\.maas\.aliyuncs\.com$/.test(host);
}

export function modelEndpoint(config: {modelUrl: string; allowRemoteModel: boolean; provider: 'ollama' | 'compatible' | 'qwen'}): URL {
  let url: URL;
  try { url = new URL(config.modelUrl); }
  catch { throw new Error('模型地址无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('模型地址不能包含用户名、密码、查询参数或片段。');
  }
  if (isLoopback(url.hostname)) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('本地模型必须使用 HTTP 或 HTTPS。');
  } else if (!config.allowRemoteModel || url.protocol !== 'https:') {
    throw new Error('远程模型需要明确开启远程处理，并使用 HTTPS 地址。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (config.provider === 'qwen') {
    if (url.protocol !== 'https:' || !isQwenHost(url.hostname) || url.port
      || !['/compatible-mode/v1', '/compatible-mode/v1/chat/completions'].includes(path)) {
      throw new Error('千问预设仅支持阿里百炼官方 HTTPS 地址，路径须为 /compatible-mode/v1。');
    }
  }
  if (config.provider === 'ollama') {
    url.pathname = path.endsWith('/api/chat') ? path : path.endsWith('/api') ? `${path}/chat` : `${path}/api/chat`;
  } else url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url;
}

export function replyEndpoint(settings: Settings): URL {
  return modelEndpoint({modelUrl: settings.modelUrl, allowRemoteModel: settings.allowRemoteModel,
    provider: settings.provider === 'ollama' ? 'ollama' : settings.modelPreset === 'qwen' ? 'qwen' : 'compatible'});
}

export function qwenReply(settings: Settings): boolean {
  return settings.provider === 'compatible' && (settings.modelPreset === 'qwen' || isQwenHost(replyEndpoint(settings).hostname));
}

export function visionApiKey(settings: Settings, vision: {apiKey?: string; useReplyApiKey: boolean}, endpoint: URL): string {
  if (!vision.useReplyApiKey) return vision.apiKey?.trim() ?? '';
  if (!['compatible', 'ollama'].includes(settings.provider) || replyEndpoint(settings).origin !== endpoint.origin) {
    throw new Error('媒体识别只能在与回复接口完全相同的来源复用密钥；请单独填写识别密钥。');
  }
  return settings.apiKey.trim();
}

export function assertModelName(name: string): void {
  if (!name.trim() || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('请填写有效的模型名称（最多 128 字符）。');
}

export async function readModelResponse(response: Response, signal: AbortSignal, maximumBytes = 256_000): Promise<unknown> {
  if (Number(response.headers.get('content-length') || 0) > maximumBytes) {
    await response.body?.cancel();
    throw new Error('模型响应过大，请检查模型服务。');
  }
  if (!response.body) throw new Error('模型返回了空响应。');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, {once: true});
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error('模型响应过大，请检查模型服务。');
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.message === '模型响应过大，请检查模型服务。') throw error;
    throw new Error('模型响应读取失败，请稍后重试。');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  signal.throwIfAborted();
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new Error('模型服务没有返回有效 JSON。'); }
}
