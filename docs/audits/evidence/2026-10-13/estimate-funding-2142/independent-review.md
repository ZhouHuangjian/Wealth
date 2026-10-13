# 2.14.2 基金参考估值与最近收益更新复查

审查日期：2026-10-13（Asia/Shanghai）。基线 HEAD：`952af3f618520559e64892d2d78464bd3258993d`，审查对象包括当前未提交改动；不是对该 HEAD 已包含全部改动的声明。文末哈希固定本次读到的主要文件。

审查者为行情适配实现代理：对另一代理编写的 `fund_return_updates.py` 和前端接入属于交叉审查；对本人编写的新浪适配与来源策略属于作者复查，不能代替第三方独立审计。本记录不表示已部署。

## 结论与范围

本次范围内发现的发布阻塞已修正；最终后端全量复跑由主代理协调，本记录不预报其结果。五只 QDII 的公开备用响应能够提供带基准的参考值，但不能据此宣称已补齐五只基金的“今日正式收益”。已确认的产品边界是：参考区间另列、正式收益保留净值归属日、未知数据不补零、原已关闭来源不因升级重新开启。

| 范围 | 实际检查 | 结论/限制 |
| --- | --- | --- |
| 配置升级 | `provider_policy.validate_provider_config/provider_chain`；缺省版本、1/2/3/4、显式开关/空链/省略优先级；纯测试 | 原关闭保持关闭；schema 4 自定义省略保持省略；schema 0 仍为不支持版本，不是可升级旧格式 |
| 源适配与缓存 | `sina_fund_estimate.quote`、`fund_sources.compare_quote/_cached_provider_call`、`market_data._provider_quote`；固定响应纯测试 | 原始价格/基准/时间独立；不把参考数据放入正式净值仲裁或 `Price`；旧缓存不续写获取时间 |
| 同步与接口 | `market_sync.refresh_one/quote_list`；缓存/公开行纯测试；静态沿链 | 独立 `reference_estimate` 保留原时间；正式冲突不会把参考值升格为正式净值；保留历史参考不等于重新获取 |
| 新收益读侧 | `fund_return_updates.py` 全文件、`ReturnEvidence`、货币转换、`daily_return_overview`、`portfolio.net_worth_comparison`；7 项无数据库合成检查 | 基准日期/价格严格匹配；正式替换保持 NAV 日；内部 Decimal 不再用输入金额精度规则重验；数据库回归由主代理运行 |
| 前端接入 | `fund-updates.ts`、`LatestFundUpdates.tsx`、`DailyReturnCard`、`NetWorthComparison`；7 项纯前端测试 | 缺展示汇率仍显示已知原币金额和缺汇率原因；不展示混合区间合计为今日收益；隐藏状态阻止明细渲染 |
| 生产与真实交互 | 本审查代理未部署、未写生产、未运行浏览器 | 主代理的浏览器、发布与数据库验证分别见本目录相应记录，不能视为本代理亲自执行 |

## 发现及处理

1. **RV-2142-01 / P1，旧配置省略优先级时可能重开基金来源，已修正。** 复现输入为 schema 3、关闭旧版所有基金来源、省略 `priority`，但新浪为其原有期货能力仍启用。改动前默认基金链已含新浪，造成有效基金链变成 `['sina']`；同样配置显式写旧链时却保持空链。修正后先按旧版基金默认链解释省略字段，仅在旧链至少一个来源仍启用、链非空且新浪开关启用时增加新能力。未写平台设置、未改变其它产品新浪开关。回归覆盖缺省版本及 1/2/3、显式/省略链、规范化幂等、输入不变、新版默认和拒绝版本 0：`test_sina_fund_estimate.py::test_legacy_all_disabled_fund_sources_do_not_enable_sina_capability` 及相邻用例。
2. **RV-2142-02 / P1，正式替换分支误用输入精度校验，已由收益代理修正。** 合成正式收益 `Decimal('0.4900000000000000000000000000')` 在旧实现被 `dec(..., places=12)` 拒绝，虽数值只有两位有效小数仍会抛业务异常。现在保留可信内部 Decimal 运算结果，不转换为浮点；新正式 NAV 对应的收益日期必须精确匹配，旧日期结果不可冒充新日期。本人无数据库检查已验证 10/12 正式收益 0.49、原日期以及高精度结果。数据库用例为 `test_fund_return_updates_v2142.py::test_new_formal_nav_invalidates_old_reference_without_moving_its_return_day` 和同日正式更正用例。
3. **RV-2142-03 / P2，缺展示汇率时误隐藏原币收益，已由前端代理修正。** 后端合法响应为 `status=unavailable/native_status=estimated/amount=-0.48/base_amount=null/fx_missing`。现在显示依据采用 `native_status || status`，保留原币金额，同时展示转换缺口；不把原币数直接作为展示币种总计。`fund-updates.test.mjs` 保留这一真实接口形态。
4. **RV-2142-04 / 测试隔离，新增能力触发旧单源试件失败，已修正。** 首次冻结全量日志为 1 失败、1777 通过、12 子测试，失败为 `test_estimate_refresh_cadence.py::test_fresh_fetch_does_not_relabel_old_provider_quote`。其 schema 3 会升级新浪，而受控回调明确只接受东财，导致任务失败；这不是旧报价可以续期的理由。仅将试件配置固定为 schema 4，并说明它验证单源链；未删断言、未改报价时点、未延长有效期。本人随后纯子集 32 通过，3 个数据库用例明确排除；数据库重跑由主代理完成。

