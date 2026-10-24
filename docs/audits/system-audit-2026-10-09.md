# Wealth 系统审查：2026-10-09

状态更新（2026-10-10）：初始审查形成6项失败证据；后续授权修复的6项业务问题及AUD-007权限问题随2.12.0保数据部署，展示优化与UX-005缓存兼容亦已验收。§1–3/§6保留初始审查事实，§4维护未完成边界，§8保留10月9日修复阶段，§10记录最终提交/镜像与限定生产验证。没有合并主分支、历史账务修订/重算或核心重构。维护入口见[项目地图](../project-map.md)，现行业务规则见[领域模型§12–17](../domain-model.md#12-现行业务基线2026-10-09)。

## 1. 结论与基线

系统已有可用的个人/家庭记账底座和较完整模块；不能再称“应用尚未开发”。正常场外基金定投可以一次设置，先自动记录扣款、等待正确净值，再推算份额；公开行情不是银行支付，推算完成不是机构确认。正常路径在普通用户页面和受控后端样本中已跑通。主要实际问题是：把计划标为完成后，已扣款期次不再被补扫；标准基金账单丢失成交净值日，导致更正后的收益资格晚生效；部分收益读口径没有同步采用已核对证据、报价时间和公布时间。

初始审查没有确认重复扣款、跨空间读写或原始流水被收益回填篡改的P0缺陷，也没有证明所有这些风险都不存在。修复回归随后发现初始化授权P0风险，见AUD-007（§8.2），不能沿用初始结论否认它。1447项既有测试通过，与新增6项预期行为断言失败同时成立；它们覆盖的场景不同。

| 项目 | 2026-10-09核实结果 |
| --- | --- |
| 原仓库 | `/Volumes/mi/Wealth`；`main`，HEAD `e379dfe67a715d9913af246eba021c7b26ce45d1`，2026-10-08合并PR#3 |
| 已有工作 | 只有未跟踪 `docs/manuals/拾财系统操作手册_2.8.0.docx`；原文件保留，已只读核对257段/9613字及渲染关键页；未修改，不把旧手册作为现行规则 |
| 远端 | `https://github.com/ZhouHuangjian/Wealth.git`；默认`main`，只读查询HEAD与上述SHA相同；列出的3条功能分支没有新的默认分支发布；未发现远端tag |
| 审查隔离 | 托管worktree `codex/system-audit-2026-10-09`，从上述SHA开始；另建本机PostgreSQL、随机凭证和合成库；未使用原开发主库55432 |
| 适用指令 | 仓库及父目录、嵌套目录未发现AGENTS.md；按本次用户限定范围执行 |
| 文档部署版本 | [2.11.0记录](../release-2.11.0.md)：2026-10-08 08:23:30北京时间；候选`0103fc8e0306875781f3f722d5b93f06e37a369b`；镜像`sha256:28012e1f860cb6d0390129437fa2de0c1091389fa84c7d9685b6b630f15dc19d`；是历史记录，不能直接等同当前主分支 |
| 初始审查当日实际运行版本 | 对公网`/api/health/`进行可信TLS只读请求，返回`status=ok, version=2.11.0, mode=production`；当日实际源码SHA、镜像、迁移、私有数据、worker/beat和备份健康均未核实；后续2.12结果见§10 |
| 日期与环境 | 审查日2026-10-09，Asia/Shanghai；macOS arm64、Python3.12.3、Node22.22.1、PostgreSQL18.6；后端1447项在runtime非owner、非superuser、无BYPASSRLS角色运行 |

对外部产品规则仅用官方材料核对边界：[易方达网上交易定投规则](https://cdn.efunds.com.cn/eufs/protocols/eFundsOnlineTradeRegularInvestmentBusinessRules.html)、[易方达投资者教育](https://edu.efunds.com.cn/Mobile/c/42/42718.shtml)、[上交所2026年休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml)。日/周跳过、月顺延有特定渠道依据，不能推成所有基金/渠道承诺。真实目标产品、份额、渠道和跨市场日期链仍需样本核验。

## 2. 覆盖矩阵与阅读边界

“已阅读”指下述调用链关键路径；不表示约5万行业务代码逐行穷尽。已运行指本轮实际命令/交互，不用历史记录替代。完整定位见[功能地图](../project-map.md#功能页面接口服务数据任务测试)。

| 模块 | 已阅读 | 已运行验证 | 仅静态判断/未覆盖 |
| --- | --- | --- | --- |
| 首页、资产、收益日历、分析 | navigation-model，Home/DailyReturnCard/ProfitCalendar，reporting/portfolio/daily_returns/investments/return_dates主要读链 | 既有收益/计值回归；A/B及费用、赎回、分红/拆分、晚获知样本；普通用户首页和持仓导航 | 全部筛选/布局/多币种页面未交互；真实QDII跨境估值无样本 |
| 自动/历史定投 | DcaPlanManager/DcaAutomationFields，API计划保存，planning/dca_schedule/dca_automation，tasks，calendar/fund_sources/market_sync与约束 | 页面保存→扣款→待净值→推算完成；API保存无需重复确认；日/周/月末/未知日历既有回归；真实两连接并发、新进程补扫 | 未运行生产扫描、真实Celery/RabbitMQ故障/重启、长期停机和不同浏览器时区 |
| 账户、已有持仓、机构留存、现金与预留 | account_opening/institution_funding/availability/account_balances/reservations，ledger写入与读侧互斥计值 | 既有期初/余额/冻结/预留/已有持仓测试；本轮现金1000→898、在途→份额 | 实际机构余额/货币基金可用性无样本；开户全页面未跑 |
| 普通交易、转账、兑换、费用、退款、冲正 | views→investment_trades/fund_orders→ledger→分录/持仓约束；weighted_average/period_profit关键公式 | 既有账务/API/数学回归；本轮赎回到账、份额差异冲正替代、原事实不变 | 实际券商交收和衍生品计算未独立重算；未覆盖全部产品变体 |
| 导入、标准基金核对 | FundReconciliation，fund_reconciliation主要归一化/匹配/补证/更正/撤销，imports/SourceFact/EvidenceLink | 既有解析/核对回归；实际证据绑定、晚确认、差异更正合成样本 | 机构原生样本、真实文件交互、所有未知格式与OCR未覆盖 |
| 贷款、周期收支、目标、方案 | planning保存/预测/期次关联，loan_schedule/add_months/available_cash，ledger本金/利息/清算 | 既有数学、规划、贷款晚拆分、互斥/预留及任务测试 | 本轮无贷款和目标页面、真实合同、规模与提前还款样本 |
| 分红、手札、标签/提醒 | dividends入口/发现和ledger记账、notes私有附件、insights主要规则入口 | 既有相关测试；本轮再投/拆分账务与收益 | 通知到实际分红确认全页面、全部信号逻辑未逐分支阅读 |
| 权限、管理台、删除恢复、私有文件 | views/api/dispatch_space、admin_access、platform_admin/cleanup，软删除与管理scope，模型与关键RLS/不可变迁移 | 全量安全/管理回归；runtime权限与跨空间引用诊断 | 管理台全部路径未浏览器复验；0010大型管理函数未逐行安全证明；撤权进行中下载未做真实负载 |
| 多源、估值、行情任务 | provider_policy/credentials，fund_sources身份/日期/来源归组，market_quality、market_data基金quote/_quote，market_sync主要路径，AK适配与测试 | 受控单源、冲突、同源、恢复、过期及正式替代；全量既有适配测试 | 本轮无供应商实际网络探测、订阅授权/全市场实测、真实性能或付费源配置 |
| 配置、依赖、迁移、发布、备份 | README、requirements/lock、compose/Dockerfile、settings、CI、local_dev/backup主要入口、0001–0012结构与关键约束 | 空库0001–0012迁移；后端/前端/脚本检查；隔离启动 | 当前版本真实备份恢复未重演，远程CI/镜像构建与生产运维未执行 |
| 文档 | README、领域/接口/状态/决策/运行/验收主线；ADR；基金2.7/2.8、QDII2.9、日期研究；2.7–2.11关键发布全读 | 与现行函数、测试、页面逐项交叉检查并更新 | 长篇V2/早期研究及早期发布按目录和相关段落阅读，非全页复核；原工作区未跟踪2.8 DOCX已只读提取全文；渲染12页，1–4页中文缺字，布局未通过；没有重新交付DOCX |

本轮发现旧的“应用未开发”、费用拟单列、定投每期人工确认、旧导航及旧运行版本描述不能继续作为现行规则。旧需求/技术研究/发布证据保留历史时间和真假边界；现行规则集中到domain-model§12–16、api-contract§21–22。真实机构兼容、全P0验收及运行健康仍不能升级为已完成。

## 3. 初始审查确认的问题（当时尚未修复）

以下代码行号对应初始SHA，症状和失败是修复前事实。复现使用固定时钟、受控日历、禁真实行情网络和合成账簿；源码在`backend/audit_scenarios/test_system_audit_20261009.py`。`-m audit_finding -k aud00N`在初始实现失败；当前修复分支同样断言已通过并纳入默认tests，见§8。

### AUD-001 / P1：计划完成阻断已经扣款的期次

- 用户症状：本期已扣款、待正式净值；计划状态改为`completed`后，即使净值已齐也一直无份额。暂停状态能续办，不能把二者混称都坏。
- 预期：停止新期次与结清已授权的在途阶段分开；尊重显式关闭自动化。实际：`run_plan`在非active/paused时直接返回。复核纠正初次静态误读：`scan_all`原本选所有启用的DCA计划，阻断在run_plan，不是任务查询。
- 复现：创建开启自动化的单期计划，运行生成一个debit/零confirm；改计划状态为completed；加入精确成交日NAV；调用`scan_all`；confirm仍为0。诊断第534行。
- 根因/位置：`wealth/dca_automation.py:951–975`，特别是963；`wealth/tasks.py:scan_all`调用该函数（原选择无此状态限制）。状态把“停止生成”和“停止已支付处理”合并。
- 影响：满足此状态组合的已付期次；不能据此宣称普通active计划、自然end_date或所有已部署账簿卡死。
- 最小修复：分离生成资格与已扣款结清资格；对已授权未终结阶段补扫，取消/关闭的资金处置要明确，不重新开启开关。与暂停/退款/结束范围共同回归。
- 数据/接口：一般无需改变原流水；已有卡住期次需要只读差异清单、明确授权后幂等补扫，不能批量改为active。
- 验收：completed不新增未来扣款，已付一期净值到齐后只生成一次confirm；显式disabled不自动恢复；暂停、取消、退款、服务重启无重复。任务批次B2。

### AUD-002 / P2：实际账单已核对，日收益仍标份额推算

- 用户症状：同一交易在核对/持仓读侧是actual，日收益仍是`quantity_source=automatic_estimate`、status estimated。
- 预期：净值正式性、份额来源、交易核对分维度；有效实际证据能提升份额来源，撤销证据又恢复推算。实际金额本案例不变。
- 复现：自动完成无费计划→导入同订单/金额/份额/价格的完整确认账单→attach补证→读`event_evidence`及daily_return；前者actual，后者automatic_estimate。诊断第544行。
- 根因/位置：`wealth/return_dates.py:57–74`只检查原payload和engine stage_key；没有使用`wealth/fund_reconciliation.py:304–350`的有效EvidenceLink结论。不可变原payload本身应保留。
- 影响：已经对账的推算份额及对应日历/最近收益标记；并非二次扣款。
- 最小修复：批量加载有效核对来源，提供统一份额证据读函数，避免N+1；保留旧推算事实及来源关系，禁止直接修改automatic_estimate。
- 数据/接口：读侧来源改变，无现金/份额修订；缓存/收益投影需失效。状态名称兼容现有消费方。
- 验收：attach实际后两个页面/接口一致；撤销、部分账单、替代和不同订单仍准确，无新增Event。任务B3。

### AUD-003 / P1：标准基金账单漏传成交净值日，晚确认少算中间收益

- 用户症状：只记了扣款的期次随后以机构账单确认，收益资格落到确认日；即使原CSV含nav_date也丢失。本例D2显示1元而应为2元。
- 预期：D0旧100份×1；D1以1.02买102元新增100份；D1旧份额收益2元，D2以1.03计200份收益2元；D3获知/确认不挪收益。实际D1=2、D2=1，新confirm无nav_date。
- 复现：构造上述旧持仓和D1 debit；标准确认账单`nav_date=2026-09-29, confirmation_date=2026-10-01, quantity=100, nav=1.02, fee=0`；preview选择paid候选、correct补确认；读取payload与D1/D2收益。诊断第560行。
- 根因/位置：`wealth/fund_reconciliation.py:87–164`仅归一化ALIASES列，没有nav_date；`_correct:753–780`写confirmation_date，缺新成交日；`return_dates.py:16–44`没有成交日时按记录日期回退。已有确认时还可能沿用旧nav_date，后者本轮只作静态风险，未声称已复现。
- 影响：标准核对中新创建确认的晚到事实及收益读侧；没有证明原扣款被改日或现金重复减少。
- 最小修复：显式映射并保留有依据的NAV日期/申请时间链；验证身份、币种、扣款与确认关系。未知日期标缺口，不能由confirmation_date减T+1或最新价格猜测；更正改变NAV日时显式替代并审计。
- 数据/接口：标准核对归一化/预览增加日期信息；初始提案考虑升级解析版本，实际修复保持fund-confirmation-1兼容；旧SourceRecord.raw可能保留原列，可生成差异预览。原Event禁止批量update；收益投影可在证据明确后重建。
- 验收：本例nav_date保留、D1=2/D2=2；缺字段不猜；QDII实际规则、费用、已有confirm日期变更、退款/后续卖出依赖和旧preview冲突均通过。任务B1。

### AUD-004 / P2：重新抓取的数小时前估值仍进入今日估算

- 用户症状：报价在09:00公布，15:00刚抓取，仍计算为当前今日估算2元，尽管适配器已标delayed。
- 预期：获取新鲜度和报价时点分别检查；显示09:00参考值/覆盖区间，缺当前可靠报价则今日收益为空并说明。实际新fetched_at通过600秒门槛，源published_at六小时前未拦。
- 复现：固定D1 15:00，正式基准1、100份，`market_data._quote`构造09:00的1.02估值、刚抓取，写参考Price和market_quotes后读daily_return。诊断第587行。
- 根因/位置：`wealth/market_data.py:239–325`生成`data_state=delayed,status=ok`；`wealth/daily_returns.py:346–375`只看failed/stale/fetched_at，未消费公布/估值时间及delayed。
- 影响：参考估算的展示/聚合；不生成正式收益Event。是否所有供应商都六小时旧未做网络实测。
- 最小修复：统一quote有效性与区间证据，按市场/产品定义时效；明确旧值、休市、未知基准的降级规则，不能一概显示0。
- 数据/接口：读侧增加/复用估值时间、基准日期与原因；必要信息未知时null，不伪造发布时间。无原流水迁移。
- 验收：刚抓取旧报价不会变成当前值；当前可靠报价、休市、无公布时间、QDII多日基准、正式替换都不双算。任务B4。

### AUD-005 / P2：等待资金的同日重复扫描制造修订

- 用户症状：没有任何真实账务/配置变化，重复等待扫描仍增加空间修订；可能使预览失效、重复触发投影。后两项负载影响尚未实测。
- 预期：同进度、同阻塞原因的重复检查只更新健康检查时间或不变，不制造账务修订。实际revision 4→6，仍无debit/confirm。
- 复现：今天到期，现金1000、冻结999，本期102；运行得到waiting_cash；再运行同一天同条件，比较revision。诊断第631行。
- 根因/位置：`wealth/planning.py:625–737`重建未付当日期次details（665附近），擦除automation运行内容；`wealth/dca_automation.py:325–340`再次补回状态，两次bump。
- 影响：当前日未付等待期次；金融事件未重复，不能称重复扣款。
- 最小修复：分离稳定计划字段和处理状态，保持一致时不改version/revision；检查时间留运行层。不要为此去掉幂等/修订保护。
- 数据/接口：可能调整Occurrence.details内部合并策略；保留历史进度；确认preview只在真实相关变化后过期。
- 验收：同条件多次扫描revision/Occurrence版本/Event数稳定，条件改变后推进一次，并发/预览/旧投影约束有效。任务B5。

### AUD-006 / P1：正式计值读侧接受未来公布的净值

- 用户症状：普通价格API允许保存过去NAV日但published_at在明天的正式观察；概览正式选择器立即读到它。DCA选择器会等待公布，两侧不一致。
- 预期：经济日期与数据可用时间分别判定；未公布观察不能立即作为可用正式净值。实际`formal_price`选择D1的1.02，预期仍是D0的1.00。
- 复现：先有D0正式净值；通过普通用户`POST prices`保存D1、published_at=固定now+1天，API200；读取formal_price。诊断第643行。未来业务交易仍受独立校验，不能据此推成允许未来扣款。
- 根因/位置：`wealth/reporting.py:40–55`与ReturnEvidence正式Price集合无published_at截止；`wealth/dca_automation.py:811`有该条件。正式价格质量与可用性实现重复且不一致。
- 影响：正式估值/收益展示及采用该读函数的模块；本轮未观察到真实生产异常。DCA份额入账在此案例受保护。
- 最小修复：统一“可用正式观察”谓词（身份、归属日、隔离、撤销、已公布），定义未知公布时间允许使用已获取正式数据的证据；Price入口可拒绝明显未来公布或留作不可用观察，需明确契约。
- 数据/接口：现有future published观察需只读列举、到时恢复；不删除Price、不改原流水；收益投影按更正后资格重建。
- 验收：同样Price集合在DCA/持仓/首页/日历一致；pub空/过去/未来和跨时区边界、冲突隔离均通过。任务B4。

## 4. 尚未复现的风险与待验证边界

不是缺陷的证据不升级为缺陷。以下有位置和验证任务，负责人均待指定。

| 编号/优先级 | 证据、影响与最小下一步 | 验收/数据影响 |
| --- | --- | --- |
| R-001/P1 时间区不统一风险 | `planning.today`用space.timezone；daily_returns及部分开户/交易入口用timezone.localdate；前端dayjs采用浏览器日期。不同空间/服务器/浏览器跨午夜组合未运行，不能声称已错日 | 固定同一UTC时点，上海/纽约空间和两浏览器时区走页面→API→读侧；若有差异统一业务日期上下文，保留原事实时间 |
| R-002/P1 任务运行/网络延迟 | `tick`先分红/行情再scan；本地“每30秒”是轮次完成后等待，不是无条件30秒SLA；beat配置存在不证明生产运行 | 人工隔离注入超时、kill/重启真实worker/broker，检查局部失败、进度和补扫；生产只读任务健康另核实，不移动网络入写事务 |
| R-003/P1 产品/日历覆盖 | 静态年历覆盖有限、未知年无weekday假装兜底；产品confirmation_days是配置，非机构实际证明 | 逐产品登记渠道/份额/货币/截止/海外休市依据，补新年度样本后维护年历；未知待核实只阻塞相应阶段，不伪造NAV日 |
| R-004/P2 估值证据/缓存身份 | 当前绝对GSZ估值优于随意乘最新净值，但不是全部源都有基准/覆盖区间；公共缓存键的份额类别区分及根spec传递需逐适配器核对 | 同代码异份额/币种/单位、旧基准QDII、多日/汇率案例和真实样本；无证据降级，不预设现有计算双算 |
| R-005/P2 等待可观察性 | 页面解释为什么等待和“无需操作”；修复后API/页面已有last_checked_at，不等于任务健康；下次重试/失联/超期出口仍缺，单次状态最多500期且汇总覆盖需说明 | 显示最近实际检查和调度健康，处理范围/剩余量有说明；界面不要求逐期确认；超时策略先决策，不能自动退款或生成份额 |
| R-006/P2 性能/重复计算 | overview/portfolio重复计值、多处Resource更新、Price历史扫描、import及报表逐事件查询；前端构建两个chunk>500kB | 用已授权合成规模记录query数/延迟、长任务局部失败和UI响应；本轮未跑真实规模，不凭静态热点要求重写框架 |
| R-007/P1 恢复与真实样本 | 初始恢复证据到0006；修复后0012原生小样本恢复及权限/文件/重复补扫通过（§8），核对EvidenceLink/替代完整链、Docker恢复、异地备份/告警与具名机构原生样本仍未核实 | 现版含核对替代、冲突、软删除、Token/私有文件的隔离恢复、角色和重复补扫；无生产恢复/数据修复授权，仍列未完成 |

## 5. 验证与阻塞清单

分类：A必须阻止错误写入；B自动等待/恢复；C原则上提示；D仅在没有风险依据时删除/合并。前端负责及时说明，API负责可信输入/授权，数据库防绕过/并发，职责相似不能按出现次数删除。以下“测试”指已存在并随本轮全量运行，新增诊断另标；提示是当前源代码或已看页面，非每条都做了交互。

| ID/类 | 位置/函数与触发 | 风险/受影响操作 | 当前提示或状态、恢复条件 | 测试与处理 |
| --- | --- | --- | --- | --- |
| V01/A | views.api/dispatch_space、common.get_obj、RLS；无成员/跨space引用 | 任何读写、私账/导出泄露 | 禁止/对象不存在；只能由当前合法授权恢复 | security/admin_access；保留各层 |
| V02/A | admin_access.require_delegation，所有者未授权/撤权 | 管理员代管读取/写入 | 授权代管拒绝；角色身份不替代同意 | consent含重放撤权；保留 |
| V03/A | ledger.post_event、模型stage_key/SourceFact、API幂等 | 重复请求/两扫描/同订单重复入账 | 同请求返回原结果，同键不同内容冲突；不需反复确认 | API/ledger；两连接实测；保留事务+DB |
| V04/A | common.dec、NUMERIC、ledger确认、基金归一化 | 非有限/超精度/币种错/金额份额费用矛盾 | 字段或金额差异错误；正确数据/合理有据尾差再提交 | math/ledger/fund；保留，不改float |
| V05/A | deferred分录平衡/复合租户FK/不可变触发器 | 不平衡、外空间引用、update历史 | DB拒绝；冲正替代而非修改事实 | security/ledger；保留 |
| V06/A | availability/institution_funding、余额/冻结/预留 | 真实资金不足、重复使用冻结资金 | waiting_cash/余额说明；登记真实余额、释放冻结后续扫 | availability/reservations；区分资料缺口，不找别的卡 |
| V07/A | reverse_event、fund_reconciliation._correction_block | 已卖出依赖、退款/确认重复、错误撤销 | 后续交易依赖/差异提示；按依赖链受控更正 | ledger/fund correction；保留 |
| V08/A | fund_reconciliation._occupied_by_other_order/_source_compatibility | 同日同额异订单误归并 | 冲突/候选，用户有依据选择；不能自动消失 | reconciliation/dca matching；保留 |
| V09/A | instrument_metadata/fund_sources身份核验 | 同代码异类别/币种/单位错误NAV | 身份不符/不支持；补正确产品依据 | official fixtures；保留，缓存风险R-004单验 |
| V10/A | API/领域未来实际日期校验 | 预测误写实际 | 日期尚未到达；到期才成事实 | due schedule/ledger；保留，AUD-006读侧另修 |
| V11/A | Resource.version、核对preview digest/revision | 旧表单/旧预览覆盖新数据 | 刷新后重预览；真实变化才失效 | planning/import；保留，AUD-005减少假变化 |
| V12/A→B | market_quality.updated_quarantine，已知同日冲突 | 已知错误价格继续确认/计值 | 同产品同日隔离、前值/缺口；至少2独立发布方同日一致才解除 | quality/AK origin实测；不因只剩单源抹冲突；OD-01受控官方路径 |
| V13/B | dca_automation._process精确NAV日 | 对应NAV未公布/缺失 | 页面“等待正式净值，无需操作”；market refresh+scan唤醒 | exactNAV晚到/后日不替代通过；保留自动等 |
| V14/B | trading_calendar/subscription_calendar未知、未到确认日 | 休市、跨渠道规则未核实 | waiting_calendar/waiting_confirmation；日历/日期到齐后scan | holidays/cutoff/unknownyear；不要仅排周末 |
| V15/B | market_data/fund_sources请求失败 | 本产品资料不可用 | failed/stale/来源错误，不造0；有界请求/下轮重试 | recorded failures、cache；不要求全源健康；真实网络本轮未跑 |
| V16/B | DCA waiting_fee/configuration_required未知fee/一次配置 | 份额不可准确推算 | 计划可保存，已知扣款可记录；补一次计划设置后scan | unknown_fee测试通过；不必逐期补配置 |
| V17/B | ReturnEvidence/_calendar_item缺前值/中间日 | 日收益区间不完整 | amount=null/缺口；历史正式数据补齐重建 | missingday测试通过；不平均摊或显示0 |
| V18/C | provider_policy/credentials，付费源无Token | 没有备用/订阅通道 | unconfigured；使用适用公开源，无需购买才保存计划 | provider/source；保留提示，不设全局硬门槛 |
| V19/C | 单一合格来源且从未有冲突 | 独立验证覆盖少 | 单源状态；不是已发生冲突，来源另示 | compare+quality；正常使用，身份保护不降级 |
| V20/C | notes/description/凭证可空，普通记账 | 非关键资料不全 | 可留空；后续补充，无需阻断 | API/前端基本验证；保留可选 |
| V21/C | 系统推算尚无机构EvidenceLink | 误声称交易真实确认 | “系统推算/未核对”，正常期不要求实际单 | UI实测；AUD-002统一来源标记 |
| V22/C | 已有持仓缺全部旧交易/成本 | 不能算全历史收益 | 可录当前份额；未知历史收益partial，不虚构扣款 | holding/funding；不要为补仓强制全历史 |
| V23/D | 原逐期确认/重复开始日的旧约定 | 让普通自动定投重复操作 | 当前新计划无需再次确认/开始日，页面已验证 | once_v280+API/UI；旧文档明确被替代，不删安全核对 |
| V24/D | repeated same waiting scan details重建 | 没有新的风险/事实仍制造变化 | 用户无新信息；不能用版本冲突让正常预览反复失效 | AUD-005；合并稳定进度更新 |
| V25/B+D | completed计划的paid阶段资格 | 非数据未齐，而是没有再调度 | 永久等待组合已复现；手工确认不是合理默认出口 | AUD-001；修扫描资格而非删NAV校验 |
| V26/A+B | formal Price published_at资格 | 未来公开数据提前计值/不同读函数 | DCA等待，reporting提前用；属于真实不一致 | AUD-006；统一资格，保留日期维度 |

没有发现“必须全部来源同时正常”“缺估值就不处理正式NAV”“只有单源就是冲突”“必须完整历史才能录当前持仓”为当前统一逻辑。它们不能作为已确认缺陷。已知冲突仅隔离对应身份/日期；其他日期和资产继续读。可信官方更正的最小恢复设计见[领域规则§15](../domain-model.md)，明确标为待实现，不能以“官方优先”直接删旧冲突。

## 6. 实际验证、命令与结果

先手算后断言，固定D0=09-28、D1=09-29、D2=09-30、D3=10-01；诊断日历是受控模型，刻意允许该合成日期，不代表国庆真实交易日。网络adapter被禁止。原始日志/JUnit在忽略目录`.runtime/audit-2026-10-09/`，摘要及截图在[evidence](evidence/2026-10-09/results.json)；复制诊断源码和专用运行入口可重新生成结果。

| 实际命令/入口 | 结果 | 环境与限制 |
| --- | --- | --- |
| 私有隔离driver `test --junitxml=../.runtime/audit-2026-10-09/backend-baseline.xml --tb=short` | **1447 passed，12 subtests，504 warnings，136.22秒** | 初始本机55439/wealth_test、同一基线业务源码；driver未提交，等价可复现入口为`audit_local.py test`；warning主要缺静态收集目录等，未隐瞒/删除 |
| `npm test`（frontend） | **152 passed，0失败/跳过** | 已有Node22依赖；不是完整浏览器验收 |
| `npm run build` | 类型检查+生产构建通过，4.39秒 | 大chunk警告，未做加载性能测试 |
| `python -m unittest discover -s scripts -p 'test_*.py' -v` | **5 passed，0.501秒** | 当前可见test_backup用例；不沿用发布说明31项的历史计数，未执行生产备份/恢复 |
| `.venv/bin/python scripts/audit_local.py init` | 专用55441空库0001–0012迁移通过 | 新owner/runtime角色、独立随机配置；首次长Unix socket路径失败，改为短的私有临时目录后成功；不改变系统数据库 |
| `... audit_local.py test audit_scenarios -m audit_invariant --junitxml=../.runtime/audit-2026-10-09/audit-invariants.xml --tb=short` | **14 passed，6 deselected，1 warning，4.42秒** | A/B参数化等；初次新增赎回fixture账户选择错误已纠正，未改预期/业务来全绿 |
| `... audit_local.py test audit_scenarios -m audit_finding --junitxml=../.runtime/audit-2026-10-09/audit-findings.xml --tb=short` | **6 failed，14 deselected，1 warning，1.98秒** | 6个真实差异仍在，退出码1；没有skip/xfail或弱化断言 |
| `... audit_local.py probe concurrency` | 两连接均返回；debit=1，confirm=1，cash=898，shares=100 | PostgreSQL真实分离连接和事务；非SQLite；两扫描不是两次扣款 |
| `... audit_local.py probe restart-prepare`后新进程`restart-recover` | 已扣款无NAV→进程结束→精确NAV补齐→重复scan两次，仍debit/confirm各1、898/100 | 验证进程重载补扫；不是Celery/RabbitMQ故障演练 |
| 普通用户浏览器，本机127.0.0.1:18089 | 登录→持仓→全部定投→保存102、一次无费设置→在途102/待NAV→自动完成100份 | 合成用户/空间，产品confirmdays=0仅为样本；添加Price和调用scan_all由隔离后台驱动，没有声称真实beat自动触发 |
| 公网health及远端只读查询 | 2.11.0/production；默认分支SHA已核对 | 未登录生产、无私有账簿读取/变更，无外部支付 |

便携失败原文见[finding-results.txt](evidence/2026-10-09/finding-results.txt)。只读旧2.8手册的一次设置说明与正常路径相符，但管理员代管说明早于2.9.1的所有者授权；现行授权以领域/接口/代码为准。打包LibreOffice输出12页，检查1–4页出现中文缺字；文本独立提取完整，未将渲染成功等同布局通过，原DOCX哈希前后一致。本轮不改旧手册。

浏览器证据：[等待净值](evidence/2026-10-09/ui-dca-waiting-nav.png)、[自动推算完成](evidence/2026-10-09/ui-dca-auto-completed.png)。页面说明本期来源、等待原因、推算状态；未要求逐期再确认。在后台扫描完成后点“刷新进度”展示结果，未手工确认份额。复核：该按钮对有权限且enabled计划可能发POST run，因此不能把按钮当纯只读；状态GET才是只读。下一次处理时间与真实调度健康尚无完整用户出口。

补充风格/模型/类型检查的准确结果见results.json；未运行项包括真实机构原生导入、目标产品渠道日期链、实际供应方网络探测、当前12迁移恢复、真实broker/worker恢复、完整管理台/贷款/导入页面、浏览器跨时区、负载和生产版本一致性。现有测试数量不能替代这些证据。

## 7. 后续执行与维护

修复批次、依赖、影响文件、验收、回滚和历史数据要求集中在[开发状态](../development-status.md#2026-10-09-系统审查与修复队列)；未决口径在[决策登记](../open-decisions.md#6-2026-10-09-待决策事项)。先B1账单日期，再B2已付期次调度，再B3来源一致，B4正式/估值资格，B5稳定进度和可观察性。任何真实账务更正另需差异预览和明确授权；初始审查未改业务代码，随后授权修复的实际结果见§8。

历史收益重算只重建可再生读模型/投影；原始事件、扣款/到账/创建时间及原始文件保留。先备份验证、按空间预览差异、固定算法与截止修订、幂等重建并记录审计；替代证据不明时留缺口。运行健康、等待定位、安全重试、核对与回滚见[RUNBOOK§8](../RUNBOOK.md#8-定投与收益维护基线2026-10-09)。今后改规则先用[修改影响表](../project-map.md#修改影响表)找调用方和测试，再更新唯一文档位置。

## 8. 授权修复与验收记录

2026-10-09，用户追加“开始根据上述问题来修复”。在原托管隔离分支实施B1→B2→B3→B4→B5；全量回归发现AUD-007后补B0。当日以下内容为初始SHA上的未提交增量，状态是**已有实现、隔离验证通过、未部署**；当时没有生产连接/修订、主分支合并、历史重算或原事实批量更新。初始6项失败原文和results.json保留。后续实际提交、部署与限定生产只读验证见§10及[2.12发布说明](../release-2.12.0.md)，不改写当日证据。

### 8.1 逐项实现与原断言验收

| 问题 | 实现位置（本次工作区行号） | 修复后证据及接口/数据影响 |
| --- | --- | --- |
| AUD-003/P1 | fund_reconciliation.py:41,88,170,386,537,750；FundReconciliation.tsx日期字段/预览 | 可选nav_date有据映射、界限校验、日期差异独立复核、补确认/冲正替代传入；晚确认D1/D2=2/2。旧映射缺新键自动识别，显式空值仍保留。未知成交日不猜、不继承旧日期。解析版本保持1，旧已处理批次不自动重解析；无列迁移/历史update |
| AUD-001/P1 | dca_automation.py:80,342,959；dca-automation.ts和进度页 | completed仅处理已有event期次，不生成新排期/扣款；off/取消/冲正/排除和事实冲突仍阻止。多期、未扣、重复扫描、新进程补扫通过，计划仍completed。scan_all原选所有enabled计划，无需修改tasks |
| AUD-002/P2 | fund_reconciliation.py:362；return_dates.py:6,58；daily_returns/ profit_calendar | 一次批量读取有效完整实际确认id，按份额证据升级；撤销、部分付款不升级；原automatic_estimate和金融事件不动。日历/日收益一致，证据查询不是逐期逐事件N+1 |
| AUD-004/P2 | daily_returns.py:spot；market_quality.py:32 | 当前日参考Price需要真实已知时点且0–20分钟，取数≤10分钟，delayed/stale不能重新变成今日。5分钟有效、21分钟/null/future缺口及正式替换回归通过；只影响估算读侧，不写正式收益事实。产品基准/区间仍未完整建模 |
| AUD-006/P1 | market_quality.py:32,43；DCA/fund_orders/holdings选择器；approved_prices调用方 | 使用同一未来公布过滤，正式收益/计值与扣款后NAV等待一致；pub未知仍null且正式观察可用，未来Price保留到时恢复资格。无删除Price或原账日期变更 |
| AUD-005/P2 | planning.py:625（690后合并）；dca_automation.py:342；DcaPlanAutomationStatus | 生成事实相同保留进度，revision/Occurrence版本稳定；真实现金/配置变化仍推进。新增plan_status/last_checked_at兼容字段，页面标北京时间，不制造下一次重试或任务健康承诺 |

默认回归 [test_audit_repairs_20261009.py](../../backend/tests/test_audit_repairs_20261009.py) 29项：导入原6项测试函数，预期断言没有删除/弱化；新增日期边界/日期单独更正、未知/旧映射、completed多期和off/取消/冲正、有效证据/撤销/部分/N+1、估值过去/未知/未来、正式恢复资格与分阶段、空扫描/现金与金额变化。固定时钟/日历/样本同初始审查，核心测试不访问当天行情。

### 8.2 AUD-007 / P0：重复初始化和ACL-free恢复打开私有清理权限

- 用户症状/风险：已迁移库再次初始化后，runtime可INSERT内部wealth_cleanup_scope，可能伪造清理能力绕过不可变保护。恢复使用--no-acl也丢失私有表及受保护SECURITY DEFINER函数ACL。普通页面直接可利用路径和生产受影响情况未证实；不能把脚本级风险说成已发生数据丢失。
- 预期/实际：普通wealth_app即使设置context flags/private scope也不得取得清理能力。首次修复全套回归1475 passed/1 failed，已有test_administration_v25::test_immutable_and_rls_cannot_be_bypassed_with_context_flags_or_private_scope在第354行发现INSERT不再报DatabaseError。断言保留。
- 复现：隔离库先完成0010–0012迁移，再重复audit_local.py init（内部configure_database重新授权），以非owner runtime运行上述安全测试。初始脚本对ALL TABLES授CRUD，迁移REVOKE不会再次执行，所以安全测试失败。恢复路径亦有同样宽授权，--no-acl还重置函数ACL。
- 位置/根因：scripts/local_dev.py:174的configure_database、scripts/backup.py:362的restore；两处宽授权与迁移0010/0011的私有权限相矛盾。不是RLS本身被关闭，不能通过删除安全断言解决。
- 最小实现：新增[scripts/database_privileges.py](../../scripts/database_privileges.py)维护共用事务授权块，枚举owner公有业务表时排除wealth_cleanup_scope，明确REVOKE PUBLIC/runtime私有表权限；恢复4个已知受保护非trigger函数的非PUBLIC执行权限。local_dev与backup共用，不改变runtime角色、RLS、不可变触发器或清理业务规则。
- 影响：本地重复启动/初始化及备份恢复权限；无业务数据库列迁移、金额/份额/账务变更。其他运维脚本和现存生产ACL仍需只读核实；没有主动修订生产权限。
- 验收：重复init两次后定向安全/管理71项通过，全量1476通过；当前0001–0012原生真实恢复前后private_cleanup_denied=true、受保护非trigger函数非PUBLIC、RLS/不可变和Viewer原件权限均通过。演练对函数ACL新增断言初次误涵盖原trigger函数，改为可直接调用的非trigger函数；没有放松私有表/不可变断言。
- 回滚：保留最小授权策略，不恢复ALL TABLES宽授权；发布前先只读列权限、认证备份和维护窗，再独立授权修订。不会用回退代码删除正确金融事实；无历史数据修复执行。

### 8.3 实跑命令、失败与结果

环境：macOS arm64、Python3.12.3/Django5.2.17、Node22.22.1、PostgreSQL18.6；独立55441、wealth_test/wealth_ui_test及restore专用源/目标库；runtime wealth_app非owner、NOSUPERUSER/NOBYPASSRLS。audit_local不读取仓库.env，行情关闭。解释器为原已安装/锁定依赖；临时前端node_modules链接只为隔离构建，结束移除。

| 命令/实际入口 | 结果 | 边界/证据 |
| --- | --- | --- |
| audit_local.py test audit_scenarios -m audit_finding（修复前） | 原6项再次失败 | 复现后才改代码，初始失败保留 |
| 分批日期/定投定向回归 | 62 passed | B1/B2及既有相关用例 |
| 来源/正式/估值定向回归 | 89 passed、1 deselected | 有意筛选不计为整套；后续默认全套包含对应常规用例 |
| 最后排期/修复/规划定向 | 70 passed | B5与原目标断言 |
| 首次修复全量 | 1475 passed、1 failed、12 subtests，148.10秒 | 发现AUD-007，不掩盖失败；原安全断言未改 |
| audit_local.py init 重复两次 +权限定向 | 71 passed | 新授权策略不重开私有表 |
| audit_local.py test --junitxml=../.runtime/audit-local/repair-backend.xml --tb=short | **1476 passed、253 warnings、12 subtests，145.71秒** | [原始日志](evidence/2026-10-09/repair-backend.log)、[JUnit](evidence/2026-10-09/repair-backend.xml)。warning主要测试静态目录等，未删除 |
| audit_local.py test audit_scenarios --junitxml=../.runtime/audit-local/repair-audit-scenarios.xml --tb=short | **20 passed** | 原14不变量与6缺陷断言全部保留；默认29回归另包含于全量，不把计数重复相加 |
| frontend npm test / npm run build / npm run format:check | **153 passed，0失败/跳过**；类型与构建通过，4.68秒；格式通过 | 大chunk警告保留，没有称加载性能已验 |
| ruff format --check backend scripts；ruff check --select E9,F63,F7,F82 backend scripts | **166文件格式通过；指定规则通过** | 不是宣称所有ruff规则通过；现有未使用import等未顺带改 |
| audit_local.py check；python -m unittest discover -s scripts -p test_*.py -v | 模型check、无迁移差异；**5 passed，0.480秒** | 脚本边界，不拿历史31数量代替 |
| audit_local.py probe concurrency | 双连接、debit/confirm各1，cash898/shares100 | 真PG连接/事务，没有外部支付 |
| audit_local.py probe restart-completed-prepare；新进程restart-recover | 已付待NAV→completed→进程结束→精确NAV/重复scan，debit/confirm各1、898/100 | 新进程补扫；不是真实Celery/RabbitMQ重启 |
| audit_local.py restore-drill | **当前0012原生恢复通过，净资产前后8690；恢复核验1.903秒** | [恢复原始结果](evidence/2026-10-09/repair-restore-drill.json)；认证加密/文件hash、非owner/RLS/不可变/清理ACL/Viewer权限、两次补扫。小样本，不含fund EvidenceLink/替代全链、Docker和生产RPO/RTO |
| 普通用户浏览器127.0.0.1:18091 | 保存102自动扣→等NAV→100份推算→完整CSV一致绑定→正式收益2 | 合成旧100份/现金1000；最终cash898、200份，debit/confirm各1，无再次买入。nav_date列可见。completed由夹具设定，当前编辑页只提供active/paused；NAV和scan由受控后台触发，不称真实beat健康 |

所有本次摘要/源文件哈希与未跑项见[repair-results.json](evidence/2026-10-09/repair-results.json)。本机临时凭证、原始账簿/真实机构文件不入证据目录；样本全部合成。

### 8.4 页面证据与未完成事项

[等待净值](evidence/2026-10-09/repair-ui-waiting.jpg) → [已结束计划的已扣期完成](evidence/2026-10-09/repair-ui-completed.jpg) → [NAV日预览](evidence/2026-10-09/repair-ui-nav-mapping.jpg) → [实际证据绑定](evidence/2026-10-09/repair-ui-reconciled.jpg) → [正式收益2元](evidence/2026-10-09/repair-ui-formal-return.jpg)。对应路径和夹具边界只维护在[browser-verification](../browser-verification.md)。

10月9日该阶段未完成：真实机构/目标产品规则、未知年度/跨时区全页面、完整估值基准/覆盖区间与产品时效策略、已知冲突受控官方更正、等待超期/失联出口、全部管理/贷款/更正页面、真实broker/worker故障、核对替代完整恢复/Docker/规模、生产SHA/ACL/调度/备份健康。生产运行和限定保护后来补验见§10，其余缺口保留。持仓汇总列仍叫“今日估算收益”但正式明细带日期/正式标签，跨页面指标命名未全面调整；不能宣称所有收益展示已统一。

下一步按[开发队列B6/B7与剩余范围](../development-status.md#2026-10-09-系统审查与修复队列)推进；新口径先有产品/来源证据，历史修复先差异预览，部署另核对源码/产物/SHA、备份及回滚。不是把未经复现的检查项宣布为缺陷，也不是把修复代码存在等同生产已经恢复。


## 9. 用户追加的展示优化与部署授权

用户在审计修复后明确要求优化处理提示与点击定位、日期倒序、侧栏铜钱娱乐，并授权验收后部署。2.12候选包含前阶段修复及UX-001～004；实际范围和最新验证集中在[发布说明](../release-2.12.0.md)、[开发状态](../development-status.md)、[接口§25](../api-contract.md)。本节不改写初始失败证据。

真实页面检查另发现新增核对默认值被StrictMode/clearOnDestroy清理，已修复挂载初始化并验证账户/CNY/日期/口径，未移除任何保存校验。净值收益、资金、权限规则继续使用前述唯一维护位置。10月9日公开health为2.11.0，SSH拒绝；当日未执行生产发布、账务修订、历史重算或ACL更改。后续访问已解决，实际发布见下节。

## 10. 2026-10-10 最终验收与保数据部署

本次按用户追加授权完成部署，冻结应用c99d3b35bc82e38cb52559333a30e7f86e527605，实际镜像c9fffa59a720f3e972b3b3460cfa512551012a4cda9ebcc85c0a16217685fa94；08:13:25（北京时间）最终验收通过。未合并主分支或覆盖原工作区/既有手册。源包、实跑命令、原始日志、截图、备份与剩余范围唯一入口为[2.12发布说明](../release-2.12.0.md)和[最终结果](evidence/2026-10-10/ux-deployment-results.json)。10月9日候选证据保持原样，旧1495结果没有复用为最终1498通过。

### 10.1 UX-005 / P2：旧首页投影遗漏修正入口所需对象

- 症状与预期：同日/同修订升级后，首页待核对/余额等待仍返回旧缓存的泛化提示及缺少账户/产品ID，准确修正入口不能定位。预期返回原期次的扣款账户、持仓账户、产品和实际原因，Viewer查询保持只读；这不等于发生金额错误。
- 复现：按已部署2.11提交0103fc8的真实旧todo形状构造 `Projection.payload`（`account-equity-v24`），与当前空间revision/当日一致；分别设置waiting_cash和needs_review；普通Viewer两次GET overview。新测试修复前3失败：两个account_id为None，一个版本仍为v24。原失败只在工具输出，没有伪造原始日志文件。
- 位置与根因：`backend/wealth/reporting.py:23,515`仍输出旧计算版本，`backend/wealth/views.py:930`的 `dispatch_space` overview分支接收同版本旧缓存；任务的get_or_create也不会覆盖同修订投影。新待办结构改变而缓存版本没同步，不能依靠用户写账或等次日刷新。
- 最小修复：reporting唯一常量改v25，生产者和缓存读取者共用。旧缓存只读绕过、现算本版响应；当前v25缓存仍cached=true。没有删除投影、批量更新历史、修改任务或账务修订。
- 影响与回归：仅overview响应/缓存兼容，无列迁移、金额或原始流水变化；默认[缓存回归](../../backend/tests/test_overview_projection_version.py)第120/169行共3项覆盖两等待状态、旧行不改、连续GET、精确对象/原因、SQL写入拒绝及完整前后状态相同。缓存/期次导航/jobs专项20通过，全部进入最终1498。
- 验收与回滚：同日同revision旧v24缓存存在时，返回v25正确对象和原因，旧Projection内容完全不变；v25缓存继续使用，Viewer无写入。回滚评估响应与前端兼容，保留所有原始记录，不以删除旧投影或重置修订为回滚步骤。状态：已修复、隔离及最终镜像验证、已部署；没有历史数据修复需求。

### 10.2 发布证据与新增覆盖边界

Ubuntu24.04/Python3.13.16服务器独立候选库：关键459、完整1498及12子测试（375.73秒）通过，无skip；独立前端178及类型/格式/构建通过，发布安全工具51。实际页面完成准确扣款账户核对入口、说明按需、最近/未来日历、待办倒序、六轮卦象/键盘/重置与新增账户默认值；均为隔离合成普通用户。

停写后服务器加密备份、本地副本均认证，恢复应用前40表、4会话、11序列、数据库保护和文件指纹完全一致；schema0012不变。五项服务健康/0重启、worker响应、单一beat、每日备份及证书续期正常。14次生产只读空间GET（含4个定投状态）、来源目录和21公网文件核验通过。当前runtime非owner/无superuser/bypass，tenant表强制RLS、immutable触发器及私有清理表拒绝已核实；未全面枚举全部函数ACL。

生产验证没有登录/造交易/改权限/恢复/重算或重开禁用计划、来源，启动后的正常任务合法更新继续运行。当前空间已授权代管，未授权管理员拒绝分支生产实际0次，不虚构样本；候选隔离权限回归保留。来源目录验收没有联网拉行情，不证明真实来源全部可用。备份认证不等于本次生产恢复演练，快照实际私有文件0；完整核对替代恢复、规模/RPO/RTO、故障注入、跨时区/真实机构/完整估算基准及实际减少动画偏好仍待验证，原R/OD未完成项没有因上线而关闭。

初次服务器关键套件误引用不存在的v212文件，失败发生在停生产前；修为实际v211套件并增加启动前路径验证。旧d959844候选完整1495虽通过，发现UX-005后重新冻结c99并重建/全量1498；初始工具失败、被替代证据及10月9日SSH失败均保留。没有删除业务断言或跳过用例。


## 11. 2026-10-12 首页今日估算收益专项排查

本次针对用户指出的首页估值收益不生效/不显示。main为 `f2b0b87ac72a95cce5cb46f6a8a41670b128d7b9`，线上实际2.14.0，镜像 `sha256:5e769074c72847d97a3534e43bbb371dedf436891bb0489bf36ab657c1fc92cf`；daily_returns/market_sync/market_data/fund_sources/market_quality/portfolio共6财务文件与main逐字节相同。2.13–2.14为聊天增量；当前net-worth-comparison实时计算，不套用2.12旧overview Projection问题。未改业务代码、默认回归、生产配置或触发手工刷新/登录/会话、交易、迁移、重算、部署。

### 11.1 实际只读观察

12:23:41、12:26:15、12:29:16（北京时间）读取现有所有者授权空间；事务强制READ ONLY，最后一次以普通owner身份调用真实GET net-worth-comparison，并使用REPEATABLE READ保证一次API响应快照一致。前两次为read-committed诊断，正常后台可在不同查询之间更新。web/worker/beat同一现版镜像且healthy；行情与盘中来源启用，没有给私账新增代管授权。

- 首次8项只有1项可算，为无已记录持仓账户的零收益推算；7只基金无有效今日收益。5只本次来源返回没有GSZ/GZTIME及reference Price，保留较早正式NAV：这是观测到的覆盖缺口，不断言永久不支持或5项代码缺陷。只提供正式NAV的官方/SDK源不能制造盘中值。
- 产品A有今日估值，但12:15刷新ready仍引用12:05的获取时刻，12:23超过10分钟门槛而失效。产品B虽较新获取，报价停在11:30，触发20分钟报价时效。未发现对应净值冲突。
- 无手工刷新，12:25自然更新后A恢复estimated；12:29真实首页API200，known_count=2/total_count=8、known_amount有非零值，完整amount仍null。部分汇总保护正确，其余缺口没有按零凑总额。
- 首页helper对partial显示known_amount，收益卡没有专门隐藏开关；金额遮挡会显示圆点，comparison每60秒重读。缺口原因在“收益明细”。没有登录用户实际浏览器，不能声称排除了其遮挡、旧响应、日期/币种选择或资源错误。

原始诊断不输出余额/份额/收益数额、账号/空间身份或凭证；含私人持仓映射的观测只保存在主工作区ignored `.runtime/estimate-diagnosis-20261012/`，不入公共Git。可共享摘要与合成复现见[本批证据](evidence/2026-10-12/estimate-diagnosis-results.json)。

### 11.2 EST-001 / P1：正常刷新与缓存叠加造成间歇性失效

症状/预期：有持续更新的盘中来源，ready之后当日收益仍消失，后续轮次才恢复；预期健康周期处理衔接有效数据，真正旧/未知/未来报价依旧拒绝，真实获取/报价时刻不可改写。

位置与根因：`config/settings.py:165`为300秒beat；`wealth/market_sync.py:27,538` INTERVAL/refresh_due按上次worker开始判300秒到期；`wealth/fund_sources.py:47,75`缓存600秒；`market_sync.py:497`保存原quote.fetched_at；`daily_returns.py:379`获取超过600秒拒绝。任务启动偏差、相同扫描粒度和缓存寿命形成间隙，不是外部扣款/确认失败。

固定时钟复现真实refresh_due→refresh_one→provider缓存→Price→daily_return：t0 worker晚0.2秒；beat t300距last_attempt只有299.8秒而跳过；beat t599.8 worker在t600取得年龄599.8秒的缓存，ready但fetched_at仍t0.2；t620收益null；beat t899.8再跳过，t1199.8重新取数后恢复合成2元。Event/JournalLine/PositionMovement全文前后相同。

最小任务：协调盘中缓存TTL、扫描频率/到期锚点与读取有效期，留出worker/网络耗时裕度，可按盘中/正式操作区分缓存寿命。不能只把fetched_at改成现在，不能删除时效、未来时间、币种或冲突保护，也不重新启用用户关闭的来源。实现细节须独立修复及验收后确定。

影响/验收/回滚：无历史账务修复或迁移，保持接口；若新增命中/真实获取时刻仅为兼容可观察字段。旧Price保留。诊断6项修复后全通过并转默认回归，增加恒价新tick、重复/并发、失联恢复、disabled及正式替代；回退只退行情实现/适用配置，不删价格或恢复旧流水。当前已复现、未修复/部署。

### 11.3 EST-002 / P2：提示与原因入口不足

`investments._calendar_item`在当天既无reference又无正式价时泛称“缺少正式价格”，即使较早正式NAV存在；DailyReturnCard仅在抽屉逐项显示message。用户难分暂无盘中估值、过期、基准缺口。最小任务为准确缺口类型与行情详情入口、partial明确已知部分及覆盖，保持null、不将累计持有收益/过去NAV收益/本金填今日。需要实际普通用户交互验收；本轮未改页面。

午间/收盘停更与“最新带时间估算”展示属于EST-003及既有OD-05待决；须产品/来源/交易时段依据，不能推定所有基金同规则或简单放大20分钟门槛。正式收益继续归原净值日，不用另一条最新NAV乘未知基准涨幅补数。规则唯一维护在领域模型§14。

### 11.4 实跑、失败与范围

隔离分支 `codex/estimate-return-diagnosis-20261012`，macOS arm64/Python3.12.3/PostgreSQL18.6（55443、wealth_test迁移0015，行情禁用）/Node22.22.1；主工作区/既有手册不改。持久化链用非owner合成库，无真实网络。

- [固定时钟诊断](../../backend/audit_scenarios/test_estimate_refresh_cadence_20261012.py)：6项中2业务预期失败、4性质/控制通过，0.45秒，无xfail/skip。通过项为599.8秒保留真时间、600秒精确过期、零worker偏差及新获取35分钟前报价仍拒绝；默认testpaths不收集诊断，不冒充默认绿色。原日志[保留](evidence/2026-10-12/cadence-20261012.log)。
- 命令：`/Volumes/mi/Wealth/.venv/bin/python scripts/audit_local.py --pg-port 55443 --web-port 18093 test audit_scenarios/test_estimate_refresh_cadence_20261012.py -o addopts='' -vv -s`。
- 同一隔离入口运行既有 `test_today_estimate_requires_observation_time_even_after_fresh_fetch` 与 `test_public_cache_ttl_does_not_cache_user_labels_or_rewrite_fetch_time`：5 passed，1.47秒，0 skip，原保护保留。
- `node --experimental-strip-types --test frontend/tests/daily-return.test.mjs`：现有5项通过。另调用真实dailyReturnDisplay的5个合成场景通过（1/8零、2/8合成非零、全缺数、完整估算、正式），3项遮挡/原因位置仅静态检查；未mount React或操作生产浏览器。
- 初次诊断脚本容器路径错误在读业务数据前失败，修正后继续；不是应用业务失败。未跑本轮完整1598回归、真实外部适配器网络验证、全页面、历史重算或部署。

后续批次及验收见[开发状态](../development-status.md#2026-10-12-首页估算收益排查有诊断未修复)，影响范围按[项目地图](../project-map.md#修改影响表)及现行规则定位；提出方案不代表已修复。

## 12. 2026-10-13 估值与收益一致性修复

用户授权开始修改并检查其他相关问题后，在`codex/estimate-return-diagnosis-20261012`从诊断提交`1459c78`继续实现2.14.1候选。§11保留2026-10-12当时的线上2.14.0观察、原2失败/4通过及未修复状态，不回写为当时已通过。以下保留候选实现与阶段验证，**最终冻结、Linux完整回归及部署结果见§12.4**；尚无本批生产历史数据修复、迁移或原始账务变更。部署前2026-10-13 12:45:55（北京时间）只读核实生产为2.14.0、镜像`5e769074…`、schema0015。

### 12.1 发现、复现与最小修复

表中测试均使用固定时钟、受控交易日历及合成价格/账簿，不依赖当天网络；代码位置以函数名为稳定入口。金额仅为合成断言，不包含真实持仓。

| 编号 / 优先级 | 用户症状、实际与预期 / 根因位置 | 可复现输入与最小实现 | 回归入口与验收 |
| --- | --- | --- | --- |
| EST-001 / P1 | 健康刷新仍暂时撤下今日收益；5分钟beat与worker起点比较错过扫描，600秒缓存撞上600秒fetch有效期。`settings`、`fund_sources._data_cache_ttl`、`market_sync._refresh_is_due/refresh_due` | §11.2的0.2秒worker偏差和599.8秒缓存样本。盘中TTL60秒、正式/历史600秒；scan60秒、单产品300秒；正常请求锚点、旧/无效锚点回退真实尝试，锁内复查到期和租约 | `test_estimate_refresh_cadence.py`：正常来源连续可算，恒价新tick可更新；并发/队列/失联重试不重复提交；35分钟旧报价、停用仍拒绝；Event/JournalLine/PositionMovement不变 |
| EST-002 / P2 | 有较早NAV却泛称“缺少正式价格”，partial或待更新没有直接说明和出口。`investments._calendar_item`、`daily_returns.spot`、`DailyReturnCard/HoldingsOverview` | 无今日estimate但前日正式收益可算；部分可算且known_amount=0；正式NAV配自动推算份额。新增缺口码/精确message、摘要与真实对象路由，条目覆盖和原币/折算标签；较早收益只带原日期显示 | `test_estimate_availability_20261013.py`及前端daily-return/business-action/holding-display：缺口不造0，金额隐藏保留；页面须点击到对应行情/规则/交易/核对/汇率，错误对象不能跳到另一对象 |
| EST-004 / P1 | 日收益已正式、持仓/净资产却仍用同日旧估值。`investments`持仓价格选择与`portfolio`共用读链 | 10份、基准10、同日参考12/正式11，交换写入顺序；同日持仓与估算净资产均110，reference_delta=0。次日参考13应仍显示130；选择正式价格优先仅限同日 | `test_portfolio::test_formal_nav_supersedes_same_day_estimate_in_holdings_and_wealth`；首页/持仓/配置一致，三条Price全保留，次日估值不被旧NAV遮蔽 |
| EST-005 / P1 | 缺折算FX把有效原币日收益一并隐藏。`daily_returns.ReturnEvidence.convert`、`holdingDailyAmount/holdingLatestReturnAmount` | 原币收益10、显示币种无FX或FX已8日；`native_status/native_message`保留原资格、amount=10而base_amount=null，汇总留缺口；补当日1.2汇率后折算12。最近正式收益同时补齐scope_unconfirmed保护 | `test_estimate_availability_20261013::test_missing_or_old_fx_preserves_native_return_without_filling_total`、holding-display回归；原币可见但不得凑完整总额，范围待核实不能借最近正式值绕过 |
| EST-006 / P1 | 日历与首页对机构权益的外部资金/缺中间交易日处理不同，资金转入可被误当收益。`investments.profit_calendar`、`daily_returns.ReturnEvidence.snapshot` | 权益1000→1100并收入/转入100应收益0，股息100仍收益100；正式快照跨缺失开放日为空、仅跨休市可算；日历复用同一ReturnEvidence及EXTERNAL_FLOWS，仅采正式结算 | `test_return_calendar_consistency.py`：income/expense/refund/transfer/fx净资本剔除，分红保留；日历与首页同口径；仅盘中权益不进正式日历，不改Snapshot或原流水 |
| EST-007 / P1 | 无关产品股息改变机构账户日历结果。`investments.profit_calendar`股息循环覆盖函数的account_id/instrument_id筛选参数 | 选机构账户，有另一账户产品分红；循环身份改用独立局部变量，保留请求筛选 | `test_unrelated_product_dividend_does_not_change_snapshot_account_filter`：返回仅所选机构账户，合成5元收益不变，其他产品不混入 |
| EST-008 / P1 | 日历可沿用过旧FX，首页已经提示缺FX，同日同币种结果矛盾。日历`converted_item`与`ReturnEvidence.convert` | 收益日的FX年龄7日可用、8日不可用，未来FX不能用；统一日收益FX边界，保留原币金额；已实现并通过最终镜像回归 | `test_return_calendar_consistency::test_calendar_and_home_share_dated_fx_coverage`及原币FX回归；同日期币种一致，缺FX时汇总amount/base_amount留空，不改FxRate |
| EST-009 / P1 | 新鲜子估值被较老正式源fetch拖失效，或不同tick借主报价新fetch续期。`daily_returns.ReturnEvidence.spot`报价身份绑定 | 650秒旧正式源+新鲜子估值；仅类型、code/currency/source/economic_date/value/published_at严格匹配选用Price时用子fetched_at。有quote但不匹配返回quote_metadata_mismatch；旧无quote状态保守兼容 | `test_fresh_intraday_uses_own_fetch_time_not_other_nav_source`、`test_unrelated_quote_cannot_lend_its_fresh_fetch_time`：正确新估值可算；任一身份/tick不匹配等待对应证据，不改Price时间、不借主fetch、原600/1200秒保护保留 |

EST-003/OD-05仍是待决政策：午休/收盘后是否另展示“最新带时间估算”须产品、来源和时段依据，不在本批放宽时效。§11中5只基金缺盘中数据为当时来源覆盖观察，不宣称永久不支持、不推定为5个代码缺陷，也不通过打开用户停用来源凑数。

### 12.2 接口、数据影响与回滚边界

兼容增加`missing_reason_code/native_status/native_message/fetched_at`，保留旧状态枚举、原币amount和折算base_amount语义；已知部分只汇总有效折算项。每日收益、持仓、净资产和日历是读结果，本批不新增迁移、不改Event/JournalLine/PositionMovement/SourceRecord.raw、机构快照或历史Price；正式同日替代不删除旧估值。overview计算版本升级v26，只读拒绝旧v24/v25缓存，GET不写Projection或提高账簿修订。

回滚按应用/读算法及缓存版本兼容执行，保留已发生的正确行情与账务事实；不得为了撤销展示差异恢复旧库覆盖新数据。本次应用与前一镜像、备份和配置已冻结核验，实际发布结果见§12.4；后续回滚仍须保留这些证据。若后续需要修历史收益投影，须先逐空间/日期差异预览、核验原事实不变、备份、幂等重建和审计；本批没有执行该操作。权限、身份/币种、重复记账、冲突隔离与用户关闭偏好均保留。

### 12.3 验证状态与维护入口

- 已执行阶段：前端196项全部通过，TypeScript、所改文件格式、构建通过（仅已有大包警告）；本地完整后端1676项及12项子测试通过，0跳过、224.05秒。之后追加严格报价元数据匹配与核对导航，最终Linux镜像结果见§12.4，不把此阶段数替换成最终数。此前106项及93项为定向组合，不相加、不冒充最终完整回归。阶段测试输出由本批最终验收汇集；诊断旧失败日志继续保留在`evidence/2026-10-12/`。
- 已完成合成owner浏览器：CNY部分收益+2、1/3项可算及缺数原因；USD原币+2未填入CNY总额；首页明细到汇率、首页/持仓到正确基金行情；隐藏后明细无金融内容。测试中重建曾导致一次旧chunk 404，重启隔离web并reload后完成，不能声称首次无异常；没有以此代表生产浏览器。
- 最终应用、Linux回归、模型边界、备份和运行核验见§12.4。最后核对导航改动已有前端回归，额外浏览器交互尚未记录；不以其他入口通过替代。未以服务测试代替页面验收。
- 未扩张范围：真实机构样本、全部QDII跨市场时段、真实上游适配网络、运行规模、生产恢复/历史修复、EST-003产品时效策略。只有当前可复现输入支持的缺陷进入本批。

规则只维护[领域模型§14](../domain-model.md#14-指标字典估算与缺失)；接口见[api-contract§21](../api-contract.md#21-每日收益与持仓展示现行)；改动影响和回归选取见[项目地图](../project-map.md#修改影响表)；排障及安全重试见[RUNBOOK§8.7](../RUNBOOK.md#87-估值不显示与跨页面收益差异2141)；状态和最终发布信息见[开发状态](../development-status.md)与[2.14.1记录](../release-2.14.1.md)。


### 12.4 最终冻结与保数据部署

2026-10-13 13:13:04（北京时间）已完成2.14.1部署。应用`2abad9f8d26fb14607e51bcde42c016512c30770`，镜像`sha256:c2fcb778b51ed59c19f33b9e005c41080ea212ca7f21364bee4e39e387d0f9a5`，schema`0015_chat_remote_controls`。冻结镜像Linux完整后端1679项及12项子测试通过，0跳过；前端196项及类型、格式、归档源码重建通过。本地1676+12及106/93仍是前述阶段证据，没有作为最终镜像总数使用。

停写切换前后44张既有表、会话、私有文件、schema和权限指纹一致；服务器备份认证通过，本机副本哈希一致。没有执行生产迁移、数据重置或历史账务修复。web/worker/beat运行同一验收镜像，五项服务健康，备份与证书续期计时器active；可信HTTPS及23个前端资源字节与冻结构建一致。2026-10-13 13:13:16（北京时间）强制只读核验1个既有授权空间的真实首页接口，均返回200；未登录、创建会话、触发手工行情刷新或输出金融数值。

最后核对导航改动已有前端回归，额外浏览器交互尚未记录；不以其他入口通过替代。合成页面范围和测试异常保留于§12.3，截图见[合成首页截图](evidence/2026-10-13/estimate-return-home.png)、[合成明细截图](evidence/2026-10-13/estimate-return-details.png)；不声称生产浏览器或未完成场景已验收。集中结果见[最终证据](evidence/2026-10-13/final-results.json)，原始候选全量输出见[完整后端日志](evidence/2026-10-13/backend-full.log)。EST-003、真实来源覆盖、全部产品规则和恢复演练等剩余范围继续保留。


## 13. 2026-10-13 定投补足与海外参考估值（2.14.2）

此次从已部署2.14.1后文档提交952af3f继续；用户追加授权：明确选择不足资金来源、继续查5只海外指数基金的备用估值、参考基估宝日期与收益处理并部署。详细变更、验收及部署状态统一维护于[2.14.2发布记录](../release-2.14.2.md)，不把上文2.14.1验收数字当作本次证据。

| 发现 | 已确认事实/根因 | 最小处理与验收 |
| --- | --- | --- |
| FUND-001 P1 | 4个到期期次没有扣款，主账户缺可用现金，计划原结构没有明确备用账户/生效范围。不是银行实际扣款失败 | 增可选来源+明确日期；同空间同币种现金，原子补差+扣款；无资金继续等待；新测试top_up_v2142及双连接probe证明不重复 |
| FUND-002 P2 | 等待事项原主入口只有核对余额，没有资金配置入口；状态包装可能盖掉具体等待原因 | 首页/期次直达精确计划资金设置，保留核对次入口；错误reason结构化；合成UI验默认仅今日和明确历史范围 |
| EST-010 P1 | 最新响应有GSZ而NAV字段缺失时，正式历史回退丢掉独立估值 | 分开保留真实估值观察和正式历史；不能提升估值为正式价格；固定样本10例通过 |
| EST-011 数据能力 | 首轮主源GSZ为空，官方仅NAV；用户提供开源新线索后，新浪实际五只均有夜间参考。017641/270042数值与05:04时间吻合截图 | 接入可靠身份/时点/基准的独立参考，不参与NAV仲裁或写Price；开源源码研究不复制授权受限代码 |
| EST-012 P1/P2 | 原“今日”20分钟盘中资格不适合直接表达海外上一时段待公布参考，但放宽原规则会错移经济日期 | 追加只读最近基金收益更新；稳定历史份额和匹配基准才算区间额，正式新NAV使旧窗口失效；不把公布时间写成收益归属日，不混入今日汇总 |

范围边界：正式收益归属和原始流水仍保留；没有生产账户代选、历史重算或数据库迁移。首次全量因被中断并发fixture遗留测试元数据而13失败，保留失败日志；全新隔离库阶段1721+12子测试通过。随后新增新浪/最近更新功能须以最终冻结日志另验。原金融权限、余额、产品身份、冲突与关闭来源保护不移除。当前普通用户交互为本地合成owner，不冒充生产用户浏览器验收。

### 13.1 最终验收与部署

2026-10-13 19:34:36（北京时间）2.14.2部署完成，应用`71f322456e8f64651bfc6b8d1da6e3599eece586`，Linux1791项及12子测试、前端214项通过。保数据切换、源码/镜像绑定及原始失败日志见[2.14.2发布记录](../release-2.14.2.md)与[最终证据](evidence/2026-10-13/estimate-funding-2142/final-results.json)。合成浏览器已验补足日期范围、一次扣款、海外区间−0.48转晚到正式+0.49、保留原收益日、隐藏和定位；不是生产账务写入验收。

### 13.2 2026-10-13 发布后EST-012

2.14.2线上自然刷新后，五只QDII的参考base随正式NAV更新，旧05:04点未变。拒绝旧点/新base正确，但等日期等净值分支未显示已有正式收益，属已复现P1读侧缺陷。强制只读API核验五只正式结果均可计算、归属10/12，未读取输出用户金额/份额；本地合成页面也复现“待补全”。在2.14.3小批次修复，详见[发布记录](../release-2.14.3.md)和[修复前只读证据](evidence/2026-10-13/estimate-formal-2143/pre-fix-readonly.json)。初次诊断脚本误从summary.items读取`latest_confirmed_return`，返回空；已改为该层实际的`latest_formal_return`重跑，原错误输出留在隔离runtime，不据其宣称缺少正式收益。

EST-012最终状态：2.14.3已于2026-10-13 20:06:07（北京时间）保数据部署，应用`8f538c3a88afb4bff5e76ea6e5ce4e0c4d3dfb27`、镜像`sha256:9f4ca6be7bbb75b123654a7bde0145a81aca50ab09ea528f9222662d8a1b912c`，schema仍为`0015_chat_remote_controls`。本地及Linux冻结镜像各1807项和12子测试通过、0跳过。 原账务、会话和文件指纹保留，详细验收见[2.14.3发布记录](../release-2.14.3.md)。
