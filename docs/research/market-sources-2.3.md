# 2.3 市场目录与数据源策略

本文件记录适配实现及本机公开源核验，不代表生产部署结果。

## 策略与生效时间

`wealth.provider_policy` 维护固定提供方目录，不接受自定义 URL、代理、密钥或代码。管理员保存的配置存于 `PlatformSetting(key="market_sources").data`；API 乐观锁 `version` 与配置内 `schema_version: 1` 分离。配置含 `enabled` 和按 `fund/stock/etf/future/option/index/gold` 分类的 `priority` 列表。列表可为空；不支持的源、重复源、非布尔启用值均拒绝。

每次后台刷新与明确发起的远程检索都重新读数据库，无进程永久缓存。正在运行的刷新使用启动时的配置快照，后续任务读取新配置。当前调度周期内的原有结果仍保留实际来源与时点；停用某源不会删除历史证据。读取配置失败时停止联网，不退回全启用；历史补全意图继续保留。

纯适配层 `fetch_quote`、`fetch_history`、`search_products` 接受 `provider_config=`，不隐式读库。未显式传入配置的离线适配测试使用默认策略。后台和目录入口传入数据库快照。按启用、优先级、产品身份、市场、当前/历史能力筛选来源；失败、空响应、身份不符时尝试下一个兼容源。陈旧价格可作为明确标记的最后结果，优先使用后续源的新观察。响应提供 `provider_id`，当前报价另提供 `provider_attempts`。

## 支持边界

| 产品 | 当前/参考数据 | 正式历史 | 明确限制 |
| --- | --- | --- | --- |
| 境内人民币场外基金 | 天天基金/东方财富单位净值；有提供时单独返回盘中估值 | 同一家提供方的实际单位净值序列 | 此类只有一个提供方家族；货币基金不作普通净值。美元份额不能套用人民币净值 |
| 境内、香港股票/ETF | 腾讯 | 腾讯未复权收盘价 | 当前没有第二个同类报价提供方 |
| 美股股票/ETF | 腾讯 → Yahoo，可调顺序 | Yahoo 未复权收盘价 | 历史仅一个适配源；Yahoo可能限流。校验 symbol、currency、instrumentType |
| NDX | Yahoo → 腾讯 | Yahoo → Nasdaq 官方 | 腾讯 NDX 历史包曾混入 DX.N 股票，故禁止使用其历史 |
| SPX、DJI、IXIC | Yahoo → 腾讯 | Yahoo → 腾讯 | 严格校验对应指数代码、ZS类型、币种；不使用 ETF 代替 |
| VIX | Yahoo → Cboe 官方延迟报价 | Yahoo → Cboe 官方日收盘 | Cboe 报价约15分钟延迟；当前源不可用时可显示带原日期的最近收盘 |
| 沪深主要指数、HSI | 腾讯 → 东方财富 | 腾讯 → 东方财富 | 仅已登记且核验的代码；指数点位不能直接当持仓资产 |
| H30269/930955/931446 红利低波指数 | 东方财富 | 东方财富 | 当前只有一个适配源；连接失败明确不可用 |
| 境内期货、ETF/已支持商品期权 | 新浪 | 暂无自动正式历史适配 | 只有一个源，不编造备用源或历史结算；期货账户按权益处理 |
| XAU 现货黄金 | 新浪 USD/金衡盎司 | 暂无历史适配 | 新浪时间字段为北京时间；内部市场CN用于该源时区，不代表境内金价 |
| 境内黄金ETF | 腾讯 | 腾讯未复权收盘 | 按证券代码和币种获取，不套用XAU或沪金合约价格 |

`eastmoney_search` 是单独的股票/ETF公共元数据搜索提供方，不提供价格；启停它不会误停腾讯行情，启停腾讯也不会绕过另行禁用的目录源。场外基金目录仅使用 `eastmoney_fund`。各类别没有第二个源时，界面及目录明确这一事实。

## 公共目录与新增候选

