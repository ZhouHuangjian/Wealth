# 19:40 公开新浪基准变化复核

时间：2026-10-13 19:40:24（Asia/Shanghai）。只读公共请求，未连接生产、未修改业务代码。原始响应保存在 ignored `.runtime/fund-cc-research/sina-recheck-20261013T114024Z/`；可提交摘要见 [sina-reference-recheck-20261013T114024Z.json](sina-reference-recheck-20261013T114024Z.json)。对照为 [18:41 公开源证据](sina-reference-source-probe.json)，并读取当时保留的原始 JSON 做逐字段比较。

## 观察到的事实

五只基金均 HTTP 200。仅顶层 `worth`、`worth_date`、`worth_rate` 发生变化；每只基金的 **455 个 `networth` 点完整相同**，首尾时间、`pre_nav`、`growthrate`、`pre_nav2`、`growthrate2` 均未更新。最后报价仍为北京时间 2026-10-13 05:04:00。摘要同时保存旧/新完整响应 SHA-256 和按固定排序序列化的 `networth` SHA-256。

| 基金代码 | 18:41 基准：10/09 | 19:40 基准：10/12 | 未变的 05:04 报价 | 未变的来源涨幅 | 对新基准一致？ |
| --- | ---: | ---: | ---: | ---: | --- |
| [017641](https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=017641) | 1.7251 | 1.7237 | 1.7203 | -0.2788% | 否 |
| [019305](https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=019305) | 1.7083 | 1.7068 | 1.7035 | -0.2797% | 否 |
| [019172](https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=019172) | 1.8179 | 1.8053 | 1.8066 | -0.6202% | 否 |
| [021778](https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=021778) | 8.4426 | 8.3802 | 8.4560 | +0.1586% | 否 |
| [270042](https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=270042) | 8.4745 | 8.4119 | 8.4880 | +0.1589% | 否 |

“一致”使用适配器同一思路，比较 `pre_nav` 与 `worth × (1 + growthrate)`，容许三个已发布小数各自的舍入误差；这只是检查，不用于创造价格。五只对旧 10/09 基准均一致，对新 10/12 基准均不一致。

例如 270042：原基准 `8.4745 × (1 + 0.001589) = 8.4879659805`，与报价 8.4880 的差额为 0.0000340195，在容差 0.00010431670 内。新基准 `8.4119 × (1 + 0.001589) = 8.4252665091`，与未变报价差 0.0627334909，远大于容差 0.00010428540。这不是提高舍入容差可以解决的问题。

## 安全使用结论

1. 当前响应混合了新的正式 NAV 基准和旧估值序列。不能将旧率乘新的 NAV，也不能把 `pre_nav - 新 worth` 解释为一个新待公布区间的收益。现行 `reference_baseline` 拦截有真实依据，应保留。
2. 本次基准值来源仍是新浪响应自身；它不是第二个独立正式净值来源，不得凭该字段插入正式 `Price` 或解除已知净值冲突。
3. 本地/生产若已从既有正式链获得同产品、同币种的可用 10/12 NAV，可独立展示它已计算的最近正式收益，注明归属 10/12；无需等待这组不一致参考序列修复，也不得将它与旧参考相加。是否已经取得正式数据由主代理另行检查，不由本公共请求推断。
4. 若添加读侧回退，保持正式 NAV 日期与 `latest_confirmed_return.nav_date` 精确一致、有效份额及核对规则不变、沿用 Decimal 和原收益日汇率；无对应结果就明确缺数。参考失效原因独立保留。不能笼统宣称“该正式值替代了同一待公布区间”，因为响应没有提供足以证明该估值所属经济日的字段。
5. 下一时段如正式基准不再变而估值序列真的更新，并恢复比例一致性，仍需原有身份、时间、基准日有效份额及区间无变动检查后才能计算独立参考金额。关闭的来源、付费源和社区源保持当前设置。

## 执行方法和边界

五个固定 HTTPS URL 使用本机 `curl` 并发直接读取，启用默认 TLS 验证，20 秒超时、2 MB 响应上限，无凭据和自定义代理目标。网页提取工具无法读取该 API，本机 Python 缺少 requests 且 urllib 默认 CA 校验失败，因此最终成功读取使用系统 curl；没有关闭证书验证。当前接口会继续变化，复跑不能期待返回本记录同样的数值，应对照保留响应哈希和时间。

只有公共证据文件新增，未修改适配器、读侧或生产状态；读侧回退为建议，尚未在本复核中实现。
