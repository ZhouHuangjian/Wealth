# 公共行情目录、指数与商品期权接入（2026-09-25）

这是在 [2.1 行情研究](market-data-v3.md) 基础上的增量记录，不代表生产服务器已发布。没有复制第三方项目源码，没有新增付费订阅或 API 密钥。

## 目录与检索契约

`MarketSymbol` 的数据库表名为 `wealth_marketsymbol`。这是跨租户共享的**公开产品元数据**，只保存代码、提供方确认的名称、公开别名、分类、市场、币种、合约公开属性、来源和刷新时间。它不继承 TenantModel，不保存账户、持仓、买入时间、用户自定义产品名或原始搜索词。

- `search_catalog(query, kind='fund', market='CN', remote=False, limit=20)` 默认只查数据库。NFKC/大小写规范化、中文/代码/公开别名子串搜索，ORM 参数绑定；输入最多 80 字，结果最多 50 条。不在本地 GET 搜索中初始化目录或请求外网。
- `remote=True` 才调用固定提供方搜索，验证结果后按 `(kind, market, code, currency)` upsert。返回 `items/source/local_count/refreshed_at/status/message/remote_requested/remote_status`。远程失败保留本地结果并返回 unavailable，不把旧元数据称为刚刷新。
- `metadata_only` 表示种子身份信息，`verified` 表示公开提供方确认元数据；两者都不是“当前有实时价格”的保证。报价可用性、原日期和延迟状态由独立行情接口决定。
- `refresh_catalog(limit=40000, include_funds=True, force=False)` 是显式后台入口：补齐常用股票、指数、基金、期货品种别名种子；下载公开基金目录。最近 20 小时已成功更新则跳过；force 可以强制刷新。未下载成功时仍保留本地目录。小批量会先补缺失代码，再更新较旧条目。
- 基金全目录接口本次实际响应约 3.18 MB、27,954 条；仅此后台请求允许最多 8 MB，其余单次行情请求仍默认 2 MB、8 秒超时。目录来源为 [天天基金公开基金代码文件](https://fund.eastmoney.com/js/fundcode_search.js)。只提取 JSON 字面量，不执行其 JavaScript。

发布时先完成迁移 0007，再执行 `python manage.py market_catalog --seed-only`，之后运行 `python manage.py market_catalog --force` 预热完整基金目录。迁移会在 PostgreSQL 且 wealth_app 角色存在时授予该公共表 SELECT/INSERT/UPDATE/DELETE；没有账户数据或私有行级访问策略需要复制到公共目录。每日任务可直接调用 refresh_catalog。此目录不是全部全球证券数据库：股票/指数先有常用种子，其余通过明确远程搜索逐步缓存。

## 商品期权身份和报价

用户的 `2701豆粕沽3300`、`豆粕2701认沽3300`、`m2701-P-3300`、`M2701P3300` 归一为 `m2701-P-3300`，即豆粕 2027 年 1 月看跌期权、行权价 3300；报价单位为人民币/吨，一手标的为 10 吨。代码格式和月份规则核对了 [大商所豆粕期权业务指南](https://www.dce.com.cn/dalianshangpin/resource/cms/2017/04/%E6%9C%9F%E8%B4%A7%E5%85%AC%E5%8F%B8%E8%B1%86%E7%B2%95%E6%9C%9F%E6%9D%83%E4%B8%9A%E5%8A%A1%E6%8C%87%E5%8D%97%281%29.pdf)。不会把 M/MS 系列期权混为同一代码，也不会根据输入推断实际挂牌、到期行权或持仓交易。

只识别出合约格式而尚未查证上市时，返回不入库的 `source=notation/status=unverified` 候选。`2701豆粕` 等期货自然格式另解析为 `M2701`，不会与期权互换。沪铜看涨/看跌和行权价也可解析；5 吨乘数来自 [上期所阴极铜期货期权合约](https://www.shfe.com.cn/products/option/nonferrousmetal/cu_o/standard_cu_o/202401/t20240103_331329.html)。其他品种未核实的乘数不猜测。

新浪自己的 [商品期权页面脚本](https://n.sinaimg.cn/finance/optionDP/commodity_options_191212.js?20220805) 使用 `P_OP_` 加紧凑合约代码查询。实现按实际响应解析 `P_OP_m2701P3300`，与八位 ETF 期权的 `CON_OP_10012427` 分开路由。2026-09-25 开发机实测豆粕该合约价格 40.000，源时间为 **2026-09-24 15:04:42**；沪铜 `cu2611-C-80000` 也返回有效价格，源日期为 09-23。保留原日期，不能将抓取时间当成交易时间。空合约、过期或源不可用时不产生零价格。当前不自动补商品期权历史，不生成期权成交/结算分录。

## 指数身份、实时与历史

指数是观察用基准，报价单位为“指数点”。为了与现有报价结构兼容，美国指数 currency=USD，内地指数 currency=CNY；这个字段不意味着拥有可计入资产的美元或人民币头寸。

| 系统代码 | 指数 | 提供方代码 | 身份核实 |
| --- | --- | --- | --- |
| NDX | 纳斯达克100 | Yahoo `^NDX` | [Nasdaq 指数官网](https://indexes.nasdaq.com/Index/Overview/NDX) |
| SPX | 标普500 | Yahoo `^GSPC` | [Cboe SPX 产品资料](https://www.cboe.com/en/tradable-products/sp-500/sp500-suite/) |
| VIX | Cboe 波动率 | Yahoo `^VIX` | [Cboe VIX 官网](https://www.cboe.com/tradable-products/vix/) |
| H30269 | 中证红利低波动 | 东方财富 `2.H30269` | [中证指数官方 factsheet](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/H30269factsheet.pdf) |
| 930955 | 中证红利低波动100 | 东方财富 `2.930955` | [中证指数官方 factsheet](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/930955factsheet.pdf) |
| 931446 | 中证东方红红利低波动 | 东方财富 `2.931446` | [中证指数官方 factsheet](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/931446factsheet.pdf) |

三种红利低波指数各有独立代码，不能换用中证红利 000922 或跟踪它们的 ETF 净值。当前没有香港指数适配器；选择 HK 的未知指数返回 unsupported。

`fetch_quote` 验证源代码和指数身份，返回点位、原发布时间、来源、单位。美国指数通过 [Yahoo 图表接口](https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?range=6mo&interval=1d)；内地指数通过东方财富 push2/push2his。内地盘中接口失败时可使用最近 20 天历史末条作为 **kind=close**，原经济日期不变，published_at 保持未知，另返回 `live_status=unavailable` 和“盘中行情暂不可用，显示最近已收盘点位”。如果历史接口也失败，则明确 unavailable。

实测 NDX/SPX/VIX 最新点位及半年历史均成功；2026-03-25 至 09-25 范围分别返回 127/127/129 条已收盘记录。三个内地指数的同范围历史均成功返回 127 条。东方财富盘中接口存在间歇断连，后续抽样也出现盘中与短期历史都不可用；不能将一次开发机成功描述为持续实时服务或服务器网络已验证。

历史接口沿用最多五年限制，支持半年、一年等调用范围；保留缺口，不前向填充或补零。当天尚未结束的日 K 不作为正式收盘记录：内地 16:00、美股纽约 17:00 之后才接纳当天 bar，按市场时区和夏令时判断，早收市日仍保守等到该时刻。本次美股处于 09-25 盘中，正式历史正确截止 09-24。

## 验证范围

原 53 项行情测试继续通过。新增离线样本来自实际公开响应裁剪，覆盖商品期权格式和路由、完整时间/报价单位、指数身份和币种、盘中 bar 排除、历史原日期、不补缺口和最近收盘 fallback。目录测试覆盖本地搜索无网络/不自动 seed、市场分类隔离、SQL 特殊字符、输入/结果限制、未验证合约不落库、公开字段白名单、远程失败保留目录、pinyin/中文别名、真实基金目录币种识别、幂等 upsert。最终整体测试数量及发布验收由发布记录报告。

## Ubuntu 网络实测后的美国指数备用源

在目标 Ubuntu 主机上进行了只读网络抽样：Yahoo query1 与 query2 都返回 HTTP 429，响应约 0.5–1.6 秒；不是证书错误或连接超时。只替换 query2 无法解决。适配器保留 Yahoo，只有网络源 unavailable 时切换到以下固定公共地址；身份不一致仍拒绝，不能借 fallback 掩盖错误产品。

| 指数 | 当前参考点位备用源 | 正式日收盘备用源 |
| --- | --- | --- |
| NDX | [腾讯 us.NDX](https://qt.gtimg.cn/q=us.NDX)，报文内部必须是 `.NDX`/USD | [Nasdaq 官方 NDX 历史页](https://www.nasdaq.com/market-activity/index/ndx/historical)对应 `api.nasdaq.com/api/quote/NDX/historical?assetclass=index`，返回 `data.symbol=NDX` |
| SPX | [腾讯 us.INX](https://qt.gtimg.cn/q=us.INX)，报文内部必须是 `.INX`/USD | 腾讯指数日线，校验外层请求代码与内嵌 qt 身份，剔除尚未收盘或仍缓存盘中时刻的当天 bar |
| VIX | [Cboe 官方延迟 JSON](https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/_VIX.json)，同时校验 `_VIX`、`^VIX`、`security_type=index` | [Cboe 官方历史页](https://www.cboe.com/tradable-products/vix/vix-historical-data/)链接的 [VIX_History.csv](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv) |

腾讯当前时间字段与 Cboe `last_trade_time` 按纽约时区处理，保留其真实交易日并处理夏令时；明显晚于系统时刻的报价拒绝导入，避免 UTC/北京时间误当纽约时间。Cboe 返回延迟标记（约 15 分钟），不会声称逐笔实时；延迟接口失败时可返回官方 CSV 最近收盘，保留 kind=close、原日期和 live_status=unavailable。官方新主机是 **cdn-api.cboe.com**；旧 cdn.cboe.com 请求会重定向或返回较旧 CSV，因此直接访问新官方地址，继续禁止跨站重定向。

本次实测还发现腾讯 `us.NDX` 历史包的旧日线是指数，但内嵌 qt 及追加当天 bar 可能混入 **DX.N 股票**。不能仅凭 JSON 外层名称认定身份，也不能把 11 元股票值写入指数历史。因此 NDX 历史直接采用 Nasdaq 官方源，腾讯该历史包有固定回归样本用于拒绝验证。东方财富 `100.NDX` 实际指纳斯达克综合，`100.NDX100` 才是纳斯达克100；该历史端点在服务器持续断连，本轮未用作备用源。没有用 QQQ、SPY、VIXY 等 ETF 替代指数。

服务器实际运行候选纯网络适配器后，NDX 和 SPX 的一年正式历史各返回 251 条，VIX 官方 CSV 返回 258 条，均截至 2026-09-24；9 月 25 日盘中 bar 不进入正式历史。Nasdaq 历史按一年分段、最多 400 条每段并验证 totalRecords，避免静默截断。纯行情回归覆盖源故障切换、错误证券身份、公开 CSV 格式、时间与延迟标识、未来时间拒绝、缺失日期及盘中数据排除；部署状态仍以最终发布记录为准。