`browse_catalog(kind="", market="", query="", offset=0, limit=50)` 只读公共数据库，不联网、不隐式种子、不读取用户账户。空关键词返回优先排列的指数、黄金、商品参考候选；分页上限100条，偏移上限50000。模糊搜索使用归一化字符串与参数绑定。缓存表仅保存代码、名称、公开别名、币种、公开规则元数据，不保存用户原始查询、持仓或自定义私有名称。

新增指数：上证000001、沪深300/中证500/中证1000/中证红利（000300/000905/000852/000922）、深证成指399001、创业板指399006、HSI、DJI、IXIC；与已有 NDX/SPX/VIX 和三种不同红利低波指数分别展示。新增 XAU、518880黄金ETF、510300沪深300ETF。商品候选补充白银、有色金属、原油、橡胶、焦煤/焦炭、农产品、股指、国债等连续参考代码。

连续合约仅用于市场环境观察，标记 `reference_only`，并不宣称是可成交的具体到期合约。新商品目录的品种名称/交易所复用 `instrument_metadata.FUTURES_PRODUCTS` 的交易所公开资料；尚未逐个取得有效报价的候选维持 `metadata_only`，不标记“行情可用”。缺失乘数、交收或确认天数不做推断。

冷启动与每日刷新仍使用 `refresh_market_catalog` 管理命令/任务：先写固定公共种子，再在基金源启用时刷新公开基金清单。关闭基金源后可保留已有缓存与种子，但不会继续请求基金清单。浏览和普通本地搜索不触发此过程。

## 核验依据与实际探测

2026-09-26 本机实际调用固定公开端点，确认沪深300、HSI、DJI、IXIC 的腾讯当前报价与9月份历史收盘；DJI/IXIC 当日盘中条目被排除。取得 AAPL 的 Yahoo 当前价与历史，518880 的腾讯当前价与历史，XAU 的新浪当前价。日期、币种、时区均保留源字段；这些探测结果不承诺数据源后续可用性。腾讯实际响应裁剪为 `tests/fixtures/market_data/expanded_indices.json`，测试不联网。

原始指数身份参考：

- [上交所指数行情目录](https://www.sse.com.cn/market/sseindex/quotation/index.shtml)
- [中证指数事实表（含沪深300、中证500及518880对照）](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/930929factsheet.pdf)
- [深交所市场月报（399001、399006）](https://docs.static.szse.cn/www/market/periodical/month/W020250513504907210876.html)
- [恒生指数公司指数目录](https://www.hsi.com.hk/zh-cn/indexes/)
- [Nasdaq指数历史官方接口](https://api.nasdaq.com/api/quote/NDX/historical?assetclass=index)
- [Cboe官方VIX历史文件](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv)

保留此前 2.2 研究记录中的 Ubuntu Yahoo 429、腾讯NDX混入股票、红利低波源断连等证据。本次没有采用代理证券冒充指数，也没有取消固定域名、响应大小、超时、禁止重定向和禁止执行源脚本等边界。

## 最终候选服务器探针（2026-09-27）

`wealth:release-2.3-20260926` 最终镜像 `sha256:06f0d6236a0e87e0fa00566fbf242a63567815e5d00c3327c2834e24d2a3e7e0`，在无生产环境变量、无数据卷的临时容器读取公开行情，证据 `.runtime/v23/server-quote-probe.json`。11 个样本的当前参考报价均返回有效结果：NDX、SPX、VIX、沪深300、恒生、道指、纳斯达克综合、AAPL、518880、XAU、m2701-P-3300。Yahoo 指数源失败时，按配置切换到腾讯或 Cboe。

其中 8 个样本历史查询成功；AAPL 当前仅 Yahoo 历史路径，此次返回 provider_unavailable；XAU 和商品期权未提供历史源，明确返回 unsupported_history。沪深300、518880 和豆粕期权源时间为 9 月 24 日；VIX 为约 15 分钟延迟参考源。休市日不应把最近报价误标成今日成交。样本成功不等于每只产品、每个时段均可用。

发现并修复新浪伦敦金时区问题：该源时间文本按北京时间解析，与产品选择 CN/US 无关。增加跨午夜与延迟状态测试，服务器最终探针确认 published_at 不晚于 fetched_at，避免黄金报价落在未来。
