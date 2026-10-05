import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { Eye, Plus, RefreshCw } from "lucide-react";
import { api, ApiError, listOf, send } from "../api";
import type { Item } from "../api";
import { Panel } from "../components";
import { HelpText, helpColumns } from "../help";
import { useDebounced } from "../state";
import { ConfigurationPreview } from "./ManagementExtras";
import { adminAccessRequired, canDelegate } from "../admin-access";

type Option = { value: string; label: string };
type Preview = {
  data: any;
  preview_digest: string;
  source_revision: number;
  navigation_version: number;
};
type Template = Item & {
  title: string;
  description: string;
  published: boolean;
  data: any;
  created_at: string;
};

function useSourceOptions(
  path: string,
  enabled: boolean,
  labelKey: string,
  delegatedOnly = false,
  revision = 0,
) {
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  useEffect(() => {
    setOptions([]);
    setCount(0);
    setError("");
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    api(path, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        setOptions(
          listOf<Item>(result)
            .filter((row) => !delegatedOnly || canDelegate(row))
            .map((row) => ({
              value: String(row.id),
              label: String(row[labelKey]),
            })),
        );
        setCount(result.count || 0);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, enabled, labelKey, delegatedOnly, revision]);
  return { options, loading, error, count };
}

export default function AdminTemplates() {
  const { message, modal } = App.useApp();
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<Template[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Template | null>(null);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<Option>();
  const [space, setSpace] = useState<Option>();
  const [userQuery, setUserQuery] = useState("");
  const [spaceQuery, setSpaceQuery] = useState("");
  const [sourceRevision, setSourceRevision] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const previewSequence = useRef(0);
  const [form] = Form.useForm();
  const debouncedUser = useDebounced(userQuery);
  const debouncedSpace = useDebounced(spaceQuery);
  const users = useSourceOptions(
    `/admin/users?${new URLSearchParams({ q: debouncedUser, offset: "0", limit: "100" })}`,
    open,
    "username",
  );
  const spaces = useSourceOptions(
    `/admin/spaces?${new URLSearchParams({ user_id: user?.value || "", q: debouncedSpace, offset: "0", limit: "100" })}`,
    open && !!user,
    "name",
    true,
    sourceRevision,
  );
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!open || !user) return;
    const refresh = () => setSourceRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [open, user?.value]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setListError("");
    api(`/admin/configuration-templates?limit=20&offset=${(page - 1) * 20}`)
      .then((result) => {
        if (!active) return;
        const currentRows = listOf<Template>(result);
        setRows(currentRows);
        setDetail((current) =>
          current && !currentRows.some((row) => row.id === current.id)
            ? null
            : current,
        );
        setCount(result.count || 0);
      })
      .catch((e) => {
        if (active) {
          setListError((e as Error).message);
          setRows([]);
          setDetail(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, revision]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") reload();
    }, 15000);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);
  useEffect(
    () => () => {
      previewSequence.current++;
    },
    [],
  );

  function invalidatePreview() {
    previewSequence.current++;
    setPreview(null);
    setPreviewing(false);
    setReviewed(false);
    setPublishError("");
  }
  useEffect(() => {
    if (!open || !space) return;
    let active = true;
    const check = async () => {
      try {
        const result = await api(`/admin/spaces/${space.value}`);
        if (active && !canDelegate(result)) {
          invalidatePreview();
          setSpace(undefined);
          setPublishError(adminAccessRequired);
          setSourceRevision((value) => value + 1);
        }
      } catch (e) {
        if (active) {
          invalidatePreview();
          setSpace(undefined);
          setPublishError((e as Error).message);
          setSourceRevision((value) => value + 1);
        }
      }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void check();
    }, 15000);
    window.addEventListener("focus", check);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [open, space?.value]);
  function start() {
    setUser(undefined);
    setSpace(undefined);
    setUserQuery("");
    setSpaceQuery("");
    invalidatePreview();
    form.resetFields();
    setOpen(true);
  }
  async function readPreview() {
    if (!user || !space) return;
    const current = ++previewSequence.current;
    setPreview(null);
    setReviewed(false);
    setPreviewing(true);
    setPublishError("");
    try {
      if (!canDelegate(await api(`/admin/spaces/${space.value}`))) {
        if (current === previewSequence.current) {
          setSpace(undefined);
          setSourceRevision((value) => value + 1);
        }
        throw new Error(adminAccessRequired);
      }
      const result = await api<Preview>(
        `/admin/configuration-templates/preview?${new URLSearchParams({ user_id: user.value, space_id: space.value })}`,
      );
      if (current === previewSequence.current) setPreview(result);
    } catch (e) {
      if (current === previewSequence.current) {
        setPublishError((e as Error).message);
        if (e instanceof ApiError && e.status === 403) {
          setSpace(undefined);
          setSourceRevision((value) => value + 1);
        }
      }
    } finally {
      if (current === previewSequence.current) setPreviewing(false);
    }
  }
  async function publish(values: { title: string; description?: string }) {
    if (!preview || !user || !space || !reviewed) return;
    setPublishing(true);
    setPublishError("");
    try {
      await send("/admin/configuration-templates", {
        title: values.title,
        description: values.description || "",
        source_user_id: user.value,
        source_space_id: space.value,
        preview_digest: preview.preview_digest,
      });
      setOpen(false);
      invalidatePreview();
      setPage(1);
      reload();
      message.success("配置参考已发布，平台登录用户可以预览选用");
    } catch (e) {
      if (e instanceof ApiError && [403, 412].includes(e.status)) {
        setPreview(null);
        setReviewed(false);
        if (e.status === 403) {
          setSpace(undefined);
          setSourceRevision((value) => value + 1);
        }
      }
      setPublishError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }
  function changePublication(row: Template) {
    modal.confirm({
      title: row.published ? "下架这份配置参考？" : "重新发布这份配置参考？",
      content: row.published
        ? "下架后其他用户将不能继续查看或采用此模板；已经采用的设置保持不变。"
        : "重新发布之前保存的这份配置快照，平台登录用户都可以预览选用。来源后续变化不会自动同步。",
      okText: row.published ? "确认下架" : "重新发布",
      onOk: async () => {
        setBusyId(row.id);
        try {
          await send(
            `/admin/configuration-templates/${row.id}`,
            { version: row.version, published: !row.published },
            "PATCH",
          );
          reload();
          message.success(
            row.published ? "配置参考已下架" : "配置参考已重新发布",
          );
        } catch (e) {
          message.error((e as Error).message);
          if (e instanceof ApiError && [403, 412].includes(e.status)) {
            setDetail(null);
            reload();
          }
          throw e;
        } finally {
          setBusyId(null);
        }
      },
    });
  }

  return (
    <>
      <Panel
        title="配置参考管理"
        action={
          <Space>
            <Button
              icon={<RefreshCw size={15} />}
              onClick={reload}
              loading={loading}
            >
              刷新
            </Button>
            <Button type="primary" icon={<Plus size={15} />} onClick={start}>
              从用户配置创建
            </Button>
          </Space>
        }
      >
        <Alert
          className="form-alert"
          type="info"
          showIcon
          message="分享可参考的设置，发布后平台登录用户都可查看"
          description="仅可选用所有者已允许代管的空间。模板仅包含菜单、首页显示、标签名称与目标占比、市场自选，不复制账号、交易、余额、持仓数量或私人笔记；发布前需核对自定义内容是否适合公开。模板为发布时快照。"
        />
        {listError && (
          <Alert
            className="form-alert"
            type="error"
            message={listError}
            action={
              <Button size="small" onClick={reload}>
                重试
              </Button>
            }
          />
        )}
        <Table<Template>
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{
            current: page,
            total: count,
            pageSize: 20,
            showSizeChanger: false,
            onChange: setPage,
          }}
          scroll={{ x: 780 }}
          columns={helpColumns<Template>([
            { title: "配置参考", dataIndex: "title" },
            { title: "说明", dataIndex: "description", ellipsis: true },
            {
              title: "状态",
              render: (_, row) => (
                <Tag color={row.published ? "green" : undefined}>
                  {row.published ? "已发布" : "已下架"}
                </Tag>
              ),
            },
            {
              title: "创建时间",
              render: (_, row) =>
                row.created_at?.slice(0, 16).replace("T", " "),
            },
            {
              title: "操作",
              render: (_, row) => (
                <Space>
                  <Button
                    size="small"
                    type="link"
                    icon={<Eye size={14} />}
                    onClick={() => setDetail(row)}
                  >
                    预览
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    danger={row.published}
                    disabled={busyId !== null}
                    loading={busyId === row.id}
                    onClick={() => changePublication(row)}
                  >
                    {row.published ? "下架" : "重新发布"}
                  </Button>
                </Space>
              ),
            },
          ])}
        />
      </Panel>
      <Modal
        title={detail?.title || "配置预览"}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={<Button onClick={() => setDetail(null)}>关闭</Button>}
        width={760}
      >
        <p>{detail?.description}</p>
        <ConfigurationPreview data={detail?.data} />
      </Modal>
      <Modal
        title="从用户配置创建参考方案"
        open={open}
        onCancel={() => {
          if (!publishing) {
            setOpen(false);
            invalidatePreview();
          }
        }}
        closable={!publishing}
        maskClosable={!publishing}
        keyboard={!publishing}
        width={820}
        footer={null}
      >
        <Alert
          className="form-alert"
          type="info"
          showIcon
          message="先选择来源并预览，再填写名称发布"
          description="发布内容会面向平台全部登录用户，请检查标签名称及自选配置是否适合共享。"
        />
        <Form layout="vertical" form={form} onFinish={publish}>
          <div className="form-grid">
            <Form.Item
              label="来源用户"
              required
              extra={
                users.count > 100
                  ? "结果超过 100 位，请输入用户名缩小范围"
                  : undefined
              }
            >
              <Select
                aria-label="选择配置来源用户"
                showSearch
                labelInValue
                allowClear
                filterOption={false}
                value={user}
                loading={users.loading}
                disabled={publishing}
                options={users.options}
                placeholder="搜索并选择一位用户"
                onSearch={setUserQuery}
                onChange={(value) => {
                  setUser(value);
                  setSpace(undefined);
                  setSpaceQuery("");
                  invalidatePreview();
                }}
                notFoundContent={
                  users.loading ? "正在读取用户…" : "没有匹配的用户"
                }
              />
            </Form.Item>
            <Form.Item
              label={<HelpText text="该用户的账簿空间" />}
              required
              extra={
                spaces.count > 100
                  ? "结果超过 100 个，请输入空间名称缩小范围"
                  : "仅显示所有者已允许管理员代管的空间"
              }
            >
              <Select
                aria-label="选择配置来源空间"
                showSearch
                labelInValue
                allowClear
                filterOption={false}
                value={space}
                loading={spaces.loading}
                disabled={!user || publishing}
                options={spaces.options}
                placeholder={user ? "选择已授权的空间" : "请先选择用户"}
                onSearch={setSpaceQuery}
                onChange={(value) => {
                  setSpace(value);
                  invalidatePreview();
                }}
                notFoundContent={
                  spaces.loading
                    ? "正在读取空间…"
                    : "没有匹配的已授权空间；请由空间所有者先开启代管授权"
                }
              />
            </Form.Item>
          </div>
          {(users.error || spaces.error) && (
            <Alert
              className="form-alert"
              type="error"
              message={users.error || spaces.error}
            />
          )}
          <Button
            icon={<Eye size={15} />}
            onClick={() => void readPreview()}
            loading={previewing}
            disabled={!user || !space || publishing}
          >
            预览将分享的配置
          </Button>
          {preview && (
            <div className="form-alert">
              <ConfigurationPreview data={preview.data} />
              <div className="form-grid">
                <Form.Item
                  label="参考方案名称"
                  name="title"
                  rules={[
                    {
                      required: true,
                      whitespace: true,
                      message: "填写方案名称",
                    },
                    { max: 100, message: "最多 100 字" },
                  ]}
                >
                  <Input
                    maxLength={100}
                    disabled={publishing}
                    placeholder="例如：简洁菜单与常用市场自选"
                  />
                </Form.Item>
                <Form.Item
                  label="适用说明"
                  name="description"
                  rules={[{ max: 500, message: "最多 500 字" }]}
                >
                  <Input.TextArea
                    rows={2}
                    maxLength={500}
                    showCount
                    disabled={publishing}
                    placeholder="说明这份配置适合如何参考"
                  />
                </Form.Item>
              </div>
              <Checkbox
                checked={reviewed}
                disabled={publishing}
                onChange={(event) => setReviewed(event.target.checked)}
              >
                已检查以上配置，同意向平台登录用户公开
              </Checkbox>
            </div>
          )}
          {publishError && (
            <Alert className="form-alert" type="error" message={publishError} />
          )}
          <div className="form-alert">
            <Space>
              <Button
                type="primary"
                htmlType="submit"
                loading={publishing}
                disabled={!preview || !reviewed || previewing}
              >
                发布配置参考
              </Button>
              <Button
                disabled={publishing}
                onClick={() => {
                  setOpen(false);
                  invalidatePreview();
                }}
              >
                取消
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </>
  );
}
