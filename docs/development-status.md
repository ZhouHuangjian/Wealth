# 开发与验收状态

更新时间：2026-10-07。业务基线为用户上传的 [V2 原文](requirements-v2.md)。**2.10.0 已于 2026-10-07 20:19（北京时间）完成保数据发布与验收**。新增官方基金净值、多源差异隔离、订阅 Token 加密配置和实际基金账单核对。最终候选完整后端 1,370 项及 12 项子测试、前端 145 项、隔离浏览器 18 项、发布脚本安全检查 31 项通过。详见 [2.10.0 发布记录](release-2.10.0.md)。真实机构原生账单、订阅授权接口、全市场覆盖及完整规模测试仍有边界；**V2 完整 P0 验收仍未全部完成**，以下历史证据及未完成项继续保留。

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
