# 产品识别与确认日期预览（2.3）

核对日期：2026-09-26。实现为确定性纯函数，不调用网络、不写账本、不生成定投成交、申购确认、费用或资金变动。

## 接口与人工覆盖

`wealth.instrument_metadata.resolve_instrument_metadata(body)` 返回根级字段 `code/name/kind/market/currency/exchange/specification/calendar/settlement_rule/status/candidates/sources/warnings/rule_version`。`kind=etf` 保持 ETF 分类，并使用场内交易渠道。六位纯数字在未选类型时可能同时代表基金、股票、指数，返回 `ambiguous`；不能据此直接创建未确定类型的产品。

自动规则的品种与交易所识别不等于合约挂牌确认，期货期权规格始终包含 `contract_verified=false`。代码月份、期权正行权价有基础校验；合约是否挂牌、到期、临时停牌及合约乘数应另行向交易所或机构核对。连续合约只表示参考行情。

人工输入通过 `overrides` 提供，持久保存于 `specification.metadata_overrides`。支持类型、市场、币种、交易所、日历、确认天数及截止时间。显式空对象清除旧覆盖；`confirmation_days:null` 禁止自动确认日期。系统生成的 `specification.settlement_rule` 再次送入识别器仍保留 estimated，不会升级为人工或已核实规则。唯一公共目录命中可通过服务层 `_catalog_currency` 提供币种；人工覆盖优先级最高。

自动规格带 `specification.metadata_identity={code,kind}`，代码或类型改变时清除原产品的自动识别字段，保留明确人工覆盖与用户标签。旧版无此标记的衍生品规格如与新基金/股票代码冲突，也会清除期货交易所与日历，防止新产品套用旧规则。公共目录补充数据前应先采用已清理的规格，避免再次混入旧字段。

`wealth.trading_calendar.preview_trade_dates(body)` 接收内嵌 `instrument` 或同级产品字段，以及 `application_at`（带时区或按市场本地时区）、`application_date`；可人工指定 `trade_date` 和 `confirmation_date`。返回归属交易日、预计确认日、日历、规则、依据、警示，以及 `is_forecast=true`、`creates_ledger_event=false`。仅提供日期时假设截止前申请并警示；达到或超过场外基金的 15:00 截止点按下一开放交易日预估。实际成交仍只能通过机构记录/用户确认入账。

## 基金规则及边界

普通场外基金建议 T+1，QDII 建议 T+2，FOF 建议 T+3，均标记 `estimated`、`requires_confirmation=true`。这些是同类产品的参考值，不是逐个基金合同的核实结果。货币基金的建议指申购确认，不能推导起息日、收益分配日或赎回到账日。基金净值归属日、净值发布日期、确认日、查询到份额的日期、可赎回日期不能混为一谈。

