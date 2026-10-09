# 本地启动、部署与恢复手册

维护日期2026-10-09。提供本地启动和compose容器步骤；现行定位与回归入口见[项目地图](project-map.md)，本轮版本/任务/恢复边界见[审查报告](audits/system-audit-2026-10-09.md)。公网health只读返回2.11.0，不等于当前镜像/SHA、调度或备份已验证。服务器部署历史见[部署记录](server-deployment.md)和[2.11发布](release-2.11.0.md)；不以旧记录承诺现在健康。系统没有外部付款、自动机构账单拉取或自动汇率能力。

2.10.0 新增数据源 Token 加密存储。运维必须保留原 `DJANGO_SECRET_KEY`；轮换使用 `DJANGO_SECRET_KEY_FALLBACKS`（旧密钥的 JSON 数组），过渡期间重新保存 Token 后才能移除旧密钥。后台只提供写入/删除及状态，不提供读取明文；不要直接编辑数据库密文。公开官方净值无需 Token，订阅 Token 仅在独立管理台 → 数据源配置，默认停用。详细来源范围、故障与差异处理见 [2.10.0 发布说明](release-2.10.0.md)。

## 0. 当前电脑直接运行

本机已验证 PostgreSQL 18、Python 3.12 和 Node 环境；macOS 的原生启动与 Ubuntu 服务器的 Docker 部署分别验收，不能将本机 Docker Desktop 权限限制视为服务器容器尚未验证。当前可从仓库根目录运行：

```sh
python3 scripts/local_dev.py start
python3 scripts/local_dev.py status
python3 scripts/local_dev.py stop
```

默认打开 `http://127.0.0.1:8000`。空库首次初始化创建平台管理员；普通用户和账簿在独立管理台另行建立，管理员角色本身不拥有私人账簿。启动器不写入演示余额，不安装全局软件，也不修改已有全局服务。若不存在 `.env`，依据模板创建独立随机凭证；已有 `.env` 则要求权限 0600 且没有占位密码。依赖仅安装在项目 `.venv` 和前端 `node_modules`。

`start` 会复用或初始化本项目 `.runtime/pgdata` 中的 PostgreSQL 18 集群，固定仅监听本机 55432；数据库若不属于该目录或端口被其他服务占用，会拒绝操作。应用使用 `wealth_app`，迁移使用 `wealth_owner`。`wealth` 是用户账本，`wealth_test` 为隔离测试数据库，浏览器验收另用 `wealth_ui_test`。任何测试数据都不得进入 `wealth`。

启动器编译网页、启动同源网页/API；本地任务一轮完成后等待约30秒再扫描，网络慢时不能承诺每30秒准时处理。tick顺序为分红→行情→提醒→计划→outbox。此开发模式无需消息队列；正式容器采用Celery/RabbitMQ，计划扫描间隔300秒。只有一个受控任务循环；自动记账不向银行付款。`status`返回最近扫描时间与退出状态，私有日志在`.runtime/web.log`、`.runtime/tick.log`和`.runtime/supervisor.log`。

`stop` 只停止本启动器记录、且经进程命令与实例标识验证的网页和任务进程；不会停止 PostgreSQL、删除账本或终止其他服务。端口冲突时可用 `python3 scripts/local_dev.py start --port 18080`。该入口面向本地开发使用，始终绑定 127.0.0.1，不用于直接公网发布。

新电脑仍需事先具备 PostgreSQL 18、Python 3.12+ 和 Node/npm。可通过 `WEALTH_PG_BIN` 指定 PostgreSQL 18 的工具目录；启动器不会自动修改包管理器或系统服务。若需要更新已存在数据库的超级用户密码，必须在维护窗口单独轮换，不能仅改 `.env` 后假定数据库已经同步。

### 已执行的本地恢复演练

```sh
.venv/bin/python scripts/test_restore_local.py
```

此命令只创建 `wealth_restore_source_test` 和 `wealth_restore_target_test` 两个独立合成数据库，默认结束后清理。若同名库已存在，会拒绝替换；确有本演练标记的残留可用 `--reset-drill` 重建，非演练标记永不删除。该命令是恢复验证工具，**不是用户主账本备份命令**。