## 关键边界的证据

- **不开启已关闭来源。** 策略每次刷新前重新读取；`provider_chain` 过滤 false 开关后才进入缓存/API 路由。`test_disabled_sina_does_not_fetch_or_reuse_cached_data` 先造缓存、再禁用，验证既不请求也不取回缓存。旧资料仍可能在行情详情展示原时间，读侧获取时间超过 600 秒即不再计算参考金额，不借另一来源刷新时间续期。
- **身份、基准与价格隔离。** 适配只接收 CN/CNY 的六位代码，每个返回点需匹配代码；逐点校验日期、正价格与真实时间。`worth/worth_date` 为基准，`pre_nav` 为来源直接报价；`growthrate` 只用于独立的舍入一致性检查，不乘刚更新的 NAV 造价格。`reference_estimate.economic_date=null`，且 `usable_for_accounting/usable_for_daily_return=false`。该字段不进入正式来源数量、正式冲突消解或 `Price` 写入集合。
- **已关闭海外时段也必须说明区间。** 新读侧允许本地查看日凌晨的旧时段报价作为独立参考，但要求最近 600 秒真实获取、无失败刷新、无未来时间、价格与正式基准一致；不据此推断 NAV 归属日。基准之后发生买卖、分红、拆分，或有效份额/日期/持仓核对存在缺口时不算金额。固定样本 100 份、基准 1.7251、参考 1.7203，结果为区间参考 -0.48，NAV/收益归属日仍为空。
- **正式 NAV 替换而非叠加。** 新正式 NAV 比基准新，或同基准日正式价格更正，旧参考立即失效；仅复用与最新正式 NAV 日期相同的正式收益。没有相应结果就保留缺数，不能用旧日收益贴上新日期。合成新 NAV 10/12=1.73 的正式收益为 +0.49，归属 10/12；不是把 -0.48 与 +0.49 相加，也不是迁往获取日 10/13。
- **汇率日期与原币事实。** 正式替换项先设 `date=latest.economic_date`，再调用共用转换函数；无数据库检查确认 10/13 汇率不用于 10/12 正式收益。缺展示汇率时原币金额仍保留，汇总 `known_amount` 不包含无法转换项。参考项只有查看日，转换信息不能被理解为已核实的海外收益经济日。
- **新读侧不被旧概览投影缓存冻结。** 沿实际调用链核对后确认它由 `net-worth-comparison` 接口实时计算，前端已有 60 秒重读；不是只读取 `reporting.overview` 缓存。读侧不保存 `Price`、账务事件或日收益事实。`ReturnEvidence` 的账户、持仓、行情状态与价格均按当前空间及所选账户/产品加载；没有新管理代管入口或权限捷径。
- **隐私。** 前端隐藏状态不渲染基金更新明细；来源公共缓存只用代码/币种/市场/操作等公共身份，不携带账户名、空间标识或自定义基金名。提交的来源证据仅有公共 URL、时间、摘要、哈希和有限字段，无生产私账与凭据。

## 实际运行的检查

运行目录为隔离工作区根；解释器使用 `/Volumes/mi/Wealth/.venv/bin/python`。纯后端测试明确使用无法连接的本地 1 端口地址，专用适配器使用固定 HTTP 样本，默认测试禁止新浪实时网络，不使用生产数据。

```sh
WEALTH_TESTING=1 DATABASE_URL=postgresql://unreachable:unreachable@127.0.0.1:1/wealth_pure_mock_test /Volumes/mi/Wealth/.venv/bin/python -m pytest backend/tests/test_sina_fund_estimate.py backend/tests/test_provider_policy.py backend/tests/test_market_data.py backend/tests/test_fund_sources_v2100.py backend/tests/test_akshare_integration_v211.py backend/tests/test_fund_estimate_fallback.py backend/tests/test_akshare_provider.py -o addopts='' -q
```

结果：**260 通过，0.53 秒**，见 [review-pure.log](review-pure.log)。其中新浪适配器文件 44 例。没有运行数据库用例。

