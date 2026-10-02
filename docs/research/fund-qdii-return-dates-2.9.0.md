# QDII 收益归属日、公布时间及数据接口研究（2.9.0）

研究日期：2026-10-02。参考仓库已执行 `git fetch origin`，远端仍为 `373ee71409256e2208f88bb9a83c99a9320f20b1`（2026-09-28）；本项目审查基线为 `8f5e376fdde0d8c57965a6180d297556809add71`。以下本项目行号指该基线，后续实现可能改变行号。

本文补充 [2.8.0 研究](fund-workflows-2.8.0.md)，区分参考代码事实、官方业务说明和本项目建议。参考项目采用 AGPL-3.0，本次仅研究其业务行为和公开接口，独立实现改进，不复制其代码、组件、样式或依赖。参考仓库说明文件不是本项目的开发指令。

## 1. 结论：正式收益记净值归属日，公布日只解释什么时候看见

例如某基金 9 月 28 日净值 1.00、9 月 29 日净值 1.10；后一个净值于 9 月 30 日才被平台获取，持有 100 份且无交易、分红时，10 元收益归属于 **9 月 29 日**。不能因为 9 月 30 日才看到就再计入 9 月 30 日收益。

三种日期应分别保留：

| 概念 | 含义 | 推荐显示 |
| --- | --- | --- |
| 净值/收益归属日 | 数据源正式净值所属的估值日期 | 净值收益 · 09-29 |
| 源公布时间 | 数据源确实提供的发布时间，可能缺失 | 公布时间，缺失则不展示 |
| 系统获取/记录时间 | 我们首次或最近获取这条数据的时间 | 数据获取时间，不能写成公布时间 |

另有申购申请日、成交净值日、扣款日和份额确认日；这些交易节点也不能合并。QDII 不统一等于“T+2 才产生收益”。

