import type { AppState, Conversation } from "../shared/types.js";
import { messageEvidenceHash } from "./contact-evidence.js";
import { safeContextText } from "./contact-model.js";

/** Retrieve event originals, never past model scores. Future updates stay hidden. */
export function eventEvidenceContext(
  state: AppState,
  conversation: Conversation,
  through = Infinity,
) {
  if (!conversation.processing?.memoryEnabled) return [];
  const messages = state.messages
    .filter(
      (m) =>
        m.conversationId === conversation.id &&
        m.role !== "system" &&
        m.sequence <= through,
    )
    .sort((a, b) => a.sequence - b.sequence);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const terms = (text: string) => {
    const chars = Array.from(text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
    return new Set(chars.slice(1).map((c, i) => chars[i] + c));
  };
  const query = terms(
    messages
      .slice(-12)
      .map((m) => m.text)
      .join(" "),
  );
  return (conversation.memory?.entries ?? [])
    .filter(
      (e) =>
        e.kind === "event" &&
        e.event &&
        e.status === "approved" &&
        e.sourceMessageIds.length &&
        [...e.sourceMessageIds, ...e.event.resolvedByMessageIds].every((id) => {
          const m = byId.get(id);
          return m && e.sourceMessageHashes?.[id] === messageEvidenceHash(m);
        }),
    )
    .map((entry) => ({
      entry,
      rank:
        (entry.event!.state === "active" ? 20 : 0) +
        (entry.event!.kind === "boundary" && entry.event!.state !== "resolved"
          ? 40
          : 0) +
        [...terms(entry.text)].filter((term) => query.has(term)).length,
    }))
    .sort(
      (a, b) =>
        b.rank - a.rank || b.entry.createdAt.localeCompare(a.entry.createdAt),
    )
    .slice(0, 12)
    .map(({ entry }) => ({
      kind: entry.event!.kind,
      state: entry.event!.state,
      confirmedByUser: true,
      originals: [
        ...new Set([
          ...entry.sourceMessageIds,
          ...entry.event!.resolvedByMessageIds,
        ]),
      ].map((id) => {
        const m = byId.get(id)!;
        return {
          id: m.id,
          speaker: m.role,
          text: safeContextText(m.text, 500),
          sentAt: m.sentAt,
        };
      }),
    }));
}
