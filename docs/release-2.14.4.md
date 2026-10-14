# 2.14.4 空仓收益与休市状态一致性

状态：已实现，正在隔离验收，尚未部署。审查日期2026-10-14；分支`codex/estimate-return-diagnosis-20261012`，干净基线`41b1cd1883728bdc273620e9bac59738527889dd`。实际运行2.14.3镜像`9f4ca6be7bbb75b123654a7bde0145a81aca50ab09ea528f9222662d8a1b912c`，schema0015；原工作区`docs/manuals/`未覆盖。

| 编号 / 优先级 | 用户症状、证据与根因 | 修复与验收 |
| --- | --- | --- |
| RET-013 / P1 | 期货持续无仓，首页0但收益日历缺数。10/14 08:48生产强制只读核对：一个future账户，10/04完整settlement、无已记录敞口，首页已返回estimated 0；`profit_calendar`显式禁止cash-only路径 | 复用受控空仓推算，日历如实标estimated。旧正式后无仓→0；资金转移剔除、分红保留；当天平仓净收益97仍97；仅首日空仓不虚造全天0；冻结不解除提现限制 |
| RET-014 / P2 | 正常休市且无当日行情仍显示未更新。`spot`缺价格先返回no_estimate；旧休市判断仅在有参考价时执行，且False/None合并 | 引入共享三态日历证据和连续区间守卫：首页/持仓/日历显示休市、不填0、不制造待办；开放日漏数、NAV冲突、费用、期权变化、范围不清仍保留待补全 |

修前固定样本：新休市集成9项中5失败、4通过；首轮合并回归181通过、1项新手工手续费样本在teardown被账务不平衡约束拒绝，已为该样本补真实expense对方科目，未改约束/断言/跳过。阶段104项已通过；最终全量与页面结果在完成后补录，不能相加冒充全量。

规则唯一维护于[领域模型§14.4](domain-model.md#144-空仓休市与缺数2144)，字段见[API§21](api-contract.md#21-每日收益与持仓展示现行)。关键位置：`ReturnEvidence.snapshot/spot`、`return_account_state`、`return_sessions`、`investments._calendar_item/profit_calendar/_aggregate_days`，前端`daily-return`、`DailyReturnCard`、`HoldingsOverview`、`ProfitCalendar`。已知+休市为partial，全部休市无金额；不给部分汇总套完整收益率。

本批不改schema、交易/Price/份额、生产计划或来源设置，不执行历史数据修复。重算仅为只读投影，overview版本v28隔离旧缓存。回滚至已验收2.14.3应用即可，保留所有新事实；不能还原旧数据库覆盖发布后的记录。2027未覆盖年历、期货具体夜盘、海外NAV披露时点、货币基金计提等仍待产品依据，不因本次标签修复宣称已支持。
