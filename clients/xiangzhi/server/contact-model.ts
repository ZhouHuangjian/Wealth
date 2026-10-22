import type { ContactModelSettings, Conversation, Settings } from '../shared/types.js';
import { codexStructuredCompletion } from './codex-provider.js';
import { assertModelName, isLoopback, isQwenHost, modelEndpoint, readModelResponse, replyEndpoint } from './model-config.js';

/** Shared transport only; each feature supplies its own fixed JSON schema. */
export interface ContactModelDependencies {fetch?: typeof fetch; codex?: typeof codexStructuredCompletion; historyCache?:import('./full-history-context.js').HistoryCache; onHistoryProgress?:import('./full-history-context.js').HistoryDependencies['onHistoryProgress']}
export interface ContactModelCompletion {
  content: string; provider: 'qwen' | 'compatible' | 'codex'; modelName: string;
  usage?: {promptTokens: number; completionTokens: number; totalTokens: number};
}
const TIMEOUT_MS = 40_000;
const INVALID_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function safeContextText(value: string, maximum = 2000): string {
  return value.slice(0, maximum)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[邮箱已隐藏]')
    .replace(/(?<!\d)(?:\d{17}[\dXx]|\d{15})(?!\d)/gu, '[证件号已隐藏]')
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu, '[手机号已隐藏]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/gu, '[密钥已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/giu, '[凭据已隐藏]');
}

export function boundedString(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === 'string' && (empty || !!value.trim()) && value.length <= maximum && !INVALID_CONTROLS.test(value);
}

export function jsonObject(content: string, feature: string): Record<string, unknown> {
  if (content.length > 64_000) throw new Error(`${feature}结果过长，请重新生成。`);
  let value: unknown;
  try { value = JSON.parse(content.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()); }
  catch { throw new Error(`${feature}模型没有返回有效 JSON，请重新生成。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${feature}结果结构无效。`);
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
}

function key(settings: Settings, config: ContactModelSettings, endpoint: URL): string {
  if (!config.useReplyApiKey) return config.apiKey?.trim() ?? '';
  if (!['compatible', 'ollama'].includes(settings.provider) || replyEndpoint(settings).origin !== endpoint.origin) {
    throw new Error('分析或记忆只能在与回复接口完全相同的来源复用密钥，请单独填写模型密钥。');
  }
  return settings.apiKey.trim();
}

function usage(data: unknown): ContactModelCompletion['usage'] {
  const raw = (data as {usage?: Record<string, unknown>} | null)?.usage;
  if (!raw) return undefined;
  const values = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens];
  if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000)) return undefined;
  return {promptTokens: values[0] as number, completionTokens: values[1] as number, totalTokens: values[2] as number};
}

export function contactModelIdentity(config: ContactModelSettings): string {
  const provider = config.provider;
  if (provider === 'disabled') return 'disabled';
  if (provider === 'codex') return JSON.stringify({provider, modelName: config.modelName.trim() || '默认模型'});
  const endpoint = modelEndpoint({...config, provider});
  return JSON.stringify({provider, modelName: config.modelName.trim(), endpoint: endpoint.toString(), thinking: config.thinkingEnabled ?? false});
}

export function contactModelIsRemote(config: ContactModelSettings): boolean {
  if (config.provider === 'codex') return true;
  return config.provider !== 'disabled' && !isLoopback(modelEndpoint({...config, provider: config.provider}).hostname);
}

/** Contact overrides select a model; endpoint and credentials remain in settings. */
export function effectiveContactModelSettings(settings: Settings, conversation: Conversation,
  feature: 'analysis' | 'memory'): ContactModelSettings | undefined {
  const base = settings[feature];
  const choice = feature === 'analysis' ? conversation.processing?.analysisModel : conversation.processing?.memoryModel;
  if (!base || !choice) return base;
  if (!['compatible', 'codex'].includes(choice.provider)) throw new Error('分析和记忆仅支持千问、兼容接口或 Codex 模型。');
  return {...base, provider: choice.provider === 'codex' ? 'codex' : choice.modelPreset === 'qwen' ? 'qwen' : 'compatible',
    modelName: choice.modelName};
}

