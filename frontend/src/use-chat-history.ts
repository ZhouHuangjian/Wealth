import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { historyResponseMatches, mergeHistoryPage } from "./chat-history-model";
import type {
  HistoryContact,
  HistoryPage,
  HistoryProgress,
  MessageHistory,
} from "./chat-history-model";

type Directory = {
  mode: "loading" | "ready" | "legacy" | "waiting" | "error";
  contacts: HistoryContact[];
  progress: HistoryProgress | null;
};
const emptyDirectory = (): Directory => ({
  mode: "loading",
  contacts: [],
  progress: null,
});

export function useChatHistory({
  userId,
  deviceId,
  conversationId,
  enabled,
  onPrivateError,
  onAccessError,
}: {
  userId: string;
  deviceId?: string;
  conversationId?: string;
  enabled: boolean;
  onPrivateError: () => void;
  onAccessError: (reason: unknown) => void;
}) {
  const [directory, setDirectory] = useState<Directory>(emptyDirectory);
  const [page, setPage] = useState<MessageHistory | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onPrivateError, onAccessError });
  callbacks.current = { onPrivateError, onAccessError };
  const pageRef = useRef(page);
  pageRef.current = page;
  const loadMore = useRef<() => Promise<void>>(async () => {});
  const scope = `${userId}:${deviceId ?? ""}:${enabled}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const selectedRef = useRef(conversationId);
  selectedRef.current = conversationId;
  // Store the owning scope alongside the data: no previous account/device content
  // is exposed during the render before an effect's cleanup has run.
  const [directoryScope, setDirectoryScope] = useState("");
  const [pageScope, setPageScope] = useState("");
  const [pagePerson, setPagePerson] = useState<string>();

  useEffect(() => {
    const requestScope = scope;
    const controller = new AbortController();
    let running = false;
    const valid = () =>
      !controller.signal.aborted && scopeRef.current === requestScope;
    setDirectory(emptyDirectory());
    setDirectoryScope(requestScope);
    setError("");
    if (!enabled || !deviceId) return () => controller.abort();
    const read = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const contacts: HistoryContact[] = [];
        let before: string | null = null;
        const cursors = new Set<string>();
        let result: HistoryPage<HistoryContact>;
        do {
          result = await api<HistoryPage<HistoryContact>>(
            `/chat/devices/${encodeURIComponent(deviceId)}/history?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`,
            { signal: controller.signal },
          );
          if (!valid()) return;
          if (!historyResponseMatches(result, userId, deviceId, null)) {
            setDirectory(emptyDirectory());
            callbacks.current.onPrivateError();
            return;
          }
          contacts.push(...result.items);
          before = result.next_cursor;
          if (before && cursors.has(before))
            throw new Error("联系人分页位置重复，请刷新重试");
          if (before) cursors.add(before);
        } while (before);
        if (!valid()) return;
        setDirectory({
          mode: result.progress.streamId ? "ready" : "waiting",
          contacts: [
            ...new Map(
              contacts.map((contact) => [contact.id, contact]),
            ).values(),
          ],
          progress: result.progress,
        });
        setError("");
      } catch (reason) {
        if (!valid()) return;
        if (reason instanceof ApiError && [404, 405].includes(reason.status)) {
          setDirectory({ mode: "legacy", contacts: [], progress: null });
        } else {
          if (
            reason instanceof ApiError &&
            [401, 403, 409, 410].includes(reason.status)
          ) {
            setDirectory(emptyDirectory());
            setPage(null);
            if ([401, 403].includes(reason.status))
              callbacks.current.onAccessError(reason);
          } else setDirectory((previous) => ({ ...previous, mode: "error" }));
          setError((reason as Error).message);
        }
      } finally {
        running = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    const visibility = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [scope, enabled, deviceId, userId, refresh]);

  const directoryReady =
    enabled &&
    directoryScope === scope &&
    (directory.mode === "ready" ||
      (directory.mode === "error" && !!directory.progress?.streamId));
  const contactExists =
    directoryReady &&
    directory.contacts.some((contact) => contact.id === conversationId);
  useEffect(() => {
    const requestScope = scope;
    const person = conversationId;
    const controller = new AbortController();
    let running = false;
    const valid = () =>
      !controller.signal.aborted &&
      scopeRef.current === requestScope &&
      selectedRef.current === person;
    setPage(null);
    pageRef.current = null;
    setPageScope(requestScope);
    setPagePerson(person);
    setNotice("");
    setLoading(false);
    setLoadingOlder(false);
    loadMore.current = async () => {};
    if (!contactExists || !deviceId || !person) return () => controller.abort();
    const read = async (older = false) => {
      if (running || !valid() || document.visibilityState !== "visible") return;
      const before = older ? pageRef.current?.next_cursor : null;
      if (older && !before) return;
      running = true;
      if (older) setLoadingOlder(true);
      else setLoading(true);
      try {
        let result: MessageHistory;
        let reset = false;
        const path = `/chat/devices/${encodeURIComponent(deviceId)}/history?conversationId=${encodeURIComponent(person)}&limit=50`;
        try {
          result = await api<MessageHistory>(
            `${path}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
            { signal: controller.signal },
          );
        } catch (reason) {
          if (!valid()) return;
          if (
            reason instanceof ApiError &&
            reason.status === 409 &&
            reason.code === "history_page_stale"
          ) {
            result = await api<MessageHistory>(path, {
              signal: controller.signal,
            });
            reset = true;
          } else throw reason;
        }
        if (!valid()) return;
        if (!historyResponseMatches(result, userId, deviceId, person)) {
          setPage(null);
          callbacks.current.onPrivateError();
          return;
        }
        const previous = pageRef.current;
        const changed =
          previous && previous.historyRevision !== result.historyRevision;
        if (reset || (changed && previous.items.length > 50))
          setNotice("历史记录有更新，已重新载入最新一页，可继续查看更早消息。");
        const next = mergeHistoryPage(
          reset ? null : previous,
          result,
          older && !reset,
        );
        pageRef.current = next;
        setPage(next);
        setError("");
      } catch (reason) {
        if (!valid()) return;
        if (
          reason instanceof ApiError &&
          [401, 403, 404, 409, 410].includes(reason.status)
        ) {
          setPage(null);
          pageRef.current = null;
          if ([401, 403].includes(reason.status))
            callbacks.current.onAccessError(reason);
        }
        setError((reason as Error).message);
      } finally {
        running = false;
        if (valid()) {
          setLoading(false);
          setLoadingOlder(false);
        }
      }
    };
    loadMore.current = () => read(true);
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [scope, contactExists, deviceId, conversationId, userId, refresh]);

  return {
    directory:
      enabled && directoryScope === scope ? directory : emptyDirectory(),
    page:
      enabled && pageScope === scope && pagePerson === conversationId
        ? page
        : null,
    loading,
    loadingOlder,
    error: enabled && directoryScope === scope ? error : "",
    notice:
      enabled && pageScope === scope && pagePerson === conversationId
        ? notice
        : "",
    loadOlder: useCallback(() => loadMore.current(), []),
    refresh: useCallback(() => setRefresh((value) => value + 1), []),
  };
}