```sh
WEALTH_TESTING=1 DATABASE_URL=postgresql://unreachable:unreachable@127.0.0.1:1/wealth_pure_mock_test /Volumes/mi/Wealth/.venv/bin/python -m pytest backend/tests/test_estimate_refresh_cadence.py -m 'not django_db' -o addopts='' -q
```

最后一次结果：**32 通过、3 个数据库用例未选择，0.17 秒**，见 [review-cadence.log](review-cadence.log)。这 3 项不是跳过失败断言，而是为避免与主代理共用测试数据库；完整测试必须由主代理单独运行。

```sh
cd frontend
node --experimental-strip-types --test tests/fund-updates.test.mjs tests/reference-estimate.test.mjs
```

结果：**7 通过、0 失败、0 跳过**，见 [review-frontend.log](review-frontend.log)。此外执行 7 项无数据库临时合成读侧检查（固定时钟、替身证据），覆盖区间金额、旧获取时间、非法日期、错产品、正式替换/精度、正式汇率日期、旧正式收益不改日期；输出见 [review-readside.log](review-readside.log)。这些临时检查不是默认测试套件，长期回归入口仍是 `test_fund_return_updates_v2142.py`。

`ruff check` 对 `provider_policy.py`、`sina_fund_estimate.py`、`fund_return_updates.py`、`test_sina_fund_estimate.py`、`test_estimate_refresh_cadence.py` 通过；`git diff --check` 通过。未在本复查中重跑完整前端构建或数据库全量，不把其它代理运行计入以上数字。

## 开源项目实际日期调用核查

源码研究固定为 [hzm0321/real-time-fund@85e1237](https://github.com/hzm0321/real-time-fund/tree/85e1237f0f3dc266d4d021b67612654c15f84e80)，许可证 AGPL-3.0；未复制其实现代码。其实际刷新路径在 `app/hooks/useRefreshManager.js`：本地 `localRecordToChanges` 在 176 行定义；382 行取 `latestNavDate=data.jzrq`；422/438/487 行按该 NAV 日写收益；475 行按历史 NAV 游标日期回填；536 行写入 `fundDailyEarnings`。当前刷新路径不是通过导出的 `recordDailyEarnings` 来一律记到 `todayStr`。因此页面“今天看到更新”不等于该项目历史正式收益归属今天。文件 SHA 和公开响应摘要见 [sina-reference-source-probe.json](sina-reference-source-probe.json)。

未迁移其使用申购确认天数推测 NAV 发布日、社区涨幅乘最新 NAV、或仅凭北京时间日期判断海外收益所属日的做法。也未接入社区 Supabase、付费源、用户未启用来源；未重算或改写历史账务。

## 仍需持续验证

公开源的时效和覆盖可能变化，当前响应不能保证未来每只基金都有可算值；源披露的重仓参考也不代表完整投资组合。来源元数据不足、正式基准不一致、区间有份额变化时保持缺数是预期行为。最终发布验收仍需主代理记录冻结后的全量结果、运行中的任务健康与真实读取结果，不能用本纯测试报告替代。

### 文件指纹

以下仅固定本次审查快照；后续改动应更新审查或重新复核。

| 文件 | SHA-256 |
| --- | --- |
| `backend/wealth/provider_policy.py` | `eb103f6b38f58083b311c05958d421019342b87dd01040a5d717b0a94cf90419` |
| `backend/wealth/sina_fund_estimate.py` | `4622b8afce51086e2f20e8177b850eb49515bca5ccb6fb90de6a54345e538284` |
| `backend/wealth/fund_sources.py` | `360a84dff5dfa3bf88024b3703c57fa34da10a2c3c1e4bdb30f934497a7e4f02` |
| `backend/wealth/market_data.py` | `93e6c4d73824890403e2bc29cdba8926b3bf0b241dd5532dcf0fa747c9c5c64c` |
| `backend/wealth/market_sync.py` | `ab97a5f0dc354f4e30d3541f22b25e20a776ea88e1a143c355009fc1b59b7fb9` |
| `backend/wealth/fund_return_updates.py` | `e05f7e7378c6a92c076aac3e9ffca1600ad945346b58509e4b66a6c7a08d67a0` |
| `backend/wealth/daily_returns.py` | `74171b366c27f2db3dd8a07a37572433b1288fbe499adaaa86f26902ac648711` |
| `backend/tests/test_sina_fund_estimate.py` | `95f86eb8db33db9c23fb178dc8ef953c618034242914c826220dc59b3bd764ae` |
| `backend/tests/test_estimate_refresh_cadence.py` | `b4c7a61965ecd1083191a75098ee9473d05059cf36d79f4cd3117bf195796db1` |
| `frontend/src/fund-updates.ts` | `03626f622ce713f19ca369f293eea04d8b1f60de07968a672526f300e389af1a` |
| `frontend/src/pages/LatestFundUpdates.tsx` | `937e5756f7fa3608bcaad62d6590fc904e74e3321b354e80ac90d2ff13a000f5` |
