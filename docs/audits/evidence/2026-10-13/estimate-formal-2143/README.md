# 2.14.3 EST-012 正式收益切换证据

问题：新浪基准和正式NAV同步前进，但凌晨参考报价不变，参考比率保护正确拒绝后，2.14.2读侧将已有正式收益也隐藏。

- `pre-fix-readonly.json`：生产强制只读、无登录/会话/刷新、只取已授权代管空间。只输出公开NAV和金额是否可用，不保存真实收益金额、份额或账户标识。五只正式10/12收益均可计算。
- `formal-transition-before.png`、`formal-transition-after.png`：本地18093合成普通用户，同一基准更新样本。原正式10/12 NAV1.73、10/9 NAV1.7251、100份，手算+0.49；修复前无值，修复后显示+0.49且归属10/12，记录时间10/13。展开计算依据核对真实旧NAV基准1.7251，截图经实际查看。没有登录生产浏览器。
- 真实公开源样本另见[2.14.2转场记录](../estimate-funding-2142/sina-baseline-change-1940.md)，其正式1.7237对应100份手算-0.14；与UI合成1.73样本区分，不将合成数冒充生产金额。
- 定向命令：`python scripts/audit_local.py --pg-port 55443 --web-port 18093 test tests/test_fund_return_updates_v2142.py tests/test_daily_returns_v263.py tests/test_overview_projection_version.py`，59通过；日志`backend-targeted.log`。
- Python CI格式190文件和致命规则检查通过；发布保护模拟8项通过，仅测试替身，不是生产部署成功证据。

本地完整回归1807项、12子测试通过，0跳过，233.24秒；373条warning为隔离静态目录未创建，日志`backend-local-full.log`。Linux冻结镜像1807项及12子测试通过、0跳过；实际部署和数据保留证明见`final-results.json`。复用本地隔离PostgreSQL18，完整回归另建专用合成库，不清理或重置既有测试库。

冻结应用提交`8f538c3a88afb4bff5e76ea6e5ce4e0c4d3dfb27`。归档源码使用Node22重新类型检查及构建，23个前端文件与2.14.2通过214项前端测试的构建逐字节相同，本补丁未修改前端源码；不把继承的前端测试说成重新运行。构建有既有500kB chunk提示，无构建失败。首次打包误用系统Python3.9，不支持tar安全解包的`filter`参数而中止、未产生候选镜像；随后用项目Python3.12重新完成。

最终版本状态：2.14.3已于2026-10-13 20:06:07（北京时间）保数据部署，应用`8f538c3a88afb4bff5e76ea6e5ce4e0c4d3dfb27`、镜像`sha256:9f4ca6be7bbb75b123654a7bde0145a81aca50ab09ea528f9222662d8a1b912c`，schema仍为`0015_chat_remote_controls`。本地及Linux冻结镜像各1807项和12子测试通过、0跳过。

线上20:06:29只读确认7/7最近基金结果可计算，目标五只均为正式10/12且保留参考失败原因；原今日10/13仍只3/8可算，另外5只无今日估值不造数。补足来源生产配置仍为0。所有只读证据不含实际收益/份额数值；本机验证副本与服务器认证后的加密备份一致。
