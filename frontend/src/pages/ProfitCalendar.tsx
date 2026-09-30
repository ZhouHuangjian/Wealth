import { helpColumns } from "../help";
import { useEffect, useState } from "react";
import { Alert, Button, Segmented, Select, Space, Table, Tag } from "antd";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { dateToday, listOf } from "../api";
import type { Item } from "../api";
import { LoadState, Money, Panel } from "../components";
import { useResource, useWorkspace } from "../state";
import { investmentKinds, monthBounds, profitTone } from "../investment";
import { QuoteStatus, Rate } from "./InvestmentWorkspace";

export default function ProfitCalendar() {
  const { hidden } = useWorkspace();
  const today = dateToday();
  const [month, setMonth] = useState(today.slice(0, 7)),
    [period, setPeriod] = useState("day"),
    [metric, setMetric] = useState("amount"),
    [selectedDay, setSelectedDay] = useState(today),
    [kind, setKind] = useState(""),
    [account, setAccount] = useState("");
  const year = month.slice(0, 4);
  const range = ["month", "year"].includes(period)
    ? { start: `${year}-01-01`, end: `${year}-12-31` }
    : monthBounds(month);
  const params = new URLSearchParams({
    ...range,
    period,
    selected_day: selectedDay,
    ...(kind ? { kind } : {}),
    ...(account ? { account_id: account } : {}),
  });
  const state = useResource("profit-calendar", `?${params}`);
  const accounts = useResource("accounts", "?limit=200");
  const data = state.data;
  const days = listOf<any>(data?.days),
    buckets = listOf<any>(data?.buckets);
  const offset = new Date(`${month}-01T12:00:00`).getDay();
  const length = new Date(Number(year), Number(month.slice(5)), 0).getDate();
  const cells = Array.from(
    { length: Math.ceil((offset + length) / 7) * 7 },
    (_, i) => i - offset + 1,
  );
  const currentBucket = buckets.find(
    (b) => selectedDay >= b.date && selectedDay <= (b.end || b.date),
  );
  const summary = data?.summary;
  function step(direction: number) {
    if (["month", "year"].includes(period))
      setMonth(`${Number(year) + direction}-${month.slice(5)}`);
    else {
      const d = new Date(
        Number(year),
        Number(month.slice(5)) - 1 + direction,
        1,
        12,
      );
      setMonth(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      );
    }
  }
  useEffect(() => {
    if (!selectedDay.startsWith(month))
      setSelectedDay(month === today.slice(0, 7) ? today : `${month}-01`);
  }, [month]);
  const value = (row: any) =>
    metric === "amount" ? (
      <Money value={row?.amount} sign />
    ) : (
      <Rate value={row?.return_rate} />
    );
  function label(row: any, date: string) {
    if (date > today) return "";
    if (!row) return "未更新";
    if (row.status === "no_position") return "无持仓";
    if (row.amount === null || row.amount === undefined) return "未更新";
    return null;
  }
  return (
    <div className="profit-calendar">
      <Panel
        title="收益日历"
        action={
          <Space wrap>
            <Select
              aria-label="收益产品分类"
              value={kind}
              onChange={setKind}
              options={[
                { value: "", label: "全部类型" },
                ...Object.entries(investmentKinds).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
              style={{ width: 125 }}
            />
            <Select
              aria-label="收益账户"
              value={account}
              onChange={setAccount}
              options={[
                { value: "", label: "全部账户" },
                ...listOf<Item>(accounts.data).map((a) => ({
                  value: a.id,
                  label: a.name,
                })),
              ]}
              style={{ width: 170 }}
              showSearch
              optionFilterProp="label"
            />
          </Space>
        }
      >
        <div className="calendar-controls">
          <Segmented
            aria-label="收益周期"
            value={period}
            onChange={(v) => setPeriod(String(v))}
            options={[
              { label: "日", value: "day" },
              { label: "周", value: "week" },
              { label: "月", value: "month" },
              { label: "年", value: "year" },
            ]}
          />
          <div className="calendar-navigation">
            <Button
              aria-label="上一期"
              icon={<ChevronLeft size={18} />}
              onClick={() => step(-1)}
            />
            <strong>
              {["month", "year"].includes(period)
                ? `${year} 年`
                : `${year} 年 ${Number(month.slice(5))} 月`}
            </strong>
            <Button
              aria-label="下一期"
              icon={<ChevronRight size={18} />}
              onClick={() => step(1)}
            />
          </div>
          <Segmented
            aria-label="收益显示单位"
            value={metric}
            onChange={(v) => setMetric(String(v))}
            options={[
              { label: "金额", value: "amount" },
              { label: "%", value: "rate" },
            ]}
          />
        </div>
        <LoadState {...state}>
          <div className="calendar-summary">
            <div>
              <small>
                {["month", "year"].includes(period) ? "本年" : "本月"}
                {summary?.status === "partial" ? "已知收益" : "收益"}
              </small>
              <strong
                className={
                  hidden
                    ? ""
                    : profitTone(summary?.amount ?? summary?.known_amount)
                }
              >
                <Money
                  value={summary?.amount ?? summary?.known_amount}
                  currency={data?.currency}
                  sign
                />
              </strong>
            </div>
            <div className="calendar-legend">
              <span className="profit-up">● 盈利</span>
              <span className="profit-down">● 亏损</span>
              <span>— 未更新</span>
            </div>
          </div>
          {period === "day" ? (
            <>
              <div className="calendar-weekdays">
                {"日一二三四五六".split("").map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
              <div
                className="calendar-grid"
                role="group"
                aria-label={`${month} 收益日历`}
              >
                {cells.map((day, i) => {
                  if (day < 1 || day > length)
                    return (
                      <div key={`empty-${i}`} className="calendar-empty-cell" />
                    );
                  const date = `${month}-${String(day).padStart(2, "0")}`;
                  const row = days.find((d) => d.date === date);
                  const text = label(row, date);
                  return (
                    <button
                      type="button"
                      key={date}
                      aria-label={`${date}${hidden ? " 金额已隐藏" : text ? ` ${text}` : " 收益"}`}
                      aria-pressed={selectedDay === date}
                      onClick={() => setSelectedDay(date)}
                      className={`calendar-day ${selectedDay === date ? "selected" : ""} ${date > today ? "future-day" : ""} ${hidden ? "" : profitTone(row?.amount)}`}
                    >
                      <span className="calendar-date">
                        {date === today ? "今" : day}
                      </span>
                      <strong>{text !== null ? text : value(row)}</strong>
                      {row?.status === "partial" && <small>部分数据</small>}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div
              className={`calendar-buckets ${period === "month" ? "monthly" : ""}`}
            >
              {buckets.length ? (
                buckets.map((b) => (
                  <button
                    type="button"
                    key={b.date}
                    aria-pressed={currentBucket?.date === b.date}
                    onClick={() => setSelectedDay(b.date)}
                    className={`${hidden ? "" : profitTone(b.amount)} ${currentBucket?.date === b.date ? "selected" : ""}`}
                  >
                    <span>
                      {period === "year"
                        ? `${b.date.slice(0, 4)} 年`
                        : period === "month"
                          ? `${Number(b.date.slice(5, 7))} 月`
                          : `${b.date.slice(5)} — ${(b.end || b.date).slice(5)}`}
                    </span>
                    <strong>{b.amount == null ? "未更新" : value(b)}</strong>
                    <QuoteStatus status={b.status} />
                  </button>
                ))
              ) : (
                <p className="quiet-empty">暂无可计算的收益</p>
              )}
            </div>
          )}
          {summary?.status === "partial" && (
            <Alert
              className="form-alert"
              type="info"
              showIcon
              message="部分日期缺少正式价格或持仓依据，汇总只显示已知收益。"
            />
          )}
        </LoadState>
        <p className="data-caption">
          收益按价格有效日归属。手动录入的累计收益保留在持仓中，不拆分成每日收益；未来日期及缺失数据不计为零。
        </p>
      </Panel>
      <Panel
        title="当日收益明细"
        action={
          <Space>
            <CalendarDays size={17} />
            <time>{selectedDay}</time>
          </Space>
        }
      >
        <LoadState {...state}>
          <Table
            rowKey={(r: any, i) => `${r.account_id}-${r.instrument_id}-${i}`}
            pagination={false}
            size="middle"
            scroll={{ x: 780 }}
            dataSource={listOf<any>(data?.details)}
            locale={{
              emptyText:
                selectedDay > today
                  ? "该日期尚未发生"
                  : "该日暂无可计算的收益明细",
            }}
            columns={helpColumns([
              {
                title: "产品 / 账户",
                render: (_, r: any) => (
                  <div className="cell-name">
                    <strong>
                      {r.instrument_name || r.name || r.account_name}
                    </strong>
                    <small>{r.account_name}</small>
                  </div>
                ),
              },
              {
                title: "当日收益",
                render: (_, r: any) => (
                  <span
                    className={hidden ? "" : profitTone(r.amount ?? r.profit)}
                  >
                    <Money
                      value={r.amount ?? r.profit}
                      currency={r.currency || data?.currency}
                      sign
                    />
                  </span>
                ),
              },
              {
                title: "收益率",
                render: (_, r: any) => <Rate value={r.return_rate} />,
              },
              {
                title: "来源",
                render: (_, r: any) =>
                  hidden
                    ? "内容已隐藏"
                    : r.source === "institution_snapshot"
                      ? "机构结算单"
                      : r.source || r.price_source || r.reason || "—",
              },
              {
                title: "状态",
                render: (_, r: any) => (
                  <div className="cell-name">
                    <QuoteStatus status={r.status} />
                    {r.message && (
                      <small style={{ maxWidth: 240, whiteSpace: "normal" }}>
                        {hidden ? "内容已隐藏" : r.message}
                      </small>
                    )}
                  </div>
                ),
              },
            ])}
          />
        </LoadState>
      </Panel>
    </div>
  );
}
