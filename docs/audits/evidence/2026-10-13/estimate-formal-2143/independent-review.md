# 2.14.3 正式收益回退独立复查

日期：2026-10-13（Asia/Shanghai）。基线 HEAD：`71f322456e8f64651bfc6b8d1da6e3599eece586`；对象为此基线后的未提交差异，文件指纹见文末。审查者未实现本次读侧回退，也未修改本次业务代码。

## 结论与范围

**本次差异未发现发布阻塞。** 参考数据失效时，系统可以展示独立计算且日期匹配的最近正式收益；它没有恢复不一致的旧估算，也没有把历史正式收益加入今日总额。正式收益自身的已知冲突和账务缺口仍可阻止回退。最终数据库全量、页面交互与部署由主代理另行验收，本记录不表示已经完成这些步骤。

完整审阅：`backend/wealth/fund_return_updates.py` 与 `backend/tests/test_fund_return_updates_v2142.py` 的 git diff。补读调用方 `daily_returns.daily_return_overview/ReturnEvidence.spot/read_check/convert_return_currency`、现有前端 `fund-updates.ts` 的原币状态显示规则，确认输入来源和日期含义。未重新审计其它模块、权限框架、行情适配器或部署脚本。

## 真实触发条件

此前公共只读复核已证实：新浪五只 QDII 的 `worth/worth_date` 更新为 10/12，但 455 点估值序列仍与旧 10/09 基准配套；因此 `reference_baseline` 阻断参考金额有依据，不能放宽比例校验。证据见 [19:40 基准变化复核](../estimate-funding-2142/sina-baseline-change-1940.md)。

本次仅读取主代理已保存的 `.runtime/estimate-funding-2142/release/live-transition-corrected.json`，没有登录或请求生产：五个代码 017641、019305、019172、021778、270042 的正式报价日均为 2026-10-12，`recent_returns` 均记录该日 `amount_available=true`，参考比率均为 false。这里保留公共代码和布尔可用性，不复制私人账户、份额或收益值。首次诊断使用错误字段得到的 null 不能再作为正式收益缺失的证据。

## 逐项审查

| 要点 | 实际实现与审查结论 |
| --- | --- |
| 只回退来源缺口 | `unavailable()` 仅允许 `reference_baseline/reference_time/reference_date/reference_refresh` 尝试正式回退。身份不匹配、份额缺口、区间变动、核对差异与净值冲突不在可回退原因中。原参考校验继续执行，没有把坏参考改成可用估算。 |
| 正式输入独立 | 复用同一 `(account_id, instrument_id)` 的 `latest_confirmed_return`；它来自现有 `ReturnEvidence.spot()` 正式计算。要求 `amount is not None` 且 `nav_date` 精确等于最新正式 Price 的经济日期。不借另一账户/产品、旧日或金额缺失结果。当前映射由已按空间过滤的内部调用方构造，不接受外部提交的收益字典。 |
| 已知冲突不绕过 | 新回退额外检查正式收益 `interval_start` 到查看日的 `nav_quarantines`，因此早于参考基准但仍位于正式计算区间的冲突也不能被忽略；未核实持仓交易日期和当前原持仓核对差异同样阻止。纯诊断包含 10/10 冲突、10/12 参考基准和正式 10/09→10/12 区间这一边界。 |
| 正常估算优先 | 仅在参考校验失败的分支调用回退；参考基准、时间、比率和份额依据均有效时，仍计算独立参考区间。没有优先取一个旧正式金额覆盖新有效估算。 |
| 零值和精度 | 使用 `is not None`，不把 0 当作缺失；直接保留内部 Decimal（包括 36 位小数表达），不转 float 或重新套输入金额位数上限。推算份额标识继续传递。 |
| 日期和汇率 | 正式项 `date/nav_date/return_date` 均采用最新正式 NAV 日；随后共用货币转换函数仍按该日选汇率。来源报价时间、正式记录时间不充当收益日。缺展示汇率保留原币金额与 `native_status=formal`，展示币种合计留空。 |
| 解释与原始事实 | 独立保留 `reference_unavailable_reason_code/message`；文案明确“最近正式收益”和“覆盖区间不一定相同”。不承诺两者属于同一海外收益经济日，不将旧率乘新 NAV。该模块继续只读，不创建 Price、交易、日收益事实或缓存。 |
| 测试预期变化 | 原“刷新失败没有金额”用例改为“刷新失败仍保留独立正式收益”，属于本次明确产品行为变化；它仍要求正式收益归原 NAV 日、保留刷新失败原因，而非删除旧估算失效断言。新增回归覆盖真实基准变化、坏参考元数据、无写入、正确优先级、缺 FX、scope/日期/冲突阻断和零值来源。 |

## 本审查实际运行

没有运行数据库测试，与实现代理的定向数据库测试分开。执行了附带的 [independent-readside-probe.py](independent-readside-probe.py)：固定时钟、合成账户/产品、内存证据替身、无法连接的数据库地址，无真实网络，直接调用当前只读实现并断言输入不被改写。

```sh
WEALTH_TESTING=1 PYTHONPATH=backend DJANGO_SETTINGS_MODULE=config.settings DATABASE_URL=postgresql://unreachable:unreachable@127.0.0.1:1/wealth_pure_mock_test /Volumes/mi/Wealth/.venv/bin/python docs/audits/evidence/2026-10-13/estimate-formal-2143/independent-readside-probe.py
```

结果：**15 项通过**，详见 [independent-readside.log](independent-readside.log)。包含：基准前进后按原 NAV 日回退、非法日期不抛 500、错产品、错账户、错映射产品、旧 NAV 日、未知正式金额、零与 36 位 Decimal、有效估算优先、区间内较早冲突、同日冲突、未核实日期、未解决持仓核对、缺 FX 保留原币、NAV 日 FX。其中缺 FX 与 FX 日期分开执行，报告总计 15 项以脚本输出为准。

```sh
/Volumes/mi/Wealth/.venv/bin/ruff check backend/wealth/fund_return_updates.py backend/tests/test_fund_return_updates_v2142.py
git diff --check
```

均通过。审查脚本是独立诊断，不自动纳入默认数据库测试；默认回归维护在 `backend/tests/test_fund_return_updates_v2142.py`。本审查没有声称运行完整后端套件、浏览器、发布或恢复演练。

## 剩余限制

回退只解决“已可计算的最近正式收益被失效参考遮住”。没有可用正式收益、原始账务未核对或净值冲突时继续缺数；有正式结果也不表示当日估算已恢复。原先就存在的正式分支只做等价提取，不借此扩大为重算历史账务。发布时间与海外经济日没有可靠映射时仍不推断，未来来源变化需要新的受控样本。

### 文件指纹

| 文件 | SHA-256 |
| --- | --- |
| `backend/wealth/fund_return_updates.py` | `055cca4a9ea38b82aa2bd8232b4d1d4b234ec3e37627e3ea834fbbc1ab6812f6` |
| `backend/tests/test_fund_return_updates_v2142.py` | `958ef0c0730b364591950ae64a431f376ed96b63cf181148ae3ed09dc172ad26` |
| `backend/wealth/daily_returns.py` | `74171b366c27f2db3dd8a07a37572433b1288fbe499adaaa86f26902ac648711` |
| `frontend/src/fund-updates.ts` | `03626f622ce713f19ca369f293eea04d8b1f60de07968a672526f300e389af1a` |
