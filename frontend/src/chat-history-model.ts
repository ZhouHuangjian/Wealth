import type {
  RemoteCurrentConversation,
  RemoteCurrentMessage,
} from "./chat-current-model";
import type { RemoteConversation, RemoteStatus } from "./chat-remote-model";

export type HistoryReadProgress = {
  status: "pending" | "running" | "complete" | "error";
  scanned: number;
  added: number;
  lastCheckedAt: string | null;
  detail: string;
};
export type HistoryContact = {
  id: string;
  name: string;
  note: string;
  messageCount: number;
  lastMessageAt: string | null;
  lastSequence: number | null;
  updatedAt: string;
  enabled?: boolean;
  autoReplyEnabled?: boolean;
  processing?: { intentEnabled?: boolean; affinityEnabled?: boolean };
  history?: HistoryReadProgress;
};
export type HistoryProgress = {
  streamId: string | null;
  ackSeq: number;
  phase: "unknown" | "backfill" | "live";
  totalConversations: number;
  totalMessages: number;
  expectedConversations: number | null;
  expectedMessages: number | null;
  lastSyncedAt: string | null;
};
export type HistoryPage<T> = {
  user_id: string | number;
  version: 1;
  device_id: string;
  conversationId: string | null;
  historyRevision: number;
  items: T[];
  next_cursor: string | null;
  total: number;
  progress: HistoryProgress;
};
export type MessageHistory = HistoryPage<RemoteCurrentMessage>;

export function historyResponseMatches(
  page: Pick<HistoryPage<unknown>, "user_id" | "device_id" | "conversationId">,
  userId: string,
  deviceId: string,
  conversationId: string | null,
) {
  return (
    String(page.user_id) === String(userId) &&
    page.device_id === deviceId &&
    page.conversationId === conversationId
  );
}

export function mergeHistoryPage(
  previous: MessageHistory | null,
  received: MessageHistory,
  older: boolean,
): MessageHistory {
  const sameScope =
    previous &&
    historyResponseMatches(
      previous,
      String(received.user_id),
      received.device_id,
      received.conversationId,
    );
  if (!sameScope || previous.historyRevision !== received.historyRevision)
    return received;
  // Replacing with the first page also removes deleted messages. A stable revision
  // permits retaining already loaded older pages, while updating analysis in place.
  const ids = new Map(previous.items.map((item) => [item.id, item]));
  for (const item of received.items) ids.set(item.id, item);
  return {
    ...received,
    items: [...ids.values()].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
    ),
    next_cursor: older ? received.next_cursor : previous.next_cursor,
  };
}

export function historyPeople(
  contacts: HistoryContact[],
  snapshotPeople: RemoteConversation[],
): RemoteConversation[] {
  return contacts.map((contact) => {
    const existing = snapshotPeople.find((person) => person.id === contact.id);
    return {
      externalId: "",
      autoReplyEnabled: false,
      enabled: false,
      ...existing,
      id: contact.id,
      name: contact.name,
      note: contact.note,
      ...(contact.enabled !== undefined ? { enabled: contact.enabled } : {}),
      ...(contact.autoReplyEnabled !== undefined
        ? { autoReplyEnabled: contact.autoReplyEnabled }
        : {}),
      processing: { ...existing?.processing, ...contact.processing },
    };
  });
}

export function historyCurrent(
  status: RemoteStatus | null,
  person: RemoteConversation | undefined,
  history: MessageHistory | null,
): RemoteCurrentConversation | undefined {
  if (!person || !status?.snapshot?.remoteEnabled) return undefined;
  let current = status.snapshot.currentView?.conversations.find(
    (item) => item.conversationId === person.id,
  );
  // Archive contacts can be outside the bounded recent activity snapshot.
  for (const command of status.commands) {
    const receipt = command.result.currentView;
    if (
      command.status === "succeeded" &&
      receipt?.conversationId === person.id &&
      (!current || Date.parse(receipt.syncedAt) > Date.parse(current.syncedAt))
    )
      current = receipt;
  }
  if (
    !history ||
    !historyResponseMatches(
      history,
      String(status.user_id),
      status.device_id,
      person.id,
    )
  )
    return current;
  return {
    ...current,
    conversationId: person.id,
    revision: current?.revision ?? "",
    syncedAt: history.progress.lastSyncedAt ?? current?.syncedAt ?? "",
    messages: history.items,
    drafts: current?.drafts ?? [],
    truncated: false,
  };
}

export function historyReadLabel(progress: HistoryReadProgress | undefined) {
  if (!progress) return "等待 Mac 上报完整历史读取状态";
  if (progress.status === "complete")
    return `本机可用历史已全部读取 · 累计检查 ${progress.scanned} 条`;
  if (progress.status === "error")
    return `历史读取中断，可继续 · 已检查 ${progress.scanned} 条`;
  return `正在补齐历史 · 已检查 ${progress.scanned} 条`;
}