export async function contactModelCompletion(settings: Settings, config: ContactModelSettings | undefined,
  messages: {role: string; content: string}[], schema: Record<string, unknown>, feature: string,
  signal?: AbortSignal, dependencies: ContactModelDependencies = {}): Promise<ContactModelCompletion> {
  if (signal?.aborted) throw new Error(`${feature}已取消。`);
  if (!config || config.provider === 'disabled') throw new Error(`请先在设置中配置并开启${feature}模型。`);
  if (Buffer.byteLength(JSON.stringify(messages)) > 128_000) throw new Error(`${feature}上下文过长，请减少输入。`);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let content: string;
  let tokenUsage: ContactModelCompletion['usage'];
  const abortError = (): Error | null => signal?.aborted ? new Error(`${feature}已取消。`)
    : timeout.aborted ? new Error(`${feature}超过 40 秒，已取消。`) : null;
  if (config.provider === 'codex') {
    if (!config.allowRemoteModel) throw new Error(`Codex ${feature}会调用远程模型，请先允许远程处理。`);
    try {
      content = await (dependencies.codex ?? codexStructuredCompletion)({...settings, provider: 'codex',
        modelName: config.modelName, allowRemoteModel: config.allowRemoteModel}, messages, schema, combined);
    } catch { throw abortError() ?? new Error(`Codex ${feature}失败，请检查模型、CLI 登录状态和网络。`); }
  } else {
    // Compatible APIs do not all implement schema-constrained output. Include
    // the server-owned schema in the instruction and still validate the result.
    const instruction=`\n输出必须严格符合以下固定 JSON Schema；不增加说明、reason 或其他未定义字段：\n${JSON.stringify(schema)}`;
    const requestMessages=messages[0]?.role==='system'
      ? [{...messages[0],content:messages[0].content+instruction},...messages.slice(1)]
      : [{role:'system',content:instruction},...messages];
    if(Buffer.byteLength(JSON.stringify(requestMessages))>128_000)throw new Error(`${feature}上下文过长，请减少输入。`);
    const endpoint = modelEndpoint({...config, provider: config.provider});
    assertModelName(config.modelName);
    const apiKey = key(settings, config, endpoint);
    if (config.provider === 'qwen' && !apiKey) throw new Error(`请配置千问${feature}密钥。`);
    const qwen = config.provider === 'qwen' || isQwenHost(endpoint.hostname);
    const headers: Record<string, string> = {'Content-Type': 'application/json'};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(endpoint, {method: 'POST', headers, redirect: 'error', signal: combined,
        body: JSON.stringify({model: config.modelName.trim(), messages:requestMessages, stream: false, temperature: 0.1, max_tokens: 3000,
          ...(qwen ? {enable_thinking: config.thinkingEnabled ?? false} : {})})});
    } catch { throw abortError() ?? new Error(`无法连接${feature}模型，请检查地址、网络和认证。`); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${feature}模型返回 HTTP ${response.status}，请检查模型权限或配置。`);
    }
    let data: unknown;
    try { data = await readModelResponse(response, combined, 128_000); }
    catch (error) { throw abortError() ?? error; }
    const message = (data as {choices?: {message?: {content?: unknown; tool_calls?: unknown; function_call?: unknown}}[]} | null)?.choices?.[0]?.message;
    if (typeof message?.content !== 'string' || !message.content.trim() || message.tool_calls || message.function_call) {
      throw new Error(`${feature}模型没有返回可用的纯文本内容。`);
    }
    content = message.content;
    tokenUsage = usage(data);
  }
  const cancelled = abortError();
  if (cancelled) throw cancelled;
  return {content, provider: config.provider, modelName: config.modelName.trim() || '默认模型', ...(tokenUsage ? {usage: tokenUsage} : {})};
}
