import type {
  RemoteConversation,
  RemoteProfile,
  RemoteStatus,
} from "./chat-remote-model";

export type RemoteCurrentMessage = {
  id: string;
  revision: string;
  role: "self" | "peer" | "system";
  text: string;
  kind:
    | "text"
    | "image"
    | "voice"
    | "emoji"
    | "video"
    | "file"
    | "link"
    | "system"
    | "unknown";
  sentAt: string | null;
  sequence: number;
  mediaSummary?: string;
  recognition?: { provider: string; modelName: string; recognizedAt: string };
  analysis?: {
    intents: { label: string; percentage: number }[];
    affinity?: { score: number | null; confidence: number } | null;
    provider: string;
    modelName: string;
    analyzedAt: string;
    stale?: boolean;
  };
  truncated?: boolean;
};
export type RemoteCurrentDraft = {
  id: string;
  basedOnMessageId: string;
  text: string;
  label: string;
  reason: string;
  createdAt: string;
  provider: string;
  modelName?: string;
  modelChoiceId?: string;
  profileVersion?: string;
};
export type RemoteCurrentConversation = {
  conversationId: string;
  revision: string;
  syncedAt: string;
  messages: RemoteCurrentMessage[];
  drafts: RemoteCurrentDraft[];
  profile?: RemoteProfile;
  profileTruncated?: boolean;
  truncated?: boolean;
  wechat?: {
    enabled: boolean;
    status: "paused" | "reading" | "ready" | "error";
    lastCheckedAt: string | null;
    detail: string;
  };
};
export type RemoteCurrentView = {
  syncedAt: string;
  conversations: RemoteCurrentConversation[];
};

export function currentConversation(
  view: RemoteCurrentView | undefined,
  conversation: RemoteConversation | undefined,
) {
  if (!view || !conversation) return undefined;
  return view.conversations.find(
    (item) => item.conversationId === conversation.id,
  );
}

export function currentIntentLabels(message: RemoteCurrentMessage) {
  return (message.analysis?.intents ?? [])
    .slice()
    .sort((a, b) => b.percentage - a.percentage);
}

export function mergeCurrentView(
  view: RemoteCurrentView | undefined,
  received: RemoteCurrentConversation,
) {
  const items = view?.conversations ?? [];
  const existing = items.find(
    (item) => item.conversationId === received.conversationId,
  );
  if (existing && Date.parse(existing.syncedAt) > Date.parse(received.syncedAt))
    return view;
  return {
    syncedAt:
      !view || Date.parse(received.syncedAt) > Date.parse(view.syncedAt)
        ? received.syncedAt
        : view.syncedAt,
    conversations: [
      ...items.filter(
        (item) => item.conversationId !== received.conversationId,
      ),
      received,
    ],
  };
}

export function reconcileCurrentStatus(
  previous: RemoteStatus | null,
  result: RemoteStatus,
): RemoteStatus {
  if (!result.snapshot?.remoteEnabled || !result.snapshot.currentView)
    return result;
  let view = result.snapshot.currentView;
  const allowed = new Set(
    result.snapshot.conversations.map((person) => person.id),
  );
  for (const command of result.commands) {
    const received = command.result.currentView;
    if (
      command.status === "succeeded" &&
      received &&
      allowed.has(received.conversationId)
    )
      view = mergeCurrentView(view, received) ?? view;
  }
  if (
    previous &&
    String(previous.user_id) === String(result.user_id) &&
    previous.device_id === result.device_id
  ) {
    for (const received of previous.snapshot?.currentView?.conversations ??
      []) {
      if (allowed.has(received.conversationId))
        view = mergeCurrentView(view, received) ?? view;
    }
  }
  return { ...result, snapshot: { ...result.snapshot, currentView: view } };
}

export function currentDraftsAreStale(current: RemoteCurrentConversation) {
  const last = current.messages.at(-1);
  return (
    !!current.drafts.length &&
    (!last ||
      last.role !== "peer" ||
      current.drafts.some((draft) => draft.basedOnMessageId !== last.id))
  );
}

export const currentKindLabels: Record<RemoteCurrentMessage["kind"], string> = {
  text: "文字",
  image: "图片",
  voice: "语音",
  emoji: "表情",
  video: "视频",
  file: "文件",
  link: "链接",
  system: "系统消息",
  unknown: "消息",
};
