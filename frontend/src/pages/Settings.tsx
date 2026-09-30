import { WorkspaceIdentity } from "./WorkspaceIdentity";
import { NavigationTabs, NavigationEditor } from "../navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import { GlossaryDirectory, HelpText, helpColumns } from "../help";
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
} from "antd";
import { Download, UserPlus } from "lucide-react";
import {
  EntityManager,
  Fields,
  LoadState,
  PageTitle,
  Panel,
  ResourceTable,
  Status,
} from "../components";
import { api, currencyOptions, dateToday, listOf, send } from "../api";
import type { Item } from "../api";
import { useResource, useWorkspace } from "../state";
export default function Settings({
  workspaceActions,
  templateContent,
}: {
  workspaceActions?: ReactNode;
  templateContent?: ReactNode;
}) {
  const { space } = useWorkspace();
  return (
    <>
      <PageTitle eyebrow="MANAGEMENT" title="管理中心" />
      <NavigationTabs
        group="settings"
        routeParam="tab"
        items={[
          {
            key: "members",
            label: "空间与成员",
            children: (
              <>
                <WorkspaceIdentity />
                <Members workspaceActions={workspaceActions} />
              </>
            ),
          },
          {
            key: "templates",
            label: "配置参考",
            children: templateContent || (
              <Panel title="配置参考">
                <Alert
                  type="info"
                  showIcon
                  message="管理员可以将配置整理为参考方案，应用前可先查看具体内容。"
                />
              </Panel>
            ),
          },
          {
            key: "navigation",
            label: "导航偏好",
            children: (
              <Panel title="个人导航">
                <NavigationEditor />
              </Panel>
            ),
          },
          {
            key: "help",
            label: "名词帮助",
            children: (
              <Panel title="名词帮助">
                <GlossaryDirectory />
              </Panel>
            ),
          },
          {
            key: "fx",
            label: "汇率记录",
            children: (
              <EntityManager
                resource="fx"
                title="估值汇率"
                allowEdit={false}
                description="1 单位 base 折合 rate 单位 quote。缺失汇率不按 1:1 处理。"
                fields={[
                  {
                    name: "base",
                    label: "原币 base",
                    type: "select",
                    options: currencyOptions,
                    required: true,
                    initial: "USD",
                  },
                  {
                    name: "quote",
                    label: "目标币 quote",
                    type: "select",
                    options: currencyOptions,
                    required: true,
                    initial: "CNY",
                  },
                  {
                    name: "rate",
                    label: "折算汇率",
                    type: "number",
                    required: true,
                  },
                  {
                    name: "economic_date",
                    label: "适用日期",
                    type: "date",
                    required: true,
                    initial: dateToday(),
                  },
                  { name: "source", label: "来源", required: true },
                  {
                    name: "purpose",
                    label: "用途",
                    type: "select",
                    required: true,
                    initial: "valuation",
                    options: [
                      { label: "正式估值", value: "valuation" },
                      { label: "未来假设", value: "assumption" },
                    ],
                  },
                ]}
                columns={[
                  { title: "原币", dataIndex: "base" },
                  { title: "目标币", dataIndex: "quote" },
                  { title: "汇率", dataIndex: "rate" },
                  { title: "适用日", dataIndex: "economic_date" },
                  { title: "来源", dataIndex: "source" },
                ]}
              />
            ),
          },
          {
            key: "sources",
            label: "账单适配",
            children: (
              <ResourceTable
                resource="adapters"
                title="账单导入适配"
                description="正式兼容性以具体版本、字段覆盖和真实样本对账为准。"
                columns={[
                  { title: "来源", render: (_, r) => r.name || r.source },
                  {
                    title: "状态",
                    dataIndex: "status",
                    render: (v) => <Status value={v} />,
                  },
                  {
                    title: "格式 / 覆盖",
                    render: (_, r) =>
                      r.format || r.coverage || r.notes || "待样本验证",
                  },
                ]}
              />
            ),
          },
          { key: "exports", label: "导出与备份", children: <Exports /> },
          {
            key: "security",
            label: "隐私与安全",
            children: (
              <Panel title="本空间的共享边界">
                <div className="policy-list">
                  <div>
                    <h3>当前空间：{space.name}</h3>
                    <p>
                      同一空间成员按
                      <HelpText text="空间所有者、编辑成员、查看成员" />
                      的角色访问。私人账户或笔记请建立独立私人空间。
                    </p>
                  </div>
                  <div>
                    <h3>原始文件与完整导出</h3>
                    <p>
                      默认仅空间所有者可下载。文件不会产生长期公开下载链接，每次访问都会重新检查权限。
                    </p>
                  </div>
                  <div>
                    <h3>真实记录与未来计划分开</h3>
                    <p>
                      本系统不连接银行支付或交易下单。计划到期生成待办，确认实际发生后才更新账目。
                    </p>
                  </div>
                  <div>
                    <h3>外部模型与行情</h3>
                    <p>
                      公开行情按已启用的数据源获取，未启用外部
                      AI。手札、账单与财务明细不会因页面展示而自动向外部模型发送。
                    </p>
                  </div>
                </div>
                <PasswordForm />
              </Panel>
            ),
          },
        ]}
      />
    </>
  );
}
function Members({ workspaceActions }: { workspaceActions?: ReactNode }) {
  const { space, reload } = useWorkspace();
  const state = useResource("members");
  const [open, setOpen] = useState(false),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false);
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  return (
    <>
      <Panel
        title={space.name}
        subtitle={`本位币 ${space.base_currency} · 当前角色 ${{ owner: "空间所有者", editor: "编辑成员", viewer: "查看成员" }[space.role] || space.role}`}
        action={
          space.role === "owner" && (
            <Button
              icon={<UserPlus size={16} />}
              type="primary"
              onClick={() => {
                setOpen(true);
                setToken("");
              }}
            >
              邀请成员
            </Button>
          )
        }
      >
        <Alert
          className="form-alert"
          showIcon
          message="加入成员会获得当前空间的共享范围。需要保密的账户或手札应放入私人空间。"
        />
        <LoadState {...state}>
          <Table
            rowKey="id"
            dataSource={listOf<Item>(state.data)}
            columns={helpColumns<Item>([
              {
                title: "成员",
                render: (_, r) =>
                  r.username || r.user?.username || r.name || r.user_id,
              },
              {
                title: "角色",
                dataIndex: "role",
                render: (v) => <Status value={v} />,
              },
              {
                title: "状态",
                dataIndex: "status",
                render: (v) => <Status value={v || "active"} />,
              },
              {
                title: "管理",
                render: (_, r) =>
                  space.role === "owner" ? (
                    <Space>
                      <Select
                        size="small"
                        value={r.role}
                        aria-label="调整成员角色"
                        options={[
                          { value: "owner", label: "空间所有者" },
                          { value: "editor", label: "编辑成员" },
                          { value: "viewer", label: "查看成员" },
                        ]}
                        onChange={(role) =>
                          modal.confirm({
                            title: "确认调整成员权限？",
                            content:
                              "新的请求将立即使用新的成员权限，最后一位空间所有者不能降级。",
                            onOk: async () => {
                              try {
                                await send(
                                  `/spaces/${space.id}/members/${r.id}`,
                                  { role, version: r.version },
                                  "PATCH",
                                );
                                reload();
                              } catch (e) {
                                message.error((e as Error).message);
                                throw e;
                              }
                            },
                          })
                        }
                      />
                      <Button
                        danger
                        type="link"
                        size="small"
                        onClick={() =>
                          modal.confirm({
                            title: "移除这位成员？",
                            content:
                              "移除后无法继续查看本空间的新页面、文件或导出结果。",
                            okText: "确认移除",
                            onOk: async () => {
                              try {
                                await api(
                                  `/spaces/${space.id}/members/${r.id}`,
                                  { method: "DELETE" },
                                );
                                reload();
                              } catch (e) {
                                message.error((e as Error).message);
                                throw e;
                              }
                            },
                          })
                        }
                      >
                        移除
                      </Button>
                    </Space>
                  ) : null,
              },
            ])}
            locale={{ emptyText: "暂无可展示成员" }}
          />
        </LoadState>
        {workspaceActions}
      </Panel>
      {space.role === "owner" && (
        <EntityManager
          resource="invitations"
          title="邀请记录"
          allowEdit={false}
          columns={[
            { title: "角色", dataIndex: "role" },
            {
              title: "有效至",
              dataIndex: "expires_at",
              render: (v) => v?.slice(0, 16).replace("T", " "),
            },
            {
              title: "状态",
              render: (_, r) =>
                r.revoked ? "已撤销" : r.used_at ? "已接受" : "待接受",
            },
          ]}
          extraActions={(r) =>
            !r.revoked &&
            !r.used_at && (
              <Button
                size="small"
                danger
                type="link"
                onClick={() =>
                  modal.confirm({
                    title: "撤销此邀请？",
                    content: "撤销后邀请码将立即失效。",
                    okText: "撤销邀请",
                    onOk: async () => {
                      await send(
                        `/spaces/${space.id}/invitations/${r.id}/revoke`,
                      );
                      message.success("邀请已撤销");
                      reload();
                    },
                  })
                }
              >
                撤销
              </Button>
            )
          }
        />
      )}
      <Modal
        open={open}
        title="邀请加入当前空间"
        onCancel={() => setOpen(false)}
        footer={null}
      >
        {token ? (
          <>
            <Alert
              showIcon
              type="success"
              message="邀请已创建"
              description="将邀请码交给对方。新用户在注册页面填写邀请码即可加入；已有账号可在账簿切换菜单中选择“使用邀请码加入”。本系统不会自动发送消息。"
            />
            <Input.TextArea
              aria-label="邀请码"
              readOnly
              value={token}
              rows={3}
              className="form-alert"
            />
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token);
                  message.success("已复制邀请码");
                } catch {
                  message.info("请手动复制邀请码");
                }
              }}
            >
              复制邀请码
            </Button>
          </>
        ) : (
          <Form
            form={form}
            layout="vertical"
            initialValues={{ role: "viewer", expires_days: "7" }}
            onFinish={async (values) => {
              setBusy(true);
              try {
                const r = await send(`/spaces/${space.id}/invitations`, values);
                setToken(r.token || r.invite_token);
                message.success("已创建邀请");
              } catch (e) {
                message.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Fields
              fields={[
                {
                  name: "role",
                  label: "邀请角色",
                  type: "select",
                  required: true,
                  options: [
                    { label: "查看成员 · 仅查看", value: "viewer" },
                    { label: "编辑成员 · 记账与计划", value: "editor" },
                    { label: "空间所有者 · 管理与导出", value: "owner" },
                  ],
                },
                {
                  name: "expires_days",
                  label: "有效天数",
                  type: "number",
                  required: true,
                },
              ]}
            />
            <Button type="primary" htmlType="submit" loading={busy}>
              创建邀请
            </Button>
          </Form>
        )}
      </Modal>
    </>
  );
}
function Exports() {
  const { space } = useWorkspace();
  const [download, setDownload] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Panel
      title="完整数据导出"
      subtitle="下载前重新验证空间所有者权限；导出文件可能包含敏感财务明细。"
    >
      {space.role !== "owner" ? (
        <Alert type="warning" showIcon message="完整导出仅向空间所有者开放" />
      ) : (
        <Space direction="vertical">
          <Button
            type="primary"
            icon={<Download size={16} />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const r = await send(`/spaces/${space.id}/exports`);
                setDownload(
                  `/api/v1/spaces/${space.id}/exports/${r.id}/download`,
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            生成本空间导出
          </Button>
          {download && (
            <a href={download} download>
              下载已生成的空间数据
            </a>
          )}
          {error && <Alert type="error" showIcon message={error} />}
        </Space>
      )}
    </Panel>
  );
}

export function PasswordForm() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="reverse-box">
      <h3>修改登录密码</h3>
      <Form
        form={form}
        layout="vertical"
        onFinish={async (values) => {
          setBusy(true);
          setError("");
          try {
            await send("/auth/password", values);
            message.success("登录密码已更新");
            form.resetFields();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Form.Item
            name="current_password"
            label="当前密码"
            rules={[{ required: true, message: "填写当前密码" }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="password"
            label="新密码"
            rules={[
              { required: true, message: "填写新密码" },
              { min: 10, message: "至少 10 位" },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </div>
        {error && (
          <Alert className="form-alert" type="error" showIcon message={error} />
        )}
        <Button htmlType="submit" loading={busy}>
          更新密码
        </Button>
      </Form>
    </div>
  );
}
