export function qualityPresentation(row: Record<string, any>) {
  const quality = row.data_quality;
  const labels: Record<string, string> = {
    consistent: "多源一致",
    single_source: "单一来源",
    conflict: "净值有差异",
    unavailable: "暂无可用来源",
  };
  return quality
    ? {
        label: labels[quality.status] || "尚未核对",
        color:
          quality.status === "conflict"
            ? "orange"
            : quality.status === "consistent"
              ? "green"
              : "default",
        message:
          row.retained_previous_quote === true
            ? quality.status === "conflict"
              ? "当前显示上次可用净值。新获取的冲突净值已隔离，不用于记账。"
              : quality.status === "unavailable"
                ? "此次未获得可用净值，当前显示上次可用值，请留意其净值日。"
                : quality.compared_date &&
                    row.economic_date &&
                    quality.compared_date < row.economic_date
                  ? "此次来源返回的净值日期较早，当前保留此前较新的可用值。"
                  : "此次更新未替换原行情，当前显示上次可用值，请留意其净值日。"
            : quality.usable_for_accounting === false
              ? "此次净值不能用于记账，请核对来源差异或等待更新。"
              : quality.status === "single_source"
                ? quality.independent_source_count === 1 &&
                  new Set(
                    (row.provider_observations || [])
                      .filter(
                        (observation: any) =>
                          observation.economic_date === quality.compared_date,
                      )
                      .map((observation: any) => observation.provider_id)
                      .filter(Boolean),
                  ).size > 1
                  ? "多个查询渠道来自同一原始数据源，尚无独立来源交叉核对。"
                  : "此日期只有一个独立可用来源，尚无其他来源交叉核对。"
                : "同一净值日的可用来源已核对一致。",
      }
    : null;
}

export function quoteDetails(row: Record<string, any>) {
  const quarantined = Object.values(row.nav_quarantine || {}).flatMap(
    (entry: any) =>
      (entry.observations || []).map((observation: any) => ({
        ...observation,
        quarantined: true,
        quarantine_date: entry.date,
        observed_at: entry.observed_at,
      })),
  );
  return {
    observations: row.provider_observations || [],
    attempts: row.provider_attempts || [],
    quarantined,
  };
}

export function marketTime(value: unknown, absent = "来源未提供") {
  if (typeof value !== "string" || !value) return absent;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
}

export function providerLabel(provider?: string) {
  return (
    (
      {
        gffunds_official: "广发基金官方",
        efunds_official: "易方达基金官方",
        cifm_official: "摩根基金官方",
        tushare_fund: "Tushare 基金净值",
        lixinger_fund: "理杏仁基金净值",
        eastmoney_fund: "天天基金 / 东方财富",
        eastmoney: "东方财富",
        eastmoney_index: "东方财富指数",
        eastmoney_search: "东方财富产品搜索",
        akshare: "AKShare",
        tencent: "腾讯行情",
        yahoo: "Yahoo Finance",
        sina: "新浪行情",
        cboe: "Cboe",
        nasdaq: "Nasdaq",
      } as Record<string, string>
    )[provider || ""] ||
    provider ||
    "来源未提供"
  );
}

export function sourcePresentation(row: Record<string, any>) {
  const groupLabels: Record<string, string> = {
    eastmoney: "东方财富",
    sina: "新浪",
    gffunds: "广发基金官方",
    efunds: "易方达基金官方",
    cifm: "摩根基金官方",
    tushare: "Tushare",
    lixinger: "理杏仁",
  };
  const upstream = row.upstream_provider_id,
    group = row.source_group,
    provider = row.provider_id || row.provider;
  return {
    label:
      row.source ||
      row.provider_name ||
      providerLabel(row.provider_id || row.provider),
    origin:
      (upstream && upstream !== provider) || (group && group !== provider)
        ? row.source_group_name ||
          (upstream
            ? providerLabel(upstream)
            : groupLabels[group] || providerLabel(group))
        : null,
    interfaceName:
      typeof row.interface_name === "string" ? row.interface_name : null,
  };
}

export function sourceTimestampMessage(row: Record<string, any>) {
  if (row.timestamp_quality !== "source_clock_only") return null;
  const clock =
      typeof row.source_clock === "string" ? row.source_clock.trim() : "",
    message =
      typeof row.timestamp_message === "string"
        ? row.timestamp_message.trim()
        : "";
  const parts = [clock ? `来源时钟：${clock}` : "", message].filter(Boolean);
  return parts.length ? `${parts.join("。").replace(/。+$/, "")}。` : null;
}
