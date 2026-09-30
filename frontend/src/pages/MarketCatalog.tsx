import { helpColumns } from "../help";
import { useState } from "react";
import type { Key } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import { api, listOf, send } from "../api";
import type { Item } from "../api";
import { investmentKinds, catalogMarket } from "../investment";
import { LoadState } from "../components";
import { useDebounced, useResource, useWorkspace } from "../state";
function identity(r: any) {
  return `${r.kind}|${catalogMarket(r.market || "CN")}|${String(r.code).toUpperCase()}`;
}
export default function MarketCatalog({
  onClose,
  existing,
}: {
  onClose: () => void;
  existing: Item[];
}) {
  const { space, reload } = useWorkspace();
  const { message } = App.useApp();
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState(""),
    [market, setMarket] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<Record<string, Item>>({}),
    [busy, setBusy] = useState(false),
    [showHome, setShowHome] = useState(true),
    [results, setResults] = useState<
      { name: string; success: boolean; message: string }[]
    >([]);
  const q = useDebounced(query);
  const state = useResource(
    "market/catalog",
    `?${new URLSearchParams({ q, kind, market, offset: String((page - 1) * 20), limit: "20" })}`,
  );
  const rows = listOf<Item>(state.data).map((r) => ({
    ...r,
    rowKey: identity(r),
  }));
  const known = new Set(existing.map(identity));
  async function add() {
    setBusy(true);
    const done: typeof results = [];
    const remaining = { ...selected };
    for (const [key, r] of Object.entries(selected)) {
      if (known.has(key)) {
        delete remaining[key];
        continue;
      }
      try {
        await send(`/spaces/${space.id}/market-watchlist`, {
          product: {
            code: r.code,
            name: r.name,
            kind: r.kind,
            market: r.market,
            currency: r.currency,
            specification: r.specification || {},
          },
          enabled: true,
          show_on_home: showHome,
          lookback_days: 365,
        });
        known.add(key);
        delete remaining[key];
        done.push({ name: r.name, success: true, message: "已加入" });
      } catch (e) {
        done.push({
          name: r.name,
          success: false,
          message: (e as Error).message,
        });
      }
    }
    setResults(done);
    setSelected(remaining);
    setBusy(false);
    reload();
    if (done.some((r) => r.success))
      message.success(
        `已添加 ${done.filter((r) => r.success).length} 项，行情将后台更新`,
      );
  }
  return (
    <Drawer
      title="公开产品候选目录"
      width={980}
      open
      onClose={() => !busy && onClose()}
      extra={
        <Button
          type="primary"
          loading={busy}
          disabled={!Object.keys(selected).length}
          onClick={add}
        >
          加入所选 {Object.keys(selected).length || ""} 项
        </Button>
      }
    >
      <p className="data-caption">
        浏览已缓存的公开产品与指数，支持多选；这里不会创建持仓或启用交易提醒。目录缺少的产品仍可通过“添加关注”联网查找。
      </p>
      <Space wrap className="table-toolbar">
        <Input
          aria-label="搜索候选目录"
          placeholder="名称、代码或别名"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          allowClear
        />
        <Select
          aria-label="候选产品分类"
          value={kind}
          style={{ width: 145 }}
          onChange={(v) => {
            setKind(v);
            setPage(1);
          }}
          options={[
            { value: "", label: "全部类型" },
            ...Object.entries(investmentKinds).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <Select
          aria-label="候选市场"
          value={market}
          style={{ width: 130 }}
          onChange={(v) => {
            setMarket(v);
            setPage(1);
          }}
          options={[
            { value: "", label: "全部市场" },
            { value: "CN", label: "境内" },
            { value: "HK", label: "香港" },
            { value: "US", label: "美国" },
          ]}
        />
        <span>
          加入后在首页显示{" "}
          <Switch
            checked={showHome}
            onChange={setShowHome}
            aria-label="批量关注显示首页"
          />
        </span>
      </Space>
      <LoadState {...state}>
        <Table<Item>
          rowKey="rowKey"
          dataSource={rows}
          scroll={{ x: 650 }}
          rowSelection={{
            selectedRowKeys: Object.keys(selected),
            preserveSelectedRowKeys: true,
            getCheckboxProps: (r) => ({
              disabled:
                busy || known.has(identity(r)) || r.status === "unverified",
            }),
            onChange: (keys: Key[], current) => {
              const merged = { ...selected };
              current.forEach((r) => {
                if (r) merged[identity(r)] = r;
              });
              const allowed = new Set(keys.map(String));
              setSelected(
                Object.fromEntries(
                  Object.entries(merged).filter(([k]) => allowed.has(k)),
                ),
              );
            },
          }}
          pagination={{
            current: page,
            pageSize: 20,
            total: state.data?.count ?? state.data?.total ?? rows.length,
            onChange: setPage,
            showSizeChanger: false,
          }}
          columns={helpColumns<Item>([
            {
              title: "产品",
              render: (_, r) => (
                <div className="cell-name">
                  <strong>{r.name}</strong>
                  <small>
                    {r.code} · {r.specification?.exchange || r.market}
                  </small>
                </div>
              ),
            },
            {
              title: "类型",
              render: (_, r) => investmentKinds[r.kind] || r.kind,
            },
            {
              title: "币种 / 单位",
              render: (_, r) =>
                r.kind === "index"
                  ? r.specification?.quote_unit || "点"
                  : `${r.currency} ${r.specification?.quote_unit || ""}`,
            },
            { title: "目录来源", render: (_, r) => r.source || "公共目录" },
            {
              title: "状态",
              render: (_, r) =>
                known.has(identity(r)) ? (
                  <Tag>已关注</Tag>
                ) : r.status === "unverified" ? (
                  <Tag>仅格式识别</Tag>
                ) : (
                  <Tag color="green">可加入</Tag>
                ),
            },
          ])}
        />
      </LoadState>
      {results.length > 0 && (
        <div className="form-alert">
          <h3>添加结果</h3>
          {results.map((r, i) => (
            <Alert
              key={i}
              type={r.success ? "success" : "warning"}
              message={`${r.name}：${r.message}`}
            />
          ))}
          {results.some((r) => !r.success) && (
            <p className="data-caption">
              未成功项目仍保留选择，可修正后重试；已成功项目不会再次提交。
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}
