# 拾财服务器部署记录

## 2.11.0 当前发布

2026-10-08 08:23:30（北京时间）完成 AKShare 公共行情渠道的保数据部署与验收。AKShare 已启用，置于基金、股票、ETF、期货及期权来源链末尾；无需 Token，原顺序、凭证及代管授权未修改。访问 [系统](https://124.223.23.76/)。

最终镜像 `sha256:28012e1f860cb6d0390129437fa2de0c1091389fa84c7d9685b6b630f15dc19d`，应用提交 `0103fc8e0306875781f3f722d5b93f06e37a369b`，发布目录 `/opt/wealth/releases/2.11.0-20261008/`。完整后端 1,447 项及 12 项子测试、关键回归 408 项、前端 152 项与合成浏览器 7 项通过。40 张表、4 个会话、11 个序列和文件完整保留，无迁移或重置；五个服务健康，任务与备份定时器正常。

生产 14 个只读空间接口、数据源目录、HTTPS 与 20 个前端文件通过核验。加密备份在服务器和本地均认证通过。实际 SDK 基金、ETF、期货与期权示例可用，股票示例此次上游不可用，按规则保留备用切换。详细源码、备份、验收哈希及能力边界见 [2.11.0 发布记录](release-2.11.0.md)。下文保留历史发布状态，不代表当前配置。

## 2.10.0 历史发布

2026-10-07 20:19（北京时间）完成保数据部署及线上验收。新增三家基金公司人民币普通基金正式净值、可配置订阅来源、净值冲突隔离及实际基金交易核对。公开数据不能读取个人成交；实际确认通过标准 CSV/XLSX 关联已有申购。访问 [系统](https://124.223.23.76/)。

最终镜像 `sha256:dadac5705b3aafe92df46044cc7599ee7a807187659217c01189887118a4d4d4`，应用提交 `2a05af955da3c1a2052bb6e6c1229357709e90a1`。完整后端 1,370 项及 12 项子测试、前端 145 项、隔离浏览器 18 项通过；全部 40 张表、4 个登录会话、11 个序列与保留文件核对一致，无迁移或数据重置。14 个生产只读接口、数据源目录和 20 个公网前端文件验收通过；五个服务健康。订阅 Token 未配置，原代管授权保持不变。备份、源码绑定及验证边界见 [2.10.0 发布记录](release-2.10.0.md)。

前两版为 [2.9.1](release-2.9.1.md) 与 [2.9.0](release-2.9.0.md)，下文继续保留较早的部署历史。

## 2.8.0 历史发布

2026-09-30 12:53（北京时间）完成保数据部署及线上只读验收。定投一次设置后自动补记扣款和推算份额，正常期次不再逐笔确认；调整日/周/月假期策略、QDII净值日期与收益展示，并精简首页、持仓和表单布局。访问 [系统](https://124.223.23.76/)。

最终镜像通过217项关键回归；两个空间23项只读投影、43份待确认金额汇总与19个公网前端文件核验通过。40张表、5个会话、序列及文件保留；五个服务健康，未修改数据库迁移或清空数据。镜像、加密备份及版本修正证据见 [2.8.0 发布记录](release-2.8.0.md)，上一版本见 [2.7.0 发布记录](release-2.7.0.md)。下文保留历史记录。

## 2.6.4 历史发布

2026-09-28 22:19（北京时间）完成保数据部署及九项生产只读查询、公网HTTPS核验。按计划定投补录、正式净值份额推算与持仓更新接入五分钟后台任务；现有计划须主动启用。隔离服务器167项测试通过，五个服务健康，40张表、会话、文件、序列保留。备份和镜像证据见 [2.6.4 发布记录](release-2.6.4.md)。

## 2.6.3 历史发布

2026-09-28 21:51（北京时间）完成保数据部署，21:52 完成五类生产只读查询和公网 HTTPS 验证。首页新增每日投资收益与明细，持仓支持列配置、置顶排序及分币种汇总。镜像、备份及 40 张表保留证据见 [2.6.3 发布记录](release-2.6.3.md)。

## 2.6.2 历史发布

**2026-09-28 18:55（北京时间）已发布 2.6.2**，18:56 完成公网及现有生产空间只读核验。修复待办读取、账本标签切换和后补标签归集；增加持仓买卖、两位小数展示及基金申购共同开放日规则。

镜像 `sha256:7eb3b686635f85615ebdf22801d816ca3b534da0d61ec4ea0e3e1ce7d6605c85`，标签 `wealth:release-2.6.2-20260928`，目录 `/opt/wealth/releases/2.6.2-20260928/`。本版没有数据库迁移；40 张表、会话、文件和业务序列在切换前后保持一致。五个服务 healthy，18 个公网前端产物与候选匹配。

服务器关键 139 项、前端 83 项、发布保护 9 项及本地后端完整回归通过。加密备份 `/var/backups/wealth/wealth-20260928T105444Z.backup.enc` 在服务器和本机认证校验通过，SHA-256 `f17ea145445859a74f152927c5b7e5039af605efa420b52ea2383f88f20a26aa`。详细证据见 [2.6.2 发布记录](release-2.6.2.md)。

## 2.6.1 历史发布

**2026-09-28 13:15（北京时间）已发布 2.6.1**，13:16 完成 HTTPS 只读验收。增加管理员业务回收记录彻底删除、完整业务字段编辑、存量持仓资金更正、期初日期合并编辑及账簿/用户名修改。未录入持仓与占用资金的期货账户可按已记录权益推算可提取金额；已有线上账户已验证生效。

镜像 `sha256:bfa5a21b505c5a7d5e0f4557dd619a9388f802ebc4523abc52fec9d691963c03`，标签 `wealth:release-2.6.1-20260928`。原业务数据、会话、文件与业务序列保全通过；0011 仅新增受控清理函数，没有执行生产记录删除。五个服务 healthy，18 个公网前端产物与候选匹配。

服务器关键 220 项、最终完整回归 1059 项及 12 项子测试、前端 79 项、运维保护 17 项通过。加密备份 `/var/backups/wealth/wealth-20260928T051421Z.backup.enc` 在服务器和本机认证校验通过，SHA-256 `96fcc451872791f820142482fab95e839947019ec5e4f2e2da1a3b376d0b2a9b`。详细证据见 [2.6.1 发布记录](release-2.6.1.md)。

## 2.6.0 历史发布

**2026-09-28 08:32（北京时间）已发布 2.6.0**，08:33 完成只读 HTTPS 核验。管理员代管空间内新增统一业务管理入口，支持 22 类业务维护；页面减少重复提示和重复确认表单，修正窄窗口边界。当前镜像 `sha256:9e6d12a7b1467ac5aedfc95d8bbaf4ca350fd5b075271a14b82ffea0ce983f96`，标签 `wealth:release-2.6.0-20260928-ui`，发布目录 `/opt/wealth/releases/2.6.0-20260928-ui/`。

后端本地/服务器完整回归均为 979 项及 12 项子测试；最终页面版本的 115 个后端文件与完整回归版本一致。最终候选关键 115 项、前端 77 项、运维保护 9 项通过。40 张表、会话、序列、私有文件与调度文件在停写切换前后保持一致；没有清库、生产迁移或清空队列。五个服务 healthy，17 个公网前端产物与候选构建逐字节匹配。

备份 `/var/backups/wealth/wealth-20260928T003140Z.backup.enc` 已在服务器和本机完成认证校验，SHA-256 为 `94ab61c283ed30da57ab880f043c912f15f715a0509cf5a5200b79dfaac3a4f3`。浏览器操作使用独立合成数据，未修改生产账簿。详见 [2.6.0 发布记录](release-2.6.0.md)。

## 2.5.5 历史发布

**2026-09-28 01:15（北京时间）已发布 2.5.5**，支持期初日期更正及账户/产品可恢复删除。该版镜像 `sha256:750010546c31fa5b6a068f3f70ce9489322df5916847cc3ef3b1be1dfb77cb5c`，标签 `wealth:release-2.5.5-20260928-ui`。原始财务事实保留，恢复不重复产生金额，关联业务阻止误删。

后端本地/服务器均通过 958 项及 12 项子测试；最终页面调整的 113 个后端文件与全套回归版本一致，最终候选关键 94 项、前端 77 项通过。完整保数据切换、双地认证加密备份、浏览器操作与布局已有证据，详见 [2.5.5 发布记录](release-2.5.5.md)。

## 2.5.4 历史发布

**2026-09-28 00:36（北京时间）已发布 2.5.4**。定投补录改为自动检查和一次总确认，整理摘要、提示与长表单布局。按要求先部署再完成验证：本地/服务器完整回归均为 889 项、12 项子测试，前端 71 项、保数据运维 9 项通过，浏览器一次确认及重复跳过通过。

40 张表、会话、序列和私有/调度文件完整保留，未清库或执行生产迁移。五服务健康，可信 HTTPS 与 14 个前端文件匹配。镜像 `sha256:77e0ece3e6bf509af40a0749e07b34c29dfbc0575dbee69a085647473b634d4a`。加密备份 `/var/backups/wealth/wealth-20260927T163453Z.backup.enc` 已在服务器与本机认证校验；详见 [2.5.4 发布记录](release-2.5.4.md)。

## 2.5.3 历史发布

**2026-09-27 23:59（北京时间）已发布 2.5.3**，历史定投估算后新增实际记录核对与确认补录。按用户要求先部署，再完成完整回归和隔离浏览器验收；本地与服务器均为 857 项测试、12 项子测试通过，前端 66 项通过。

40 张表、会话、序列、私有与调度文件完整保留，无清库、队列清空或生产迁移。五个服务健康，可信 HTTPS 与 14 个前端文件匹配。镜像 `sha256:da0dddded34d09cb4d80aa11a001f74c499dadf00b2aa70ec7845cbf3edc2709`。备份 `/var/backups/wealth/wealth-20260927T155835Z.backup.enc` 已在服务器与本机认证校验。详见 [2.5.3 发布记录](release-2.5.3.md)。


## 2.5.2 历史发布

**2026-09-27 23:26（北京时间）已发布 2.5.2**，增加历史每日基金定投估算与极小零金额占位持仓安全冲正。40 张表、会话、序列、私有与调度文件在停写切换前后完整保留；未清库、未清消息队列、未执行生产迁移。五个服务健康，可信 HTTPS 和 14 个前端文件精确匹配。本地与服务器均为 819 项后端测试、12 项子测试通过，前端 60 项通过。

镜像 `sha256:f45d4b8c66debefd2684eab3bef4b9d754b6aa6c1cdc4b8b64946f608ad393fb`，备份 `/var/backups/wealth/wealth-20260927T152453Z.backup.enc` 已在服务器与本机认证校验。详见 [2.5.2 发布记录](release-2.5.2.md)。

## 2.5.1 历史发布

**2026-09-27 23:01（北京时间）已发布 2.5.1**，保留现有数据。40 张表、登录会话、序列及私有/调度文件在停写切换前后指纹一致；五个服务健康，可信 HTTPS 和全部前端产物通过核验。镜像 `sha256:fe610ef54d83f12fa85c89145a3848e49c1b842f247b4704a37b492de15a8bfa`，完整回归 774 项、12 项子测试；详见 [2.5.1 发布记录](release-2.5.1.md)。

## 2.5 历史发布

**2.5.0 已于 2026-09-27 21:37（北京时间）部署到 [HTTPS 入口](https://124.223.23.76/)**。本轮按用户要求清空旧普通用户、所有空间及业务数据；原平台管理员账号和密码保留，管理员不再拥有私人空间。

机构资金按市值拆分持仓；数据日期与正式/估算口径独立记录；名词帮助可配置。管理员没有成员身份，通过明确的代管入口管理用户账簿。旧普通用户及全部空间已清空，个人记账须另建普通账号。

本地和服务器后端均为 673 项测试、12 项子测试通过，前端 35 项通过。五服务健康；迁移至 0010；可信 HTTPS、原管理员登录、零普通用户/空间和前端产物一致性均核验通过。

备份 `/var/backups/wealth/wealth-20260927T133553Z.backup.enc` 已在服务器和本机认证校验。发布材料在 `/opt/wealth/releases/2.5-20260927/`，镜像 `sha256:5ef49c009c019940755202aa5928222922da933d6f685afcd9dd028eb06a935c`。回退数据必须恢复备份，单独回退镜像不能找回已清空账目；详见 [2.5 发布记录](release-2.5.md)。下文为历史部署证据，不代表当前仍保留旧空间或账务。

## 历史 2.4 发布

**2.4.0 已于 2026-09-27 20:35（北京时间）部署到 [HTTPS 入口](https://124.223.23.76/)**。已有账号、权限与账目保留；新增分红核对、空间回收站、邀请码注册、配置参考和管理中心。 五个服务健康，36 张既有表内容核验相同，备份为 `/var/backups/wealth/wealth-20260927T123427Z.backup.enc`。构建与发布材料在 `/opt/wealth/releases/2.4-20260927/`，详细证据与回退说明见 [2.4 发布记录](release-2.4.md)。以下按时间保留历史部署过程。

以下为旧版环境说明；初次部署日期为 2026-09-25，相关账号和空间状态已经被本次 2.5 数据重置取代。访问地址：**https://124.223.23.76/**。已按用户要求使用 IP，并取得浏览器信任的 Let's Encrypt IP 证书。HTTP 自动跳转到 HTTPS。

独立应用账号为 `admin`，所属账簿为“我的账簿”。初始密码保存在部署电脑的 `.runtime/deploy/服务器访问资料.txt`（0600），不写入此文档、源码或镜像；应用密码与服务器 SSH 密码不同。主账簿没有演示余额和测试交易。应用中的计划、还款提醒不会向银行发起扣款。

这次完成的是服务器部署及下述运行验证，不等于 V2 全部 P0 验收通过。机构账单适配、行情与性能等边界仍以 [开发与验收状态](development-status.md) 为准。

## 历史 2.3.0 升级（2026-09-27 19:38）

此次保留现有数据，增加产品识别和交易日规则、可调整导航、缓存候选目录与平台管理，详见[2.3 发布记录](release-2.3.md)。

- 镜像 `wealth:release-2.3-20260926`，ID `sha256:06f0d6236a0e87e0fa00566fbf242a63567815e5d00c3327c2834e24d2a3e7e0`；前端 `index-D20my1MJ.js` / `index-Cxqla7YX.css`。
- 本地与服务器最终完整回归均为 511 passed、12 subtests；前端 21 项测试、类型/格式及构建通过；运维脚本 5 项测试通过。
- 停写后备份 `/var/backups/wealth/wealth-20260927T113816Z.backup.enc`，SHA256 `f50cf5d75bfd79cdba5abd72d67d3f0dc531f6afd966ee9609b87c9c4dbea610`；加密副本已复制本机并校验。
- 0008 仅新增平台控制相关表。升级前后全部租户财务表、账簿、成员及用户身份/密码指纹相同；原应用登录信息保留。现有 admin 被明确授予平台管理员权限。
- HTTPS/API 验证、五个主服务健康、运行角色无 superuser/BYPASSRLS、单实例 beat、备份和证书 timer 均通过。
- 记录 `.runtime/v23/deployment-record.json` 与服务器 `/opt/wealth/deployment-record-v2.3.json`；回退镜像 `wealth:rollback-before-2.3-20260926` 保留。

下面的 2.2 数据清理仅为历史操作，不适用于本次升级。

## 历史 2.2.0 升级（2026-09-25 23:26）

本轮增加昨结与今日估算净资产、配置标签与目标占比、市场自选及条件提醒，调整导航和中文业务说明；具体计算口径及限制见 [2.2 发布记录](release-2.2.md)。

- 当前镜像 `wealth:release-2.2-20260925`（`wealth:local` 同指向），ID `sha256:5fe51df62dd7ff0c8f47bde449343746c7996703a554652b4353032297a9914e`；前端 `index-CrcblGEe.js` / `index-CbKBHRWY.css`。
- 生产迁移已至 `0007_market_symbol`。公开目录 27,981 条（基金 27,954）；目录每日更新，持仓行情及条件检查每 300 秒扫描。公共目录不存租户私有资料。
- 本地完整回归 358 passed、12 subtests；最终生产候选在独立 `wealth_v22_release_test` 迁移与定向验收 174 passed，43.45 秒；后端 65 文件哈希与清单匹配。
- 按用户授权在停止 web/worker/beat 后清空所有 20 个租户业务表、旧会话、附件与 beat 状态，清除主队列及延迟队列历史消息；事务核验保留 2 用户、2 空间及 2 成员关系。两空间发布后账户、产品、事件、持仓变动、资源与 outbox 均为 0，revision 为 0。
- 清理前新建加密备份 `/var/backups/wealth/wealth-20260925T152528Z.backup.enc`，SHA256 `ab20564cde84bceba6866e334eccbfca7c6a17aeebcd36525d1bb13dd648b4f8`；本机副本 `.runtime/v22/backups/`，两端认证校验通过。未覆盖或删除历史备份。
- 五个服务 healthy，运行数据库角色 `wealth_app` 无 superuser/BYPASSRLS，单实例 beat；备份及证书 timer active。HTTPS 真实 CSRF 登录、新增净资产/配置/观察/提醒 API、公共目录、退出及未登录拒绝通过，health 返回 2.2.0。
- NDX/SPX/VIX 现价与历史数据从服务器取得，豆粕期权/期货及基金价格有效；H30269 的公开行情接口当前断连，保留暂不可用状态，不能承诺实时覆盖。
- 回退镜像 `wealth:rollback-before-2.2-20260925` 保留。只回退应用可保留新增目录表，但不会恢复清空的数据；恢复旧账簿须按加密快照恢复流程执行，并考虑上线后新增记录。
- 最终运行记录 `.runtime/v22/deployment-record.json`，服务器副本 `/opt/wealth/deployment-record-v2.2.json`。本轮未向主账簿录入合成测试交易。

以下 2.1 及首次 2.0 记录均为历史证据，历史数据数量、镜像和验收数量不代表当前版本。

## 历史 2.1.0 升级（2026-09-25 21:36）

本次升级完成用户要求的资产与投资合并、产品和账户关联、已有持仓录入、收益日历、自动行情、首页分类估值、期货账户筛选、按钮及文案清理、凭证选填。逐项口径见 [2.1 发布说明](release-2.1.md)。

- 当前镜像标签：`wealth:release-2.1-20260925`，`wealth:local` 指向该镜像。
- 当前镜像 ID：`sha256:a506ff67c9ec7f10ca0967e8186623cf938490d24fa322f86d3eb100572eee5f`。
- 前端主包 `index-BOZRLKm7.js`；没有新增数据库迁移，仍为 0001–0006。
- 候选镜像先在独立 `wealth_v21_test` 运行完整回归：244 passed、12 subtests，102.86 秒。未在主账簿添加测试账户或交易。
- 升级前执行并验证加密备份 `/var/backups/wealth/wealth-20260925T133010Z.backup.enc`，SHA256 `381269eafa7081091a3c9c3c0d226fc9f7a89268a249a2cc8ef7188e3ac26ed3`。本机副本为 `.runtime/v3/backups/`，密钥沿用独立密钥。
- 回退镜像保留为 `wealth:rollback-before-2.1-20260925`。本次无结构变更，需要回退时可停止应用三服务、将此标签重新标为 `wealth:local`，再 `docker compose up -d --wait web worker beat`；不删除数据卷。
- 切换前后六类表摘要完全一致：用户、账户、产品、事件、分录、持仓变动。核验时保留 1 用户、2 账户、1 产品、2 事件、4 分录。登录检查会正常更新登录时间，不属于账务改写。
- 五服务健康，HTTPS 证书及安全响应头正常。真实 CSRF 登录、Secure Session、新增持仓/日历/行情/估值 API、退出及未登录拒绝通过，Chrome 实际显示新版登录页。
- 新行情任务在 worker 注册，单实例 beat 配置每 300 秒扫描；实际后台刷新已为原有产品取得报价及 10 条历史数据，事件保持 2 条，outbox 无待处理项。十个基金/QDII/沪深港美股票/境内期货/ETF 期权/XAU 样本已从服务器取得有效源数据。
- 备份与证书续期 timer 继续启用，未改动原账号密码、SSH 设置或数据卷。最终记录为 `.runtime/v3/deployment-record.json` 与服务器 `/opt/wealth/deployment-record-v2.1.json`。

下文首次 2.0 部署与初始空账簿恢复记录保留为历史证据，不代表升级时主库仍为空。

## 环境与布局

| 项目 | 部署值 |
| --- | --- |
| 主机 | Ubuntu 24.04.4 LTS，amd64，时区 Asia/Shanghai |
| Docker / Compose | 29.1.3 / 2.40.3 |
| 入口 | Nginx 1.24.0，公网 80/443 |
| 应用 | Python 3.13.15、Django 5.2.17、Celery 5.6.3；容器 uid 10001 |
| 数据库 / 队列 | PostgreSQL 18.6 / RabbitMQ 4.3.6；只在 Compose 内网监听 |
| 服务 | `web`、`worker`、单实例 `beat`、`db`、`rabbitmq`，均有健康检查及 `unless-stopped` 重启策略 |
| 应用端口 | 仅宿主 `127.0.0.1:8000`，经 Nginx 转发 |
| 源码与 Compose | `/opt/wealth`，Compose project 名为 `wealth` |
| 环境配置 | `/etc/wealth/runtime.env`，`/opt/wealth/.env` 为其符号链接 |
| 私密目录 | `/etc/wealth` 0750；环境与备份密钥 0600；归档目录 `/var/backups/wealth` 0700 |
| 数据卷 | `wealth_postgres_data`、`wealth_private_media`、`wealth_rabbitmq_data`、`wealth_scheduler_data` |
| Nginx 配置 | `/etc/nginx/sites-available/wealth` |
| 备份用户 | `wealth-ops`，不可交互登录，具备 Docker 操作权限 |

Docker 与 Nginx 已设置开机启动，备份和证书续期 timer 已启用。未执行整机重启演练。没有修改服务器 SSH 密码或全局 SSH known_hosts。

迁移角色 `wealth_owner` 与业务运行角色 `wealth_app` 分离。业务角色不是表 owner，没有 superuser/BYPASSRLS。迁移 `0001_initial` 至 `0006_immutable_audit_history` 已执行。`DJANGO_DEBUG=0`，启用 Secure Cookie、CSRF、受控代理头、HTTPS 跳转、HSTS、DENY 防嵌入及 nosniff；访问日志不记录查询参数。

## 首次 2.0 发布构建（历史）

首次发布标签：`wealth:release-20260925`。当时运行时 `wealth:local` 指向同一镜像，旧镜像 ID 为：

```text
sha256:89d245c6711db3fc80ae6fdcc2f9b64bc2db96d8406aa3ae3bd177d6bfbce3b4
```

后端依赖由 `backend/requirements.lock` 固定 45 个版本，前端使用 `npm ci`。服务器访问 PyPI 时部分下载不稳定，因此在部署电脑从官方 PyPI 下载并校验 Linux/CPython 3.13 wheels，传至 `/opt/wealth/wheels`，通过 `Dockerfile.offline` 安装。应用版本没有因此降级或替换为其他包源。该文件只将 Dockerfile 的 pip 安装替换为 BuildKit 只读挂载 wheels 后的离线安装，Node 与基础镜像仍需可用或已缓存。

原始 wheels 归档 SHA256：

```text
463dd050c6e2be2e5a675f11e793c36230b27377ff14c0bedd9278fe1d45a4d7
```

服务器配置了腾讯云 Docker 镜像加速地址 `https://mirror.ccs.tencentyun.com`。具体版本及源码哈希保存在 `/opt/wealth/deployment-record.json` 和 `/opt/wealth/source-manifest.json`；源码清单涵盖发布文件，不包含密钥、用户数据、node_modules 或虚拟环境。

RabbitMQ 4.3 的兼容修复采用 Celery 原生配置：任务队列 `wealth.tasks` 使用 quorum、发布确认及对应 QoS；控制/回复/事件队列使用独占方式。未开启已废弃的 transient non-exclusive 队列兼容开关。首次失败启动遗留的旧 `celery` 队列保留供排查（核查时 8 条消息、0 个消费者），不再接收新任务；新任务队列有 1 个消费者、无积压，初始化业务任务已经完成。

## TLS 续期

证书路径 `/etc/letsencrypt/live/124.223.23.76/`，Certbot 位于 `/opt/wealth-certbot`。首次证书有效期为 2026-09-25 07:23:21 UTC 至 2026-10-01 23:23:20 UTC。IP 使用短期证书，因此不能按通常的三个月有效期理解。

`wealth-certbot.timer` 每 6 小时检查一次，最多错峰 15 分钟，续期成功后校验并重载 Nginx。`certbot renew --dry-run` 已成功验证挑战和部署钩子；80 端口的 ACME 路径需持续可达。没有配置外部证书到期通知。

```sh
systemctl list-timers wealth-certbot.timer
journalctl -u wealth-certbot.service --since yesterday
/opt/wealth-certbot/bin/certbot renew --dry-run --no-random-sleep-on-renew --run-deploy-hooks --deploy-hook "/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx"
```

## 备份与恢复证据

`wealth-backup.timer` 每天当地时间 03:00 加最多 15 分钟错峰执行，补跑错过的计划。备份短暂停止 web、worker、beat，完成后恢复原状态；用户可能短暂无法访问。归档包含数据库、私有附件和哈希清单，认证加密密钥独立存放在 `/etc/wealth/backup.key`。

首次 systemd 执行已成功，`Result=success`、`ExecMainStatus=0`：

```text
/var/backups/wealth/wealth-20260925T093105Z.backup.enc
SHA256 a25e236baa31251f300ef1052f6c5583a1689433557cf1d81b5bd5e70e9cb13b
```

初次加密快照另存于部署电脑 `.runtime/deploy/backups/`，密钥副本位于项目之外的 `/Users/zhouhuangjian/.wealth-secrets/wealth-124.223.23.76/backup.key`（0600）。**每日自动备份当前只写服务器本地**；未设置自动异地同步、保留删除策略或外部失败通知。密钥与归档应分别妥善保管。

已把该快照恢复到新 Compose project `wealth-restore-check-20260925` 的空数据库和新私有文件卷，未覆盖主库。恢复核验与主库结果一致：

- 1 个应用用户、1 个 Owner 账簿；0 个金融账户、0 条经济事件、0 条分录，净资产为 0。
- 6 个应用迁移保留；业务角色非 owner、非 superuser、无 BYPASSRLS。
- 事件、outbox、投影表强制 RLS；无空间上下文和另一个空间上下文均不能读到存在的 outbox 与投影。
- 初始化 outbox 一次投递后状态 `done`，无错误；投影 revision 为 1，与账簿一致。
- 认证解密、数据库归档和附件清单校验通过；当前空账簿有 0 个私有文件。

核验后只清理了本次独立恢复 project 与测试数据库 `wealth_deploy_test`。原生开发恢复演练另覆盖合成交易与附件，见 [运行手册](RUNBOOK.md)。本次小库恢复不代表生产容量 RPO/RTO 已达标。

## 已执行验证

| 项目 | 结果 |
| --- | --- |
| 容器后端整套测试 | 独立 `wealth_deploy_test`，业务运行角色，137 passed、12 subtests，79.37 秒 |
| 最后一次队列配置变更 | 本地任务测试 13 项通过，真实 RabbitMQ worker ping 成功，主库 outbox 已完成 |
| 服务 | 五服务健康；数据库和队列未映射公网端口 |
| 公网 HTTPS | 系统 CA 验证通过，HTTP 301，生产 health、JS/CSS、CSRF 登录、Secure Session、Owner 总览、账户/事项/任务接口、退出及未登录拒绝均通过 |
| 浏览器 | Chrome 实际打开 IP HTTPS 登录页，布局正常，无证书拦截 |
| 首次初始化 | 公网 setup 已关闭，不允许他人抢先创建首个 Owner |
| 续期 | Certbot dry-run 成功 |
| 备份与恢复 | 实际 systemd 加密备份成功、独立 Compose 恢复与权限/数据核验一致 |

部署检查仅保留 `security.W005`、`security.W021` 两条 HSTS 子域/preload 提示：IP 部署未启用这两项。远程 GitHub Actions、真实队列故障恢复、完整浏览器矩阵、真实机构样本及千万级/20 并发测试仍未完成。

本机可复查证据为 `.runtime/deploy/https-verification.json`、`.runtime/deploy/restore-verification.json`、`.runtime/deploy/deployment-record.json`。不对外公开这些运行目录。

## 日常运维与升级

以下命令在服务器执行，不需要把环境文件内容输出到终端：

```sh
cd /opt/wealth
docker compose ps
docker compose logs --tail=100 web worker beat
systemctl list-timers wealth-backup.timer wealth-certbot.timer
journalctl -u wealth-backup.service --since yesterday
df -h / /var/backups/wealth
```

重启应用使用 `docker compose restart web worker beat`，重启全部服务使用 `docker compose restart`；命名数据卷保留。**不要对正式 project 执行 `docker compose down -v`**。

升级前先运行并确认 `systemctl start wealth-backup.service` 成功。保存旧镜像标签，审核迁移，在维护窗口构建并部署：

```sh
cd /opt/wealth
docker compose stop web worker beat
docker build -f Dockerfile.offline -t wealth:local .
docker compose --profile tools run --rm migrate
docker compose up -d --wait web worker beat
```

如果依赖锁改变，需先更新并重新校验 wheels；不能沿用旧 wheel 集合假定可构建。若改用在线构建，按主 `Dockerfile` 构建并保留版本锁。升级应重新运行公网与任务检查，更新发布标签和哈希记录。数据库结构变更后的回滚必须按相应迁移策略执行，不能只换回应用镜像。

需要重设应用密码时由运维人员交互执行 `docker compose exec web python manage.py changepassword admin`；不要把密码作为命令行参数或写入源码。该账号是应用账簿 Owner，不是服务器 root 或 Django 超级用户。
