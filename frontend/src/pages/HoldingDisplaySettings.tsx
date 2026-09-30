import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Select, Space } from "antd";
import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { api } from "../api";
import { HelpText } from "../help";
import {
  defaultHoldingDisplay,
  holdingColumnDefinitions,
  holdingPreferenceKey,
  normalizeHoldingDisplay,
} from "../holding-display";
import type { HoldingDisplayPreferences } from "../holding-display";

export function useHoldingDisplayPreferences(spaceId: string) {
  const [scope, setScope] = useState<{
    spaceId: string;
    key: string;
    value: HoldingDisplayPreferences;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const preferences =
    scope?.spaceId === spaceId ? scope.value : defaultHoldingDisplay();
  useEffect(() => {
    let active = true;
    setScope(null);
    setNotice("");
    void api("/auth/me")
      .then((auth) => {
        if (!active) return;
        const key = holdingPreferenceKey(auth.user?.id, spaceId);
        if (!key) {
          setNotice("未能识别当前用户，暂不保存显示设置。");
          return;
        }
        let value = defaultHoldingDisplay();
        try {
          const raw = localStorage.getItem(key);
          if (raw) value = normalizeHoldingDisplay(JSON.parse(raw));
        } catch {
          setNotice("无法读取本机显示设置，本次先使用默认显示。");
        }
        setScope({ spaceId, key, value });
      })
      .catch(() => {
        if (active) setNotice("暂时无法读取用户信息，显示设置尚不可保存。");
      });
    return () => {
      active = false;
    };
  }, [spaceId]);
  const save = (next: HoldingDisplayPreferences) => {
    if (!scope || scope.spaceId !== spaceId) return;
    const value = normalizeHoldingDisplay(next);
    setScope({ ...scope, value });
    try {
      localStorage.setItem(scope.key, JSON.stringify(value));
      setNotice("");
    } catch {
      setNotice("浏览器未允许保存；设置仅在本次页面有效。");
    }
  };
  return { preferences, save, notice, ready: scope?.spaceId === spaceId };
}

export default function HoldingDisplaySettings({
  preferences,
  onChange,
  ready,
  notice,
}: {
  preferences: HoldingDisplayPreferences;
  onChange: (value: HoldingDisplayPreferences) => void;
  ready: boolean;
  notice: string;
}) {
  const [open, setOpen] = useState(false);
  const move = (index: number, delta: number) => {
    const order = [...preferences.order];
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    onChange({ ...preferences, order });
  };
  return (
    <>
      <Button
        type="text"
        size="small"
        icon={<SlidersHorizontal size={14} />}
        onClick={() => setOpen(true)}
      >
        显示设置
      </Button>
      <Drawer
        title="持仓显示设置"
        width={440}
        open={open}
        onClose={() => setOpen(false)}
      >
        <p className="data-caption">
          仅当前浏览器生效，按登录用户与账簿分别保存；不会修改持仓或账务数据。
        </p>
        <p className="data-caption">
          勾选显示列，用箭头调整顺序。固定列始终放在左侧或右侧；产品与操作列保留。
        </p>
        {notice && <Alert type="warning" showIcon message={notice} />}
        {!ready && !notice && (
          <p className="data-caption">正在读取个人显示设置…</p>
        )}
        <div className="holdings-display-columns">
          {preferences.order.map((key, index) => {
            const column = holdingColumnDefinitions.find((c) => c.key === key)!;
            const required = "required" in column && column.required;
            return (
              <div className="holdings-display-column" key={key}>
                <Checkbox
                  checked={!preferences.hidden.includes(key)}
                  disabled={required || !ready}
                  onChange={(event) =>
                    onChange({
                      ...preferences,
                      hidden: event.target.checked
                        ? preferences.hidden.filter((k) => k !== key)
                        : [...preferences.hidden, key],
                    })
                  }
                >
                  <HelpText text={column.label} />
                </Checkbox>
                <div className="holdings-display-options">
                  <Select
                    size="small"
                    aria-label={`${column.label}固定位置`}
                    value={preferences.fixed[key] || "none"}
                    disabled={!ready}
                    options={[
                      { value: "none", label: "不固定" },
                      { value: "left", label: "固定左侧" },
                      { value: "right", label: "固定右侧" },
                    ]}
                    onChange={(value) => {
                      const fixed = { ...preferences.fixed };
                      if (value === "none") delete fixed[key];
                      else if (value === "left" || value === "right")
                        fixed[key] = value;
                      onChange({ ...preferences, fixed });
                    }}
                  />
                  <Space size={0}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowUp size={14} />}
                      aria-label={`上移${column.label}`}
                      disabled={index === 0 || !ready}
                      onClick={() => move(index, -1)}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowDown size={14} />}
                      aria-label={`下移${column.label}`}
                      disabled={
                        index === preferences.order.length - 1 || !ready
                      }
                      onClick={() => move(index, 1)}
                    />
                  </Space>
                </div>
              </div>
            );
          })}
        </div>
        <Button
          type="text"
          size="small"
          disabled={!ready}
          onClick={() =>
            onChange({
              ...defaultHoldingDisplay(),
              pinned: preferences.pinned,
              sort: preferences.sort,
            })
          }
        >
          恢复默认列显示
        </Button>
      </Drawer>
    </>
  );
}