[广发基金 2024-05-15 投教说明](https://edu.gffunds.com.cn/lcxt/zdjptzjhl/tzjhl1/202405/t20240515_393621.shtml)区分 A 股、港股与美股 QDII 的净值披露节奏，并说明跨境假期可能延迟交易确认。该文还说明海外休市但境内开放时，净值仍可能体现汇率变化；境内长假后的净值可能包含假期底层资产变化。该说明用于确认日期概念，不能代替每只基金合同的估值日定义。

[易方达关于长假及 QDII 净值的投教说明](https://edu.efunds.com.cn/Mobile/c/42/42718.shtml)同样要求先看净值日期；多数 QDII 披露较迟，部分香港、日本市场产品并不适用同样延迟。人民币份额净值还包含其规则下的汇率影响，不能再简单加一次美元兑人民币涨幅。

## 2. 基估宝实际上有两种不同口径

### 2.1 当日收益栏是展示选择，不是收益日历归属

固定参考文件 [useHoldingProfit.js:22–37](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/hooks/useHoldingProfit.js#L22)：

- 将 `confirmDays >= 2` 当作延迟基金。
- 正式净值日期等于今天，或延迟基金净值仅落后一个 A 股交易日时，允许其作为 `profitToday` 的价格。
- 否则只有今天的估值时间戳存在时才使用估值；无法计算则为空。
- 正式净值计算仍把 `profitBasisDate` 设为实际 `jzrq`，并按该日期回退买卖份额（同文件 138–156）。

[fundHelpers.js:176–191](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/lib/fundHelpers.js#L176)的“已更新”使用申赎确认天数和 A 股交易日数；[tradingCalendar.js:47–55](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/lib/tradingCalendar.js#L47)在日历未加载时仅排除周末。这些是该软件的展示近似，不能据此确定全部 QDII 的披露或估值日。

参考的“昨日收益”也并不总是昨天：当最新净值早于今天，它取该净值日期的收益记录；当天净值已更新时才取今天之前的最新记录。见 [page.jsx:1248–1277](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/page.jsx#L1248)。因此“当日”和“昨日”栏在延迟净值情况下可能指向同一个收益日期。

### 2.2 收益日历按真实净值日期存储

[useRefreshManager.js:382–438](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/hooks/useRefreshManager.js#L382)以 `data.jzrq` 写入最近正式收益；同文件 444–475 对历史净值逐日补齐，以各行净值日期写入。日历组件按该 `date` 查找当天记录（[MyEarningsCalendarPage.jsx:194–216](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/components/MyEarningsCalendarPage.jsx#L194)）。**没有把所有 QDII 正式收益整体后移到公布日。**

参考的 `navUpdatedAt` 是刷新时发现净值日期前进后记下的本机日期（[useRefreshManager.js:282–287](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/hooks/useRefreshManager.js#L282)），不能视为基金公司的准确发布时间。

### 2.3 公式与不足

[useHoldingProfit.js:184–244](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/hooks/useHoldingProfit.js#L184)优先用前后净值之差乘有效份额；没有前净值时用涨幅反推，估值同样用估算涨幅反推。持仓资产和累计收益优先用正式净值。收益率分母采用持仓成本，这与“以前日市值为基准”的日收益率不同，不能混用。

我们保留现金流调整公式、Decimal、分红/费用及资料不足状态。参考中涨幅缺失转零、用最新可得前净值跨越缺失日期、当前成本回算历史分母等近似，不作为账簿真实性依据。参考待确认交易最终把交易日期记为找到净值的日期（[page.jsx:1703–1713](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/page.jsx#L1703)）；但其向后寻找首个可用净值的行为不应移植，缺数据不能改变本来成交日。

## 3. 接口、字段与回退

以下为固定参考代码调用的公开接口，不代表提供方承诺稳定、免费或适用于生产服务的 SLA。

| 用途 | 接口或数据来源 | 日期与数值字段 | 代码依据 |
| --- | --- | --- | --- |
| 最新净值和估值 | `fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast`，参数 `FCODES`、`FIELDS` | `NAV/PDATE` 为正式净值及其日期；`GSZ/GSZZL/GZTIME` 为估值、涨幅及时间 | [fund.js:950–978](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L950) |
| 历史正式净值 | `fund.eastmoney.com/pingzhongdata/{code}.js` | `Data_netWorthTrend.x/y/equityReturn/unitMoney`，时间戳对应净值日，不是公布时间 | [fund.js:575–627](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L575)、[725–767](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L725) |
| 新浪两种估算 | `stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol={code}` | `pre_nav/growthrate` 或 `pre_nav2/growthrate2`；`pre_date/min_time` | [fund.js:1083](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L1083)、[1331–1371](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L1331) |
| 自建 QDII 估值 | 已配置 Supabase 的 `gs_qdii` 表 | `gztime/gszzl/gzstatus`；客户端用最新正式净值乘涨幅推算估值 | [fund.js:1136–1153](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L1136)、[1484–1489](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L1484) |
| 申赎确认天数 | `fundmobapi.eastmoney.com/FundMNewApi/FundMNBaseInfo` | `Datas.SSBCFMDATA` | [fund.js:1391–1412](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L1391) |

参考 `fetchFundData` 并行读取选定估值源与历史净值；估值源失败时退到正式历史净值，并非总是遍历另外三种估值源；历史净值更晚时再覆盖较旧正式净值（[fund.js:1441–1480](https://github.com/hzm0321/real-time-fund/blob/373ee71409256e2208f88bb9a83c99a9320f20b1/app/api/fund.js#L1441)）。自动“最优源”还依赖其 Supabase 后端与登录配置，不能当作独立公开行情服务直接接入。

`gs_qdii` 的客户端代码无法证明服务端模型、汇率口径、涨幅基准净值日期或发布时间真实性。不能直接把其涨幅乘任何较新的净值；先要核验估值基准日、币种、更新时间与产品匹配。我们优先保留已知正式净值，缺估值显示“暂无估值”，不把缺失转零。

本次最初试读遇到本机默认证书链校验错误，随后使用系统 Python 和 certifi 的可信 CA 完成新浪 `270042` 现场读取（证据位于被忽略的 `.runtime/v290/sina-fund-270042.json`，未绕过 TLS）。该响应 `pre_date` 为 10 月 2 日，`worth_date` 为 9 月 29 日；`prerate` 参考较早净值，可能覆盖多日，不能直接当成 10 月 2 日单日收益。本轮不新增该估值源；一次响应也不构成接口可用率或服务承诺。

同次验证天天基金最新接口返回 HTTP 200（`.runtime/v290/eastmoney-fund-live.json`）：`270042` 的正式 `NAV=8.3418/PDATE=09-29`，`GSZ/GZTIME` 为空；`020602` 的 `PDATE=09-30`，`GSZ=1.0826/GZTIME=09-30 15:00`。这同时说明跨境基金可能只有较早正式净值，普通基金估值也可能只是节前旧快照。两个来源都不能仅因今日请求成功就归入今日收益。

## 4. 本项目现状与实际缺口

| 本项目基线位置 | 已有能力或缺口 | 改进 |
| --- | --- | --- |
| `market_data.py:309–420` | 已有天天基金最新估值、正式历史净值回退；正式净值按 `PDATE/x`，估值按 `GZTIME` | 保留；历史净值缺正式发布时间时保持 null |
| `provider_policy.py:9–15` | 基金当前只有 `eastmoney_fund` 适配器，配置多源不等于已有第二基金源 | 可独立新增经验证的新浪估值适配器，但不能冒充正式净值或无声套用跨日涨幅 |
| `market_sync.py:185–249`、`models.py:164–172` | Price 已分 `economic_date/published_at/created_at` | 输出 `observed_at` 指实际记录时间；不把它命名为官方公布时间 |
| `daily_returns.py:273–318, 543–632` | 今日收益只接纳当日正式/参考价格；另有 `latest_confirmed_return` | 保留，不把晚公布旧净值加到今日总计；补足收益归属日和记录时间解释 |
| `daily_returns.py:84–95`、`investments.py:1098–1115` | 除期初重建外，份额变动按账务确认日计算 | 有可靠 `nav_date` 的已确认基金，分析份额应按成交净值日生效；两个入口共用规则 |
| `fund_orders.py:280–307`、`dca_automation.py:868–891` | 确认事件已同时保存确认日和 `nav_date`，但分析没有充分利用 | 不改变账簿事实，只修分析日期 |
| `valuation_calendar.py:20–27` | 场外跨境基金默认用海外市场日历作收益连续性检查 | 将参考估值市场日历与正式净值连续性规则区分；无产品规则不猜所有 QDII 均每天跟随美股出净值 |
| `frontend/src/pages/HoldingsOverview.tsx:24–64` | 正式价格＋推算份额可展示，已带日期 | 用“净值收益/净值日期”避免把确认日、公布日混为一谈 |

### 确认日集中收益的具体问题

假设 9 月 28 日申购 100 元、成交净值 1.00、100 份、9 月 30 日确认，9 月 29/30 日净值分别为 1.10/1.20，无费用。现有分析若从 9 月 30 日才加入份额，会把 20 元一次记在确认日；已知完整交易后，正确分析应为 9 月 29 日 +10、9 月 30 日 +10。9 月 28 日新申购份额不享有买入前的当日涨幅；费用如计入收益则单独按现金流规则处理。

资金账和在途金额仍按真实扣款、确认日期流转。历史收益重新归属不意味着把账户在途提前清除，也不意味着修改不可变交易事实。

## 5. 推荐可实施契约

1. 保持兼容字段 `date`，明确等于 `return_date`，表示实际收益归属日；`nav_date/price_date` 表示所用价格归属日。`published_at` 只保留数据源实际提供的时间，`observed_at` 表示系统记录价格的时间。
2. `price_basis=formal/estimate` 与 `quantity_source=recorded/automatic_estimate` 分开。正式净值＋推算份额允许展示金额，但不声称机构确认。
3. 为两个收益入口共用份额分析日期解析：仅真实存在且未冲销的场外基金 `fund_confirm`，关联同空间、产品匹配的原 `fund_debit`，且 `debit_date <= nav_date <= confirmation_date` 才能用于回溯。任意填写的早期 `application_date/nav_date` 不构成更早申请事实；未来若支持先申请后扣款，需另有可核验申请记录。无效、未来或来源冲突日期不默默迁移；普通买卖、期货、期权保持现有语义。历史查询允许在确认事实已被获知后重算，界面应说明这是按目前已知记录回溯，而非“当时已知”。
4. 正式净值相邻记录跨周末/假期时，按产品估值日历判断是否漏报；日历未知时可展示明确区间变化，但不能标成单日收益。今日跨境参考估值仍使用匹配的海外参考市场日历，不因正式披露规则未知而一律禁用。
5. 首页“今日估算”只汇总实际目标日可计算项，最近净值收益单独展示真实日期。混合日期的最新收益不能包装为同一天汇总。非零缺口继续显示部分可算，未开市/未发布不伪装零收益。
6. 不新增逐期人工确认；后续正式净值到达后自动回填分析，保留推算来源、失败日期与更正入口。

## 6. 必要回归场景

- QDII T 日买入、T+2 确认，T+1/T+2 涨跌分别归属，首页与收益日历一致。
- 普通 A 股基金 T+1 确认也使用成交净值日期，费用不重复扣，买入当天不获取买入前收益。
- 未确认申购仍为在途，不能凭计划创建就回填真实持仓；已冲销确认不进入收益。
- `nav_date` 缺失、非法、晚于确认日或与正式成交净值冲突时不猜日期。
- QDII 旧日期净值今天获取，最近净值收益可见，今日估算不重复纳入；`observed_at` 与 `published_at` 不混淆。
- 9 月 30 日至国庆后跨境净值：境外开市不等于该产品天天披露；不能把多日区间变化编造成每个自然日收益。
- 有今日有效美股 QDII 参考估值时仍可使用；接口异常或估值日期过旧不能以零收益替代。
- 净值公布、交易更正与重复刷新不产生第二笔账务，日收益补齐不会改变在途本金或账户余额。

## 7. 本轮独立实现及验证范围

- `wealth/return_dates.py` 统一分析份额日期：已发生、未冲销的场外基金份额确认可按其有效 `nav_date` 回溯；账务事件日期不变。缺日期的旧记录继续按已有日期计算；非法、早于匹配原申购扣款或晚于确认日的日期显示待核对。关联扣款批量预载，不随确认笔数增加数据库读取次数。
- `wealth/daily_returns.py` 与 `wealth/investments.py` 共用上述规则；历史收益注明“按目前已记录事实回溯”。新增 `return_date/nav_date/observed_at`，正式数据源未提供公布时间时 `published_at` 保持为空。
- 今日明细中的 `latest_formal_return` 单独携带最近净值收益及日期，不进入今日收益汇总；正式净值与推算份额分别标明来源，收益日历与每日展示采用相同的推算状态。
- `wealth/valuation_calendar.py` 将正式净值连续性验证与参考估值市场日历分开。没有明确产品规则的 QDII 跨缺口正式收益仍可能显示不可计算；海外市场参考估值不会因此一律失效。本轮未增加新浪或第三方自建估算接口。
- 另补空仓账户的每日收益衔接：复用账户现金延续证据，期间无已记录敞口时结算盈亏按零推算，明确标记来源；真实已记分红仍保留，冻结、范围未核实或期间发生买卖不按零处理。该投影不创建结算单或账务。

本轮新增 QDII/收益日期 17 项、空仓日收益 6 项数据库回归。最初与已有日期、日收益、账户提现专项合计 96 项通过；相关基金订单、定投自动化、在途、分红、持仓及收益日历另 211 项通过。独立复核后补充原扣款日期下限、既有持仓在确认期间卖出与分红、未来确认及批量查询边界，再运行相关 191 项通过。证据保存于 `.runtime/v290/empty-and-qdii-tests.log`、`.runtime/v290/qdii-related-tests.log` 及 `.runtime/v290/qdii-attribution-boundary-tests.log`；这些是针对本轮变更的专项结果，不替代最终发布的全量验收。
