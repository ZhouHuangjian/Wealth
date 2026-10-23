import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** All messages stay available; only the visible variable-height rows mount. */
export function VirtualMessageList<T extends { id: string }>({
  items,
  header,
  empty,
  footer,
  renderItem,
}: {
  items: T[];
  header: ReactNode;
  empty: ReactNode;
  footer: ReactNode;
  renderItem: (item: T, index: number) => ReactNode;
}) {
  const parent = useRef<HTMLDivElement>(null),
    initialized = useRef(false),
    [nearEnd, setNearEnd] = useState(true);
  const large = items.length > 80;
  const virtual = useVirtualizer({
    count: items.length + 1,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (i ? 160 : 36),
    getItemKey: useCallback(
      (i: number) => (i ? items[i - 1].id : "conversation-header"),
      [items],
    ),
    overscan: 8,
    enabled: large,
    initialOffset: () => (large ? items.length * 160 : 0),
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 96,
    useFlushSync: false,
  });
  const latest = () => {
    if (large) virtual.scrollToIndex(items.length, { align: "end" });
    else parent.current?.scrollTo({ top: parent.current.scrollHeight });
  };
  useLayoutEffect(() => {
    if (!initialized.current || nearEnd) {
      // Wait for the scroll viewport and virtual canvas to commit their size.
      // An initial synchronous scroll can be clamped while the viewport is hidden.
      const frame = requestAnimationFrame(() => {
        latest();
        initialized.current = true;
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [items.at(-1)?.id, large]);
  return (
    <div
      className="messages virtual-messages"
      ref={parent}
      role="log"
      tabIndex={0}
      aria-label="完整聊天记录"
      onScroll={() => {
        const el = parent.current;
        if (el)
          setNearEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 96);
      }}
    >
      {large ? (
        <div
          className="virtual-message-canvas"
          style={{
            height: virtual.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtual.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtual.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${row.start}px)`,
              }}
            >
              {row.index
                ? renderItem(items[row.index - 1], row.index - 1)
                : header}
            </div>
          ))}
        </div>
      ) : (
        <>
          {header}
          {items.map(renderItem)}
          {empty}
        </>
      )}
      {footer}
      {items.length > 0 && !nearEnd && (
        <button className="jump-to-latest" type="button" onClick={latest}>
          回到最新消息 · 共 {items.length} 条
        </button>
      )}
    </div>
  );
}
