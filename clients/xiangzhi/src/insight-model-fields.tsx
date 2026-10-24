import { Check } from 'lucide-react';
import { useRef } from 'react';
import type { ContactModelSettings } from '../shared/types';
import { modelNameForProviderChange, type ModelProvider } from '../shared/model-catalog';
import { ProviderModelPicker } from './model-picker';

/** Text services share the credential behavior of the independent vision service. */
export function InsightModelFields({ kind, model, onChange, disabled, canReuseReplyKey, hasApiKey }: {
  kind: 'analysis' | 'memory'; model: ContactModelSettings; onChange: (model: ContactModelSettings) => void;
  disabled: boolean; canReuseReplyKey: boolean; hasApiKey: boolean;
}) {
  const name = kind === 'analysis' ? '意图与好感度分析' : '对话记忆';
  const change = <K extends keyof ContactModelSettings,>(key: K, value: ContactModelSettings[K]) => onChange({ ...model, [key]: value });
  const rememberedNames = useRef<Partial<Record<ModelProvider, string>>>({ [model.provider]: model.modelName });
  const selectProvider = (provider: ContactModelSettings['provider']) => {
    rememberedNames.current[model.provider] = model.modelName;
    onChange({ ...model, provider,
      modelName: modelNameForProviderChange(model.provider, provider, model.modelName, kind, rememberedNames.current),
      ...(!canReuseReplyKey ? { useReplyApiKey: false } : {}) });
  };
  return <div className="insight-model-fields">
    <div className="provider-options insight-provider-options">{([
      { id: 'disabled', title: '暂不使用', detail: '保留已保存的结果' },
      { id: 'qwen', title: '阿里千问', detail: '独立选择文字分析模型' },
      { id: 'codex', title: 'Codex', detail: '使用本机的 Codex 登录' },
      { id: 'compatible', title: '兼容 API', detail: '连接自己的文字模型' },
    ] as const).map(provider => <label className={`provider-option ${model.provider === provider.id ? 'selected' : ''}`} key={provider.id}>
      <input type="radio" disabled={disabled} name={`${kind}-provider`} checked={model.provider === provider.id} onChange={() => selectProvider(provider.id)} />
      <span><strong>{provider.title}</strong><small>{provider.detail}</small></span>{model.provider === provider.id && <Check size={15} />}
    </label>)}</div>
    {model.provider !== 'disabled' && <>
      <ProviderModelPicker provider={model.provider} role={kind} label={`${name}模型名称`} value={model.modelName} onChange={value => change('modelName', value)} disabled={disabled} />
      {model.provider === 'codex' && <p className="model-test-hint">使用本机 Codex 登录，无需填写服务地址或 API 密钥。</p>}
      {model.provider !== 'codex' && <>
        <details className="model-connection-details"><summary>连接与密钥 · {model.useReplyApiKey ? '共用回复服务密钥' : hasApiKey ? '密钥已保存' : '待配置'}</summary>
          <label className="field-label">{name}服务地址<input type="url" disabled={disabled} value={model.modelUrl} onChange={event => change('modelUrl', event.target.value)} placeholder={model.provider === 'qwen' ? 'https://你的业务空间域名/compatible-mode/v1' : 'https://your-model-service/v1'} /></label>
          <label className="checkbox-label"><input type="checkbox" disabled={disabled || !canReuseReplyKey} checked={model.useReplyApiKey} onChange={event => change('useReplyApiKey', event.target.checked)} /><span><strong>使用回复服务的 API 密钥</strong><small>服务地址来源一致时可共用；也可为此功能单独保存密钥。</small></span></label>
          {!model.useReplyApiKey && <label className="field-label">{name} API 密钥<span className="field-hint">{hasApiKey ? '已保存；留空保留现有密钥' : '仅保存在本机，不会回显'}</span><input type="password" autoComplete="off" disabled={disabled} value={model.apiKey || ''} onChange={event => change('apiKey', event.target.value)} placeholder={hasApiKey ? '•••••••• 已配置' : '输入 API 密钥'} /></label>}
        </details>
        {model.provider === 'qwen' && <label className="checkbox-label"><input type="checkbox" disabled={disabled} checked={!!model.thinkingEnabled} onChange={event => change('thinkingEnabled', event.target.checked)} /><span><strong>{name}启用思考模式</strong><small>默认关闭；需模型支持，可能增加等待和 tokens。</small></span></label>}
      </>}
      <label className="checkbox-label"><input type="checkbox" disabled={disabled} checked={model.allowRemoteModel} onChange={event => change('allowRemoteModel', event.target.checked)} /><span><strong>允许此模型参考完整会话</strong><small>仅为开启功能的联系人处理；较长历史分段整理，结果与分段缓存保存在本机。</small></span></label>
    </>}
  </div>;
}
