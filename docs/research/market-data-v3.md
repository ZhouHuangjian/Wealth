# 行情接入研究与验证（2026-09-25）

## 参考项目与实现边界

评阅了用户指定的 [hzm0321/real-time-fund](https://github.com/hzm0321/real-time-fund)：其基金检索、持仓分组、正式净值与盘中估值并列展示适合本项目的投资工作台。该项目使用 AGPL-3.0；本次未复制其实现、UI、图标或源码。这里只参考其公开的数据来源及功能思路，以 Python 标准库重新实现独立适配器。

黄金期货搜索返回 future 类型和 `is_derivative=true`，不能作为实物黄金乘数量计资产；AU0 等连续合约另标记 `reference_only=true`。

本系统仍以服务端隔离账簿和不可变分录保存投资事实。行情读取只返回价格；不会产生买卖、扣款、结算或收益分录，也不会把期货价格乘以手数当作账户权益。

## 已实测的数据范围

2026-09-25 在开发机从提供方 HTTPS 地址实际请求，以下代码成功返回有效价格及原始日期；不是演示随机数。公开参考行情可能延迟，不能承诺所有市场逐笔实时。

| 产品 | 数据源 | 验证代码 | 当前行情 | 历史行情 |
| --- | --- | --- | --- | --- |
| 人民币场外基金 | 天天基金 `FundValuationLast`、东方财富 `pingzhongdata` | 110022、161725 | 单位净值；161725 另有盘中估值，110022 无估值 | 单位净值 |
| 人民币 QDII 份额 | 同上 | 050025 | 正式净值日期为 09-23，保留披露滞后 | 单位净值 |
| A 股、场内 ETF | 腾讯财经 | 600519、000001、510300 | 参考价格及提供方时间 | 未复权日收盘价 |
| 港股 | 腾讯财经 | 00700 | 港币参考价格及提供方时间 | 未复权日收盘价 |
| 美股 | 腾讯财经、Yahoo Finance | AAPL | 美元参考价格及纽约时间 | 未复权日收盘价 |
| 商品期货 | 新浪财经 | RB2701、AU2612 | 合约报价及日期 | 暂不自动补历史 |
| 金融期货 | 新浪财经 | IF2610 | 合约报价及日期 | 暂不自动补历史 |
| ETF 期权 | 新浪财经 | 10012427 | 每份权利金及日期 | 暂不自动补历史 |
| 黄金现货 | 新浪财经 | XAU / XAUUSD | 美元/金衡盎司，明确单位 | 暂不自动补历史 |

从 2026-05-06 到 2026-09-25 实测返回：110022 和 161725 各 101 条净值，050025 共 100 条（截至 09-23），600519 共 101 条收盘价，00700 共 100 条，AAPL 共 98 条。没有补出休市日期或今天尚未公布的净值。

来源入口：[天天基金检索](https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=110022)、[基金原始净值](https://fund.eastmoney.com/pingzhongdata/110022.js)、[基金最新净值/估值](https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast?FCODES=161725&FIELDS=FCODE,SHORTNAME,NAV,PDATE,GSZ,GSZZL,GZTIME)、[腾讯证券行情](https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL)、[新浪期货报价](https://hq.sinajs.cn/list=nf_RB2701)、[Yahoo 历史价格接口](https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=6mo)。新浪字段含义另核对了 [AKShare 官方期权文档](https://github.com/akfamily/akshare/blob/main/docs/data/option/option.md) 与其官方仓库中期货适配器。

旧 `fundgz.1234567.com.cn` 接口在本次实测中返回 HTML 错误页，未采用。过期期权示例 10008273 返回空字符串，适配器正确给出 unavailable。商品期权、境外期权和境外期货暂未接入；未知代码会提示不支持或无数据。外币场外基金份额暂不自动估价；不会把人民币净值标成美元。货币基金接口的 NAV 字段可能实际为万份收益（000198 实测为 0.225），因此通过 FUNDTYPE=005 和 ishb=true 拦截，要求录入实际收益，不套用普通基金净值算法。

## 契约与价格语义

文件 `backend/wealth/market_data.py` 无 Django 模型依赖，接受 Instrument 对象或相同字段的 dict：

- `search_products(query, kind='fund', market='CN')`：基金/股票支持名称及代码；期货、ETF 期权、XAU 支持精确代码查找。
- `fetch_quote(instrument)`：返回 `status`、十进制字符串 `price`、`kind`、`economic_date`、`published_at`、`fetched_at`、`source`、`currency`、`data_state`。状态为 ok、stale、unavailable 或 unsupported。
- `fetch_history(instrument, start, end)`：最多五年，返回正式单位净值或未复权收盘价；失败抛出 `MarketDataError(code, message)`，不会静默用零填补。证券历史按一年窗口获取，避免单次条数上限截断。

基金主报价为 `official_nav`，另有 `estimate` 子对象；缺少估值不会使正式净值失效。当前证券/衍生品报价为 `market`，历史收盘价为 `close`。证券日 K 在盘中会包含仍变化的今日 bar，因此只有市场本地时间收盘缓冲期后才接纳当日 bar：内地 16:00、香港 17:00、美股纽约 17:00；此前今日 bar 不进入正式价格，实时参考报价继续更新。提前收市日也保守等待该时间，不猜测交易日历。正式净值只提供经济日期，未知发布时间保持空值；`fetched_at` 只是系统抓取时间。纽约市场使用 `America/New_York` 处理夏令时；中国与香港使用 UTC+8。

`previous_session` 和 `delayed` 区分上一交易日与当天可能延迟的报价。超过七天的基金净值、超过四天的其他价格标记 stale。这是可解释的保守提示，尚不是完整交易所节假日日历。

历史单位净值保存原始分红/折算提示 `corporate_action`，不把它自动转为实际持仓变化。跨分红、拆股、折算的完整实际收益仍依赖相应交易记录；补录买入日期本身不能推断未来发生的定投执行、赎回和分红方式。

## 网络及测试

所有请求限定固定 HTTPS 主机；禁止重定向、任意 URL、代码路径注入，TLS 正常校验。单次超时 8 秒，响应上限 2 MB。只从指定 JS 变量读取 JSON 字面量，不执行 JavaScript 或 `eval`。无第三方新依赖、API 密钥或付费订阅。

失败不覆盖已有价格；这一策略由上层租户持久化服务负责。缓存、自动刷新节奏和供应方失败记录由调用方管理，避免每次页面渲染直接访问提供方。

`backend/tests/test_market_data.py` 共 53 项离线测试通过，使用本次真实响应裁剪的固定样本。覆盖 NAV/估值隔离、QDII/历史日期、不补零、沪港美时区及收盘缓冲（含美股冬令时）、期货不同报文、期权权利金、黄金单位、币种校验、跨站重定向、超长响应及无效输入。生产服务器仍需重新探测网络可达性；开发机成功不等同于服务器已接通。提供方公开接口没有稳定性 SLA，未来若发生授权要求或格式变化，应显示暂不可用并更新适配器。
