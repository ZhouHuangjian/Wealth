import { useEffect, useRef, useState } from "react";
import { Button, Input, Spin } from "antd";
import { ArrowUpRight, Globe, Search } from "lucide-react";
import { api, listOf } from "../api";
import type { Item } from "../api";
import { useDebounced, useWorkspace } from "../state";
import { catalogMarket } from "../investment";
export default function MarketSearch({
  kind,
  market,
  onSelect,
}: {
  kind: string;
  market: string;
  onSelect: (item: Item) => void;
}) {
  const { space } = useWorkspace();
  const [query, setQuery] = useState("");
  const settled = useDebounced(query, 350);
  const [items, setItems] = useState<Item[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [recognition, setRecognition] = useState<any>(null);
  const seq = useRef(0);
  async function search(remote: boolean, q = settled) {
    const token = ++seq.current;
    if (q.trim().length < 2) {
      setItems([]);
      setNotice("");
      setRecognition(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      let resolved: any = null;
      try {
        resolved = await api(`/spaces/${space.id}/market/resolve`, {
          method: "POST",
          body: JSON.stringify({ code: q.trim(), kind }),
        });
      } catch {
        /* Unrecognized names still search the public directory. */
      }
      if (token !== seq.current) return;
      const identified =
        resolved && !["unknown", "ambiguous"].includes(resolved.status);
      setRecognition(identified ? resolved : null);
      const inferredMarket =
        identified && ["CN", "HK", "US"].includes(resolved.market)
          ? resolved.market
          : catalogMarket(market);
      const result = await api(
        `/spaces/${space.id}/market/search?${new URLSearchParams({ q: q.trim(), kind: identified ? resolved.kind || kind : kind, market: inferredMarket, remote: remote ? "1" : "0" })}`,
      );
      if (token === seq.current) {
        setItems(listOf<Item>(result));
        setNotice(
          result.message ||
            (!listOf(result).length
              ? remote
                ? "没有找到匹配产品，可更换代码或市场"
                : "本地暂无匹配，可点击联网查找"
              : ""),
        );
      }
    } catch (e) {
      if (token === seq.current) setNotice((e as Error).message);
    } finally {
      if (token === seq.current) setBusy(false);
    }
  }
  useEffect(() => {
    void search(false);
    return () => {
      seq.current++;
    };
  }, [settled, kind, market, space.id]);
  return (
    <div className="product-lookup">
      <label className="lookup-label">查找产品</label>
      <div className="lookup-input">
        <Input
          aria-label="搜索产品代码或名称"
          prefix={<Search size={16} />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            kind === "option"
              ? "如 2701豆粕沽3300、m2701-P-3300"
              : kind === "index"
                ? "如 VIX、NDX、SPX"
                : "代码或名称，例如 110011、红利低波"
          }
          allowClear
          suffix={busy ? <Spin size="small" /> : undefined}
        />
        <Button
          icon={<Globe size={15} />}
          disabled={query.trim().length < 2}
          loading={busy}
          onClick={() => search(true, query)}
        >
          联网查找
        </Button>
      </div>
      <p className="data-caption">
        输入后先查已保存和缓存产品。
        {recognition
          ? ` 已识别：${recognition.market}${recognition.exchange ? ` / ${recognition.exchange}` : ""}。`
          : ""}
      </p>
      {items.length > 0 && (
        <div className="product-results">
          {items.slice(0, 12).map((r, i) => (
            <button
              type="button"
              key={`${r.code}-${i}`}
              onClick={() => {
                onSelect({
                  ...r,
                  specification: {
                    ...r.specification,
                    metadata_identity: { code: r.code, kind: r.kind },
                  },
                });
                setQuery("");
                setItems([]);
                setRecognition(null);
              }}
            >
              <span>
                <strong>{r.name}</strong>
                <small>
                  {r.code} · {r.market} · {r.currency}{" "}
                  {r.specification?.quote_unit}
                </small>
                {r.status === "unverified" && (
                  <small className="unverified-product">
                    仅识别格式 · 未验证上市与行情
                  </small>
                )}
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </div>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
