# 2.14.3 EST-012 正式收益切换证据

问题：新浪基准和正式NAV同步前进，但凌晨参考报价不变，参考比率保护正确拒绝后，2.14.2读侧将已有正式收益也隐藏。

- `pre-fix-readonly.json`：生产强制只读、无登录/会话/刷新、只取已授权代管空间。只输出公开NAV和金额是否可用，不保存真实收益金额、份额或账户标识。五只正式10/12收益均可计算。
- `formal-transition-before.png`、`formal-transition-after.png`：本地18093合成普通用户，同一基准更新样本。原正式10/12 NAV1.73、10/9 NAV1.7251、100份，手算+0.49；修复前无值，修复后显示+0.49且归属10/12，记录时间10/13。展开计算依据核对真实旧NAV基准1.7251，截图经实际查看。没有登录生产浏览器。
- 真实公开源样本另见[2.14.2转场记录](../estimate-funding-2142/sina-baseline-change-1940.md)，其正式1.7237对应100份手算-0.14；与UI合成1.73样本区分，不将合成数冒充生产金额。
- 定向命令：`python scripts/audit_local.py --pg-port 55443 --web-port 18093 test tests/test_fund_return_updates_v2142.py tests/test_daily_returns_v263.py tests/test_overview_projection_version.py`，59通过；日志`backend-targeted.log`。
- Python CI格式190文件和致命规则检查通过；发布保护模拟8项通过，仅测试替身，不是生产部署成功证据。

本地完整回归1807项、12子测试通过，0跳过，233.24秒；373条warning为隔离静态目录未创建，日志`backend-local-full.log`。Linux冻结镜像与实际部署结果在完成后单独保存。复用本地隔离PostgreSQL18，完整回归另建专用合成库，不清理或重置既有测试库。
