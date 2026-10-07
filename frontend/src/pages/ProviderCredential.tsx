import { useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Space, Tag } from "antd";
import { api, ApiError } from "../api";
import { credentialRequest } from "../fund-reconciliation";

export default function ProviderCredential({
  provider,
  onChange,
}: {
  provider: any;
  onChange: (credential: any) => void;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const operation = useRef<string | null>(null);
  const credential = provider.credential;
  if (!credential?.required)
    return <span className="data-caption">公开来源 · 无需密钥</span>;
  const close = () => {
    setOpen(false);
    setToken("");
    setError("");
    operation.current = null;
  };
  async function write(remove = false) {
    setBusy(true);
    setError("");
    try {
      const body = credentialRequest(credential, remove ? undefined : token);
      operation.current ||= crypto.randomUUID();
      const result = await api(
        `/admin/data-sources/${provider.id}/credential`,
        {
          method: remove ? "DELETE" : "PUT",
          body: JSON.stringify(body),
          // Credential material and fingerprints never enter browser storage.
          headers: { "Idempotency-Key": operation.current },
        },
      );
      onChange(result.credential);
      close();
      message.success(remove ? "访问密钥已移除" : "访问密钥已保存");
    } catch (e) {
      setToken("");
      operation.current = null;
      setError((e as Error).message);
      if (e instanceof ApiError && [409, 412].includes(e.status)) {
        try {
          const data = await api("/admin/data-sources");
          const providers = Array.isArray(data.providers)
            ? data.providers
            : Object.values(data.providers || {});
          const latest = providers.find((p: any) => p.id === provider.id);
          if (latest) onChange((latest as any).credential);
        } catch {
          setError("密钥状态读取失败，请关闭并重新读取数据源配置");
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Space size={4} wrap>
        <Tag color={credential.configured ? "green" : "default"}>
          {credential.configured
            ? "密钥已配置"
            : credential.status === "unreadable"
              ? "密钥需重设"
              : "未配置密钥"}
        </Tag>
        <Button
          size="small"
          type="link"
          onClick={() => {
            setToken("");
            setError("");
            setOpen(true);
          }}
        >
          {credential.configured ? "管理" : "配置"}
        </Button>
      </Space>
      <Modal
        open={open}
        title={`${provider.name} · 访问密钥`}
        onCancel={busy ? undefined : close}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={close} disabled={busy}>
              取消
            </Button>
            {credential.configured && (
              <Button
                danger
                disabled={busy}
                onClick={() => {
                  operation.current = null;
                  void write(true);
                }}
              >
                移除密钥
              </Button>
            )}
            <Button
              type="primary"
              loading={busy}
              disabled={!token}
              onClick={() => void write()}
            >
              保存密钥
            </Button>
          </Space>
        }
      >
        <p className="data-caption">
          仅保存管理员提供的访问密钥。保存后不再显示；来源可用性仍取决于服务商权限与额度。
        </p>
        {error && (
          <Alert type="error" showIcon message={error} className="form-alert" />
        )}
        <label htmlFor={`credential-${provider.id}`}>新访问密钥</label>
        <Input.Password
          id={`credential-${provider.id}`}
          autoComplete="new-password"
          visibilityToggle={false}
          maxLength={4096}
          value={token}
          disabled={busy}
          onChange={(e) => {
            setToken(e.target.value);
            operation.current = null;
          }}
          placeholder="粘贴 Token，保存后清空"
        />
      </Modal>
    </>
  );
}
