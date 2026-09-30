import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { Plus, RefreshCw } from "lucide-react";
import { api, send } from "../api";
import { LoadState, Panel } from "../components";
import { useGlossary } from "../help";
import {
  glossary,
  glossaryConflict,
  mergeGlossary,
  setGlossaryVisibility,
} from "../glossary-model";
import type {
  GlossaryConfiguration,
  GlossaryOverride,
} from "../glossary-model";

type GlossaryRow = ReturnType<typeof mergeGlossary>[number];
export default function AdminGlossary() {
  const [config, setConfig] = useState<GlossaryConfiguration>({
    version: 0,
    overrides: [],
  });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [editing, setEditing] = useState<GlossaryRow | null>(null),
    [open, setOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [form] = Form.useForm();
  const lock = useRef(false),
    sequence = useRef(0);
  const { message, modal } = App.useApp();
  const { refresh } = useGlossary();
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const result = await api<GlossaryConfiguration>("/admin/glossary");
      if (current === sequence.current) {
        setConfig(result);
        setError("");
      }
    } catch (e) {
      if (current === sequence.current) {
        setConfig({ version: 0, overrides: [] });
        setError((e as Error).message);
      }
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  async function save(overrides: GlossaryOverride[]) {
    if (lock.current) return false;
    const conflict = glossaryConflict(mergeGlossary(overrides));
    if (conflict) throw new Error(conflict);
    lock.current = true;
    setBusy(true);
    try {
      const result = await send<GlossaryConfiguration>(
        "/admin/glossary",
        { version: config.version, overrides },
        "PUT",
      );
      setConfig(result);
      setError("");
      await refresh();
      message.success("名词帮助已更新");
      return true;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function mutate(overrides: GlossaryOverride[]) {
    void save(overrides).catch((e) => message.error((e as Error).message));
  }
  const allRows = mergeGlossary(config.overrides, true);
  const rows = allRows.filter((entry) =>
    [entry.term, entry.category, entry.explanation, ...(entry.aliases || [])]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const categories = [...new Set(allRows.map((entry) => entry.category))];
  const without = (term: string) =>
    config.overrides.filter(
      (entry) => entry.term.toLocaleLowerCase() !== term.toLocaleLowerCase(),
    );
  function edit(entry: GlossaryRow | null) {
    setEditing(entry);
    setFormError("");
    form.resetFields();
    if (entry) form.setFieldsValue(entry);
    setOpen(true);
  }
  return (
    <>
      <Panel
        title="名词帮助配置"
        action={
          <Space wrap>
            <Button
              icon={<RefreshCw size={15} />}
              disabled={busy}
              onClick={load}
            >
              重新读取
            </Button>
            <Button
              type="primary"
              icon={<Plus size={15} />}
              disabled={loading || busy || !!error}
              onClick={() => edit(null)}
            >
              新增名词
            </Button>
          </Space>
        }
      >
        <p className="data-caption">
          保存后用于所有用户的名词悬停、长按说明和帮助中心。内置名词可编辑或隐藏，自定义名词可删除；说明按纯文本显示。只填写通用知识，不包含个人账户或财务明细。
        </p>
        <Input.Search
          className="form-alert"
          placeholder="搜索名词、别名或说明"
          aria-label="搜索可配置名词"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
        />
        <LoadState loading={loading} error={error} retry={load}>
          <Table<GlossaryRow>
            rowKey="term"
            dataSource={rows}
            pagination={{ pageSize: 15 }}
            scroll={{ x: 850 }}
            columns={[
              {
                title: "名词",
                render: (_, row) => (
                  <div className="cell-name">
                    <strong>{row.term}</strong>
                    <small>{row.aliases?.join("、")}</small>
                  </div>
                ),
              },
              { title: "分类", dataIndex: "category" },
              { title: "说明", dataIndex: "explanation", ellipsis: true },
              {
                title: "状态",
                render: (_, row) => (
                  <Space size={4}>
                    <Tag>{row.builtin ? "内置" : "自定义"}</Tag>
                    {row.hidden ? (
                      <Tag>已隐藏</Tag>
                    ) : (
                      row.customized && <Tag color="blue">已配置</Tag>
                    )}
                  </Space>
                ),
              },
              {
                title: "操作",
                render: (_, row) => (
                  <Space size={4} wrap>
                    <Button
                      type="link"
                      disabled={busy}
                      onClick={() => edit(row)}
                    >
                      编辑
                    </Button>
                    {row.builtin ? (
                      <>
                        <Button
                          type="link"
                          disabled={busy}
                          onClick={() => {
                            mutate(
                              setGlossaryVisibility(
                                config.overrides,
                                row.term,
                                !row.hidden,
                              ),
                            );
                          }}
                        >
                          {row.hidden ? "显示" : "隐藏"}
                        </Button>
                        {row.customized && (
                          <Button
                            type="link"
                            disabled={busy}
                            onClick={() => mutate(without(row.term))}
                          >
                            恢复默认
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button
                        type="link"
                        danger
                        disabled={busy}
                        onClick={() =>
                          modal.confirm({
                            title: `删除名词“${row.term}”？`,
                            content:
                              "此名词的说明和别名将不再显示，不会改变任何账目。",
                            okText: "删除名词",
                            cancelText: "取消",
                            okButtonProps: { danger: true },
                            onOk: async () => {
                              await save(without(row.term));
                            },
                          })
                        }
                      >
                        删除
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]}
          />
          <Button
            disabled={busy || !config.overrides.length}
            onClick={() =>
              modal.confirm({
                title: "恢复全部内置名词？",
                content: `将撤销 ${config.overrides.length} 项配置并删除全部自定义名词，恢复系统内置说明。`,
                okText: "恢复默认",
                cancelText: "取消",
                onOk: async () => {
                  await save([]);
                },
              })
            }
          >
            恢复全部默认
          </Button>
        </LoadState>
      </Panel>
      <Modal
        open={open}
        title={editing ? `编辑名词 · ${editing.term}` : "新增名词"}
        width={680}
        confirmLoading={busy}
        onOk={() => form.submit()}
        onCancel={() => {
          if (!lock.current) setOpen(false);
        }}
        okText="保存说明"
        cancelText="取消"
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        cancelButtonProps={{ disabled: busy }}
      >
        <Form
          form={form}
          layout="vertical"
          disabled={busy}
          onFinish={async (values) => {
            setFormError("");
            const entry: GlossaryOverride = {
              term: values.term.trim(),
              category: values.category.trim(),
              explanation: values.explanation.trim(),
              aliases: (values.aliases || []).map((label: string) =>
                label.trim(),
              ),
              example: values.example?.trim() || "",
              hidden: editing?.hidden || false,
            };
            const remaining = editing
              ? without(editing.term)
              : config.overrides;
            if (
              (!editing || !editing.builtin) &&
              glossary.some(
                (item) =>
                  item.term.toLocaleLowerCase() ===
                  entry.term.toLocaleLowerCase(),
              )
            ) {
              setFormError("此名词已内置，请在列表中编辑原词条。");
              return;
            }
            if (
              remaining.some(
                (item) =>
                  item.term.toLocaleLowerCase() ===
                  entry.term.toLocaleLowerCase(),
              )
            ) {
              setFormError("该名词已经存在，请编辑原词条。");
              return;
            }
            try {
              if (await save([...remaining, entry])) setOpen(false);
            } catch (e) {
              setFormError((e as Error).message);
            }
          }}
        >
          <Form.Item
            name="term"
            label="名词"
            rules={[
              { required: true, whitespace: true, message: "填写名词" },
              { max: 80 },
            ]}
          >
            <Input maxLength={80} readOnly={!!editing?.builtin} />
          </Form.Item>
          <Form.Item
            name="category"
            label="分类"
            rules={[
              { required: true, whitespace: true, message: "填写分类" },
              { max: 40 },
            ]}
          >
            <Input
              maxLength={40}
              list="glossary-categories"
              placeholder="选择已有分类或输入新分类"
            />
          </Form.Item>
          <datalist id="glossary-categories">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
          <Form.Item
            name="aliases"
            label="别名（输入后回车）"
            rules={[
              {
                validator: async (_, value: string[] = []) => {
                  if (
                    value.length > 20 ||
                    value.some((label) => label.length > 80)
                  )
                    throw new Error("最多 20 个别名，每个不超过 80 字");
                },
              },
            ]}
          >
            <Select mode="tags" tokenSeparators={["，", ","]} />
          </Form.Item>
          <Form.Item
            name="explanation"
            label="详细说明"
            rules={[
              { required: true, whitespace: true, message: "填写详细说明" },
              { max: 4000 },
            ]}
          >
            <Input.TextArea rows={5} maxLength={4000} showCount />
          </Form.Item>
          <Form.Item
            name="example"
            label="示例（选填）"
            rules={[{ max: 2000 }]}
          >
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>
          {formError && <Alert type="error" message={formError} showIcon />}
        </Form>
      </Modal>
    </>
  );
}
