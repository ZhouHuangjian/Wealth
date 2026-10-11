export type ChatDevice = {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  config_available: boolean;
  connection_state: "awaiting_connection" | "connected" | "revoked";
};

// A list requested before a local device mutation must not undo its result.
export function reconcileDeviceList(
  current: ChatDevice[],
  received: ChatDevice[],
  requestedRevision: number,
  currentRevision: number,
) {
  return requestedRevision === currentRevision ? received : current;
}

export function deviceConnectionState(device: ChatDevice) {
  if (device.revoked_at || device.connection_state === "revoked")
    return "revoked";
  return device.last_seen_at ? "connected" : "awaiting_connection";
}

export function deviceConfigurationAction(device: ChatDevice) {
  if (deviceConnectionState(device) === "revoked") return null;
  return device.config_available ? "config" : "rotate";
}

export function chatInboxEmptyState(devices: ChatDevice[]) {
  const active = devices.filter(
    (device) => deviceConnectionState(device) !== "revoked",
  );
  if (!active.length)
    return {
      stage: "no_device" as const,
      title: "还没有添加 Mac 设备",
      description:
        "添加设备后，将连接配置导入 Mac 相知。回复草稿在 Mac 生成并同步到这里。",
      action: "添加 Mac 设备",
    };
  if (!active.some((device) => deviceConnectionState(device) === "connected"))
    return {
      stage: "awaiting_connection" as const,
      title: "设备已添加，等待 Mac 连接",
      description:
        "在“我的设备”中复制连接配置，导入 Mac 相知的设置并验证连接。无需重复添加设备。",
      action: "查看连接配置",
    };
  return {
    stage: "awaiting_drafts" as const,
    title: "Mac 已验证连接，等待回复草稿",
    description:
      "在 Mac 相知中选择会话、生成回复并开启草稿同步。收到新草稿后会自动显示在这里。",
    action: "管理我的设备",
  };
}
