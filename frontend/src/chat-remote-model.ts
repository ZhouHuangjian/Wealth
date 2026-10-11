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
};
export type RemoteConversation = {
  id: string;
  externalId: string;
  name: string;
  note: string;
  autoReplyEnabled: boolean;
  enabled: boolean;
};
export type RemoteCommand = {
  id: string;
  type:
    | "settings.patch"
    | "contacts.search"
    | "conversation.add"
    | "conversation.patch";
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
  };
  error: string;
};
export type RemoteSnapshot = {
  version: 1;
  remoteEnabled: boolean;
  settings: RemoteSettings;
  conversations: RemoteConversation[];
  capabilities: { wechatAvailable: boolean; codexAvailable: boolean };
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
export function changedRemoteSettings(
  current: RemoteSettings,
  edited: RemoteSettings,
): Partial<RemoteSettings> {
  // Explicit keys keep any future secret or URL fields out of remote requests.
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
  ] as const;
  return Object.fromEntries(
    keys
      .filter((key) => edited[key] !== current[key])
      .map((key) => [key, edited[key]]),
  );
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
};
export const remoteCommandStates: Record<RemoteCommand["status"], string> = {
  pending: "等待 Mac 接收",
  delivered: "Mac 已接收，等待结果",
  succeeded: "已完成",
  failed: "执行失败",
  expired: "已过期，请重新操作",
  cancelled: "已取消",
};
