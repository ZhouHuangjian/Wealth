import { BookOpen, ChevronRight, Image, MessageCircle, Mic, Sparkles } from 'lucide-react';
import type { Conversation, Settings } from '../shared/types';

export type ModelTask = 'reply' | 'vision' | 'audio' | 'analysis' | 'memory';
type ModelSettings = Pick<Settings, 'provider' | 'modelPreset' | 'modelName' | 'replyModels' | 'vision' | 'audio' | 'analysis' | 'memory'>;
const providerLabels: Record<string, string> = { codex: 'Codex', qwen: '阿里千问', compatible: '兼容 API', ollama: 'Ollama', demo: '本地规则演示', disabled: '暂不使用' };
const taskDefinitions = [
  { id: 'reply', title: '回复草稿', detail: '主要模型与多模型比较', icon: MessageCircle },
  { id: 'vision', title: '图片与表情', detail: '图片内容与自定义表情包', icon: Image },
  { id: 'audio', title: '语音转写', detail: '将语音转成可参考的文字', icon: Mic },
  { id: 'analysis', title: '意图与好感度', detail: '理解消息与互动倾向', icon: Sparkles },
  { id: 'memory', title: '档案与记忆', detail: '整理基础信息和对话记忆', icon: BookOpen },
] as const;

export function modelAssignmentLabel(model?: { provider: string; modelName: string; modelPreset?: string }): string {
  if (!model || model.provider === 'disabled') return '暂未启用';
  const provider = model.provider === 'compatible' && model.modelPreset === 'qwen' ? 'qwen' : model.provider;
  if (provider === 'demo') return providerLabels.demo;
  return `${providerLabels[provider] || provider} · ${model.modelName || (provider === 'codex' ? '默认模型' : '待选择型号')}`;
}

/** This summary deliberately excludes URLs and credentials, including unsaved values. */
export function modelAssignments(settings: ModelSettings, conversation?: Conversation) {
  return taskDefinitions.map(task => {
    const processing = conversation?.processing;
    if (task.id === 'reply') {
      const choices = processing?.replyModels ?? settings.replyModels;
      return { ...task, custom: processing?.replyModels !== undefined,
        label: choices?.length ? choices.map(modelAssignmentLabel).join(' / ') : modelAssignmentLabel(settings),
        count: choices?.length || 1 };
    }
    const override = task.id === 'analysis' ? processing?.analysisModel : task.id === 'memory' ? processing?.memoryModel : undefined;
    return { ...task, custom: !!override, label: modelAssignmentLabel(override || settings[task.id]), count: 1 };
  });
}

export function ModelCenterOverview({ settings, selected, onSelect, disabled }: {
  settings: ModelSettings; selected: ModelTask; onSelect: (task: ModelTask) => void; disabled?: boolean;
}) {
  return <section className="model-center-overview" aria-label="模型中心">
    <div className="model-center-heading"><div><h2>模型中心</h2><p>所有模型在此分配。每项可独立选择，联系人也可以使用自己的回复、分析和记忆模型。</p></div><span>全局默认</span></div>
    <div className="model-assignment-grid">{modelAssignments(settings).map(task => <button type="button" key={task.id}
      className={`model-assignment ${selected === task.id ? 'selected' : ''}`} aria-pressed={selected === task.id}
      aria-controls={`model-editor-${task.id}`} disabled={disabled} onClick={() => onSelect(task.id)}>
      <span className="model-assignment-title"><task.icon size={16} /><strong>{task.title}</strong><ChevronRight size={14} /></span>
      <span className="model-assignment-value">{task.label}</span><small>{task.detail}{task.id === 'reply' && task.count > 1 && ` · ${task.count} 个模型比较`}</small>
    </button>)}</div>
    <p className="model-center-save-note">下方修改暂存在此页，点击“保存设置”后生效。切换功能不会清空已填写内容。</p>
  </section>;
}

export function HistoryReadProgress({ conversation, messageCount }: { conversation: Conversation; messageCount: number }) {
  if (conversation.channel !== 'wechat') return null;
  const history = conversation.wechat?.history;
  const complete = history?.status === 'complete' && !history.tail;
  const title = complete ? '本机可用历史已完整读取' : history?.status === 'error' ? '历史读取待继续'
    : history?.status === 'running' || history?.tail ? '正在补齐完整历史' : '等待补齐完整历史';
  return <div className={`history-read-progress ${complete ? 'complete' : history?.status === 'error' ? 'error' : ''}`} role="status">
    <strong>{title}</strong><span>已保存 {messageCount.toLocaleString('zh-CN')} 条消息{history && ` · 已扫描 ${history.scanned.toLocaleString('zh-CN')} 条`}</span>
    <p>{history?.detail || '点击“读取历史”从此人最早的本地记录逐步读取，过程中会自动接着补齐。'}</p>
    <small>范围为这台 Mac 微信中可读取的全部记录。分析会参考完整历史；较长的对话分段整理并保存在本机，已有结果可复用。</small>
  </div>;
}

export function ContactAnalysisProgress({ progress }: { progress: {
  feature: 'analysis' | 'memory' | 'basis'; total: number; processed: number;
  stage: 'reading' | 'summarizing' | 'generating'; updatedAt: string;
}[] }) {
  if (!progress.length) return null;
  const names = { analysis: '意图与好感度', memory: '对话记忆', basis: '基础档案' };
  return <div className="contact-analysis-progress" role="status" aria-label="全量历史分析进度">
    {progress.map(item => <div key={item.feature}><strong>{names[item.feature]} · {item.stage === 'generating' ? '正在生成最终结果' : item.stage === 'summarizing' ? '正在分段整理历史' : '正在准备完整历史'}</strong>
      <span>已处理 {Math.min(item.processed, item.total).toLocaleString('zh-CN')} / {item.total.toLocaleString('zh-CN')} 条</span>
      <small>{item.stage === 'generating' ? item.processed >= item.total ? '历史准备已结束，模型还在完成本次判断。' : '本批历史准备已结束，模型正在整理这一部分；其余历史会接着处理。' : '按完整记录逐步处理，已整理的部分会保存在本机供后续复用。'}</small>
    </div>)}
  </div>;
}
