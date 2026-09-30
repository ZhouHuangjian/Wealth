import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
  Input,
  Modal,
  Space,
  Table,
  Tag,
} from "antd";
import { useNavigate } from "react-router-dom";
import { api, ApiError, listOf, send } from "../api";
import { Panel } from "../components";
import { useWorkspace } from "../state";
import { HelpText, helpColumns } from "../help";
import { useNavigation } from "../navigation";
import {
  navigationCatalog,
  navigationHidden,
  orderedNavigation,
} from "../navigation-model";

export function InviteResult({ token }: { token: string }) {
  const { message } = App.useApp();
  return (
    <>
      <Alert
        showIcon
        message="邀请码已生成"
        description="将邀请码交给需要加入的人，对方在登录页选择“持有邀请码？创建账户并加入”，注册时填入。此码为只读权限，7 天有效，仅可使用一次。"
      />
      <Input.TextArea className="form-alert" readOnly value={token} rows={3} />
      <Button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(token);
            message.success("已复制邀请码");
          } catch {
            message.info("请选中邀请码手动复制");
          }
        }}
      >
        复制邀请码
      </Button>
    </>
  );
}
export function WorkspaceTrash({
  onChanged,
  admin = false,
}: {
  onChanged: () => void | Promise<void>;
  admin?: boolean;
}) {
  const [page, setPage] = useState(1),
    [count, setCount] = useState(0);
  const [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
    [restoringId, setRestoringId] = useState<string | null>(null);
  const [purging, setPurging] = useState<any>(null),
    [confirmName, setConfirmName] = useState(""),
    [acknowledged, setAcknowledged] = useState(false),
    [purgeError, setPurgeError] = useState(""),
    [purgeBusy, setPurgeBusy] = useState(false);
  const purgeLock = useRef(false);
  const restoreLock = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const { message } = App.useApp();
  async function load() {
    if (!mounted.current) return;
    const current = ++sequence.current;
    try {
      const result = await api(
        admin
          ? `/admin/spaces?deleted=true&limit=20&offset=${(page - 1) * 20}`
          : "/spaces/trash",
      );
      if (mounted.current && current === sequence.current) {
        setItems(listOf(result));
        setCount(result.count || listOf(result).length);
        setError("");
      }
    } catch (e) {
      if (mounted.current && current === sequence.current)
        setError((e as Error).message);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [page, admin]);
  return (
    <>
      <Panel
        title="空间回收站"
        action={
          <Button size="small" onClick={load} disabled={restoringId !== null}>
            刷新
          </Button>
        }
      >
        <p>
          删除后停止访问和自动更新。恢复后账目、成员仍保留，旧邀请码不再生效。
        </p>
        {error && <Alert type="error" message={error} />}
        <Table
          rowKey="id"
          size="small"
          pagination={
            admin
              ? {
                  current: page,
                  pageSize: 20,
                  total: count,
                  showSizeChanger: false,
                  onChange: setPage,
                }
              : { pageSize: 10 }
          }
          dataSource={items}
          columns={helpColumns<(typeof items)[number]>([
            { title: "空间", dataIndex: "name" },
            {
              title: "删除时间",
              render: (_, r) => r.deleted_at?.slice(0, 16).replace("T", " "),
            },
            {
              title: "操作",
              render: (_, r) => (
                <Space>
                  <Button
                    type="link"
                    loading={restoringId === r.id}
                    disabled={restoringId !== null || purgeBusy}
                    onClick={async () => {
                      if (restoreLock.current) return;
                      restoreLock.current = true;
                      setRestoringId(r.id);
                      try {
                        await send(
                          `${admin ? "/admin" : ""}/spaces/${r.id}/restore`,
                          {
                            version: r.version,
                          },
                        );
                        await onChanged();
                        await load();
                        message.success("空间已恢复");
                      } catch (e) {
                        message.error((e as Error).message);
                      } finally {
                        restoreLock.current = false;
                        if (mounted.current) setRestoringId(null);
                      }
                    }}
                  >
                    恢复空间
                  </Button>
                  {admin && (
                    <Button
                      type="link"
                      danger
                      disabled={restoringId !== null || purgeBusy}
                      onClick={() => {
                        setPurging(r);
                        setConfirmName("");
                        setAcknowledged(false);
                        setPurgeError("");
                      }}
                    >
                      永久删除
                    </Button>
                  )}
                </Space>
              ),
            },
          ])}
        />
      </Panel>
      {admin && (
        <Modal
          open={!!purging}
          title="永久删除回收站空间"
          onCancel={() => {
            if (!purgeLock.current) setPurging(null);
          }}
          closable={!purgeBusy}
          maskClosable={!purgeBusy}
          keyboard={!purgeBusy}
          cancelButtonProps={{ disabled: purgeBusy }}
          okText="永久删除"
          cancelText="取消"
          confirmLoading={purgeBusy}
          okButtonProps={{
            danger: true,
            disabled:
              purgeBusy || confirmName !== purging?.name || !acknowledged,
          }}
          onOk={async () => {
            if (
              purgeLock.current ||
              !purging ||
              confirmName !== purging.name ||
              !acknowledged
            )
              return;
            purgeLock.current = true;
            setPurgeBusy(true);
            setPurgeError("");
            try {
              await send(
                `/admin/spaces/${purging.id}/purge`,
                {
                  version: purging.version ?? purging.revision,
                  confirm_name: confirmName,
                },
                "DELETE",
              );
              setPurging(null);
              await load();
              await onChanged();
              message.success("空间已永久删除");
            } catch (e) {
              setPurgeError((e as Error).message);
            } finally {
              purgeLock.current = false;
              setPurgeBusy(false);
            }
          }}
        >
          <Alert
            type="warning"
            showIcon
            message="此操作无法在系统中恢复"
            description="将删除此空间的账户、账目、持仓、计划、成员关系及附件等数据；平台管理审计记录保留。"
          />
          <p>
            请输入完整空间名称：<strong>{purging?.name}</strong>
          </p>
          <Input
            value={confirmName}
            disabled={purgeBusy}
            aria-label="确认永久删除的空间名称"
            onChange={(e) => setConfirmName(e.target.value)}
          />
          <p>
            <Checkbox
              checked={acknowledged}
              disabled={purgeBusy}
              onChange={(e) => setAcknowledged(e.target.checked)}
            >
              我确认永久删除此空间，并了解无法恢复
            </Checkbox>
          </p>
          {purgeError && <Alert type="error" message={purgeError} showIcon />}
        </Modal>
      )}
    </>
  );
}
export function WorkspaceActions({
  onChanged,
  admin,
}: {
  onChanged: () => void | Promise<void>;
  admin: boolean;
}) {
  const { space } = useWorkspace();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [target, setTarget] = useState<any>(null),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const deleteLock = useRef(false);
  return (
    <>
      <Panel
        title="管理操作"
        action={
          admin ? (
            <Button onClick={() => navigate("/admin")}>进入平台管理</Button>
          ) : undefined
        }
      >
        <p>管理中心集中维护空间成员、邀请码、菜单、配置参考与数据导出。</p>
        {space.role === "owner" && (
          <Button
            danger
            onClick={async () => {
              try {
                if (admin) setTarget(await api(`/admin/spaces/${space.id}`));
                else {
                  const rows = listOf<any>(await api("/spaces"));
                  setTarget(rows.find((r) => r.id === space.id));
                }
                setName("");
                setError("");
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            删除当前空间
          </Button>
        )}
      </Panel>
      <WorkspaceTrash onChanged={onChanged} admin={admin} />
      <Modal
        title="删除空间并移入回收站"
        open={!!target}
        onCancel={() => {
          if (!deleteLock.current) setTarget(null);
        }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        cancelButtonProps={{ disabled: busy }}
        okText="移入回收站"
        okButtonProps={{
          danger: true,
          disabled: busy || name !== target?.name,
        }}
        confirmLoading={busy}
        onOk={async () => {
          if (deleteLock.current || !target || name !== target.name) return;
          deleteLock.current = true;
          setBusy(true);
          try {
            await send(
              `${admin ? "/admin" : ""}/spaces/${target.id}`,
              {
                version: target.version ?? target.revision,
                confirm_name: name,
              },
              "DELETE",
            );
            await onChanged();
            navigate("/");
            message.success("空间已移入回收站，可在管理中心恢复");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            deleteLock.current = false;
            setBusy(false);
          }
        }}
      >
        <p>
          本空间所有成员将无法继续访问，后台更新停止。账目保留，可由空间管理员或平台管理员恢复。
        </p>
        <p>
          请输入完整名称：<strong>{target?.name}</strong>
        </p>
        <Input
          aria-label="确认删除的空间名称"
          disabled={busy}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <Alert type="error" message={error} />}
      </Modal>
    </>
  );
}
export function ConfigurationPreview({ data }: { data: any }) {
  if (!data) return null;
  const dashboardNames: Record<string, string> = {
    show_market_environment: "市场环境",
    show_valuation: "分类估值",
    show_signals: "条件提醒",
  };
  const marketNames: Record<string, string> = {
    CN: "境内",
    HK: "香港",
    US: "美国",
    GLOBAL: "国际",
    SHFE: "上海期货交易所",
    INE: "上海国际能源交易中心",
    DCE: "大连商品交易所",
    CZCE: "郑州商品交易所",
    CFFEX: "中国金融期货交易所",
    GFEX: "广州期货交易所",
  };
  const kindNames: Record<string, string> = {
    fund: "基金",
    stock: "股票",
    etf: "ETF",
    future: "期货",
    option: "期权",
    index: "指数",
    gold: "黄金",
  };
  const navigation = Object.entries(data.navigation || {}).map(
    ([key, saved]) => {
      const preference = saved as { order: string[]; hidden: string[] };
      const catalog = navigationCatalog[key];
      const rows =
        catalog?.items.map(([itemKey, name]) => ({ key: itemKey, name })) ||
        [
          ...new Set([
            ...(preference.order || []),
            ...(preference.hidden || []),
          ]),
        ].map((itemKey) => ({ key: itemKey, name: itemKey }));
      const ordered = orderedNavigation(rows, preference);
      return {
        key,
        title: catalog?.title || key,
        visible: ordered
          .filter((item) => !navigationHidden(key, item.key, preference))
          .map((item) => item.name),
        hidden: ordered
          .filter((item) => navigationHidden(key, item.key, preference))
          .map((item) => item.name),
      };
    },
  );
  return (
    <>
      <Descriptions
        size="small"
        column={1}
        items={[
          {
            key: "dashboard",
            label: "首页显示",
            children: Object.entries(data.dashboard || {}).map(
              ([key, value]) => (
                <Tag key={key} color={value ? "green" : undefined}>
                  {dashboardNames[key] || key}：{value ? "显示" : "隐藏"}
                </Tag>
              ),
            ),
          },
        ]}
      />
      <h4>个人菜单</h4>
      <p className="data-caption">
        下表按实际显示顺序预览。未列出的菜单组使用系统默认顺序与显示范围；平台管理菜单不会被模板覆盖。
      </p>
      <Table<any>
        size="small"
        rowKey="key"
        pagination={false}
        dataSource={navigation}
        locale={{
          emptyText: "未设置自定义菜单，采用后使用系统默认顺序与显示范围",
        }}
        columns={helpColumns<any>([
          { title: "菜单组", dataIndex: "title", width: 160 },
          {
            title: "显示顺序",
            render: (_, row) =>
              row.visible.length
                ? row.visible
                    .map(
                      (name: string, index: number) => `${index + 1}. ${name}`,
                    )
                    .join(" → ")
                : "全部隐藏",
          },
          {
            title: "隐藏入口",
            render: (_, row) =>
              row.hidden.length ? row.hidden.join("、") : "无",
            width: 180,
          },
        ])}
      />
      <h4>标签与目标占比</h4>
      <Table<any>
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={data.tags || []}
        locale={{ emptyText: "没有可分享的标签" }}
        columns={helpColumns<any>([
          {
            title: <HelpText text="配置标签" />,
            render: (_, row) => (
              <Tag color={row.color || undefined}>{row.name}</Tag>
            ),
          },
          { title: "标签颜色", render: (_, row) => row.color || "默认颜色" },
          {
            title: <HelpText text="目标占比" />,
            render: (_, row) =>
              row.target_weight == null ? "未设置" : `${row.target_weight}%`,
          },
        ])}
      />
      <h4>市场自选</h4>
      <Table<any>
        size="small"
        rowKey={(row) =>
          `${row.product.code}:${row.product.market}:${row.product.kind}:${row.product.currency}`
        }
        pagination={{ pageSize: 5, showSizeChanger: false }}
        scroll={{ x: 660 }}
        dataSource={data.watchlist || []}
        locale={{ emptyText: "没有可分享的市场自选" }}
        columns={helpColumns<any>([
          { title: "产品", render: (_, row) => row.product.name },
          { title: "代码", render: (_, row) => row.product.code },
          {
            title: "类型",
            render: (_, row) => kindNames[row.product.kind] || row.product.kind,
          },
          {
            title: "市场 / 币种",
            render: (_, row) =>
              `${marketNames[row.product.market] || row.product.market} / ${row.product.currency}`,
          },
          {
            title: "首页显示",
            render: (_, row) => (row.show_on_home ? "显示" : "隐藏"),
          },
          {
            title: <HelpText text="回撤观察区间" />,
            render: (_, row) => `${row.lookback_days} 天`,
          },
        ])}
      />
    </>
  );
}
export function ConfigurationLibrary() {
  const { space, reload } = useWorkspace();
  const navigation = useNavigation();
  const { message } = App.useApp();
  const [data, setData] = useState<any>(null),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<any>(null),
    [sections, setSections] = useState<string[]>([]),
    [current, setCurrent] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [listLoading, setListLoading] = useState(true),
    [previewLoading, setPreviewLoading] = useState(false),
    [error, setError] = useState("");
  const listSequence = useRef(0);
  const previewSequence = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const applyLock = useRef(false);
  useEffect(() => {
    const current = ++listSequence.current;
    const controller = new AbortController();
    setListLoading(true);
    setError("");
    api(`/configuration-templates?limit=20&offset=${(page - 1) * 20}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (current === listSequence.current && !controller.signal.aborted)
          setData(result);
      })
      .catch((e) => {
        if (current === listSequence.current && !controller.signal.aborted)
          setError(e.message);
      })
      .finally(() => {
        if (current === listSequence.current && !controller.signal.aborted)
          setListLoading(false);
      });
    return () => {
      listSequence.current++;
      controller.abort();
    };
  }, [page]);
  useEffect(() => {
    setSelected(null);
    setCurrent(null);
    setSections([]);
    return () => {
      previewSequence.current++;
      previewAbort.current?.abort();
    };
  }, [space.id]);
  function clearPreview() {
    previewSequence.current++;
    previewAbort.current?.abort();
    setSelected(null);
    setCurrent(null);
    setSections([]);
    setPreviewLoading(false);
  }
  async function preview(item: any) {
    if (applyLock.current) return;
    const sequence = ++previewSequence.current;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setSelected(item);
    setSections([]);
    setCurrent(null);
    setPreviewLoading(true);
    setError("");
    try {
      const [spaces, nav] = await Promise.all([
        api("/spaces", { signal: controller.signal }),
        api("/me/navigation-preferences", { signal: controller.signal }),
      ]);
      if (sequence !== previewSequence.current || controller.signal.aborted)
        return;
      const destination = listOf<any>(spaces).find(
        (row) => row.id === space.id,
      );
      if (!destination)
        throw new Error("当前空间已不可用，请刷新或切换账簿后重试");
      setCurrent({ templateId: item.id, space: destination, navigation: nav });
    } catch (e) {
      if (sequence === previewSequence.current && !controller.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (sequence === previewSequence.current && !controller.signal.aborted)
        setPreviewLoading(false);
    }
  }
  return (
    <Panel title="配置参考">
      <p>
        预览管理员整理的方案，自行选择采用哪些设置。模板包含菜单、标签、目标占比与市场自选，不包含银行账号、余额、交易、持仓数量或私人笔记。
      </p>
      {error && !selected && <Alert type="error" message={error} />}
      <Table
        rowKey="id"
        loading={listLoading}
        dataSource={listOf<any>(data)}
        pagination={{
          current: page,
          total: data?.count || 0,
          pageSize: 20,
          onChange: setPage,
          showSizeChanger: false,
          disabled: busy,
        }}
        columns={helpColumns([
          { title: "方案", dataIndex: "title" },
          { title: "说明", dataIndex: "description" },
          {
            title: "操作",
            render: (_, r) => (
              <Button
                type="link"
                disabled={busy || listLoading}
                onClick={() => void preview(r)}
              >
                预览与选用
              </Button>
            ),
          },
        ])}
      />
      <Modal
        title={selected?.title || "配置参考"}
        open={!!selected}
        onCancel={() => {
          if (!applyLock.current) clearPreview();
        }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        cancelButtonProps={{ disabled: busy }}
        width={760}
        okText="采用所选配置"
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            busy ||
            previewLoading ||
            !current ||
            current.templateId !== selected?.id ||
            current.space.id !== space.id ||
            !sections.length ||
            space.role === "viewer",
        }}
        onOk={async () => {
          if (
            applyLock.current ||
            !selected ||
            !current ||
            current.templateId !== selected.id ||
            current.space.id !== space.id ||
            !sections.length
          )
            return;
          applyLock.current = true;
          setBusy(true);
          setError("");
          try {
            const result: any = await send(
              `/spaces/${space.id}/configuration-templates/${selected.id}/apply`,
              {
                version: selected.version,
                sections,
                space_revision: current.space.revision,
                navigation_version: current.navigation.version,
              },
            );
            await navigation
              .reload()
              .catch(() =>
                message.warning("配置已采用，菜单暂未刷新，请重新载入页面"),
              );
            reload();
            clearPreview();
            message.success(
              `已采用配置：新增 ${result.tags_added} 个标签、${result.watchlist_added} 个自选`,
            );
          } catch (e) {
            if (e instanceof ApiError && e.status === 412) setCurrent(null);
            setError((e as Error).message);
          } finally {
            applyLock.current = false;
            setBusy(false);
          }
        }}
      >
        <ConfigurationPreview data={selected?.data} />
        <Alert
          className="form-alert"
          showIcon
          message="采用前请确认"
          description="标签和自选只添加缺少项，同名项保留原设置；新增标签的目标占比与原配置合计不能超过 100%。选择菜单或首页显示会替换对应设置，个人菜单影响你的全部空间。"
        />
        {previewLoading && (
          <p className="data-caption">正在核对当前空间与个人设置…</p>
        )}
        <Checkbox.Group
          disabled={busy || previewLoading || !current}
          value={sections}
          onChange={(v) => setSections(v as string[])}
          options={[
            {
              label: "个人菜单",
              value: "navigation",
              disabled: space.role === "viewer",
            },
            {
              label: "首页显示",
              value: "dashboard",
              disabled: space.role !== "owner",
            },
            {
              label: "标签与目标占比",
              value: "tags",
              disabled: space.role !== "owner",
            },
            {
              label: "市场自选",
              value: "watchlist",
              disabled: space.role !== "owner",
            },
          ]}
        />
        {error && (
          <Alert
            className="form-alert"
            type="error"
            message={error}
            action={
              selected && !current ? (
                <Button
                  size="small"
                  disabled={busy || previewLoading}
                  onClick={() => void preview(selected)}
                >
                  重新核对当前设置
                </Button>
              ) : undefined
            }
          />
        )}
      </Modal>
    </Panel>
  );
}
