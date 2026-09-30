# 开源底座源码适配审计

审计日期：2026-09-16。范围：Wealthfolio 与 Sure；面向多个独立用户/家庭的电脑网页端，境内资产、港美股及外币，账单来源包含喵喵记账、支付宝、微信、广发期货、银河期货、广发基金、易方达基金。基金需覆盖定投、红利低波相关产品和用户提到的 T+2 QDII 流程。

## 1. 结论

1. **Wealthfolio 适合参考投资核算、期权活动和资产页面，也值得做单家庭验证；不适合不改核心就作为共享实例的多家庭产品底座。** 当前 Web 身份认证是同一账本的访问门禁：固定 JWT subject、全局服务和单一 SQLite 数据库，没有家庭数据作用域。OIDC 允许多人登录不代表财务数据隔离。
2. **Sure 是仍值得保留的多家庭 Web fork 候选。** 已有真实 Family、账户所有者、同家庭共享权限、按家庭/账户范围查询、PostgreSQL、后台任务、导入、对账和收支框架。应当用实测决定是否复用，不能因为偏好 Python 或 React 就直接淘汰。
3. **两者均未在本次审计中证明能直接满足“多源凭证归并 + 可审计会计总账 + 中国基金确认 + 国内期货期权结算”。** Wealthfolio 的期权和收益模型更深，但多租户要跨层改造；Sure 的多用户和日常财务更贴近，投资核心及原始来源链需要较多补充。
4. **当前设计基线采用自建模块化单体；Sure fork 保留为 G0 阶段可以推翻该基线的比较项。** 原因是本需求要统一多空间隔离、来源证据、账务核心、基金确认和机构结算投影；若 fork 需同时替换这些关键领域及关联报表，净节省可能有限。这是核心模型适配判断，不是技术栈偏好。建议以同一组 PoC 和改造范围估算复核；本次未执行 PoC，也未证明自建性能、实现正确性或实际工期。
5. React/TypeScript + Django/DRF + PostgreSQL 可以作为自建候选，RLS、Decimal、持久化任务和对象存储应由产品要求推导。**换技术栈本身并不会自动得到正确账务或隔离。** 若团队能维护 Rails，Sure fork 的现成界面、权限与流程有实际价值。

## 2. 证据口径与版本

本次通过 GitHub 官方仓库、官方文档、GitHub release API 和只读浅克隆检查。未安装依赖、启动项目、执行其脚本、导入真实金融数据或运行测试。源码放在独立临时目录；本工作区仅写本研究文件。