2026-09-25 已实测：独立 owner 迁移、runtime 种合成事实、PostgreSQL 自定义归档、数据库及私有文件清单、认证加密、解密校验、恢复、逐币种分录平衡、净资产/持仓/管理成本、附件哈希、强制 RLS、无上下文拒绝、跨空间拒绝、Viewer 写入与原文件下载拒绝、不可变事实与关闭事件触发器，以及两次任务补跑后事实不变。核对 `.runtime/restore-drill-result.json` 的 before/after，恢复保留了 `0001_initial` 至 `0006_immutable_audit_history` 六项迁移。

合成结果：现金 8,900、基金 495 份／正式净值 2、管理成本 1,000、负债本金 1,200，净资产 8,690；恢复前后一致。本次“解密＋恢复＋核验＋两次补跑”约 1.57 秒，只有两空间和一份附件，不代表生产规模 RTO，也未测出生产 RPO。机器可复查记录位于 `.runtime/restore-drill-result.json`；本地启动、健康、空白初始化与任务扫描记录位于 `.runtime/local-start-check.json`。

服务器初始快照已另行恢复到独立 Compose project；记录见[服务器部署记录](server-deployment.md)，不与本地合成数据证据混用。实际容量测试与未知旧系统迁移仍需独立验收，不能用本合成演练或初始空账簿恢复代替 AT-46 的全部条件。

## 1. 目录与服务

| 组件 | 职责 | 暴露范围 |
| --- | --- | --- |
| web | Django API、会话和编译后的网页 | 默认仅 `127.0.0.1:8000` |
| db | PostgreSQL 18，持久化账本 | Compose 内网，无主机端口 |
| rabbitmq | 异步消息 | Compose 内网，无主机端口 |
| worker | 执行持久化任务 | 内网 |
| beat | 产生扫描/补发任务，严格一个实例 | 内网 |
| migrate | 临时执行数据库迁移 | 仅 `tools` profile |

