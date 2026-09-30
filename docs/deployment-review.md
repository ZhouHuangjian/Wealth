# 服务器部署审查

2026-09-25，目标为 Ubuntu 24.04、IP 直接访问。此文记录代码审查和本地配置验证；服务器是否部署成功应以实际发布记录为准。未读取或记录真实数据库、SSH 或备份密码。

## 本次部署必要配置

1. **HTTPS 与入口隔离。** `DJANGO_DEBUG=0` 时会话与 CSRF Cookie 都为 Secure；必须使用 HTTPS。Nginx 在宿主终止 TLS，应用保持 `127.0.0.1:8000`，数据库和 RabbitMQ 不映射主机端口。代理须覆盖 `X-Forwarded-Proto`，不能照搬客户端请求头。生产 `.env` 设置 `WEALTH_TRUST_PROXY=1`、`WEALTH_FORCE_HTTPS=1`、`WEALTH_HSTS_SECONDS=3600`，并准确填写公网 IP 和 `127.0.0.1` 的 allowed hosts、HTTPS CSRF origin。应用健康检查允许回环 HTTP。
2. **空库初始化不可先公开。** `/api/v1/auth/setup` 在没有用户时允许创建首用户。必须先在服务器私有命令中创建独立随机密码的应用用户、账簿及 owner 成员关系，再开放公网入口；不能复用 SSH 密码。`createsuperuser` 只创建用户，不会自动建立账簿。之后应验证 `setup_required=false`。
3. **证书续期。** Let's Encrypt 已支持 IP 证书；Certbot >=5.4 可用 webroot 与 `--ip-address`、`--preferred-profile shortlived` 签发。证书有效期约六天，必须配置自动续期和 Nginx reload hook，并验证挑战路径在 80 端口可达。IP 证书不使用 HSTS 子域和 preload 配置。[官方说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)
4. **角色与持久化。** 迁移使用 `wealth_owner`，网页和任务使用 `wealth_app`；运行角色必须为非 owner、非 superuser、无 BYPASSRLS。首次启动顺序为 db/rabbitmq 健康、迁移、私有初始化、web/worker/唯一 beat。账本、私有文件、队列、beat 状态均须保留命名卷。已有数据不能用 `down -v` 重建。
5. **日志与备份。** Gunicorn access log 已改为只记录 URL path，不记录 query，防止邀请令牌进入日志；Nginx 应同样用 `$uri` 而非 `$request`/`$request_uri`。备份密钥必须在项目和备份目录之外、权限 0600。`scripts/backup.py` 会短暂停止应用写入，数据库与文件一起加密；须验证备份后服务恢复，并安排调度。仅本机备份不能替代异地备份。

## 已修改的部署基线

- `backend/config/settings.py`：增加显式代理信任、HTTPS 跳转、HSTS 参数和健康检查例外；启用原本只设值但未生效的 `XFrameOptionsMiddleware`。默认不开启代理信任、跳转和 HSTS，保持本地 HTTP 开发可用。
- `compose.yaml`：传入上述三个环境变量；access log 不记录 query 或 Referer。
- `Dockerfile`：从 `backend/requirements.lock` 安装已固定版本的 Python 依赖，以镜像内非 root 用户执行 `collectstatic`；构建期仅使用固定的非秘密占位密钥，该值不成为运行时环境变量。前端仍通过 WhiteNoise 的构建目录提供，私有账单不公开。

## 本地验证

Ruff 格式与关键错误检查通过。中间件验证通过：HTTP 首页跳 HTTPS、可信代理 HTTPS 不循环跳转、HSTS 响应头、`X-Frame-Options: DENY`、两种健康路径不跳转、普通 API 仍跳转。默认本地模式不信任代理头、不跳转、不产生 HSTS。

使用生产参数执行 Django deployment checks，仅剩 `security.W005` 与 `security.W021`，分别提示未开启 HSTS 子域和 preload；对 IP 部署有意不启用。这不代替服务器端证书、Cookie、CSRF、数据库权限和后台任务检查。

## 发布时需补齐的实际证据

- `https://124.223.23.76/`、健康 API、编译后 JS/CSS 正常，HTTP 跳转到 HTTPS，证书链与 IP SAN 正确。
- 登录成功且会话/CSRF Cookie 有 Secure 属性；写接口通过 CSRF、未登录接口拒绝访问、初始 setup 关闭。
- 用真实运行角色检查 RLS 和已有迁移；web、worker、beat、db、rabbitmq 均健康，任务可执行且 beat 只有一个。
- 首次加密备份可校验；续期任务和备份调度已启用；磁盘和日志保留受控。容器重启不丢失配置、数据库及私有文件。

完整容量、跨浏览器、机构真实样本等原有产品验收缺口不会因完成部署而自动关闭。

## RabbitMQ 4.3 与 Celery 5.6 兼容配置

服务器首次启动发现控制队列声明被 RabbitMQ 4.3 拒绝。该版本默认不再允许非持久、非独占的队列，也不再允许 global QoS。已使用 Celery 5.6.3 / Kombu 5.6.2 原生配置解决，不开启 RabbitMQ 废弃功能：控制命令、回复与事件队列设为独占；持久任务队列使用新的 `wealth.tasks` quorum 队列，开启 publisher confirm，并让 Celery 检测 quorum 后关闭 global QoS。新队列名避免覆盖已有 classic `celery` 队列，旧队列保留。单节点 quorum 仍然只是单节点部署，不代表跨服务器高可用。

本地直接加载真实 Celery 应用配置并检查实际构造对象：控制、回复、事件队列均 `exclusive=True` 且非 durable；任务队列为 durable quorum；投递路由进入 `wealth.tasks`；publish confirm 已开启；Celery Tasks bootstep 的 global QoS 判断返回 False。Ruff 检查通过。这些是无需连接 broker 的配置验证，实际 worker ping、任务完成和 outbox 清空仍需服务器实测。

依据：[Celery 5.6 配置](https://docs.celeryq.dev/en/v5.6.0/userguide/configuration.html#task-default-queue-type)、[RabbitMQ 废弃功能列表](https://www.rabbitmq.com/release-information/deprecated-features-list)。