| 项目 | 审计源码基准 | 最近稳定版（查询时） | 许可证 |
|---|---|---|---|
| Wealthfolio | [13e4de49aea71a6a9a07501c357babc3516c7f7f](https://github.com/wealthfolio/wealthfolio/commit/13e4de49aea71a6a9a07501c357babc3516c7f7f)，提交时间 2026-09-15T14:12:17-04:00 | [v3.8.0](https://github.com/wealthfolio/wealthfolio/releases/tag/v3.8.0)，发布时间 2026-09-07T12:52:48Z | [AGPL-3.0](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/LICENSE) |
| Sure | [f3595a74521cf681b9d12f454104739ba3732d5f](https://github.com/we-promise/sure/commit/f3595a74521cf681b9d12f454104739ba3732d5f)，提交时间 2026-09-16T00:17:00-07:00 | [v0.7.4](https://github.com/we-promise/sure/releases/tag/v0.7.4)，发布时间 2026-08-31T04:57:15Z | [AGPL-3.0](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/LICENSE) |

**下面源码发现针对指定 main 提交，不保证已经进入上列稳定版。** Sure HEAD 已在 v0.7.5 的开发周期；验证时要选择固定版本重做必要检查，不能混用 main 文档、稳定版镜像和不同版本数据库。

证据标签：

- **文档宣称**：作者说明了能力；尚未执行。
- **源码确认**：在本次固定提交读到数据结构或明确逻辑；不等于端到端正确。
- **未验证/未发现**：本次限定范围未证实；不代表整个项目绝对没有，需样本与运行验证。

## 3. Wealthfolio 审计

### 3.1 PC Web 与租户边界：明确的结构性差距

**文档宣称：** React 前端、Rust 后端，支持桌面及 Docker/Web；可密码登录和 OIDC。[固定版 README](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/README.md)

**源码确认：**

- [Web auth](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/apps/server/src/auth.rs#L228)：签发 JWT 时 `sub` 固定为 `wealthfolio-web`。session id 用于会话/备份任务边界，并不是用户账本标识。
- [Accounts API](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/apps/server/src/api/accounts.rs#L23)：列表调用全局 `state.account_service.get_all_accounts()` 或 `get_non_archived_accounts()`；创建、更新、删除接口也没有当前家庭参数。
- [AppState](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/apps/server/src/main_lib.rs#L73)：账户、持仓、估值、收益、设置、基础币种等作为共享服务注入。
- [SQLite schema](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/storage-sqlite/src/schema.rs#L3)：accounts、activities 没有 tenant_id/family_id/user_id；活动通过 account_id 关联账本账户。
- [OIDC 实现](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/apps/server/src/oidc.rs)：身份提供方 allowlist 控制是否能进入实例；它不能替代业务对象的数据作用域。

**适配含义：** 独立实例/数据库可以隔离不同家庭，但要另建租户路由、实例运维、备份恢复、升级和家庭成员权限。若要共享数据库式 SaaS，则必须改认证、schema、全部查询/写入、缓存、设置、导出、后台任务及插件数据访问；不能只加一列 tenant_id 或装 OIDC。对于首版就多独立用户/家庭的需求，插件无法补齐这条核心边界。

### 3.2 投资账与会计总账

**源码确认：** Activity 不是只有“日期金额备注”的轻量记录。它有活动类型、子类型、状态、交易/结算时间、数量、价格、费用、税、币种、汇率、source_system、source_record_id、source_group_id、idempotency_key、import_run_id 和 needs_review。[Activity 模型](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/activities/activities_model.rs#L134)、[schema](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/storage-sqlite/src/schema.rs#L24)

活动被编译/解释为现金、头寸和收益影响；经济事件层区分交易、收入、费用、税、内外部转移，以及成本依据完整度。这是值得借鉴的结构。[economic_events.rs](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/portfolio/economic_events.rs#L16)

**边界：** 本次读到的是投资 Activity + lot + snapshot/valuation 模型，未看到满足本需求的“凭证头—多条分录—按币种借贷平衡—冲销—来源修订”的总账实现。不能因存在经济事件、TRANSFER_IN/OUT 或 cash effect 就直接称为完整复式会计总账。要么显式扩展核心，要么由外部总账服务作为唯一权威，再把结果投影给它；后者会引入两套模型的一致性成本。

### 3.3 导入、幂等与中国账单归并

**文档宣称：** CSV 五步导入向导，保存字段映射、预览、标记重复；支持现金账户文件。[官方 CSV 说明](https://wealthfolio.app/docs/guide/csv-import/)

**源码确认：**

- schema 已有 import_runs、活动来源和审核标记，具有导入审计的基础，不需要从完全空白开始。
- [idempotency.rs](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/activities/idempotency.rs#L10) 用账户、活动类型、日期、标的、数量、价格、金额、币种、来源引用、备注及非零费用生成语义摘要；日期规范化到日，会忽略时分秒。
- 数据库对非空活动幂等键建立唯一索引。[migration](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/storage-sqlite/migrations/2026-01-01-000000_refactor_asset_model/up.sql#L638)
- 插件 API 暴露 `activities.checkImport/import/saveMany`，有保存映射接口；存在按插件隔离的持久化键值存储。[SDK](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/packages/addon-sdk/src/host-api.ts#L169)

**适配含义：** 可以做喵喵/微信/支付宝的格式转换插件，但不能把现有语义摘要等同于跨来源归并。银行、支付平台、记账软件对同一消费可能有不同名称、时间、引用号；相反，同账户同一天两笔相同金额消费可能完全合法。需要在现有 Activity 之前增加“原始文件—原始行—标准化观察记录—候选匹配—确认的经济事件”的关系，保留多份证据且允许撤销关联。

**未验证：** 没有针对用户列出的五家金融机构/软件及支付账单的样本适配证据；文件编码、Excel/PDF格式、退款、红包/优惠、收支不计、银行卡代扣、重复导出均需实际样本。

### 3.4 计划、确认和实际收益

**源码确认：**

- Activity 状态有 Posted、Pending、Draft、Void；主要已入账活动查询按 POSTED 过滤。[状态模型](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/activities/activities_model.rs#L134)、[仓储查询](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/storage-sqlite/src/activities/repository.rs#L1562)
- 独立 [save_up.rs](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/planning/save_up.rs) 以假设收益率、月投入做预测；这不是生成实际成交的核算函数。
- [performance_service.rs](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/portfolio/performance/performance_service.rs) 实现现金流调整的 TWR 和 XIRR，并对缺失价格/未知外部转移、无法收敛等返回不可用状态；测试源码含期间 IRR 与年化 XIRR区分、无现金流符号变化、求解失败等用例。本次未执行测试。

**缺口：** 有 Pending/settlement_date 不代表已支持国内基金的“计划—扣款—申请受理—份额确认—撤单/退款—赎回到账”。T+2 QDII应按具体基金合同、交易日历和订单状态解释，不能硬编码为统一两自然日。跨境节假日、净值所属日与发布日期、净值补发、费用确认、基金转换和红利再投仍要验证。不同基金类别也不应仅依靠“红利低波”名称推断费用、市场或结算规则。

### 3.5 期权、期货及收益边界

**文档宣称：** 期权有 BTO/STO/BTC/STC、合约乘数、无价值到期；行权/指派按期权腿和标的股票交易记录。[官方活动说明](https://wealthfolio.app/docs/guide/activities/)

**源码确认：** 活动常量/模型包含 OPTION_EXPIRY 与头寸开平语义；持仓及收益层有 lot/disposal 结构。另一方面，核心 `InstrumentType` 包含 Equity/Crypto/FX/Option/Metal/Bond，外部 `FUTURE/FUTURES` 被归一到 Equity。[资产模型](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/assets/assets_model.rs#L101)、[活动模型](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/crates/core/src/activities/activities_model.rs)

**适配含义：** v3.8 发布说明的期货合约乘数估值改善，不能证明逐日盯市和保证金核算已存在。国内期货要分别核对资金权益、可用资金、保证金占用、逐日/逐笔盈亏、交易日与自然日、手续费、平今平昨；期权还需区分权利金现金流、保证金、合约标的与行权交割方式。广发期货、银河期货的正式结算单应是 PoC 的对照依据。

### 3.6 后台处理

**源码确认：** Web 的领域事件由进程内 Tokio mpsc 队列消费，合并事件后触发重算、分类和同步；另有四小时券商同步定时器。[queue_worker.rs](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/apps/server/src/domain_events/queue_worker.rs#L69)、[scheduler.rs](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/apps/server/src/scheduler.rs#L22)

**未验证：** 本次看到的进程内重算通道不等于具备持久化重试语义的业务任务队列；项目也有同步 outbox 等机制，不能据此断言所有任务都不持久化。对本项目必须专门验证“入账提交后进程崩溃—重启—补算”、多工作进程并发和每家庭隔离。正式定投确认/结算导入不能仅依赖浏览器在线或内存任务。

## 4. Sure 审计

### 4.1 PC Web、多家庭及 RBAC

**源码确认：**

- [User](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/user.rb#L22) belongs_to Family，角色有 guest/member/admin/super_admin。
- [Family](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/family.rb#L36) 拥有账户、导入、账单、规则、预算等；交易通过其账户关联。
- [Account](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/account.rb#L69) 有 accessible_by、writable_by 与 included_in_finances_for；[AccountShare](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/account_share.rb#L5) 有 full_control/read_write/read_only，校验共享用户必须同家庭。
- [Accounts API](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/controllers/api/v1/accounts_controller.rb#L62) 明确从当前用户 family.accounts.accessible_by(user) 查询；[Web账户页](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/controllers/accounts_controller.rb#L333) 按用户可见账户加载并检查管理权限。
- [AccountPolicy](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/policies/account_policy.rb) 区分修改财务数据、备注分类和删账户；read_write 在这里主要允许注释/分类，不等于 full_control。
- [部署文件](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/compose.example.yml) 是 Rails Web + PostgreSQL/Redis 的服务形态；[生产配置](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/config/environments/production.rb#L113) 使用 Sidekiq。

**限制：** 这是实际应用层隔离的证据，不是全站权限安全证明。本次在 db/schema、迁移和已检索模型范围未发现 PostgreSQL RLS 策略。用户 belongs_to 一个家庭也不等于“同一身份可同时加入多个空间”。本项目设计默认同一用户可加入多个空间，以 Owner/Editor/Viewer 角色共享同空间账目，私人账目使用独立私人空间隔离；Sure 如按此设计复用，需要增加 membership 并核对现有账户共享规则的迁移。

**必须验证的权限路径：** 在当前提交，[Transactions API](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/controllers/api/v1/transactions_controller.rb#L205) 为 show/update/destroy 共用 accessible_by 取对象，create 使用 writable_by；[API scope授权](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/controllers/api/v1/base_controller.rb#L195) 只核对 token 的 read/read_write scope。需要端到端验证只读共享账户是否在 API 更新/删除时也得到账户级拒绝，以及导入、报表、导出、搜索、后台任务的作用域。此处是静态发现的待验证项，未运行攻击或宣称已确认漏洞。

### 4.2 账务与交易模型

**源码确认：**

- [Entry](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/entry.rb#L11) 归属一个账户，委托类型为 Transaction/Trade/Valuation；支持原始 source/external_id、导入关联、对账状态和拆分。
- [schema](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/db/schema.rb#L681) 的 Entry 金额为 decimal(19,4)，Trade 价格为 decimal(19,10)、数量 decimal(34,18)，不能只凭“用了数据库数值型”就忽略各来源精度。
- 转账模型、余额正反推算、账单对账是现成可复用能力；但 Entry 一行一个账户的结构不能直接视为通用复式分录总账。
- [Trade](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/trade.rb#L58) 以数量正负判定买卖；已实现损益寻找历史 holding.avg_cost，按售价与平均成本比较。
- [CostBasisTracker](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/holding/cost_basis_tracker.rb#L13) 用 BigDecimal维护移动加权平均；卖出释放成本，全部卖完重置。

**缺口：** 本次未在主要投资模型中找到可确认的基金订单确认状态机、通用 TWR/XIRR、国内期货逐日盯市、期权行权及保证金模型。不能把“有 securities、trades、holdings”当成支持全部投资会计。Trade 中 fee存在，但其可见 realized_gain_loss 公式没有显式费用项，因此净损益口径需结合完整流水做测试，不能直接用于费用后收益。

Sure 有 [Binance FuturesImporter](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/binance_item/futures_importer.rb#L14)，提取钱包余额加未实现收益作为权益，并保存原始响应。这是特定交易所账户导入，不是广发/银河结算单或中国期货核算引擎。

### 4.3 导入、撤销与多源关联

**源码确认：**

- [Import](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/import.rb) 有家庭、原始文件字符串、状态、映射、后台发布、失败恢复和撤销；[schema](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/db/schema.rb#L1126) 还有 import_sessions 与家庭绑定。
- [TransactionImport](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/transaction_import.rb#L2) 在事务中匹配账户/分类，检查重复，创建或更新已有记录。
- [ProviderImportAdapter](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/account/provider_import_adapter.rb#L739) 的通用重复匹配在同一账户内按金额、币种、日期，必要时名称；可选日期窗口。导入期间用 claimed_entry_ids 保留同一文件中真实重复的两行。
- [Entry 唯一约束](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/db/schema.rb#L705) 包含 account+source+external_id 及 account+idempotency_key。

**适配含义：** 已有导入和来源幂等基础，有助于快速接入喵喵记账，但尚不满足“同一支付行为多份原始凭证共同指向一个经济事件”的来源图。不同来源先映射到同一真实账户仍不足以解决退款、手续费、支付平台钱包与银行卡的路由关系。

**撤销必须专项验证：** TransactionImport 会把匹配已有记录的 import关联改成此次导入；Import.revert 会销毁关联 entries。[导入更新](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/transaction_import.rb#L45)、[撤销](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/import.rb#L326)。本次没有执行因此不确认实际后果，但不能预设“撤销导入”会自动还原已有交易的全部前态。产品要求应是撤销本批新增/变更，保留其他来源及先前用户修改；需要变更快照/操作日志或补偿策略。

### 4.4 计划与事实、后台任务

[RecurringOccurrence](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/models/recurring_occurrence.rb#L1) 把预期实例与真实付款分配分开，状态有 scheduled/paid/skipped/missed；这是“计划不直接当实际账”的有用基础。但它面向周期性账单，不能直接替代基金申请/确认记录。

[ApplicationJob](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/jobs/application_job.rb#L1) 在数据库事务提交后入队，死锁可重试；[ImportJob](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/jobs/import_job.rb)、[SyncJob](https://github.com/we-promise/sure/blob/f3595a74521cf681b9d12f454104739ba3732d5f/app/jobs/sync_job.rb) 为独立任务。任务带已有实体对象并沿所属家庭处理，不代表具备额外的数据库强制租户隔离；重试幂等、任务取消、导入中途失败仍需验证。

## 5. 复用方式比较

| 路线 | 能保留的价值 | 必须新增/改造 | 对当前要求的判断 |
|---|---|---|---|
| Wealthfolio 插件 | 现成账户/投资UI、CSV活动入口、收益分析、目标预测 | 中国格式解析及关联层；无法仅靠插件补全全局租户隔离和核心复式账务 | 不作为共享实例多家庭主底座；可用于单家庭样例验证 |
| Wealthfolio 每家庭独立实例 | 保留最多现成投资功能；数据库物理隔离 | 实例供给与路由、版本维护、备份、成员权限、跨层来源审计、国内结算 | 可选产品路线，但必须用户接受实例化运维/权限限制后再定 |
| Wealthfolio 深度 fork | 前端、Rust业务模块、收益和持仓等 | 认证到缓存/任务/导出全面多租户化，账务和国内产品状态机 | 核心改动面较大，不能按“小改”估时 |
| Sure fork / Rails 内新增领域模块 | 多家庭、权限框架、账户、收支、导入、报表、后台任务 | 原始证据层、跨源关联、严谨账务/冲销、基金与衍生品子账、收益口径和权限补强 | **保留为 G0 可推翻自建基线的 fork 比较项，先PoC** |
| Sure + 独立投资服务 | 保留现成日常财务，另建结算 | 双端账户标识、可靠事件传递、对账、权益投影、故障恢复 | 如果两端都可写同一余额会形成双重真相；须只指定一处权威，不默认推荐 |
| 自建模块化单体 | 可以从第一天统一租户、来源证据、账务、结算日期和收益口径 | 身份/权限、导入UI、报表、后台、备份均需建设 | 当前设计基线；核心领域需要大幅重建是依据，仍须用同一PoC和实测估算复核 |

**开源许可证边界：** 两个主项目均为 AGPL-3.0。二次开发并让用户经网络交互时，应落实其第13条对应源码提供要求；复制模块到新系统也不能忽略原许可证。Wealthfolio 品牌另有[商标要求](https://github.com/wealthfolio/wealthfolio/blob/13e4de49aea71a6a9a07501c357babc3516c7f7f/TRADEMARKS.md)。这里记录项目明确许可，未对具体商业部署作完整法律审查。产品如果有闭源要求，需要在决定 fork 前明确；不能把“开源”理解成任意闭源重发。

## 6. 决策 PoC 与验收门槛

以下是开发前验证计划，**本轮尚未执行**。推荐同一份脱敏“金标准”样本同时验证 Sure fork 和自建最小领域模型；Wealthfolio只做投资算法/界面参照或独立实例对照。每项记录版本、样本、期望、结果、修改范围及剩余差异。

| 门槛 | 最小样本与动作 | 必须达到 |
|---|---|---|
| P01 独立空间隔离 | A/B两空间，Owner/Editor/Viewer角色；一个用户加入多空间；另有私人空间；交叉尝试列表、详情、修改、导入、导出、下载、搜索、任务结果 | 仅A空间成员看不到/改不到B财务对象；同空间按角色共享；私人空间隔离；多空间身份不扩大数据范围；页面与API一致；外部标识相同也不串户 |
| P02 导入保真与幂等 | 喵喵、微信、支付宝、银行，同文件重导、重叠月份、断点重试 | 不重复记账；每条来源留文件摘要、行号、原文、版本和解析结果；错误行可定位且不静默丢弃 |
| P03 多源归并无误伤 | 同一银行卡消费来自三源；同日同商户同金额两笔真实消费；部分/全额退款；钱包转账 | 三源只产生一次消费，证据均保留；两笔真实消费不能合并；不确定项进入人工确认；退款回连原事件 |
| P04 撤销与更正 | 导入覆盖已有分类；导入后人工修改；撤销一批或更正一条 | 只撤销此次影响，不删除其他证据；不能无痕改已核对事实；可重放得到相同余额 |
| P05 账务不变量 | 银行到券商、申购在途、手续费、分红、信用卡还款、外币兑换 | 按确定的分录/子账规则平衡；内部转移不变收益；资金/持仓/权益不存在重复计量 |
| P06 基金真实确认 | 广发/易方达真实脱敏样本：扣款日、申请日、确认份额/净值、退款、赎回；含用户指定QDII和跨市场假日 | 计划与实际隔离；扣款到确认存在资金去向；T+2依产品日历/规则验证；份额、费用、资金与机构确认结果逐项一致 |
| P07 收益与定投 | 不规则多笔投入、分红再投、赎回、费用；预期收益场景 | 首版已实现/未实现/现金收入/费用分别解释，XIRR与独立基准一致（规定精度）；不可计算时有原因；预测绝不计入实际。TWR作为后续具备完整估值与现金流数据时的条件项 |
| P08 机构结算映射与对账 | 首版使用广发/银河连续数个交易日正式结算单，保留其权益、可用、保证金、盈亏、手续费及合约明细 | 字段映射、交易日和币种正确；机构权益快照与总资产投影只计一次；结算单各项及余额变动可核对，差异可定位；不得把合约名义价值计净资产。首版不要求逐笔复算；逐笔复算与完整衍生品生命周期在后续独立验收 |
| P09 境外/外币 | 港美股票交易、跨币种出入金、分红/预扣税、外汇兑换、价格缺失 | 保留交易币/账户币/展示币；交易、结算、估值与汇率时间明确；本币损益和汇兑差异可追溯；外部行情缺失不补造 |
| P10 后台可靠性 | 导入写库后杀进程、重复投递、两个任务并行、重算后失败重试 | 不重复分录、无半笔事件；待处理状态可恢复；任务及结果带家庭边界；旧重算不能覆盖新数据 |
| P11 导出恢复 | 导出某家庭，再还原到干净环境，跨版本迁移试验 | 原始证据、记录关联、余额持仓与关键收益结果一致；不得夹带其他家庭数据 |
| P12 PC Web工作流 | 标准桌面浏览器完成样本导入→检查疑似重复→确认→资产详情→查看来源/收益→导出 | 核心流程不依赖桌面客户端；可批量操作、筛选和下钻，金额/日期/状态清楚，无假数据冒充实时数据 |

门槛失败时，记录是“配置/小范围扩展”还是“改核心数据与权限路径”。G0 的选型比较以 P01～P10 的最小样例和改造范围证据复核设计基线；生产发布前再完成对应实现的全部适用验收，不能把设计决策当作已通过测试。P08 首版范围已固定为机构结算字段映射、权益投影及对账；逐笔复算为后续范围。P07 的 TWR 为后续条件项，首版要求 XIRR及收益分项。

## 7. 开发前仍需补齐的输入

- 每种来源一份脱敏完整导出及说明：至少覆盖一次转账、消费/退款、买入卖出或申赎确认，保留字段、格式和表头。
- 广发/银河连续结算单与实际涉及的期货/期权品种；结算规则不能靠名称推断。
- 广发/易方达具体基金代码、份额类别、申赎渠道与QDII确认样例；“红利低波”是策略描述，不是足够的产品主键。
- 权限设计默认已确定：Owner/Editor/Viewer、用户可多空间、同空间账目按角色共享、私人空间隔离。后续仅需确认具体导入/冲销/导出动作的角色矩阵，并将默认设计落成权限测试。
- 自托管还是统一托管，以及若选择fork是否接受AGPL对应源码提供方式。第一版期货期权范围已固定为机构结算字段映射、权益汇总及对账，逐笔复算留待后续。
- 境外券商与币种清单、成本法/收益口径，以及账户余额历史不全时的起始快照策略。

这些缺失不妨碍完成需求与模型设计，但会阻止声称“导入与结算已支持”或给出可靠的二次开发工期。
