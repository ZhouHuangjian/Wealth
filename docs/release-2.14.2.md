# 2.14.2 指定定投补足来源与备用估值核查

状态：本地实现和验收完成，冻结候选准备服务器隔离验收，尚未部署。审查日期2026-10-13；分支`codex/estimate-return-diagnosis-20261012`，起点`952af3f618520559e64892d2d78464bd3258993d`。生产只读基线18:24北京时间仍为2.14.1、镜像`sha256:c2fcb778b51ed59c19f33b9e005c41080ea212ca7f21364bee4e39e387d0f9a5`、schema`0015_chat_remote_controls`。原工作区与既有未提交资料不覆盖。

## 范围与事实

- FUND-001/P1：截图4期（10/08、09、12、13）确实都未扣款，主账户可用现金不足且没有补足来源设置。新增可选`top_up_account_id`、明确`top_up_start_date`，一次设置后按期自动只补差额，再扣本期款；保留来源与推算标记。不产生外部银行转账或基金申购。用户未选择实际银行，本轮不会代填生产计划。
- FUND-002/P2：待处理点击直达对应计划的资金字段；核对账户为保留的次入口。等待现金的具体原因不能被通用状态文案覆盖。生效日前、备用账户不足与未选择来源分别说明。
- EST-010/P1：有有效GSZ但NAV/PDATE缺失时，原`market_data._fund_quote`转历史后丢掉有效估值。现先独立保留估值与真实报价/获取时刻，再取正式历史；历史失联也不把估值升级为正式价格。缺估值不会由NAV伪造。10个固定样本回归覆盖缺价格/日期、历史异常、身份错误、货币基金、其它启用官方源提供正式NAV。
- EST-011：五只QDII的主源GSZ/GZTIME/GSZZL为空，正式NAV仍正常。当前已核查的官方基金公司来源提供正式NAV，AKShare与天天基金同上游，不能算独立估值来源。旧fundgz五只返回HTML错误页；估值列表暂无数据。公共证据见[source probe](audits/evidence/2026-10-13/estimate-funding-2142/public-estimate-source-probe.json)。用户随后提供基估宝开源线索，已进一步直连新浪取到全部五只的参考估值，017641/270042的涨幅与05:04时间吻合截图。已实现独立来源参考和首页最近收益更新视图，不能把参考值存在写成可靠今日收益已全部补齐。

## 验收与维护

规则唯一维护于[领域模型](domain-model.md)、[接口](api-contract.md)、[RUNBOOK](RUNBOOK.md)，任务见[开发状态](development-status.md)，待决策见[决策登记](open-decisions.md)。普通合成用户路径见[浏览器验收](audits/evidence/2026-10-13/estimate-funding-2142/browser-verification.md)。应用冻结、最终Linux全量、备份与部署仍待完成，结果另记，不能用实现或本地测试代替生产上线。

无数据库迁移。保留Decimal、同空间/同币种、真实现金/冻结/历史余额约束和稳定期次阶段键。补足转账+扣款使用同一事务/空间锁，失败不留半笔；反转需先解除后续使用/冻结与依赖。正式NAV到齐后推进份额，不依赖备用估值。v27只读绕过旧首页缓存，不删原始流水或旧Projection。

回退必须先核查新补足事件及配置兼容性：2.14.1不识别补足配置且缺少对应冲正现金保护，不能简单退镜像后继续相关编辑/冲正。停止相关处理、保留新账务事实，必要时制作含兼容保护的回退应用；不得恢复旧库覆盖新账、抹除元数据或静默重算历史。

## 基估宝日期与收益迁移边界

