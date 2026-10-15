import { createContext, useContext, useId, type ReactNode } from "react";
import { Button, Input, Select, Space } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { remoteModelOptions } from "../chat-remote-model";
import type {
  RemoteModelChoice,
  RemoteModelOption,
} from "../chat-remote-model";

const ModelCatalogContext = createContext<RemoteModelOption[]>([]);
export function RemoteModelCatalogProvider({
  models,
  children,
}: {
  models: RemoteModelOption[];
  children: ReactNode;
}) {
  return (
    <ModelCatalogContext.Provider value={models}>
      {children}
    </ModelCatalogContext.Provider>
  );
}
export function RemoteModelNameField({
  value = "",
  onChange,
  provider,
  role = "reply",
  disabled,
  id,
  label = "具体模型名称",
}: {
  value?: string;
  onChange?: (value: string) => void;
  provider: string;
  role?: "reply" | "vision" | "audio" | "analysis" | "memory";
  disabled?: boolean;
  id?: string;
  label?: string;
}) {
  const models = useContext(ModelCatalogContext),
    listId = useId(),
    options = remoteModelOptions(provider, role, models);
  if (provider === "codex")
    return (
      <Select
        id={id}
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={onChange}
        options={[
          { value: "", label: "Codex 默认模型" },
          ...options.map((model) => ({
            value: model.id,
            label: `${model.label} · ${model.id}`,
          })),
          ...(value && !options.some((model) => model.id === value)
            ? [{ value, label: `已保存：${value}（不在当前列表）` }]
            : []),
        ]}
      />
    );
  return (
    <>
      <Input
        id={id}
        aria-label={label}
        maxLength={200}
        disabled={disabled}
        value={value}
        list={options.length ? listId : undefined}
        placeholder={
          provider === "qwen"
            ? role === "audio"
              ? "qwen3.8-omni-flash"
              : "qwen3.8-flash"
            : "填写此服务的 Model ID"
        }
        onChange={(event) => onChange?.(event.target.value)}
      />
      {options.length > 0 && (
        <datalist id={listId}>
          {options.map((model) => (
            <option value={model.id} key={model.id} />
          ))}
        </datalist>
      )}
    </>
  );
}

export const modelProviders = [
  { value: "qwen", label: "阿里千问" },
  { value: "codex", label: "Codex" },
  { value: "compatible", label: "兼容 AI 接口" },
];
export function RemoteModelChoiceField({
  value,
  onChange,
  disabled,
  allowInherit = true,
  role = "analysis",
}: {
  value?: RemoteModelChoice | null;
  onChange?: (value: RemoteModelChoice | null) => void;
  disabled?: boolean;
  allowInherit?: boolean;
  role?: "reply" | "analysis" | "memory";
}) {
  const service = !value
    ? "inherit"
    : value.provider === "compatible" && value.modelPreset === "qwen"
      ? "qwen"
      : value.provider;
  return (
    <div className="chat-remote-model-choice">
      <Select
        aria-label="选择模型来源"
        value={service}
        disabled={disabled}
        options={[
          ...(allowInherit
            ? [{ value: "inherit", label: "沿用全局独立模型" }]
            : []),
          ...modelProviders,
          ...(value?.provider === "ollama"
            ? [{ value: "ollama", label: "Ollama" }]
            : []),
          ...(value?.provider === "demo"
            ? [{ value: "demo", label: "演示模式" }]
            : []),
        ]}
        onChange={(provider) =>
          onChange?.(
            provider === "inherit"
              ? null
              : {
                  id: value?.id ?? crypto.randomUUID(),
                  provider:
                    provider === "qwen"
                      ? "compatible"
                      : (provider as RemoteModelChoice["provider"]),
                  modelPreset: provider === "qwen" ? "qwen" : "custom",
                  modelName:
                    provider === "qwen"
                      ? "qwen3.8-flash"
                      : provider === "codex"
                        ? ""
                        : provider === service
                          ? (value?.modelName ?? "")
                          : "",
                  ...(value?.label ? { label: value.label } : {}),
                },
          )
        }
      />
      {value && (
        <RemoteModelNameField
          provider={service}
          role={role}
          disabled={disabled}
          value={value.modelName}
          onChange={(modelName) => onChange?.({ ...value, modelName })}
        />
      )}
    </div>
  );
}
export function RemoteReplyModelsField({
  value,
  onChange,
  disabled,
  allowInherit = false,
}: {
  value?: RemoteModelChoice[] | null;
  onChange?: (value: RemoteModelChoice[] | null) => void;
  disabled?: boolean;
  allowInherit?: boolean;
}) {
  const choices = value ?? [];
  return (
    <div className="chat-remote-models">
      {allowInherit && (
        <Select
          aria-label="回复比较模型设置方式"
          value={value == null ? "inherit" : "custom"}
          disabled={disabled}
          options={[
            { value: "inherit", label: "沿用全局比较模型" },
            { value: "custom", label: "为此人单独配置" },
          ]}
          onChange={(mode) => onChange?.(mode === "inherit" ? null : [])}
        />
      )}
      {(!allowInherit || value != null) && (
        <>
          <p className="chat-remote-note">
            未添加时使用主要回复模型；最多比较 4 个模型。
          </p>
          {choices.map((choice, index) => (
            <div className="chat-remote-model-row" key={choice.id}>
              <div className="chat-remote-inline-heading">
                <strong>模型 {index + 1}</strong>
                <Button
                  type="text"
                  aria-label={`移除比较模型 ${index + 1}`}
                  icon={<Trash2 size={15} />}
                  disabled={disabled}
                  onClick={() =>
                    onChange?.(choices.filter((item) => item.id !== choice.id))
                  }
                />
              </div>
              <RemoteModelChoiceField
                role="reply"
                allowInherit={false}
                value={choice}
                disabled={disabled}
                onChange={(next) =>
                  next &&
                  onChange?.(
                    choices.map((item) =>
                      item.id === choice.id ? next : item,
                    ),
                  )
                }
              />
              <Input
                aria-label={`比较模型 ${index + 1} 展示名称`}
                placeholder="展示名称（可选）"
                maxLength={80}
                disabled={disabled}
                value={choice.label ?? ""}
                onChange={(event) =>
                  onChange?.(
                    choices.map((item) =>
                      item.id === choice.id
                        ? { ...item, label: event.target.value }
                        : item,
                    ),
                  )
                }
              />
            </div>
          ))}
          <Space>
            <Button
              icon={<Plus size={15} />}
              disabled={disabled || choices.length >= 4}
              onClick={() =>
                onChange?.([
                  ...choices,
                  {
                    id: crypto.randomUUID(),
                    provider: "compatible",
                    modelPreset: "qwen",
                    modelName: "qwen3.8-flash",
                  },
                ])
              }
            >
              添加比较模型
            </Button>
          </Space>
        </>
      )}
    </div>
  );
}