私有账单不挂到公开静态目录。`private_media`、`postgres_data`、`rabbitmq_data`、`scheduler_data` 均为命名数据卷。PostgreSQL 18 使用 `/var/lib/postgresql` 挂载点，不照搬旧版的 `/var/lib/postgresql/data`。[官方镜像说明](https://hub.docker.com/_/postgres)

## 2. 首次启动

要求 Docker Engine/Desktop、Compose v2、可访问镜像及包源。备份工具另需 Python 3.12+ 和支持 PBKDF2 的 OpenSSL；宿主 Python 只用于工具，应用容器使用 3.13。

以下是新环境初始化步骤，已部署服务器不应重复初始化。公网开放前必须通过服务器私有命令建立应用用户、账簿和 owner 关系，关闭空库首次初始化入口；不能把未初始化空库直接公开。应用密码与 SSH 密码独立，`createsuperuser` 本身不会创建账簿。现有服务器已完成私有初始化。

```sh
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

为 `.env` 中每个 `CHANGE_ME` 生成不同的随机值，不在聊天、日志或截图中展示 `.env`。建议使用十六进制随机密码，避免 URL 编码差异。然后：

```sh
chmod 600 .env
./scripts/bootstrap.sh
docker compose run --rm web python manage.py createsuperuser
```

首次用户通过交互式命令设置，不在镜像中放默认账号或演示余额。打开 `http://127.0.0.1:8000`。此地址是本机开发入口；`.env.example` 的 `DJANGO_DEBUG=1` 配合本地 HTTP 使用。

初始化的等价顺序如下，迁移完成后才能启动应用：

```sh
docker compose build
docker compose up -d --wait db rabbitmq
docker compose --profile tools run --rm migrate
docker compose up -d --wait web worker beat
```

仅在空数据卷上执行角色初始化。修改 `.env` 中的数据库密码不会自动改已有角色密码。不要通过删除数据卷解决已有账本的密码或迁移问题。日常停止使用 `docker compose stop`，不要对真实数据使用 `down -v`。

## 3. 维护与升级

1. 阅读迁移与发布说明，并先完成可验证的加密备份。
2. 维护窗口停止 web、worker、beat；等待正在执行的事务结束。
3. 构建新镜像，运行一次 `migrate`，执行后端检查和必要烟雾测试。
4. 启动 web 验证登录、空间权限和总览，再启动 worker、唯一 beat。
5. 记录应用提交、镜像 ID、迁移列表、数据备份和检查结果。破坏性迁移不能仅靠切回旧镜像回滚，应按迁移说明恢复对应数据库和私有文件快照。

```sh
docker compose ps
docker compose logs --tail=100 web worker beat
docker compose run --rm web python manage.py check
docker compose --profile tools run --rm migrate python manage.py showmigrations
```

日志不能包含密码、账单原文或完整账号。Web 健康检查只能证明当前端点可用；worker ping 只能证明进程响应；beat PID 只能证明进程存在。应同时检查应用任务状态、outbox 最老积压时间、预计扫描时间、导入失败、长期在途、未解释差额、缺净值/汇率、备份成功时间与可用磁盘。

### 3.1 行情更新与故障排查（2.1）

`WEALTH_MARKET_DATA_ENABLED=1` 启用后台行情；常规环境默认开启，测试环境默认关闭。Compose 将该变量传给应用服务。改为 `0` 后需按当前运行方式重启 web/worker/beat，停止后台及手动刷新命令；已有价格不会被删除。该开关不是出口防火墙，产品检索接口仍可按用户输入请求公开源。`WEALTH_MARKET_INLINE=1` 是本地/测试调度用途，容器生产使用 Celery。

- 唯一 beat 每 300 秒扫描一次；每个产品按最近尝试时间节流。`market_quotes` 保存请求意图，消息队列短暂不可用时由后续扫描重投。十分钟租约内保留请求 token，重复消息不重复写观察。
- 支持历史行情的产品通常每小时补齐一次近期正式数据，从最新正式价格前 14 天开始；首次补录持仓可申请从买入日期抓取，最多五年。扫描周期是调度间隔，不保证第三方数据在五分钟内产生更新。
- 本地 `tick` 每轮最多处理十个到期行情产品，再执行计划/outbox；独立本地循环仍每 30 秒扫描，单产品正常刷新间隔不因此变成 30 秒。
- 产品代码、市场、币种、份额类别及品类是行情身份。已有持仓、价格或行情任务后禁止直接换成另一个产品；新建正确产品，按账务流程迁移，不能覆盖旧价格身份。

在已登录空间查看“行情与结算 → 自动行情”或 `GET /api/v1/spaces/{s}/market/quotes`。同时核对 `status`、`refresh_status`、`economic_date`、`published_at`、`fetched_at`、来源和 `history_error`：抓取成功不等于提供方价格属于今天，QDII 净值尤其可能晚于经济日期公布。失败保留最后观察并显示陈旧；缺价格保持空值。来源停更与任务未执行应分开排查。

公网出口需要 DNS、可信 CA 和 HTTPS 访问固定源：`fundsuggest.eastmoney.com`、`fund.eastmoney.com`、`fundcomapi.tiantianfunds.com`、`searchapi.eastmoney.com`、`qt.gtimg.cn`、`web.ifzq.gtimg.cn`、`hq.sinajs.cn`、`query1.finance.yahoo.com`。适配器禁止重定向和任意 URL，单次超时 8 秒、响应上限 2 MB。不要通过关闭 TLS 校验或让客户端指定任意源地址解决网络问题。公开接口变化时保留原价格和错误状态，更新适配器后再验证。

股票/ETF 今日的日 K 在盘中仍会变化，因此正式收盘价仅在本地时间内地 16:00、香港 17:00、美股纽约 17:00 后接纳；提前收市日保守延后。参考行情仍可更新。基金盘中估值不能覆盖正式净值，期货/期权价格不能替代机构权益快照。货币基金万份收益、境外衍生品等未支持数据应保留明确提示，不能临时填零。

升级后在独立测试账簿验证产品检索、账户过滤、手动刷新、一个后台刷新周期、正式/参考价格分离、失败状态和收益日历；不能在真实账簿创建测试交易。新增自动化用例可在已初始化的隔离 `wealth_test` 执行：

```sh
.venv/bin/python scripts/local_backend.py test pytest tests/test_market_data.py tests/test_market_lifecycle.py tests/test_market_integration.py tests/test_investments_v3.py
```

新增代码不代表目标服务器的网络已经可达。目标环境的行情探测、最终测试总数与部署状态留在[2.1 发布记录](release-2.1.md)登记；不要沿用旧版 137 项回归数字代表新代码。

## 4. 对外部署条件

服务器已基于 Compose 配合 Nginx 完成 HTTPS 部署，公网登录、安全会话、空态与核心 API 已验证，web/db/rabbitmq/worker/beat 五个主服务健康。应用保持 `DJANGO_DEBUG=0`，设置准确的 `DJANGO_ALLOWED_HOSTS`（含回环健康检查地址）和 HTTPS `DJANGO_CSRF_TRUSTED_ORIGINS`。受控代理终止 TLS，再访问本机绑定的 8000 端口；`WEALTH_TRUST_PROXY=1`、`WEALTH_FORCE_HTTPS=1` 与 `WEALTH_HSTS_SECONDS` 控制代理信任、跳转和 HSTS。代理必须覆盖客户端提供的 forwarded 头，不能无条件信任外来值。

当前使用 Let's Encrypt 可信 IP 证书，已启用每 6 小时检查的续期调度，续期 dry-run 成功。IP 短期证书依赖自动续期和 Nginx reload；维护时须保留 ACME 挑战路径可达。此次部署成功不等于 V2 全部 P0 发布关卡、容量和可访问性已验收。

若代理不在同一宿主，不直接把当前 8000 端口改成公网绑定；另行配置隔离网络和仅允许代理访问的入口。数据库、队列、媒体目录保持私有。Secure Cookie 需要浏览器通过 HTTPS 访问；关闭调试后用纯 HTTP 登录将无法保存安全会话，不能因此长期关闭 Secure Cookie。

仍需按完整发布要求补齐镜像与依赖审查、密码恢复与会话失效验收、受控邮件通道、自动异地备份、失败通知以及磁盘和证书告警；已启用的本地备份和证书定时任务不等于已配置上述告警。RabbitMQ 4.3.6 已实测运行，后续随支持周期更新；镜像浮动 minor 标签不视为生产不可变发布物。[RabbitMQ 支持信息](https://www.rabbitmq.com/release-information)

Celery 5.6 使用独占控制/回复/事件队列和持久 quorum 任务队列 `wealth.tasks`，开启发布确认，并由 quorum 检测关闭 global QoS，适配 RabbitMQ 4.3 默认限制。实际 worker ping、首条主库 outbox 完成及相关 13 项任务测试已通过；真实 broker 故障/重启演练仍未执行，不应通过全局开启 RabbitMQ 废弃功能绕过兼容要求。

## 5. 加密备份

备份包含数据库归档、全部私有文件、文件哈希清单和镜像/数据库版本。脚本暂停当时运行的 web、worker、beat，备份后恢复原来的服务状态；这一过程会短暂不可用。维护期间不能有其他管理命令、迁移或直接 SQL 写入。数据库运维账号会读取全部空间，因此备份文件不提供给普通空间成员下载。

在仓库外、备份存储外生成独立密钥，设置 0600 权限，并单独保存安全副本。不能复用数据库密码或 Django 密钥：

```sh
umask 077
mkdir -p "$HOME/.wealth-secrets"
openssl rand -hex 32 > "$HOME/.wealth-secrets/backup.key"
python3 scripts/backup.py backup --key-file "$HOME/.wealth-secrets/backup.key" --output-dir ./backups
python3 scripts/backup.py verify ./backups/wealth-YYYYMMDDTHHMMSSZ.backup.enc --key-file "$HOME/.wealth-secrets/backup.key"
```

加密采用 OpenSSL AES-256-CBC/PBKDF2，并由独立派生 HMAC-SHA256 密钥对密文认证；先验证 HMAC，后解密，不把 CBC 的解密成功当作完整性校验。临时明文在受限临时目录处理并在结束时删除；宿主应启用磁盘加密，临时文件删除不等同存储介质安全擦除。密钥丢失无法恢复。

仓库提供 `infra/systemd/wealth-backup.service` 和 `.timer`。目标服务器已启用每天当地时间 03:00 加最多 15 分钟错峰的调度，并已成功执行一次 systemd 备份。模板假设仓库 `/opt/wealth`、环境文件 `/etc/wealth/runtime.env`、独立密钥 `/etc/wealth/backup.key`、归档 `/var/backups/wealth`，由专用 `wealth-ops` 用户执行；服务器实际路径和账号以[部署记录](server-deployment.md)为准。该用户须可读环境/密钥、可写归档且具备 Docker 操作权限；Docker 组本身具有高权限，不能分配给普通空间成员。以下供新服务器安装，先调整路径并完成一次手动演练：

```sh
sudo install -m 644 infra/systemd/wealth-backup.service /etc/systemd/system/
sudo install -m 644 infra/systemd/wealth-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start wealth-backup.service
sudo systemctl enable --now wealth-backup.timer
systemctl list-timers wealth-backup.timer
```

首次加密快照 `20260925T093105Z` 已复制一份到本机，并已成功恢复到隔离 Compose project；该快照含 0 个私有附件。自动备份目前仍只落在服务器本地，尚未配置自动异地复制和失败告警。失败通过服务非零退出码和 systemd 日志保留；应将失败告警接入已批准运维通道，并检查最新可恢复快照时间。备份保留周期、异地位置和删除延迟仍需落实。计划存在、归档可解密都不等于 RPO≤24h 或 RTO≤4h 已达成。

## 6. 干净环境恢复演练

本次部署已将首次加密快照恢复至新 project `wealth-restore-check-20260925`。主库与恢复库的核验结果一致：1 用户、1 Owner 空间，账户/事件/分录均为 0，净资产为 0；outbox 1 条已完成、尝试 1 次且无错误，projection 1 条、修订 1，0001–0006 迁移保留。检查的三个核心表均由 `wealth_owner` 所有并强制 RLS；运行角色 `wealth_app` 非 superuser、无 BYPASSRLS，无空间上下文或随机其他空间上下文都不能读到实际存在的 outbox/projection。记录位于 `.runtime/deploy/restore-verification.json`，详见[服务器部署记录](server-deployment.md)。

该快照包含 0 个私有附件，是初始空账簿样本，不能证明真实非空数据量下的 RPO/RTO，也不代替全部跨空间路径的攻击矩阵。以下步骤供后续独立演练使用。

演练使用新 Compose project，新数据卷与新端口；不要在现有用户账本上练习。准备仓库外的 `restore.env`，填独立随机凭证并设置 `WEALTH_PORT=18000`。先启动空数据库和队列，保持 web、worker、beat 停止：

```sh
docker compose --project-name wealth-restore-drill --env-file /secure/restore.env up -d --wait db rabbitmq
python3 scripts/backup.py --project-name wealth-restore-drill --env-file /secure/restore.env restore ./backups/wealth-YYYYMMDDTHHMMSSZ.backup.enc --key-file "$HOME/.wealth-secrets/backup.key"
```

脚本先检查 HMAC、包结构、路径、数据库和媒体文件哈希；拒绝符号链接与路径穿越。数据库恢复为 `wealth_owner` 所有并重建运行角色授权，私有文件恢复后逐个回读核对。恢复时还在停写维护事务中将历史事件技术字段 `posted_txid` 置零：原集群事务号不能在新集群继续作为“当前事务”的证明；这一操作不修改金额或业务事实，结束前恢复不可变事实触发器。恢复完成仍保持应用停止。数据库与文件跨介质的替换不是一个分布式事务；若恢复中断，保持维护状态，用同一已验证备份重试，不开放部分恢复的数据。

默认拒绝覆盖非空数据库。真实灾难恢复只有在核对目标及已有备份后，才使用明确参数 `--confirm-replace REPLACE_TARGET_DATABASE_AND_FILES`。这一参数同时意味着替换该 project 的私有文件。

恢复前后应按恢复记录模板核查：

| 核查项 | 必须留下的证据 |
| --- | --- |
| 时间与版本 | 故障/快照/恢复开始和结束时间，应用提交、镜像 ID、迁移记录 |
| 数据一致 | 空间、账户、经济事件、分录、证据文件数量；附件哈希；代表余额及负债一致 |
| 权限 | runtime 非 owner、无 BYPASSRLS；A 不能读 B；Viewer 不能写；已移除用户不能下载 |
| 财务 | 按币种分录平衡；确认/冲正链；QDII 在途、已支付贷款期次不重复 |
| 队列 | 旧队列属于恢复前时间线时先清理；从 outbox/业务事实重建任务；重复补跑不重复入账 |
| 差异 | 旧数据迁移差异逐项登记，不用无说明调整抵消差额 |
| RPO/RTO | 可恢复快照距故障的差值、恢复到可使用的耗时；未测不填通过 |

对恢复前遗留队列使用同一恢复 project 的 `celery -A config purge --force` 前确认该队列专属于本系统，且消费者已停止。此操作只清理消息，恢复依赖数据库中的 outbox 和任务幂等事实。新演练 project 的空队列不需要清理。再启动 web 做人工核验，最后启动 worker、唯一 beat 观察补跑。将演练证据写入发布记录，才能评估 AT-46。

## 7. 开发检查与 CI

后端测试必须使用隔离测试库，不能对真实数据库执行自动清空、重建或破坏性验证。开发 API 默认使用 `wealth_app`；迁移用独立 owner。前端 5173 通过 Vite 代理 API 到 8000。CI 配置见 `.github/workflows/ci.yml`；脚本安全测试可单独运行：

```sh
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

CI 通过不代表真实机构样本、性能规模、浏览器全部状态或恢复演练全部通过。发布需要 [V2 的 AT-01—46](requirements-v2.md) 对应证据。

## 8. 定投与收益维护基线（2026-10-09）

### 8.1 先判断是否在运行，再判断是否缺数据

1. 记录代码SHA、实际运行镜像/版本、迁移、业务时区和检查时间；健康API只证明web可响应。只读查计划状态、automation.enabled/start_date、选定资金/持仓账户、产品/渠道/币种和版本。显式关闭不可因排障重新开启。
2. 开发环境先看`local_dev.py status`中的扫描时间/退出码，再看tick/supervisor私有日志；容器环境核对唯一beat、worker接收scan-due/refresh-market任务及最近完成结果。服务healthy不证明某计划已处理。排查网络阶段耗时、失败/权限失效和没有Owner导致跳过；日志不公开私人账单/Token。
3. 按期次查看scheduled_date、due_date、event_id及automation.status/message/processing_state。按稳定stage_key核查debit、confirm/refund及替代关系。扣款已记但NAV未到是正常等待；没有debit先排日历/关闭/资金，不把资料缺口说成银行拒付。
4. 逐产品核对精确NAV日、正式Price、published_at（未知留空）、冲突隔离及预计确认日。不要取今天最新值或以后第一条值代替，不因估值缺失忽略正式NAV。已知冲突不能靠剩一个源解锁。
5. 看outbox状态/lease与目标revision；旧revision结果不能覆盖新投影。DCA runtime有checked_at和500期游标，状态API已输出last_checked_at、页面标北京时间；它只证明计划检查发生，不证明beat/worker持续健康。下次重试/失联出口仍属R-005，不虚构“下次重试”字段。

正常等待表只维护在[domain-model§12.3](domain-model.md#123-每种等待暂停的闭环)：进入、影响阶段、唤醒、重试、超时/人工介入、退出都有定义。当前有周期补扫，没有逐原因退避/超时升级；按产品适用规则的提醒方案是待实现OD-06。等待超期只升级核对/运维，不自动退款、换卡或填份额。

### 8.2 安全重试、核对与更正

状态GET是只读；页面“刷新进度”对有写权限且enabled的计划可能发送`POST plans/{id}/automation/run`，**不是纯读取**。run使用expected_plan_version、幂等键和合法空间权限，可能处理已到期期次。优先让健康任务自动补扫；生产run/修订不在本轮授权内，不能把“点一次试试”当只读诊断。

- 缺NAV/接口中断：恢复对应来源、检查产品日期与隔离后等待下一轮；失败只影响相关产品/日期。网络在写事务之外，有界请求；不在持仓锁中请求第三方。
- waiting_cash：核实所选账户的真实余额/期初覆盖、机构留存、冻结/预留和已有扣款；补账簿资料与真实不足分别处理。不能自动找另一银行卡或把货币基金当已赎现金。
- waiting_fee/configuration_required：只补一次计划规则且标生效范围，不重开off；已扣款可以等份额规则。费率未知不得默认为零。
- 已付而completed：修复后enabled计划可自动收尾已扣期次，计划仍completed，不新增期次/扣款；off、取消/冲正、排除和事实冲突仍阻断。生产尚未部署：先只读列期次/在途/原授权，不批量改active或重开off；生产补扫另授权。
- 实际账单晚到：标准fund-preview→明确link/correct/skip→fund-apply；相同订单优先补证，金额/份额差异冲正替代，保留原文件、原推算和审计。同日同额不是同一交易。原确认已有后续卖出/退款时先处理依赖。
- 成交净值日：修复后标准账单显式映射nav_date并分别预览扣款/确认/NAV日；未知留空，日期差异需有原因更正。旧已处理批次不自动重解析，历史补有据日期先差异预览；不能修改原confirm.economic_date绕开资格。
- 已知NAV冲突：默认等独立origin一致；官方更正提案OD-01没有已实现操作命令，不能手工删除隔离。保存原因、来源、更正证据和受影响日期。

### 8.3 隔离复现与变更检查

已有项目依赖时运行专用审查入口；它不读取工作区`.env`、不使用55432，使用短路径私有临时状态和合成库。`init`只在该入口拥有的集群配置空库，不生成真实财务记录。端口冲突必须改为新的审查端口，不能停止别人的数据库。

```sh
.venv/bin/python scripts/audit_local.py init
.venv/bin/python scripts/audit_local.py check
.venv/bin/python scripts/audit_local.py test audit_scenarios -m audit_invariant
.venv/bin/python scripts/audit_local.py test audit_scenarios -m audit_finding
.venv/bin/python scripts/audit_local.py test tests/test_audit_repairs_20261009.py
.venv/bin/python scripts/audit_local.py probe concurrency
.venv/bin/python scripts/audit_local.py probe restart-prepare
.venv/bin/python scripts/audit_local.py probe restart-recover
.venv/bin/python scripts/audit_local.py probe restart-completed-prepare
.venv/bin/python scripts/audit_local.py probe restart-recover
.venv/bin/python scripts/audit_local.py restore-drill
.venv/bin/python scripts/audit_local.py stop
```

初始finding命令6失败，修复后原断言全部通过；29项修复回归已进入默认tests，未skip/xfail或删除旧断言。重跑prepare/concurrency新建标记合成空间；recover只处理其manifest。restore-drill仅创建/清理入口拥有的独立演练源/目标库，已有非演练同名库拒绝使用。stop停止专用审查PG，和local_dev.py stop保留开发PG不同。截图/样本均合成；审查web只绑定本机，结束后停止该进程。

每次修复按project-map影响表选定测试，再运行相应财务/权限/任务回归、Python检查、模型check/迁移差异、前端类型/测试/格式和必要页面。模型变化必须在新的隔离库owner迁移、runtime执行，不能用SQLite/owner运行通过代替RLS。实际检查命令和结果写入该批次验收；不重复无影响的全套测试。

### 8.4 重算、发布与回滚要求

本轮只给步骤，不执行生产操作。历史收益分析/Projection可重建，原Event/JournalLine/PositionMovement/SourceRecord.raw不可为了日期展示修改。真实金额/份额更正独立走冲正替代并检查后续依赖。

重算前先核对输入版本/范围和私有文件，认证备份并在独立库验证可恢复；固定算法版本、空间、日期范围、截止revision，输出旧/新每日收益、缺口、来源、汇总差异及原流水校验。预览获授权后按空间小批幂等执行并保留审计；新原始事实到来时旧预览失效。失败保留现有可用投影，可回滚到先前投影版本；不能以恢复全库来撤销几行展示结果。

发布前确认B批次断言、页面、接口兼容、迁移和备份/回滚；停止/恢复任务避免双beat，源码/产物/SHA与生产分别核对。回退代码不得删除已经生成的正确新事实；有新账务的版本回滚必须先验证读兼容与队列状态。真实数据修复、密钥轮换、生产部署/恢复均须具体授权；历史2.2清空账簿的发布命令不适用于日常升级。

当前0012原生小样本恢复已验证认证加密、文件hash、RLS/不可变/清理权限、Viewer原件权限及重复补扫，结果见[恢复证据](audits/evidence/2026-10-09/repair-restore-drill.json)。核对EvidenceLink/替代完整链、Docker、真实队列中断、规模与异地备份/告警仍未验；过去0006记录保留，不用1.903秒小样本承诺生产RPO/RTO。

### 8.5 初始化与恢复后的最小权限（AUD-007）

`scripts/database_privileges.py`是初始化/恢复授权的唯一维护位置：owner业务表可授runtime CRUD，内部`wealth_cleanup_scope`禁止PUBLIC/runtime直接访问；4个已知受保护SECURITY DEFINER函数撤销PUBLIC执行并保留应用入口。`local_dev.configure_database`与`backup.restore`事务应用同一策略；新增类似私有能力表/函数必须同时更新策略和恢复/不可变回归，不能再次使用ALL TABLES宽授权。

在已授权的环境可只读检查：`SELECT has_table_privilege('wealth_app','public.wealth_cleanup_scope','INSERT');`必须false；同时核实runtime非owner/NOSUPERUSER/NOBYPASSRLS、强制RLS和受保护函数ACL。不要在生产尝试伪造INSERT来“验证”。重复init后运行`test_administration_v25::test_immutable_and_rls_cannot_be_bypassed_with_context_flags_or_private_scope`，恢复后运行test_restore_local的权限/事实/文件断言。

生产ACL尚未核实或更改；发布前只读列权限与运行版本，认证备份、维护窗与具体授权后再修订。回滚须保留私有表REVOKE及函数保护，禁止恢复不安全的ALL TABLES授权；权限收紧不需要修改历史账务。

### 8.6 2.12.0 候选版的定位与保数据发布

待核对的状态与按钮先说明下一步，点击定位当前空间的原账户/产品/期次。余额不足进入账户核对；费用与账户配置进入计划设置；日历/份额规则进入产品；已知NAV冲突进入来源详情；确认差异进入账单核对；已有扣款疑点进入关联实账。普通waiting_nav/confirmation/date不制造人工确认。仅打开页面不会执行核对、更正、扣款或份额生成。账户核对保护说明默认折叠，需要时展开。

常规验收使用 `scripts/audit_local.py` 的离线独立数据库，以及前端测试、类型检查、格式检查、生产构建；本批必跑 `test_display_ordering.py`、`test_occurrence_navigation.py`、`business-action.test.mjs`、`date-ordering.test.mjs`、`entity-form.test.mjs`、`coin-oracle.test.mjs`。浏览器验证新增核对默认值、状态点击后的对象、最近/未来范围、铜钱六爻/重置/窄屏；不能只凭服务测试声称页面通过。

已授权发布仍需验证真实SSH访问与运行镜像；网站账户不等于服务器凭证。2.12工具位于隔离工作区 `.runtime/v212/deploy/`，继承2.11两阶段停写/指纹/认证备份流程，并新增主机backup.py/database_privileges.py冻结安装和前任快照。先验候选，再prepare停写备份；拿到认证本地副本才apply；失败不清卷/恢复旧数据冒充回滚。仅替换备份工具不会执行生产权限修订。具体冻结源码、工具测试和未运行项在[发布说明](release-2.12.0.md)记录。