只读研究[开源项目](https://github.com/hzm0321/real-time-fund)，精确提交与公共样本摘要随最终证据保存；未复制其AGPL源代码。公开源码区分当日涨跌收益与持有/累计收益，截图两栏数字不能当成同一指标。其新浪来源2/3可返回夜间到清晨的估算点；source4远端社区表仅有涨幅，客户端再乘最新净值，缺少可绑定的基准，未接入后者。

用户要求的“海外上一交易时段→今晚公布前看估算→官方到齐改正式”迁移为独立的**最近基金收益更新**。保留来源报价的实际时刻与基准NAV日，允许当日清晨的上时段参考在此处显示；不是把过期报价重标为当前盘中。可计算区间需基准与最新正式NAV精确一致、适用份额可核实、期间无未处理交易/分红/拆分；不足留具体原因。新正式NAV到齐后使旧基准窗口失效，同栏显示新正式结果/所属日期，不相加。今日归属汇总、收益日历、净资产及不可变流水不因公布日变化而搬动。

没有照搬`SSBCFMDATA`确认天数判断净值是否已公布，也不以北京时间跨日推断海外净值归属日；未知经济日期如实待核实。源返回的涨幅保留原口径；区间金额用Decimal的直接参考价与匹配基准价差，不用新净值乘旧涨幅。此新视图不能冒充机构成交确认或实时行情。

实际源码核实：`useRefreshManager.js`以`data.jzrq`或历史NAV行日期写入`fundDailyEarnings`，今日只作展示/更新上下文；因此没有把“今晚获知”当作“收益归属今天”。精确提交85e1237f0f3dc266d4d021b67612654c15f84e80，定位与公开响应摘要见[sina source probe](audits/evidence/2026-10-13/estimate-funding-2142/sina-reference-source-probe.json)。

## 本地验证记录（部署前）

- 定向后端：`python scripts/audit_local.py --pg-port 55443 --web-port 18093 test tests/test_fund_return_updates_v2142.py tests/test_dca_top_up_v2142.py tests/test_daily_returns_v263.py tests/test_overview_projection_version.py`，75通过。包含 viewer 首页 GET 强制只读门禁，计算不写事实。
- 前端：Node22，`npm test`（`node --experimental-strip-types --test tests/*.test.mjs`） 214通过、0跳过；`tsc -b`、`prettier --check src tests vite.config.ts`、`vite build`通过。
- 独立双连接并发：`python scripts/audit_local.py --pg-port 55443 --web-port 18093 probe dca-top-up-concurrency`，两个worker均完成，最终仅1补足、1扣款、1确认；102元成交100份，银行898、基金现金0。固定时钟及无网络样本。
- 发布保护8项通过：缺备份、镜像/源码不符、数据指纹变化均阻止切换，无生产重置路径。
- 曾执行全量1721通过/12子测试，后续新模块后的全量为1失败/1777通过/12子测试。唯一失败来自旧schema3的受控单来源试件升级出新Sina调用；现将该试件明确为schema4固定单来源，旧报价不得续期的全部业务断言保留。最终完整复跑单列；原失败日志保留。
- 独立审查发现并修复：内部合法36位Decimal计算被当12位外部输入拒绝；缺汇率时保留的原币收益未显示；旧schema省略priority且已关闭全部基金来源时升级不得开启Sina。均有定向回归。

日志与公共源证据集中于[evidence](audits/evidence/2026-10-13/estimate-funding-2142/README.md)。不是生产恢复演练、全市场可用性保证或真实机构账单兼容声明。

本地最终完整回归：全新隔离库`wealth_funding_2142_verified_test`，Python3.12、PostgreSQL18，**1791项及12子测试通过，0跳过，226.93秒**。重跑前新建专用合成库，不重置既有库。373条warning为隔离静态目录缺失；原始结果见[本地全量](audits/evidence/2026-10-13/estimate-funding-2142/backend-local-final.log)。随后仅格式化投影测试的一行长参数列表，实际候选还将完整跑Linux回归。

Python CI规定的`ruff format --check backend scripts`与`ruff check --select E9,F63,F7,F82 backend scripts`通过。额外无选择的`ruff check backend scripts/audit_local.py`报告348项（含既有审查脚本导入/风格等，超出CI限定规则）；没有借本轮修复重排全项目。新功能模块的定向全部规则检查通过，不宣称全项目所有Ruff规则无告警。
