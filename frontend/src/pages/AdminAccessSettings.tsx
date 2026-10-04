import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Space, Switch } from "antd";
import { api, ApiError, send } from "../api";
import { adminAccessRequest, canManageAdminAccess } from "../admin-access";
import { useWorkspace } from "../state";

type Access = { enabled: boolean; version: number; can_manage: boolean };
export default function AdminAccessSettings() {
  const { space, refresh, reload, refreshIdentity } = useWorkspace();
  const { message } = App.useApp();
  const [access, setAccess] = useState<Access | null>(null),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0),
    lock = useRef(false);
  const read = useCallback(
    async (keepError = false) => {
      const current = ++sequence.current;
      setLoading(true);
      setAccess(null);
      if (!keepError) setError("");
      try {
        const result = await api<Access>(`/spaces/${space.id}/admin-access`);
        if (current === sequence.current) setAccess(result);
      } catch (e) {
        if (current === sequence.current) setError((e as Error).message);
      } finally {
        if (current === sequence.current) setLoading(false);
      }
    },
    [space.id],
  );
  useEffect(() => {
    void read();
    return () => {
      sequence.current++;
    };
  }, [read, refresh]);
  const manageable = canManageAdminAccess(access, space);
  return (
    <div>
      <Space align="center" wrap>
        <h3 style={{ margin: 0 }}>允许管理员代管此空间</h3>
        <Switch
          aria-label="允许管理员代管此空间"
          aria-describedby="admin-access-scope"
          checked={access?.enabled === true}
          loading={loading || saving}
          disabled={loading || saving || !manageable}
          checkedChildren="已允许"
          unCheckedChildren={loading ? "读取中" : "未允许"}
          onChange={async (enabled) => {
            if (!access || lock.current) return;
            lock.current = true;
            setSaving(true);
            setError("");
            try {
              const result = await send<Access>(
                `/spaces/${space.id}/admin-access`,
                adminAccessRequest(access, space, enabled),
                "PUT",
              );
              setAccess(result);
              message.success(
                result.enabled
                  ? "已允许管理员代管此空间"
                  : "已撤销管理员代管授权",
              );
              reload();
              refreshIdentity();
            } catch (e) {
              setError((e as Error).message);
              if (e instanceof ApiError && [403, 409, 412].includes(e.status))
                await read(true);
            } finally {
              lock.current = false;
              setSaving(false);
            }
          }}
        />
      </Space>
      <p id="admin-access-scope">
        默认关闭。开启后，平台管理员可读取和修改本空间账簿、下载原始文件与完整导出，并将菜单、标签和市场自选等配置整理为供其他用户参考的方案。关闭后立即停止代管访问。
      </p>
      {!loading && !manageable && (
        <p className="data-caption">
          仅空间所有者的普通账号可以修改，管理员不能替用户开启授权。
        </p>
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button
              size="small"
              disabled={saving || loading}
              onClick={() => void read()}
            >
              重新读取
            </Button>
          }
        />
      )}
    </div>
  );
}
