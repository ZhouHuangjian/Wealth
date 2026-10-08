import test from "node:test";
import assert from "node:assert/strict";
import {
  marketTime,
  providerLabel,
  qualityPresentation,
  sourcePresentation,
  sourceTimestampMessage,
  quoteDetails,
} from "../src/market-quality.ts";

test("AKShare shows the query channel and the original data source separately", () => {
  assert.equal(providerLabel("akshare"), "AKShare");
  assert.deepEqual(
    sourcePresentation({
      provider_id: "akshare",
      source_group: "eastmoney_fund",
      upstream_provider_id: "eastmoney_fund",
      interface_name: "fund_open_fund_info_em",
    }),
    {
      label: "AKShare",
      origin: "天天基金 / 东方财富",
      interfaceName: "fund_open_fund_info_em",
    },
  );
  assert.equal(
    sourcePresentation({ provider_id: "akshare", source_group: "sina" }).origin,
    "新浪",
  );
});

test("direct sources do not repeat their label and legacy data has no inferred publisher", () => {
  assert.equal(
    sourcePresentation({
      provider_id: "gffunds_official",
      source_group: "gffunds_official",
    }).origin,
    null,
  );
  assert.deepEqual(sourcePresentation({ source: "历史手工来源" }), {
    label: "历史手工来源",
    origin: null,
    interfaceName: null,
  });
  assert.equal(
    sourcePresentation({ provider_id: "future_provider" }).label,
    "future_provider",
  );
});

test("source group metadata explains AKShare without treating interface names as publishers", () => {
  assert.equal(
    sourcePresentation({
      provider_id: "akshare",
      source_group: "eastmoney",
      source_group_name: "东方财富 A 股行情",
      interface_name: "stock_zh_a_hist",
    }).origin,
    "东方财富 A 股行情",
  );
  assert.equal(
    sourcePresentation({
      provider_id: "akshare",
      interface_name: "stock_zh_a_hist",
    }).origin,
    null,
  );
});

test("multiple channels from one origin stay labelled as a single source", () => {
  const row = {
    data_quality: {
      status: "single_source",
      independent_source_count: 1,
      compared_date: "2026-10-06",
      usable_for_accounting: true,
    },
    provider_observations: [
      {
        provider_id: "eastmoney_fund",
        source_group: "eastmoney_fund",
        economic_date: "2026-10-06",
      },
      {
        provider_id: "akshare",
        source_group: "eastmoney_fund",
        economic_date: "2026-10-06",
      },
    ],
  };
  const presentation = qualityPresentation(row);
  assert.equal(presentation.label, "单一来源");
  assert.match(presentation.message, /同一原始数据源/);
  assert.doesNotMatch(presentation.message, /核对一致/);
});

test("an old observation cannot make latest single-source data appear cross-checked", () => {
  const presentation = qualityPresentation({
    data_quality: {
      status: "single_source",
      independent_source_count: 1,
      compared_date: "2026-10-06",
      usable_for_accounting: true,
    },
    provider_observations: [
      { provider_id: "eastmoney_fund", economic_date: "2026-10-06" },
      { provider_id: "akshare", economic_date: "2026-10-05" },
    ],
  });
  assert.match(presentation.message, /一个独立可用来源/);
  assert.doesNotMatch(presentation.message, /多个查询渠道/);
});

test("quarantined observations and failed attempts retain their source metadata", () => {
  const observation = {
    provider_id: "akshare",
    source_group: "eastmoney_fund",
    interface_name: "fund_open_fund_info_em",
  };
  const attempt = {
    provider: "akshare",
    source_group: "sina",
    status: "error",
  };
  const details = quoteDetails({
    provider_attempts: [attempt],
    nav_quarantine: {
      "2026-10-06": { date: "2026-10-06", observations: [observation] },
    },
  });
  assert.equal(
    sourcePresentation(details.quarantined[0]).origin,
    "天天基金 / 东方财富",
  );
  assert.equal(sourcePresentation(details.attempts[0]).origin, "新浪");
  assert.equal(details.attempts[0].status, "error");
});

test("unknown night-session natural date keeps source clock separate from publication and fetch time", () => {
  const row = {
    source_clock: "21:05:00",
    timestamp_quality: "source_clock_only",
    timestamp_message: "来源仅提供时钟和交易日；夜盘自然日期尚未核实",
    published_at: null,
    fetched_at: "2026-10-08T13:10:00Z",
  };
  assert.equal(
    sourceTimestampMessage(row),
    "来源时钟：21:05:00。来源仅提供时钟和交易日；夜盘自然日期尚未核实。",
  );
  assert.equal(marketTime(row.published_at), "来源未提供");
  assert.equal(row.published_at, null);
  assert.doesNotMatch(sourceTimestampMessage(row), /2026-10-08/);
  assert.equal(
    sourceTimestampMessage({ ...row, timestamp_quality: "published_time" }),
    null,
  );
  assert.equal(sourceTimestampMessage({ fetched_at: row.fetched_at }), null);
});
