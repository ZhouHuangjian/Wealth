import { Table, Tag } from "antd";
import { Money } from "../components";
import {
  marketTime,
  qualityPresentation,
  quoteDetails,
  sourcePresentation,
  sourceTimestampMessage,
} from "../market-quality";

export default function QuoteQualityDetails({ row }: { row: any }) {
  const details = quoteDetails(row),
    quality = qualityPresentation(row),
    timestampMessage = sourceTimestampMessage(row);
  const columns = [
    {
      title: "来源",
      render: (_: any, r: any) => {
        const source = sourcePresentation(r);
        return (
          <div className="cell-name" title={source.interfaceName || undefined}>
            <span>{source.label}</span>
            {source.origin && <small>原始来源：{source.origin}</small>}
          </div>
        );
      },
    },
    {
      title: "正式净值日",
      render: (_: any, r: any) =>
        r.economic_date || r.quarantine_date || "未提供",
    },
    {
      title: "单位净值",
      render: (_: any, r: any) => <Money value={r.price} precision={6} />,
    },
    {
      title: "机构公布时间",
      render: (_: any, r: any) =>
        marketTime(r.published_at || r.publication_date),
    },
    {
      title: "获取时间",
      render: (_: any, r: any) => marketTime(r.fetched_at || r.observed_at),
    },
  ];
  return (
    <div className="quote-quality-details">
      {quality && (
        <p>
          {quality.message}
          {row.data_quality?.compared_date
            ? ` 比较净值日：${row.data_quality.compared_date}。`
            : ""}
        </p>
      )}
      {timestampMessage && <p>{timestampMessage}</p>}
      {!!details.observations.length && (
        <Table
          size="small"
          rowKey={(r, i) => `${r.provider_id}-${r.economic_date}-${i}`}
          dataSource={details.observations}
          pagination={false}
          scroll={{ x: 750 }}
          columns={columns}
        />
      )}
      {!!details.quarantined.length && (
        <details>
          <summary>
            已隔离的历史净值（{details.quarantined.length} 条来源记录）
          </summary>
          <Table
            size="small"
            rowKey={(r, i) => `${r.provider_id}-${r.quarantine_date}-${i}`}
            dataSource={details.quarantined}
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            scroll={{ x: 750 }}
            columns={columns}
          />
        </details>
      )}
      {!!details.attempts.length && (
        <details>
          <summary>查询来源与状态</summary>
          <ul className="quote-attempts">
            {details.attempts.map((attempt: any, i: number) => (
              <li key={`${attempt.provider}-${i}`}>
                <span
                  title={sourcePresentation(attempt).interfaceName || undefined}
                >
                  {sourcePresentation(attempt).label}
                  {sourcePresentation(attempt).origin &&
                    `（原始来源：${sourcePresentation(attempt).origin}）`}
                </span>
                <Tag>
                  {(
                    {
                      ok: "已返回",
                      stale: "非最新",
                      unavailable: "暂不可用",
                      error: "查询未成功",
                      skipped: "未查询",
                      unsupported: "不适用",
                      conflict: "有差异",
                    } as Record<string, string>
                  )[attempt.status] || "未获得可用数据"}
                </Tag>
                {attempt.message && <small>{attempt.message}</small>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
