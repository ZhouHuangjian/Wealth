import type {
  RemoteCurrentView,
  RemoteCurrentConversation,
} from "./chat-current-model";

export type RemoteModelChoice = {
  id: string;
  provider: "demo" | "ollama" | "compatible" | "codex";
  modelName: string;
  modelPreset?: "custom" | "qwen";
  label?: string;
};
export type RemoteModelSettings = {
  provider: "qwen" | "compatible" | "codex" | "disabled";
  modelName: string;
  thinkingEnabled?: boolean;
};
export type RemoteModelOption = {
  id: string;
  label: string;
  inputModalities: ("text" | "image")[];
};
export function remoteModelOptions(
  provider: string,
  role: "reply" | "vision" | "audio" | "analysis" | "memory",
  codexModels: RemoteModelOption[] = [],
): RemoteModelOption[] {
  if (provider === "codex")
    return role === "audio"
      ? []
      : codexModels.filter((model) =>
          model.inputModalities.includes(role === "vision" ? "image" : "text"),
        );
  if (provider !== "qwen") return [];
  return (
    role === "audio"
      ? ["qwen3.8-omni-flash"]
      : [
          "qwen3.8-flash",
          "qwen3.8-max",
          "qwen3.7-plus",
          "qwen3.7-max",
          "qwen3.7-flash",
        ]
  ).map((id) => ({ id, label: id, inputModalities: ["text"] }));
}
export type RemoteProcessing = {
  replyModels?: RemoteModelChoice[] | null;
  autoRecognizeImages?: boolean;
  autoTranscribeVoice?: boolean;
  intentEnabled?: boolean;
  affinityEnabled?: boolean;
  memoryEnabled?: boolean;
  autoAnalyzeMessages?: boolean;
  autoCompressMemory?: boolean;
  analysisModel?: RemoteModelChoice | null;
  memoryModel?: RemoteModelChoice | null;
};
export type RemoteBasisFact = {
  id: string;
  category:
    | "current_status"
    | "interest"
    | "preference"
    | "fact"
    | "boundary"
    | "plan";
  content: string;
  sourceNote: string;
  origin?: "manual" | "model";
  createdAt: string;
  updatedAt: string;
};
export type RemoteMemoryEntry = {
  id: string;
  kind: "fact" | "event" | "preference" | "openTopic";
  text: string;
  status: "pending" | "approved" | "rejected";
  origin?: "manual" | "model";
  createdAt: string;
  updatedAt?: string;
};
export type RemoteProfile = {
  id: string;
  revision: string;
  basisFacts: RemoteBasisFact[];
  memory: {
    summary: string;
    openTopics: string[];
    entries: RemoteMemoryEntry[];
    provider: string;
    modelName: string;
    updatedAt: string;
    summaryOrigin?: "manual" | "model";
    openTopicsOrigin?: "manual" | "model";
  } | null;
};
export type RemoteSettings = {
  provider: "demo" | "ollama" | "compatible" | "codex";
  modelName: string;
  autoReplyEnabled: boolean;
  syncDraftsEnabled: boolean;
  replyDelaySeconds: number;
  cooldownSeconds: number;
  dailyLimit: number;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  revision?: string;
  modelPreset?: "custom" | "qwen";
  replyModels?: RemoteModelChoice[];
  vision?: RemoteModelSettings;
  audio?: RemoteModelSettings;
  analysis?: RemoteModelSettings;
  memory?: RemoteModelSettings;
};
export type RemoteConversation = {
  id: string;
  externalId: string;
  name: string;
  note: string;
  autoReplyEnabled: boolean;
  enabled: boolean;
  processing?: RemoteProcessing;
  affinity?: number | null;
  affinityUpdatedAt?: string | null;
  basisCount?: number;
  memoryCount?: number;
  revision?: string;
};
export type RemoteCommand = {
  id: string;
  type:
    | "settings.patch"
    | "contacts.search"
    | "conversation.add"
    | "conversation.patch"
    | "conversation.profile.get"
    | "conversation.basis.add"
    | "conversation.basis.patch"
    | "conversation.basis.delete"
    | "conversation.basis.generate"
    | "conversation.memory.patch"
    | "conversation.memory.entry.add"
    | "conversation.memory.entry.patch"
    | "conversation.memory.entry.delete"
    | "conversation.memory.compress"
    | "conversation.refresh"
    | "conversation.message.analyze"
    | "conversation.drafts.generate"
    | "conversation.message.recognize";
  payload: Record<string, unknown>;
  status:
    | "pending"
    | "delivered"
    | "succeeded"
    | "failed"
    | "expired"
    | "cancelled";
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  result: {
    contacts?: { externalId: string; name: string }[];
    hasMore?: boolean;
    profile?: RemoteProfile;
    currentView?: RemoteCurrentConversation;
  };
  error: string;
};
export type RemoteSnapshot = {
  version: 1 | 2;
  remoteEnabled: boolean;
  settings: RemoteSettings;
  conversations: RemoteConversation[];
  currentView?: RemoteCurrentView;
  capabilities: {
    wechatAvailable: boolean;
    codexAvailable: boolean;
    commandTypes?: RemoteCommand["type"][];
    codexModels?: RemoteModelOption[];
  };
};
export type RemoteStatus = {
  user_id: string | number;
  device_id: string;
  snapshot: RemoteSnapshot | null;
  last_poll_at: string | null;
  commands: RemoteCommand[];
};
export function commandPending(command: RemoteCommand) {
  return command.status === "pending" || command.status === "delivered";
}
export function remoteConnectionState(status: RemoteStatus, now = Date.now()) {
  if (!status.snapshot) return "unconfigured";
  if (!status.snapshot.remoteEnabled) return "disabled";
  const last = Date.parse(status.last_poll_at || "");
  return Number.isFinite(last) && now - last >= -60_000 && now - last <= 60_000
    ? "online"
    : "offline";
}
const copyModelChoice = (choice: RemoteModelChoice): RemoteModelChoice => ({
  id: choice.id,
  provider: choice.provider,
  modelName: choice.modelName,
  ...(choice.modelPreset !== undefined
    ? { modelPreset: choice.modelPreset }
    : {}),
  ...(choice.label !== undefined ? { label: choice.label } : {}),
});
export function changedRemoteSettings(
  current: RemoteSettings,
  edited: RemoteSettings,
): Partial<RemoteSettings> {
  // Construct nested allowlists too; remote requests never carry keys or URLs.
  const keys = [
    "provider",
    "modelName",
    "autoReplyEnabled",
    "syncDraftsEnabled",
    "replyDelaySeconds",
    "cooldownSeconds",
    "dailyLimit",
    "quietHoursEnabled",
    "quietStart",
    "quietEnd",
    "modelPreset",
  ] as const;
  const result: Partial<RemoteSettings> = Object.fromEntries(
    keys
      .filter(
        (key) => edited[key] !== undefined && edited[key] !== current[key],
      )
      .map((key) => [key, edited[key]]),
  );
  if (edited.replyModels !== undefined) {
    const choices = edited.replyModels.map(copyModelChoice);
    if (JSON.stringify(choices) !== JSON.stringify(current.replyModels ?? []))
      result.replyModels = choices;
  }
  for (const kind of ["vision", "audio", "analysis", "memory"] as const) {
    const value = edited[kind];
    if (!value) continue;
    const projected = {
      provider: value.provider,
      modelName: value.modelName,
      ...(value.thinkingEnabled !== undefined
        ? { thinkingEnabled: value.thinkingEnabled }
        : {}),
    };
    if (JSON.stringify(projected) !== JSON.stringify(current[kind]))
      result[kind] = projected;
  }
  return result;
}
export function changedRemoteConversation(
  current: RemoteConversation,
  edited: RemoteConversation,
): Record<string, unknown> {
  const result: Record<string, unknown> = { id: current.id };
  for (const key of ["name", "note", "enabled", "autoReplyEnabled"] as const) {
    const value = key === "name" ? edited.name.trim() : edited[key];
    if (value !== undefined && value !== current[key]) result[key] = value;
  }
  const processing: RemoteProcessing = {};
  for (const key of [
    "autoRecognizeImages",
    "autoTranscribeVoice",
    "intentEnabled",
    "affinityEnabled",
    "memoryEnabled",
    "autoAnalyzeMessages",
    "autoCompressMemory",
  ] as const) {
    const value = edited.processing?.[key];
    if (value !== undefined && value !== !!current.processing?.[key])
      processing[key] = value;
  }
  for (const key of ["replyModels", "analysisModel", "memoryModel"] as const) {
    const value = edited.processing?.[key];
    if (value === undefined) continue;
    const projected =
      value === null
        ? null
        : Array.isArray(value)
          ? value.map(copyModelChoice)
          : copyModelChoice(value);
    if (
      JSON.stringify(projected) !==
      JSON.stringify(current.processing?.[key] ?? null)
    )
      Object.assign(processing, { [key]: projected });
  }
  if (Object.keys(processing).length) result.processing = processing;
  return result;
}
export function supportsRemoteCommand(
  snapshot: RemoteSnapshot | null | undefined,
  type: RemoteCommand["type"],
) {
  if (!snapshot) return false;
  if (snapshot.version === 1)
    return [
      "settings.patch",
      "contacts.search",
      "conversation.add",
      "conversation.patch",
    ].includes(type);
  return snapshot.capabilities.commandTypes?.includes(type) === true;
}
export function remoteResponseMatches(
  response: { user_id: string | number; device_id?: string },
  userId: string,
  deviceId: string,
) {
  return (
    String(response.user_id) === String(userId) &&
    (response.device_id === undefined || response.device_id === deviceId)
  );
}
export const remoteCommandLabels: Record<RemoteCommand["type"], string> = {
  "settings.patch": "更新本地配置",
  "contacts.search": "搜索微信联系人",
  "conversation.add": "添加聊天人员",
  "conversation.patch": "更新会话设置",
  "conversation.profile.get": "读取对方档案与记忆",
  "conversation.basis.add": "补充对方档案",
  "conversation.basis.patch": "修改对方档案",
  "conversation.basis.delete": "删除档案条目",
  "conversation.basis.generate": "用模型整理对方档案",
  "conversation.memory.patch": "修改记忆摘要",
  "conversation.memory.entry.add": "补充记忆条目",
  "conversation.memory.entry.patch": "修改记忆条目",
  "conversation.memory.entry.delete": "删除记忆条目",
  "conversation.memory.compress": "用模型压缩对话记忆",
  "conversation.refresh": "读取最新会话",
  "conversation.message.analyze": "分析这条消息",
  "conversation.drafts.generate": "生成回复草稿",
  "conversation.message.recognize": "解析这条媒体消息",
};
export const remoteCommandStates: Record<RemoteCommand["status"], string> = {
  pending: "等待 Mac 接收",
  delivered: "Mac 已接收，等待结果",
  succeeded: "已完成",
  failed: "执行失败",
  expired: "已过期，请重新操作",
  cancelled: "已取消",
};
