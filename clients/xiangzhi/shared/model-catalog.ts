export type ModelRole = 'reply' | 'vision' | 'audio' | 'analysis' | 'memory';
export type ModelProvider = 'qwen' | 'codex' | 'compatible' | 'ollama' | 'demo' | 'disabled';
export interface ModelOption { id: string; label: string; inputModalities: ('text' | 'image')[] }
export interface ModelCatalog {
  codex: {
    source: 'local-cache' | 'unavailable';
    models: ModelOption[];
    fetchedAt: string | null;
    /** The restricted CLI adapter accepts text and images, not audio. */
    audioSupported: false;
  };
  audio: { codexSupported: false; message: string };
}

export const CODEX_AUDIO_HELP = 'Codex 当前接入支持文字和图片，暂不能直接转写语音。语音请使用千问或支持音频输入的兼容服务；转写后可继续由 Codex 生成回复。';

export function unavailableModelCatalog(): ModelCatalog {
  return { codex: { source: 'unavailable', models: [], fetchedAt: null, audioSupported: false },
    audio: { codexSupported: false, message: CODEX_AUDIO_HELP } };
}

// These are shortcuts for the Qwen models the user has configured. Other API
// services supply their own Model IDs; never suggest this list under Codex.
const QWEN_TEXT_MODELS = ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.7-flash'];
const QWEN_AUDIO_MODELS = ['qwen3.8-omni-flash'];

export function modelOptions(provider: ModelProvider, role: ModelRole, catalog?: ModelCatalog): ModelOption[] {
  if (provider === 'codex') {
    if (role === 'audio') return [];
    const required = role === 'vision' ? 'image' : 'text';
    return (catalog?.codex.models ?? []).filter(model => model.inputModalities.includes(required));
  }
  if (provider !== 'qwen') return [];
  return (role === 'audio' ? QWEN_AUDIO_MODELS : QWEN_TEXT_MODELS).map(id => ({ id, label: id,
    inputModalities: role === 'vision' ? ['text', 'image'] : ['text'] }));
}

export function defaultModelName(provider: ModelProvider, role: ModelRole): string {
  return provider === 'qwen' ? role === 'audio' ? QWEN_AUDIO_MODELS[0] : QWEN_TEXT_MODELS[0] : '';
}

/** A provider switch must not carry the previous provider's Model ID with it. */
export function modelNameForProviderChange(
  previousProvider: ModelProvider, nextProvider: ModelProvider, currentName: string, role: ModelRole,
  remembered: Partial<Record<ModelProvider, string>> = {},
): string {
  if (previousProvider === nextProvider) return currentName;
  const saved = remembered[nextProvider];
  if (typeof saved === 'string'
    && !(nextProvider === 'codex' && /^qwen/i.test(saved))
    && !(nextProvider === 'qwen' && /^(?:gpt-|o[1-9](?:-|$))/i.test(saved))) return saved;
  return defaultModelName(nextProvider, role);
}