- [广发基金关于 T+1/T+2 的投资者教育](https://edu.gffunds.com.cn/lcxt/zdjptzjhl/tzjhl1/202405/t20240515_393621.shtml)：提供普通境内基金与 QDII 的常见处理周期。
- [易方达基金确认时间 FAQ](https://api.efunds.com.cn/xcowch/ui/content/show?ID=520336&platformID=pc)：普通基金、QDII、FOF 的参考确认周期。
- [广发基金服务协议](https://gfwx.gffunds.com.cn/html/app/agreement/riskwarning/service.html)：T+N 按交易工作日计算，不按自然日。
- [广发恒生科技相关 QDII 产品 2021 年招募说明书](https://www.gffunds.com.cn/jjgg/flwj/202107/P020210914573712352703.pdf)：存在正常 T+1 确认、T+2 查询的表述。因此不能把所有 QDII 的确认周期写死为已核实 T+2。
- [易方达标普 500 指数（QDII-LOF）产品页](https://www.efunds.com.cn/fund/161130.shtml)：海外市场休市等情形可有单独暂停申赎公告。当前实现没有产品级暂停申赎日历，QDII 始终提示核对境外休市及产品开放日；预览不是必然确认日期。

## 静态交易日日历

| 日历 ID | 覆盖年份 | 时区 | 范围 |
| --- | --- | --- | --- |
| CN_EXCHANGE | 2025、2026 | Asia/Shanghai | 境内证券交易所公布休市日及周末 |
| CN_FUTURES | 2026 | Asia/Shanghai | 境内期货节假日的日间交易日 |
| HKEX | 2026 | Asia/Hong_Kong | 香港证券交易日 |
| US_EQUITIES | 2026 | America/New_York | NYSE 股票交易日 |

覆盖之外返回不可用，禁止用“周一至周五”补齐未知年份。国务院调休工作日不等于证券交易日，周末补班仍为休市。日历只描述是否为交易日，不描述半日市、开收盘时间、银行结算日、天气停市、临时市场公告或产品暂停开放。美股交易日也不等于 DTCC 结算工作日，因此没有据此推断美国股票结算日期。

官方年历来源：

- [上交所 2025 年休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20241223_10767110.shtml)。
- [上交所 2026 年休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml)；[深交所同年通知](https://www.szse.cn/disclosure/notice/t20251222_618087.html)。
- [上期所节假日安排](https://www.shfe.com.cn/services/calenderandholidays/holiday/)；[中金所 2026 年休市通知](http://www.cffex.com.cn/jystz/20251217/46425.html)。上期所同时公布节前取消夜盘安排。夜盘经济归属涉及品种与节前安排，目前不凭时间猜测，18:00 后或 06:00 前申请须手工填入结算单上的交易日。
- [港交所 2026 年假期通告](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf)。半日市仍是交易日；它不等于完整交易时段。
- [NYSE 交易时间和休市安排](https://www.nyse.com/trade/hours-calendars)；[2026 年日历](https://www.nyse.com/publicdocs/nyse/ICE_NYSE_2026_Yearly_Trading_Calendar.pdf)。

维护要求：每年先核对官方通知再增加对应年份；不能自动复制上一年假期。发生临时休市或产品开放变化时，应另增经验证的覆盖数据并更新来源和版本。

## 品种识别资料与范围

`FUTURES_PRODUCTS` 为前缀到 `{name, exchange, source}` 的映射，覆盖 SHFE、INE、DCE、CZCE、CFFEX、GFEX；包括上期所铸造铝合金/胶版印刷纸、大商所原木/纯苯、郑商所瓶片/丙烯、广期所多晶硅/铂/钯等代码。该表识别品种所属交易所，不能承诺每个年月与行权价已有上市合约，不能从期货存在推断同品种的全部期权已挂牌。

- [上期所品种及交易规则](https://www.shfe.cn/specialtopic/investor/trade/)同时列出上海国际能源交易中心品种。
- [大连商品交易所](https://www.dce.com.cn/)；[交易所 2025 年 7 月月刊](https://www.dce.com.cn/qhxy/file/2025-08-05/17543892971982c9a882b9879b789653019879c0382e003d.pdf)讨论新增纯苯品种。部分官方动态页面有访问限制；映射按品种公开代码维护，不声称在线验证每个合约。
- [郑商所 2026 年 6 月报告](https://www.czce.com.cn/cn/content_file/jysj/ydscbg/2026/6/085dd92a2afe42cd9644c0346b493c9e.pdf)及[较早的品种资料](https://www.czce.com.cn/cn/rootfiles/2021/05/21/1605587979196170-1605587979220715.pdf)。
- [中金所日行情品种分类](https://www.cffex.com.cn/en_new/DailyData.html)。
- [广期所铂合约与品种入口](https://www.gfex.com.cn/gfex/sspzb/sspz.shtml)。
- [上交所期权合约编码规则](https://star.sse.com.cn/assortment/options/rule/c/c_20150911_3985420.shtml)及[深交所证券编码资料](https://www.szse.cn/marketServices/technicalservice/doc/P020240510623040090566.pdf)。中文“2701豆粕沽3300”与行情模块使用同一个纯解析器，规范化为 `m2701-P-3300`。
- [北交所代码映射](https://www.bse.cn/service/code_mapping.html)：920 段可识别；不能把所有旧 4/8 开头代码自动判定为北交所上市证券。
- [港交所 2026 年 3 月证券代码分配表](https://www.hkex.com.hk/Products/Securities/Stock-Code-Allocation-Plan?sc_lang=en)：人民币柜台与美元柜台分开推断币种，不把所有港股代码一律标为 HKD。

## 验证

纯函数测试覆盖六所期货、商品与证券期权、中文代码、六位代码歧义、ETF 分类、人工规则持久化/清除、币种、截止时点、时区、春节/五一、调休周末、跨市场假期、未知年份及夜盘。运行：

```sh
python3 scripts/local_backend.py test pytest tests/test_instrument_metadata.py tests/test_trading_calendar.py
```

这些测试不访问数据库和外部行情接口。API 租户隔离和产品保存验证由 `test_metadata_api_v23.py` 另行覆盖。
