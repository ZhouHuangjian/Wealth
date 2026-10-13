# 开发与验收状态

## 2026-10-13 估值与收益一致性修复（2.14.1候选）

在`codex/estimate-return-diagnosis-20261012`、诊断提交`1459c78`基础上实施。**目前为候选实现，待最终验收和部署；没有生产历史数据修复或迁移。** 生产最后只读核实为2026-10-13 12:45:55（北京时间）的2.14.0（`5e769074…`），schema0015，不能把候选版本写成实际运行版本。问题证据和复现入口集中在[审查§12](audits/system-audit-2026-10-09.md#12-2026-10-13-估值与收益一致性修复候选)，规则维护在[领域模型§14](domain-model.md#14-指标字典估算与缺失)，发布冻结与最终结果补入[2.14.1发布记录](release-2.14.1.md)。负责人待指定。

| 编号 / 优先级 | 本批实现与依赖 | 状态与放行要求 |
| --- | --- | --- |
| EST-001 / P1 | 盘中缓存60秒、正式/历史600秒；每60秒扫描，单产品300秒目标周期，请求锚点与锁内到期复查，保留真实时间 | 已实现、阶段回归；最终验收微小worker偏差、队列/并发/重试、禁用和原600/1200秒保护 |
| EST-002 / P2 | 明确缺估值/过期/基准/核对原因，partial标已计算部分和条目覆盖，真实行情/规则/流水/汇率入口；正式价格与推算份额分别显示 | 已实现；阶段前端196项、类型/格式/构建通过；合成owner已验证核心缺数/FX/行情导航及隐藏，最终核对导航待补 |
| EST-004 / P1 | 持仓与净资产同日正式NAV替换旧估值，前日NAV不能覆盖次日参考报价 | 已实现、阶段回归；检查首页、持仓、日收益交叉结果，不重算原账务 |
| EST-005 / P1 | 原币`native_status/native_message`与显示币种折算分开；缺FX保留原币收益、汇总留缺口 | 已实现、阶段回归；与EST-008统一FX边界，实际原币/折算页面待验 |
| EST-006 / P1 | 日历机构权益与首页复用现金流/交易日资格；外部收入、支出、退款、转账、换汇剔除，缺中间开放日留空 | 已实现、阶段回归；日历只采正式观察，盘中权益不冒充正式 |
| EST-007 / P1 | 股息循环局部身份不再覆盖请求的账户/产品筛选参数 | 已实现、阶段回归；无关股息不得改变机构权益范围 |
| EST-008 / P1 | 日历与首页统一收益日以前、最多7个自然日的FX资格 | 已实现；最终完整回归待补，不能以计划记为已验证 |
| EST-009 / P1 | 复合来源严格绑定类型/产品/币种/来源/日期/绝对值/公布时刻后使用子估值独立fetch，旧Price不借新tick续期 | 已实现、阶段回归；新子估值+旧正式源可算；已有quote但不匹配时等待更新，旧无quote读取兼容，最终回归待补 |

阶段结果：前端196项通过；本地完整后端1676项及12项子测试通过、0跳过、224.05秒，随后又补严格估值元数据匹配和核对导航，最终Linux候选完整回归尚待执行。此前106项、93项为定向组合，不能相加充当最终全量；原2026-10-12红结果保留。合成owner浏览器已验证首页部分收益、缺数原因、有效USD原币不填CNY总额、明细→汇率、首页/持仓→指定基金行情、隐藏明细无金融内容；不是生产浏览器验收。最终冻结SHA、候选结果、备份、运行镜像和部署时间尚待统一记录。首页投影版本候选为`account-equity-v26`，只读绕过旧缓存，不删Projection、不改空间修订或原始流水。

EST-003/OD-05仍待决：午休/收盘旧估值的带时间展示须有产品/来源依据，本批不放宽报价时效。5只基金在诊断时来源没有盘中估值，仍是数据缺口，不以计算或切换正式NAV来源补造数值。回滚仅退兼容应用/读算法，保留所有正确的新行情与账务；历史收益修复仍需差异预览和单独执行范围。

## 2026-10-12 首页估算收益排查（有诊断，未修复）

以下为当日诊断阶段原记录；后续状态以上方2026-10-13小节为准，原失败证据不改写。

当前main `f2b0b87`，线上实际2.14.0/镜像`5e769074…`；6个财务核心文件与运行镜像一致。强制只读核对、自然更新观察及固定时钟诊断见[审查§11](audits/system-audit-2026-10-09.md#11-2026-10-12-首页今日估算收益专项排查)。没有业务代码修复、生产手工刷新/配置修改/账务写入或新部署。

| 编号/状态 | 证据与后续任务 | 验收/影响与回滚 |
| --- | --- | --- |
| EST-001 / P1 已复现，待修复 | 5分钟beat与worker开始时间的300秒门槛在微小偏差下跳过；10分钟报价缓存与10分钟获取有效期叠加，ready仍带旧fetched_at。协调盘中TTL、扫描粒度及到期锚点，保留真实fetch/pub时刻 | 诊断6项中2业务断言失败/4控制通过，账务事实不变；修复后6项全通过并纳入默认回归。必测299.8/300/599.8/600秒、恒价新tick、重复/并发、源失联恢复、旧/未知/未来报价、禁用源及同日正式替代；无迁移/历史账务修复。回退只退行情代码，不删观察或重开禁用源 |
| EST-002 / P2 提示不足已确认，待修复 | 无当日estimate而有较早NAV时泛称“缺少正式价格”；首页原因藏在明细。明确暂无估值/过期/缺基准和行情详情入口，partial标已知部分及覆盖 | 前端5项现有回归、5个合成场景通过，真实用户浏览器未核验。页面显示known_amount，缺数保持空，不将累计收益/过去NAV收益/本金填今日；需实际交互验收。仅读侧兼容，回退不改金融记录 |
| EST-003 / 与OD-05相关待决 | 统一20分钟时效在午间/收盘停更后会撤下估算；讨论按依据展示“最新带时间估算”与“当前有效今日收益” | 真实旧报价被拒、35分钟旧报价控制通过。须有产品/来源/交易时段依据后更新领域模型§14；不能把抓取时间当报价时间、假称实时或简单扩大所有产品阈值 |

5只基金的本次来源未返回盘中估值，属于数据覆盖缺口，不算5项已证实代码缺陷；开启只提供正式NAV的来源不会补出估值。来源扩展仍须产品/份额/币种、绝对估值或匹配基准、时间及覆盖区间证据。负责人待指定。

## 2026-10-10 审查修复与部署基线（历史阶段）

维护日期：2026-10-10；初始审查SHA `e379dfe67a715d9913af246eba021c7b26ce45d1`。修复在 `codex/system-audit-2026-10-09` 隔离工作区；用户追加授权展示优化与保数据部署，2.12.0已于08:13:25（北京时间）完成最终验收。应用冻结 `c99d3b35bc82e38cb52559333a30e7f86e527605`，实际镜像及运行证据见[发布说明](release-2.12.0.md)。未执行历史账务修订、重算或生产ACL修改；恢复正常任务后的合法更新不等于部署数据修复。规则入口为[项目地图](project-map.md)、[领域模型](domain-model.md)和[接口契约](api-contract.md)。下方旧发布记录保留历史证据。

## 2.12.0 已部署：展示与操作闭环

| 编号 | 实现和验证范围 | 当前状态 |
| --- | --- | --- |
| UX-001（P2） | 待核对/异常给出具体步骤，按原期次事实导航；普通用户已验证持仓核对与扣款账户定位，权限/对象不存在/只读投影测试通过 | 已实现、隔离验证、已部署 |
| UX-002（P2） | 最近业务日历、业务日期分页前倒序、跨年及源行号保持；固定样本回归和最近/未来页面切换通过 | 已实现、隔离验证、已部署 |
| UX-003（P2） | 实际点击发现StrictMode清理导致新增默认值全空；恢复挂载初始值并保持关闭清理/草稿保护，真实页面及3项生命周期回归通过 | 已修复、隔离验证、已部署 |
| UX-004（用户指定功能） | 独立娱乐角、三枚铜钱六爻与卦象；7项规则测试、桌面/390px窄屏、键盘/重置交互通过 | 已实现、隔离验证、已部署 |
| UX-005（P2） | 旧首页缓存缺少准确处理对象；真实旧payload回归修复前3失败，v25拒绝旧v24缓存后20项通过，旧投影保留、Viewer GET不写账 | 已修复、最终镜像全量验证、已部署 |

最终Linux镜像后端1498及12项子测试、关键459、前端178、备份脚本5、发布安全51通过；没有跳过关键用例。服务器与本地认证备份、40张表/4个会话/11个序列及文件启动前一致，五服务/任务/计时器健康，14次只读空间GET（含4个定投状态）与21公网文件通过。证据见[2.12发布说明](release-2.12.0.md)及[2026-10-10结果](audits/evidence/2026-10-10/ux-deployment-results.json)。10月9日[候选结果](audits/evidence/2026-10-09/ux-release-results.json)和被替代的d959844测试仍保留，不作为最终镜像证据；SSH访问缺口已解决。真实机构、规模、故障恢复和系统减少动画偏好仍未验。

## 2026-10-09 系统审查与修复队列

初始审查：后端1447 passed/12 subtests、前端152 passed、脚本5 passed；新增不变量14 passed、缺陷断言6 failed。这些历史结果保留，不能用修复后的绿色结果改写。[审查报告§8](audits/system-audit-2026-10-09.md#8-授权修复与验收记录)追加本次实现、失败与验收；[修复结果](audits/evidence/2026-10-09/repair-results.json)与[初始结果](audits/evidence/2026-10-09/results.json)分开保存。

10月9日修复后历史结果：**后端1476 passed、12 subtests、253 warnings；前端153 passed；原6项断言均通过，29项修复回归进入默认tests。** 原生PostgreSQL当前0001–0012恢复、两连接并发和新进程completed补扫通过；普通用户合成页面完成保存→等待→推算→CSV核对→来源升级。10月10日补充实际生产运行/任务/备份/隔离保护只读核验；真实worker/broker故障恢复、产品渠道、跨时区和规模仍未验。历史“31项脚本检查”未在审计中重现，备份脚本用例5项；本版独立发布安全工具51项不与之混算。

状态必须分开：有设计／有实现／已验证（限定环境）／已部署（对应SHA/镜像/时间）。以下7项均为**修复实现、隔离验证通过、随2.12.0已部署**，负责人待指定。AUD-007只安装配套运维脚本并验证现有生产保护，没有执行恢复/权限修订；历史收益重算没有执行。

| 编号 | 优先级与修复结果 | 验收证据/剩余边界 | 批次 |
| --- | --- | --- | --- |
| AUD-007 | P0：重复初始化/恢复不再向runtime授予私有清理表；恢复受保护函数ACL | 全量曾失败，修复后安全断言通过；0012原生恢复通过。生产runtime非owner/非superuser/无bypass、强制RLS/不可变及私有清理表拒绝已只读核实；未执行生产恢复/ACL修改，未全面枚举函数ACL | B0 |
| AUD-003 | P1：标准核对保留有据成交净值日，日期差异独立复核 | paid-only晚确认D1/D2=2/2，日期更正保留替代链；未知不猜。旧已处理批次未重解析 | B1 |
| AUD-001 | P1：completed只结清已扣期次，不生成新期次/扣款 | 多期、未扣、off、取消/冲正、两次扫描和新进程通过；前台仅active/paused，completed由受控夹具设定 | B2 |
| AUD-002 | P2：完整有效机构证据使日收益/日历份额来源升级 | 完整/部分/撤销、批量查询、金额及事件数不变；普通页面CSV绑定后显示正式收益 | B3 |
| AUD-004 | P2：旧/未知/未来时点参考价不因刚获取而算今日 | 5分钟有效、21分钟/null/future无今日值，正式覆盖同日估算；所有产品基准/区间仍待核实 | B4 |
| AUD-006 | P1：正式Price可用性统一，未来公布不提前采用 | 正式读侧/持仓/收益/DCA等待同一条件，到时自动可读；原Price不删除 | B4 |
| AUD-005 | P2：同条件waiting_cash扫描不制造修订，展示真实检查时间 | 空轮次revision/Occurrence版本稳定；真实现金/金额配置变化仍生效；API和页面last_checked_at已验证。任务健康/超期提醒仍待办 | B5 |

未复现风险R-001–007只在[审查报告§4及§8](audits/system-audit-2026-10-09.md)维护；R-005最近检查出口、R-007当前原生小样本恢复已部分补验，不能整体关闭。V2完整P0仍未通过。

### 可独立审查的批次与回滚

B0–B5有实现与本次证据，可按以下范围分开审查；B6/B7仍有设计或未完成验证。回归入口为 `backend/tests/test_audit_repairs_20261009.py`，原6项断言未弱化、未skip/xfail。各批次按[修改影响表](project-map.md#修改影响表)核验接口、投影及历史影响。

| 批次/状态 | 实际影响文件或剩余范围 | 必测/验收 | 回滚及历史数据 |
| --- | --- | --- | --- |
| B0：AUD-007已实现 | scripts/database_privileges.py、local_dev.py、backup.py、test_restore_local.py | 重复init后私有表拒绝、不可变与跨空间；0012恢复后受保护非trigger函数非PUBLIC、runtime非owner及文件权限 | 保留最小授权策略，不能回退为ALL TABLES授权。生产先只读权限清单、备份及维护窗后另授权修订；无业务事实迁移 |
| B1：AUD-003已实现 | fund_reconciliation ALIASES/_normalise/_difference/_source_compatibility/_correct；FundReconciliation日期预览 | paid-only与已有确认NAV日更正；未来/逆序/未知/旧映射；原扣款/确认日及现金不变，D1/D2=2/2 | 解析版本保持fund-confirmation-1兼容；旧raw逐空间差异预览，原事实更正走替代链。回退代码不撤销正确新事实；历史修复另授权 |
| B2：AUD-001已实现；OD-02其余范围仍待决 | dca_automation run_plan/occurrence_processing、状态摘要与进度页；scan_all原已选所有启用计划，无需改tasks | completed无新期、已付结清；disabled/取消/冲正保持；新进程和并发幂等 | 不批量改active或重新开off。生产补扫前先列有据已付未结范围；回退后既有正确Event保留，不反向清理 |
| B3：AUD-002已实现 | fund_reconciliation.actual_confirmation_ids、return_dates、daily_returns、investments.profit_calendar | 实际完整补证、撤销、部分、批量查询、来源一致，无新增Event或金额变化 | 只重建来源投影/缓存，不改原automatic_estimate；兼容回退读算法，后续收益重算须预览 |
| B4：AUD-004/006已实现有限资格；OD-05/R-004未完成 | market_quality.available_prices/approved_prices、DCA/fund_orders/holdings选择器、daily_returns.spot | 过去/null/未来pub、旧报价新fetch、正式替换与DCA分阶段；未知正式时间仍null可用 | 不删除Price、不写正式收益Event；回退读算法需保留尚未公布过滤；各产品阈值、QDII基准/区间/FX继续单验 |
| B5：AUD-005已实现；健康/超期部分待办 | planning.generate_schedule稳定进度合并、dca_automation.status、DcaPlanAutomationStatus | 不变扫描无修订；真实金额/现金变化推进一次；显示last_checked_at且不伪造next_retry | 新API字段兼容，技术检查时间不计账务修订；回退不清空历史details；真实beat健康/退避单独实现 |
| B6：OD-01/R-003有设计，未实现 | market_quality/fund_sources/provider_policy、产品依据、年历及受控官方恢复证据 | 单源未冲突可用；已知冲突不能单源自动清；官方更正身份/范围/撤销与独立origin | 有证据后才新增显式受控恢复，先预览旧隔离；恢复不改交易、不重开禁用源 |
| B7：R-002/006/007部分验证 | 0012原生小样本恢复已通过；仍缺核对EvidenceLink/替代全链恢复、Docker、真实broker/worker故障、规模及机构样本 | 私有文件/RLS/不可变/恢复重扫已验；其余各场景按记录补齐，不用测试数量抵销 | 只在独立演练库；真实运维/账务操作另授权；不得把1.903秒小样本恢复称生产RTO |

每个PR写明触发与结果、准确基线、实跑测试、未跑边界、接口兼容及历史影响。历史收益重算按domain-model§16/RUNBOOK§8先差异预览；可重建投影与不可变流水分开。没有数据修复时不要生成“历史已修复”的状态。

## 历史发布摘要（以下段落保留当时记录）

更新时间：2026-10-08。业务基线为用户上传的 [V2 原文](requirements-v2.md)。**2.11.0 已于 2026-10-08 08:23:30（北京时间）完成保数据发布与验收**。新增 AKShare 公共行情渠道、原始发布方归组与同源校验，保留 2.10.0 的官方净值、冲突隔离与实际交易核对能力。最终候选完整后端 1,447 项及 12 项子测试、前端 152 项、隔离浏览器 7 项、发布脚本安全检查 31 项通过。详见 [2.11.0 发布记录](release-2.11.0.md)。真实机构原生账单、订阅授权接口、全市场覆盖及完整规模测试仍有边界；**V2 完整 P0 验收仍未全部完成**，以下历史证据及未完成项继续保留。

## 状态规则与环境

- **已验证**：下表所述输入、结果与必要状态已有自动化或人工证据；限于记录的环境与样本。
- **部分**：已验证一部分，但同一 AT 组仍有缺口，不计为整组通过。
- **待验证**：尚无该组必要预期的执行证据；有代码或页面不等于通过。
- **P1 后续**：不属于本次 P0；未作为已交付能力。

本地后端实测环境为 macOS arm64、Python 3.12.3、Django 5.2.17、PostgreSQL 18.6，测试数据在独立 `wealth_test`。业务请求与测试运行角色为 `wealth_app`，无 superuser/BYPASSRLS 权限且不是表 owner；迁移单独使用 `wealth_owner`。数据库测试不是 SQLite 或 owner 绕过 RLS 后的结果。前端使用 Node 22。

历史 2.6.4 曾部署至 [https://124.223.23.76/](https://124.223.23.76/)，环境为 Ubuntu 24.04、Python 3.13.15、PostgreSQL 18.6、RabbitMQ 4.3.6、Docker 29.1.3、Compose 2.40.3。隔离浏览器业务操作、关键服务器回归、源码与产物核验、保数据切换、只读公网 HTTPS 核验及五个主服务健康均有证据。现有生产空间的待办、还款、持仓配置和持仓读取在数据库强制只读事务内通过；没有创建测试交易或登录会话。具体记录见[服务器部署记录](server-deployment.md)。

AT-01—46 是 V2 P0 必测组，AT-47—48 随 P1 验收。本文不计算“完成百分比”，也不以大量小测试替代未执行的并发、浏览器或真实样本验收。

## 2.2 最终冻结构建与发布验证

状态：**2.2.0 已于 2026-09-25 23:26（北京时间）发布并通过 HTTPS 核验**。最终镜像为 `sha256:5fe51df62dd7ff0c8f47bde449343746c7996703a554652b4353032297a9914e`。测试、源文件一致性、隔离浏览器操作及生产状态分别保留证据。

| 项目 | 已完成的证据 | 范围 |
| --- | --- | --- |
| 本地最终全套回归 | **358 passed、12 subtests** | 最终冻结代码；沿用隔离测试库及真实 runtime 角色 |
| 服务器最终定向验收 | **174 passed，43.45 秒**；`.runtime/v22/server-release-acceptance.log` | `wealth:release-2.2-20260925`，隔离库 `wealth_v22_release_test`，迁移 0001–0007 成功；这是定向测试，不称为最终服务器全套回归 |
| 镜像与源码对应 | `.runtime/v22/image-source-verification.json`：后端 **65 个文件全部匹配**发布 manifest | 主包 `index-CrcblGEe.js`，CSS `index-CbKBHRWY.css`；确认被验收镜像的实际内容 |
| 隔离浏览器补验 | 银行转期货 100、“银期转入”动态文字、手续费 2、权益快照 98 关联同账户事项并保存、跨账户事项过滤、首页市场开关保存与恢复；今日估算完整值 1,275.10，未重复累计转入/手续费，昨结部分值 1,000 显示暂不可比 | Chrome，独立 `wealth_ui_test`，详见[浏览器记录](browser-verification.md#22-最终冻结构建补验)；未写入生产资产 |
| 生产切换与服务 | `.runtime/v22/deploy-reset.log`：发布完成，web/worker/beat/db/rabbitmq 五个服务 healthy | 停写、新鲜加密备份并校验、清理遗留消息、运行 0007 迁移、清空旧财务数据及私有/调度文件、预热公共目录后启动 |
| HTTPS 入口和 API | `.runtime/v22/https-verification.json`：可信 HTTPS、安全响应头、版本 2.2.0、CSRF 登录、安全会话、核心新增接口及注销后访问拒绝通过 | 保留首次初始化关闭；接口通过不等于全部浏览器业务组合已验收 |
| 清理后的正式账簿 | `.runtime/v22/deploy-reset.log` 与 `.runtime/v22/runtime-state.txt`：2 用户、2 成员关系、2 空间保留；各空间修订 0，账户/事项/私人产品/持仓变动/资源/outbox 均为空 | 合成 UI 数据未进入生产；公共产品目录独立于用户账簿，允许保留和预热 |
| 服务器实际参考行情 | `.runtime/v22/server-quotes-final.json`：NDX/SPX/VIX 报价及历史可用 | H30269 来源仍不可用，明确报告缺口；不宣称全市场可用或实时 SLA |

较早候选版本的服务器 328 passed、12 subtests 是阶段记录，不能当作最终镜像完成 358 项服务器全套测试的证据。原 V2 的真实机构样本、规模负载、全部权限路径和浏览器可访问性等未验收事项继续保留。

## 2.1 变更状态与发布验证

**2.1.0 已于 2026-09-25 21:36 部署到原 IP HTTPS 入口**。本地完整回归 244 passed、12 subtests（43.18 秒）；服务器隔离测试库同样 244 passed、12 subtests（102.86 秒）；前端 7 项、类型/格式检查和构建通过。公网登录、新增四类只读 API、后台实际行情刷新及原有账务摘要保留已核验；先完成加密备份并保留回退镜像。Chrome 完成基金历史持仓、收益日历、期货账户过滤、无凭证记账和 1024px 布局检查，详见[浏览器记录](browser-verification.md)。

本次功能及用户需求逐项映射见[2.1 发布说明](release-2.1.md)。代码包括统一资产与投资导航、产品检索及对应账户、已有持仓回算/人工估值、收益日历、分类行情、期货账户过滤与可选凭证。行情层区分正式净值、已结束交易日的收盘价和参考报价；任务层处理重复投递、旧产品身份、行情失败及陈旧状态。分红/折算提示保留到持仓与收益日历，缺实际记录时不把提示当成收益事实。

已新增 `test_market_data.py`、`test_market_lifecycle.py`、`test_market_integration.py`、`test_investments_v3.py` 及相关前端验证。定向回归已有执行证据，供应方实际探测范围见[行情研究](research/market-data-v3.md)；本次完整回归、服务器部署与关键浏览器流程已有上述证据，完整镜像与时间见发布说明。 AT 分组仍保留原有未验项，不因新测试数量自动升级为整组通过。

## 已执行的验证（原 2.0 发布证据）

| 项目 | 实际证据 | 适用范围与限制 |
| --- | --- | --- |
| 后端整套回归 | `.venv/bin/python scripts/local_backend.py test pytest --junitxml=../test-results/backend.xml --tb=short`；**137 passed、12 subtests，32.95 秒**，结果在 `test-results/backend.xml` | 覆盖账务、API、权限、导入、报表、规划、任务与数学。JUnit 的 testcase 数量包含子测试，不与 pytest 主用例数混用。 |
| 服务器容器回归 | Ubuntu / Python 3.13.15 隔离测试库：**137 passed、12 subtests，79.37 秒** | 随后仅调整 Celery 队列配置，相关任务测试 13 项再次通过；不宣称整套回归在该配置调整后重复执行。 |
| 数学与报表 | 数学 24 项、报表 28 项已随本轮回归通过 | 合成数据覆盖 A1/A4、XIRR、费用、汇率、快照及未知成本；并非真实机构适配验收。 |
| 规划 | `backend/tests/test_planning.py`，12 项通过 | 包括稳定期次、已付期保留、实际事项关联、冻结/预留、互斥方案、版本和预测只读。 |
| 后台任务 | `backend/tests/test_jobs.py`，13 项通过；RabbitMQ 4.3 兼容配置后真实 worker ping 通过，首条主库 outbox 已完成并生成 projection | broker 失败由测试注入，覆盖重试、重复投递、旧修订拒绝、跨空间和补扫；没有执行真实 RabbitMQ 故障演练。 |
| 前端 | `npm test` 5 项通过；已完成类型检查与生产构建 | 覆盖高精度金额展示、幂等重试与空间范围、409、multipart；不代替所有页面的浏览器验收。 |
| 1 万行导入 | [验证记录](verification.md)：解析暂存 0.6559 秒、预览 2.9631 秒、实账 0 条 | 单空间空账本、10,000 行合成 CSV；不含 HTTP/浏览器耗时，不代表千万级记录和 20 并发。 |
| 本地运行 | `scripts/local_dev.py start/status/stop`；`.runtime/local-start-check.json` | 同源网页、健康接口、空白首次初始化、持久化任务扫描与停止已验证；无默认财务数据。 |
| 浏览器 | 登录、首次空态、开户合成余额 10,000、记支出 120.50 后账户与首页均为 9,879.50 已人工确认 | 使用独立 `wealth_ui_test`。新增账户默认值问题修复后已复验通过；8 路由均正常打开，购房目标保存、1440/1024 布局、低装饰和自由文本遮挡已复验；详见[浏览器记录](browser-verification.md)。 |
| 备份离线校验 | `python3 -m unittest discover -s scripts -p 'test_*.py' -v`，5 项通过 | 清单哈希、认证加密往返、篡改拒绝、路径/符号链接/重复路径和密钥权限。 |
| 原生 PostgreSQL 恢复 | `scripts/test_restore_local.py`；`.runtime/restore-drill-result.json`；[演练说明](RUNBOOK.md#已执行的本地恢复演练) | 独立两空间合成库、附件、权限、净值、不可变事实和两次任务补跑已通过；净资产恢复前后均为 8,690，恢复核验约 1.57 秒。不是主账本备份命令或生产 RTO。 |
| 公网容器运行 | HTTPS 登录、安全会话、空账簿、核心 API 及五个主服务健康检查通过；Chrome 已视觉确认可信 HTTPS 登录页 | 可信 IP 证书每 6 小时检查续期，续期 dry-run 成功；不等同全部浏览器或完整 P0 验收。 |
| 服务器备份与恢复 | 每日 03:00 加最多 15 分钟错峰的加密备份已启用，一次 systemd 运行成功；`20260925T093105Z` 快照已恢复到 `wealth-restore-check-20260925`，内容、任务状态、运行角色和核心表 RLS 核验通过 | 主库/恢复库均为 1 用户、1 Owner 空间、0 账户/事件/分录、净资产 0；outbox 1 条 done、projection 1 条，0001–0006 迁移一致，含 0 个私有附件。证据见 `.runtime/deploy/restore-verification.json` 和[部署记录](server-deployment.md)。初次加密快照已复制本机，自动备份仍为服务器本地，未配置自动异地或失败告警。 |
| CI | GitHub Actions 定义了后端/前端检查与镜像构建 | 远程 CI 未执行，不能以服务器手动回归代替其执行结果。 |

A4 的实际验证位于 `test_reporting.py::test_appendix_a4_snapshot_replaces_its_included_deposit_adjustment`；已移除重复的占位跳过项。

## 机构适配证据

| 来源 | 当前状态 | 尚缺资料 |
| --- | --- | --- |
| 通用 CSV/TXT/XLSX | `synthetic_verified` | 只证明通用解析、人工映射和合成账务流程；每个机构格式仍需单独核验。 |
| 喵喵记账 | `planned` | 真实脱敏导出、版本、账户/转账/退款字段和去重身份。 |
| 广发期货 | `planned` | 日结、入出金、持仓、手续费、权益与期权覆盖范围。 |
| 银河期货 | `planned` | 日结、入出金、持仓、手续费、权益与期权覆盖范围。 |
| 广发基金 | `planned` | 产品代码与份额类别、渠道、申赎确认、费用/分红、QDII 日期链。 |
| 易方达基金 | `planned` | 产品代码与份额类别、币种/渠道、申赎确认、QDII 日期链。 |
| 支付宝、微信、银行、港美券商 | `planned` | 各版本真实文件与字段，首批具体券商尚未确定。 |

红利低波不是唯一产品身份，QDII 的预计 T+2 也不是确认事实。未取得上述资料前，不承诺某只基金或某机构已兼容。2.1 已接入天天基金/东方财富、腾讯财经、新浪财经及 Yahoo Finance 的公开参考行情，已实测范围见[行情研究](research/market-data-v3.md)；没有全市场实时数据 SLA，也没有自动汇率、银行连接、机构账单拉取或外部付款能力。具名机构导入适配与公开行情接入是两项不同验收。

## V2 验收追踪

表中测试简称指向可检查的源文件： [API](../backend/tests/test_api.py)、[SEC](../backend/tests/test_security.py)、[LED](../backend/tests/test_ledger.py)、[RPT](../backend/tests/test_reporting.py)、[PLAN](../backend/tests/test_planning.py)、[MATH](../backend/tests/test_finance_math.py)、[JOB](../backend/tests/test_jobs.py)、[FILE](../backend/tests/test_import_files.py)、[GOLD](../backend/tests/test_final_acceptance.py)。函数名可直接用于 pytest 的 `-k` 过滤。下表的“部分”同时写出尚未验证的边界。

| 编号 | 场景 | 状态 | 证据与剩余项 |
| --- | --- | --- | --- |
| AT-01 | 账户/文件 ID 指向其他空间 | 部分 | API `test_tenant_isolation_and_viewer_raw_privilege`、SEC `test_fact_updates_and_cross_tenant_foreign_keys_rejected` 验证请求/RLS/外键隔离；仍需覆盖全部列表、搜索、下载与关联路径的攻击矩阵。 |
| AT-02 | Viewer 写入；Editor 原文件/完整导出 | 已验证 | API `test_tenant_isolation_and_viewer_raw_privilege`、`test_editor_cannot_manage_members_or_download_originals` 拒绝写入、原文件和完整导出；原生恢复后再次验证 Viewer 拒绝。 |
| AT-03 | 提交导出后移除 Owner，再下载 | 部分 | API `test_export_contains_facts_and_evidence_and_enforces_requestor` 与 `test_last_owner_and_immediate_revocation` 分别验证下载者与撤权；该先生成后撤权的完整组合待验证。 |
| AT-04 | 复用连接及跨空间后台任务 | 部分 | SEC `test_runtime_role_and_default_deny_rls`；JOB `test_cross_space_job_id_is_rejected_and_nested_scope_is_restored`、`test_unknown_job_is_harmless_and_does_not_leave_a_tenant_context`；真实连接池/并发 worker/缓存边界仍需部署验收。 |
| AT-05 | 快速切换空间与未保存草稿 | 部分 | 前端单测验证幂等键按空间分离；快速切换、返回旧页和草稿恢复的浏览器流程待验。 |
| AT-06 | 期初余额/负债/未知成本及补历史账单 | 部分 | LED `test_multiple_initial_holdings_without_duplicate_cash_or_product`、`test_preopening_transactions_cannot_double_count_history`，API `test_account_with_opening_is_idempotent_and_cache_invalidates`，RPT 期初市场价值测试已通过；旧系统历史覆盖规则与差异迁移全链待最终验收。 |
| AT-07 | 撤销/过期邀请及最后一位 Owner | 部分 | API `test_last_owner_and_immediate_revocation`、`test_invitation_preview_join_and_single_use`；撤销和过期邀请的组合边界尚缺执行证据。 |
| AT-08 | 笔记跨空间关联与搜索泄漏 | 部分 | PLAN `test_notes_preserve_published_original_and_reject_nested_foreign_links` 拒绝嵌套外空间关系；跨空间附件、交易关联与全文搜索的完整组合待验。 |
| AT-09 | 上传预览 1 万行且不入账 | 部分 | [1 万行实测](verification.md) 保留来源行、预览全部行且实账事件为 0；混合错误行及前端 1 万行交互仍待同规模验收。 |
| AT-10 | 三来源同一消费与独立同额消费 | 部分 | API `test_cross_source_link_checks_account_type_and_preserves_fact`、`test_overlapping_native_id_import_is_one_fact_two_evidence_rows` 验证多证据归并；真实三来源格式及独立同额记录的完整样本待验。 |
| AT-11 | 重复文件/重试/同键不同请求 | 部分 | API `test_idempotency_and_optimistic_version`、`test_overlapping_native_id_import_is_one_fact_two_evidence_rows`；同一原文件重复上传全流程仍需独立验收。 |
| AT-12 | 预览失效与选定行原子提交 | 部分 | API `test_preview_expires_after_ledger_change_and_batch_is_atomic`、`test_partial_batch_can_resume_without_republishing_committed_rows`；预览后修改映射的独立分支待验证。 |
| AT-13 | 批次冲正保留其他来源支持的事项 | 已验证 | API `test_overlapping_native_id_import_is_one_fact_two_evidence_rows`、`test_cross_source_link_checks_account_type_and_preserves_fact` 验证移除一份来源证据后实账仍存在。 |
| AT-14 | 转账两端与信用卡还款 | 部分 | LED `test_internal_transfer_and_fee_preserve_principal` 验证转账本金与费用；双侧不同时间导入和信用卡消费后还款完整场景待验。 |
| AT-15 | 中断/并发提交的事务原子性 | 部分 | SEC `test_balanced_ledger_is_deferred_until_transaction_commit`、`test_balanced_currencies_cannot_cancel_each_other` 与 JOB `test_outbox_and_financial_fact_share_the_same_rollback_boundary`；真实并发竞争及逐处故障注入未完整执行。 |
| AT-16 | 跨月部分退款及更正关联 | 部分 | LED `test_refund_cannot_restore_a_reversed_expense`、PLAN `test_reconciliation_uses_facts_and_cannot_claim_a_nonzero_difference_is_matched`；跨月金额、原交易更正、对账过期的联动待验。 |
| AT-17 | 计划/T+1/T+2 不制造实际扣款 | 部分 | LED `test_unconfirmed_plan_never_creates_a_cash_fact`、PLAN `test_month_end_schedule_is_stable_and_never_posts_cash`、JOB 扫描测试均不生成实账；2.3 新增官方已发布年份的交易日历、截止时间、QDII 建议和人工覆盖测试；具体机构合同、海外临时休市及实际确认样本仍待验。 |
| AT-18 | 基金 1,000 / 495 份 / 价格 2 / 费 10 | 已验证 | LED `test_appendix_a1_fund_lifecycle_cash_cost_and_profit`、RPT `test_appendix_a1_formal_value_is_distinct_from_fee_inclusive_cost`：成本 1,000，正式市值 990，费用不重复扣除。 |
| AT-19 | 部分确认与余款在途/实际退款 | 已验证 | GOLD `test_at19_partial_confirmation_keeps_400_in_transit_until_actual_refund` 按原始金标准验证 1,000 扣款、600 确认、400 保持在途直至实际退款；LED 另覆盖超额确认/退款拒绝。 |
| AT-20 | A1 赎回到账终值及重复导入 | 部分 | LED/RPT 的 A1 全链实测现金 10,004.80、收益 4.80，重复到账命令被拒绝；实际到账原文件重复导入这一组合仍待样本验收。 |
| AT-21 | 改未来期、重复扫描、停机补跑、账单先到 | 部分 | PLAN `test_paid_occurrence_keeps_identity_and_amount_after_future_plan_edit`、`test_occurrence_confirmation_reuses_event_does_not_post_or_accept_wrong_account`；JOB `test_periodic_scan_catches_up_plans_and_loans_without_posting_cash`；账单早于计划首次生成的匹配全链待验。 |
| AT-22 | 参考/正式净值与晚到回填 | 部分 | RPT `test_reference_price_never_becomes_official_asset_value`、`test_future_price_is_not_used_but_recent_formal_price_can_be_used`；JOB `test_old_revision_cannot_replace_a_newer_projection`；晚到正式净值回填与界面归属日的组合待验。 |
| AT-23 | 缺行情、陈旧或失败时不伪报完整 | 部分 | RPT 对缺汇率、参考价、未来价格、未知覆盖显式返回部分；2.1 已接入公开参考行情，新增失败保留旧价并标陈旧、禁止盘中日 K 冒充正式收盘、基金估值/NAV 分离等回归；上游真实持续故障与所有页面“今日完整收益”全流程仍需最终验证。 |
| AT-24 | 再投、拆分与跨账户转仓 | 已验证 | GOLD `test_at24_reinvest_split_and_internal_transfer_preserve_portfolio_boundary` 验证全链份额、成本、无新增现金及组合内部流排除；RPT 另验证转入单账户范围按市值计外部流。 |
| AT-25 | 7,000 CNY 换 1,000 USD，费用 10 | 已验证 | RPT `test_at25_fx_changes_net_assets_only_by_fee` 与 SEC 逐币种平衡约束：即时净资产仅减 10；换汇本金不计消费。 |
| AT-26 | 汇率变动收益及另一币种缺汇率 | 已验证 | RPT `test_at26_fx_gain_and_missing_other_currency_are_separate`：美元现金汇率贡献 100，缺失币种不按 1:1，合计标为部分。 |
| AT-27 | 同代码不同市场/份额/币种的身份 | 待验证 | 产品字段已存在，尚无覆盖所有身份冲突组合的执行证据；不据此宣称实际产品适配。 |
| AT-28 | 港美分批成交、分日交收与日期精度 | 部分 | LED `test_stock_trade_cash_moves_only_at_settlement_and_cost_fees_are_not_duplicated`、`test_settlement_is_scoped_to_individual_trade_not_entire_operation`；真实港美样本、时区/仅日期场景待验。 |
| AT-29 | 权益不叠加保证金/名义额/持仓 | 已验证 | RPT `test_snapshot_does_not_add_margin_notional_or_detailed_positions`：权益贡献 10,000，保证金 3,000 与名义额不叠加，期权包含口径明确。 |
| AT-30 | A4 新快照替换已含入金调整 | 已验证 | RPT `test_appendix_a4_snapshot_replaces_its_included_deposit_adjustment`：最终 19,880，期间损益 -120，旧入金调整归零。 |
| AT-31 | 较新快照但资金/期权覆盖未知 | 已验证 | RPT `test_snapshot_unknown_coverage_is_never_complete`、`test_snapshot_must_explicitly_cover_same_day_transfer`：保留已知值和缺口，不按日期较新就报完整。 |
| AT-32 | 夜盘交易日与主连切换 | 待验证 | 2.1 已有境内期货参考行情适配，黄金连续合约标为仅参考；仍未提供实际夜盘归属/主连切换的完整结算样本，不宣称自动展期或逐笔结算。 |
| AT-33 | 还款 520 = 本金 500 + 利息 20 | 已验证 | LED `test_known_repayment_principal_is_not_expense`：现金减 520、负债减 500、费用 20，不把本金计消费。 |
| AT-34 | 先扣款后拆分且重复提交 | 已验证 | LED `test_appendix_a2_unknown_repayment_then_allocation_never_double_debits_cash`、RPT `test_unknown_repayment_allocation_marks_net_worth_incomplete`：未拆分标不完整，拆分清算归零且现金不再扣。 |
| AT-35 | 月末/零息、改未来、提前还款与补扫 | 部分 | MATH 的贷款日期、零息、尾差测试；PLAN `test_zero_rate_loan_future_replacement_preserves_actual_period`；JOB 补扫测试；提前还款后全计划重排仍待验。 |
| AT-36 | 冻结/预留重叠、超额与实际付款释放 | 部分 | MATH `test_appendix_a3_frozen_reservation_overlap` 得可安排 5,000；PLAN `test_reserved_and_frozen_cash_overlap_is_counted_once_and_overallocation_rejected`、`test_goal_payment_releases_the_same_reservation_in_forecast_without_double_deduction`；多目标实际付款的界面全链待验。 |
| AT-37 | 互斥购房方案及资产落地 | 已验证 | GOLD `test_at37_alternative_plans_and_actual_house_purchase_have_net_assets_380000`：方案分别预测并互斥切换；实际房产 1,000,000、负债 700,000、现金 80,000、净资产 380,000，预留按实际现金 320,000 消耗；另外覆盖事后匹配、重复关联及冲正恢复。 |
| AT-38 | 期间损益 200 与内部流排除 | 已验证 | MATH `test_period_profit_boundary_and_appendix_a4`：11,200 − 10,000 − 1,000 = 200；RPT `test_xirr_uses_period_opening_value_and_excludes_internal_transfer` 验证组合内部流不算外部投入。 |
| AT-39 | 未知成本、缺历史、XIRR 无解/多解/失败 | 部分 | MATH 的 XIRR 失败/多根/切根测试，RPT `test_unknown_cost_disposal_keeps_actual_cash_but_does_not_invent_realized_profit`，JOB `test_projection_failure_is_durable_and_inline_retry_recovers`；历史缺口和重算失败的完整页面呈现待验。 |
| AT-40 | 已发布计划原文与清仓复盘 | 部分 | PLAN `test_notes_preserve_published_original_and_reject_nested_foreign_links` 验证发布版本、时间、正文/标签保留；关联交易和清仓后的复盘操作全链待验。 |
| AT-41 | 全部 7+1 页面与高频入口 | 部分 | API `test_app_routes_and_empty_real_overview` 返回真实空态；浏览器已验证开户 10,000、支出 120.50、账户/首页 9,879.50，8 路由与目标创建。2.2 冻结构建补验银期转入 100、手续费 2、快照 98 关联同账户事项保存及市场显示偏好；全部导入/对账表单及逐行操作仍待完整浏览器验收。 |
| AT-42 | 低装饰、1024px、200% 与键盘 | 部分 | [浏览器记录](browser-verification.md)：1024px 无页面横向溢出，1440px 总览、低装饰、自由文本隐私与有名称的开关已验证；200% 和完整键盘路径待验。 |
| AT-43 | 生产页面无假资产，负值/空态可辨 | 部分 | API 空账本与原生启动/浏览器空态已确认，无默认演示资产；全部页面、负值和非颜色提示仍待人工遍历。 |
| AT-44 | outbox 投递失败、重复重算及旧版本 | 部分 | JOB `test_broker_failure_remains_durable_then_retries_without_reposting_money`、`test_duplicate_worker_delivery_has_one_projection_and_no_new_facts`、`test_old_revision_cannot_replace_a_newer_projection` 均已执行；真实 RabbitMQ 故障/重启部署演练尚未执行。 |
| AT-45 | 千万记录/20 并发与恶意导入文件 | 部分 | FILE 验证畸形 CSV、公式、不安全压缩比；1 万行服务端预览已测；100 空间×10 万记录、20 并发、P95/P99 与资源峰值未测。 |
| AT-46 | 空环境恢复与有差异旧数据迁移 | 部分 | [原生恢复演练](RUNBOOK.md#已执行的本地恢复演练) 覆盖数据库/私有文件/权限/任务，恢复值一致；服务器初始快照也已恢复到独立 Compose project，内容、任务状态、运行角色与核心表 RLS 核验通过，见[部署记录](server-deployment.md)。实际容量、真实旧数据差异迁移与生产 RPO/RTO 仍未验证。 |
| AT-47 | 资金不足时规则与风险阈值 | P1 后续 | 未交付完整规则引擎与风险策略；现有预算/策略记录不是此验收通过。 |
| AT-48 | 模型开关、外部指令与生成错误 | P1 后续 | 未接入外部模型，不宣称 AI 生成、自动审查或模型安全验收已完成。 |

## 完整 P0 发布前的剩余关卡

1. 取得五来源真实脱敏文件、基金唯一身份及港美券商范围，完成格式版本、确认/结算日期、去重和权益包含口径验收；不得以通用模板替代机构适配。
2. 完成表中所有“部分/待验证”的组合场景，尤其真实并发、旧数据补入、购房界面全链、夜盘日期、导出撤权和跨空间全部路径；保留失败与修复的回归证据。
3. 修复并复验浏览器发现的问题，遍历 7+1 模块、高频导入/对账、空间切换、键盘与 200% 缩放；金额、错误和不完整状态不能只靠颜色表达。
4. 在已运行的目标部署上补齐真实消息队列故障/重启、非空实际容量恢复及旧系统差异迁移验收；完善自动异地备份和失败告警，记录实际 RPO/RTO。基础容器启动、备份调度与初始快照恢复已执行，不重复列为未开始。
5. 按 V2 第 28 章完成千万级记录、20 并发与持续负载测量。1 万行空账本预览与 1.57 秒小库恢复均不能替代此门槛。
6. 补全 G0 未完成的同样本开源底座对照或正式记录路线取舍，完成实际依赖/镜像审查与发布检查；远程 CI 通过后再记录其结果。

任何金额错误、重复入账、空间泄漏、无依据确认、不可恢复或生产假数据都是发布阻断项。当前“可以本机及服务器使用”不等于“V2 完整首版已验收”。
