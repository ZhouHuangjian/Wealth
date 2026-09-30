import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Button, Collapse, Empty, Input, Popover, Select, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Search, X } from "lucide-react";
import {
  findGlossaryEntry,
  glossary,
  glossaryParts,
  searchGlossary,
  mergeGlossary,
} from "./glossary-model";
import type { GlossaryEntry, GlossaryConfiguration } from "./glossary-model";
import { api, ApiError } from "./api";

const GlossaryContext = createContext<{
  entries: GlossaryEntry[];
  refresh: () => Promise<void>;
}>({ entries: glossary, refresh: async () => {} });
export const useGlossary = () => useContext(GlossaryContext);
export function GlossaryProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<
    GlossaryConfiguration["overrides"]
  >([]);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await api<GlossaryConfiguration>("/glossary");
      if (current === sequence.current) setOverrides(result.overrides || []);
    } catch (error) {
      if (
        current === sequence.current &&
        error instanceof ApiError &&
        [401, 403].includes(error.status)
      )
        setOverrides([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      sequence.current++;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  const entries = useMemo(() => mergeGlossary(overrides), [overrides]);
  return (
    <GlossaryContext.Provider value={{ entries, refresh }}>
      {children}
    </GlossaryContext.Provider>
  );
}

export function TermHelp({
  term,
  entry: supplied,
  children,
}: {
  term?: string;
  entry?: GlossaryEntry;
  children?: ReactNode;
}) {
  const { entries } = useGlossary();
  const entry = supplied || findGlossaryEntry(term || "", entries);
  const [open, setOpen] = useState(false);
  const id = useId();
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  function clearHold() {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  }
  useEffect(() => clearHold, []);
  if (!entry) return <>{children || term}</>;
  return (
    <Popover
      trigger={["hover", "focus"]}
      open={open}
      onOpenChange={setOpen}
      mouseEnterDelay={0.3}
      mouseLeaveDelay={0.15}
      overlayClassName="term-help-popover"
      title={
        <div className="term-help-heading">
          <strong>{entry.term}</strong>
          <Button
            type="text"
            size="small"
            aria-label="关闭名词说明"
            icon={<X size={14} />}
            onClick={() => setOpen(false)}
          />
        </div>
      }
      content={
        <div id={id} className="term-help-content" role="note">
          <p>{entry.explanation}</p>
          {entry.example && (
            <p className="term-help-example">
              <strong>例如：</strong>
              {entry.example}
            </p>
          )}
        </div>
      }
    >
      <span
        className="term-help"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.stopPropagation();
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return;
          clearHold();
          pressed.current = false;
          origin.current = { x: event.clientX, y: event.clientY };
          hold.current = setTimeout(() => {
            pressed.current = true;
            setOpen(true);
          }, 500);
        }}
        onPointerMove={(event) => {
          if (
            Math.hypot(
              event.clientX - origin.current.x,
              event.clientY - origin.current.y,
            ) > 10
          )
            clearHold();
        }}
        onPointerUp={clearHold}
        onPointerCancel={() => {
          clearHold();
          pressed.current = false;
        }}
        onContextMenu={(event) => {
          if (pressed.current) event.preventDefault();
        }}
      >
        {children || term || entry.term}
      </span>
    </Popover>
  );
}

/** Wrap only explicitly supplied static labels; never inspect DOM or private values. */
export function HelpText({
  text,
  children,
}: {
  text?: ReactNode;
  children?: ReactNode;
}) {
  const { entries } = useGlossary();
  const value = text ?? children;
  if (typeof value !== "string") return <>{value}</>;
  return (
    <>
      {glossaryParts(value, entries).map((part, index) =>
        part.entry ? (
          <TermHelp key={index} entry={part.entry}>
            {part.text}
          </TermHelp>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

export function helpColumns<T extends object>(
  columns: ColumnsType<T>,
): ColumnsType<T> {
  return columns.map((column) => ({
    ...column,
    title:
      typeof column.title === "string" ? (
        <HelpText text={column.title} />
      ) : (
        column.title
      ),
    ...("children" in column ? { children: helpColumns(column.children) } : {}),
  }));
}

export function GlossaryDirectory() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const { entries: vocabulary } = useGlossary();
  const entries = searchGlossary(query, category, vocabulary);
  return (
    <div className="glossary-directory">
      <p className="data-caption">
        带点状下划线的名词可以悬停、点击或长按查看说明；键盘 Tab 聚焦后按 Enter
        查看，Esc 关闭。
      </p>
      <Space wrap className="glossary-search">
        <Input
          aria-label="搜索名词说明"
          placeholder="搜索净资产、分红、期权、邀请码…"
          prefix={<Search size={16} />}
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          aria-label="名词分类"
          value={category}
          onChange={setCategory}
          options={[
            "全部",
            ...new Set(vocabulary.map((entry) => entry.category)),
          ].map((value) => ({ value, label: value }))}
        />
        <span className="data-caption">{entries.length} 个名词</span>
      </Space>
      {entries.length ? (
        <Collapse
          items={entries.map((entry) => ({
            key: entry.term,
            label: (
              <span>
                {entry.term}
                <small className="glossary-category">{entry.category}</small>
              </span>
            ),
            children: (
              <div className="glossary-description">
                <p>{entry.explanation}</p>
                {entry.example && (
                  <p>
                    <strong>例如：</strong>
                    {entry.example}
                  </p>
                )}
                {entry.aliases?.length && (
                  <small>相关写法：{entry.aliases.join("、")}</small>
                )}
              </div>
            ),
          }))}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="没有匹配的名词，试试产品类型或关键词"
        />
      )}
    </div>
  );
}
