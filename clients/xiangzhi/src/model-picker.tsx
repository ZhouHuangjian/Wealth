import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { api } from './api';
import { modelOptions, unavailableModelCatalog, type ModelCatalog, type ModelProvider, type ModelRole } from '../shared/model-catalog';

const CatalogContext = createContext<ModelCatalog>(unavailableModelCatalog());

/** One catalogue request for all the global, contact and comparison pickers. */
export function ModelCatalogProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<ModelCatalog>(unavailableModelCatalog);
  useEffect(() => {
    let active = true;
    void api<ModelCatalog>('/model-catalog').then(value => { if (active) setCatalog(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <CatalogContext.Provider value={catalog}>{children}</CatalogContext.Provider>;
}

export function ProviderModelPicker({ provider, role, label, value, onChange, disabled }: {
  provider: ModelProvider; role: ModelRole; label: string; value: string;
  onChange: (value: string) => void; disabled?: boolean;
}) {
  const catalog = useContext(CatalogContext);
  const listId = useId();
  const options = modelOptions(provider, role, catalog);
  const listed = options.some(option => option.id === value);
  return <label className="field-label">{label}
    {provider === 'codex' ? <>
      <select disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">Codex 默认模型</option>
        {value && !listed && <option value={value}>已保存：{value}（不在当前列表）</option>}
        {options.map(option => <option value={option.id} key={option.id}>{option.label} · {option.id}</option>)}
      </select>
      <small>{catalog.codex.source === 'local-cache' ? '来自本机 Codex 的模型列表；使用当前登录账号，调用时以服务实际可用性为准。' : '暂未读取到本机 Codex 模型列表，可先使用默认模型。打开并登录 Codex 后刷新此页面。'}</small>
      {value && !listed && <small className="error-text">已保存的名称未出现在本机列表，请选择可用模型或默认模型。</small>}
    </> : <>
      <input disabled={disabled} required={!['disabled', 'demo'].includes(provider)} value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={provider === 'qwen' ? role === 'audio' ? 'qwen3.8-omni-flash' : 'qwen3.8-flash' : '填写此服务的 Model ID'}
        list={options.length ? listId : undefined} />
      {options.length > 0 && <datalist id={listId}>{options.map(option => <option value={option.id} key={option.id} />)}</datalist>}
    </>}
  </label>;
}
