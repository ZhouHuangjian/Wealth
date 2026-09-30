import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Form,
  Input,
  Modal,
  Space,
  Table,
} from "antd";
import { api, send } from "../api";
import type { Item } from "../api";
import { useWorkspace } from "../state";

export function WorkspaceIdentity() {
  const { space, refresh, reload, refreshIdentity } = useWorkspace();
  const { message } = App.useApp();
  const [data, setData] = useState<Item | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form] = Form.useForm();
  useEffect(() => {
    let active = true;
    api(
      space.administration
        ? `/admin/spaces/${space.id}`
        : `/spaces/${space.id}/profile`,
    )
      .then((v) => {
        if (active) {
          setData(v);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [space.id, space.administration, refresh]);
  function open(item: Item) {
    setEditing(item);
    form.resetFields();
    form.setFieldsValue(item);
    setError("");
  }
  if (space.role !== "owner" && !space.administration) return null;
  return (
    <>
      <Collapse
        className="workspace-identity"
        size="small"
        items={[
          {
            key: "identity",
            label: "账簿与成员信息",
            children: (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <strong>{data?.name || space.name}</strong>
                  <Button
                    type="link"
                    disabled={!data}
                    onClick={() =>
                      data && open({ ...data, record_kind: "space" })
                    }
                  >
                    修改账簿名
                  </Button>
                </Space>
                {space.administration && (
                  <Table<Item>
                    size="small"
                    pagination={false}
                    rowKey="id"
                    scroll={{ x: 440 }}
                    dataSource={data?.users || []}
                    columns={[
                      { title: "用户名", dataIndex: "username" },
                      {
                        title: "邮箱",
                        dataIndex: "email",
                        render: (v) => v || "未填写",
                      },
                      {
                        title: "操作",
                        width: 100,
                        render: (_, r) => (
                          <Button
                            type="link"
                            onClick={() => open({ ...r, record_kind: "user" })}
                          >
                            编辑
                          </Button>
                        ),
                      },
                    ]}
                  />
                )}
                {error && !editing && <Alert type="error" message={error} />}
              </>
            ),
          },
        ]}
      />
      <Modal
        title={editing?.record_kind === "user" ? "修改成员账号" : "修改账簿名"}
        open={!!editing}
        onCancel={() => !busy && setEditing(null)}
        confirmLoading={busy}
        okText="保存更改"
        onOk={() => form.submit()}
        forceRender
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            if (!editing || busy) return;
            setBusy(true);
            setError("");
            try {
              if (editing.record_kind === "user")
                await send(
                  `/admin/users/${editing.id}`,
                  {
                    version: editing.version,
                    username: values.username,
                    email: values.email || "",
                  },
                  "PATCH",
                );
              else
                await send(
                  space.administration
                    ? `/admin/spaces/${space.id}`
                    : `/spaces/${space.id}/profile`,
                  {
                    version: editing.version ?? editing.revision,
                    name: values.name,
                  },
                  "PATCH",
                );
              message.success("已保存");
              setEditing(null);
              reload();
              refreshIdentity();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {editing?.record_kind === "user" ? (
            <>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true, whitespace: true }]}
              >
                <Input maxLength={100} />
              </Form.Item>
              <Form.Item
                name="email"
                label="邮箱（可选）"
                rules={[{ type: "email" }]}
              >
                <Input maxLength={254} />
              </Form.Item>
              <p className="form-context">
                修改后使用新用户名登录，密码保持不变。
              </p>
            </>
          ) : (
            <Form.Item
              name="name"
              label="账簿名"
              rules={[{ required: true, whitespace: true }]}
            >
              <Input maxLength={100} />
            </Form.Item>
          )}
          {error && <Alert type="error" message={error} />}
        </Form>
      </Modal>
    </>
  );
}
