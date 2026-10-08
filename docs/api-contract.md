# Wealth API 契约（当前实现）

契约日期：2026-09-25，覆盖 2.2 候选代码；最终部署与验收状态见 [2.2 发布记录](release-2.2.md)。本文按 `backend/wealth/views.py`、`ledger.py`、`imports.py`、`planning.py`、`reporting.py`、`investments.py`、`market_sync.py`、`market_data.py`、`catalog.py`、`portfolio.py` 与 `insights.py` 的实际实现编写，供联调与回归使用；不代表该版本已在目标服务器发布。

**当前采用 Django 同源会话接口。虽然依赖中包含 DRF / drf-spectacular，但尚未暴露或核验覆盖这些函数视图的自动 OpenAPI schema；本文不是自动生成接口的声明。**

## 2.10.0 增量契约

- `GET /admin/data-sources`：来源目录增加 `category` 与安全的 `credential` 状态（required/configured/version/status），不返回 Token 或密文。
- `PUT /admin/data-sources/{provider}/credential`：管理员提交 `{version, token}`；`DELETE` 提交 `{version}`。只支持 `tushare_fund`、`lixinger_fund`，需要 `Idempotency-Key`；普通用户不得访问。启停/排序继续用原数据源配置接口。
- `GET /spaces/{s}/market/quotes`：增加 `data_quality`、`provider_observations`、`provider_attempts`、`nav_quarantine`、`retained_previous_quote`。差异时 price 可能为之前安全值，必须同时显示状态与其原净值日。
- `POST /spaces/{s}/imports`：上传 `source=standard_fund` 的 CSV/XLSX。
- `GET /spaces/{s}/fund-reconciliation/settings?account_id=...`：返回字段、别名及该账户保存的映射。
- `POST /spaces/{s}/imports/{id}/fund-preview`：`account_id`、可选 `instrument_id`/`funding_account_id`、`mapping`/`save_mapping`；部分处理后可仅提交 `{refresh_only:true}` 重新核对。`GET` 同路径支持 `offset`/`limit`。返回上下文、版本、账簿修订、预览哈希、行及汇总。
- `POST /spaces/{s}/imports/{id}/fund-apply`：带幂等键，提交 `preview_version`、`ledger_revision`、`preview_hash`；省略 decisions 时只绑定可自动匹配的行。显式 decisions 为 `{row_id,action:link|correct|skip,debit_event_id?,reason?}` 数组。更正需要原因与完整实际确认字段；陈旧预览 409，不完整/冲突不会部分留下金融写入。

基金核对属于来源导入权限，不开放给只读成员。代管仍要求空间所有者当前授权，失效授权也不能重放过去的写入。金额、份额、净值保持精确十进制字符串；未知不是零。完整业务行为及尚未接入范围见 [2.10.0 发布说明](release-2.10.0.md)。

## 1. 基础规则

- 基础前缀：`/api/v1`。空间内路径使用 `/api/v1/spaces/{space_id}/...`，UUID 来自服务端返回，不由客户端推算。
- 默认 `Content-Type: application/json`；上传采用 `multipart/form-data`。JSON 顶层须为对象，不能传数组或 `null`。
- 金额、数量、价格、汇率、利率统一使用十进制字符串，例如 `"1000.00"`、`"0.03"`。金额原始输入最多 12 位小数，数量/价格/汇率最多 18 位小数，均受总位数限制。实现兼容整数输入，但客户端仍应统一发字符串；浮点 JSON 数字、NaN、Infinity 不接受。
- 输出的计算结果也为十进制字符串，可能保留较多尾数；不要假定所有输出只有两位或 12 位小数。未知金额/成本/收益使用 `null`，不得显示为零。
- 业务日期为 `YYYY-MM-DD`。时间戳为含时区偏移的字符串；交易只有日期时不会补造秒级时刻。事件建议始终显式提供 `economic_date`，省略时实现使用服务端当前业务日。
- 数量、期数、分页、版本及布尔状态按 JSON 整数/布尔值传递。`annual_rate: "0.03"` 表示年利率 3%。
- 正常查询和多数创建/修改返回 200；创建空间返回 201。不能将“所有创建都应为 201”作为当前客户端判断条件。
- 任何空间关联都必须属于同一空间；不可访问的空间/对象一般返回 404，避免暴露对象是否存在。

## 2. 会话、CSRF 与权限

先 `GET /auth/me` 获取 `csrf_token` 和 CSRF Cookie。所有不安全请求（POST/PATCH/PUT/DELETE）携带会话 Cookie 与 `X-CSRFToken`；浏览器同源请求采用 `credentials: "same-origin"`。登录后会轮换 CSRF token，使用新响应中的 token。会话 Cookie 为 HttpOnly、SameSite=Lax；生产配置启用 Secure。

CSRF 在进入业务视图前由 Django 中间件校验。**CSRF 失败可能返回 HTML 格式的 403，客户端必须先检查 HTTP 状态和 Content-Type，不能假设每个错误响应都为 JSON。**

| 角色 | 当前权限 |
| --- | --- |
| Owner | 本空间全部读写、成员与邀请管理、原始导入文件下载、创建完整导出 |
| Editor | 本空间账务、导入及证据预览、规划、笔记等读写；无成员/邀请管理、原始导入文件下载与完整导出权限 |
| Viewer | 只读报表、账务、规划、笔记与笔记图片；不可读原始导入批次及来源行，不可写入 |

同空间成员按角色访问整个空间，当前没有空间内“私密账户”的独立权限层；私人信息需放入另一个独立空间。系统账号或 Django 管理身份不会自动获得没有 Membership 的家庭空间访问权。

## 3. 身份与空间端点

以下表格路径均省略 `/api/v1`。

| 方法与路径 | 请求/返回与限制 |
| --- | --- |
| `GET /health` | 数据库健康状态；另有 `/api/health/`。不提供账务数据 |
| `GET /auth/me` | `user`, `spaces`, `csrf_token`, `setup_required`；未登录时 `user=null` |
| `POST /auth/setup` | 首次初始化：`username`, `password`, 可选 `space_name`。已有用户后永久关闭该入口，返回 `setup_closed` |
| `POST /auth/login` | `username`, `password`。来源 IP＋用户名组合在五分钟内限制登录尝试次数 |
| `POST /auth/logout` | 注销当前会话 |
| `POST /auth/password` | `current_password`, `password`；新密码至少 10 字符，拒绝常见或纯数字密码 |
| `POST /auth/join` | 未有账号者以 `token`, `username`, `password` 接受邀请 |
| `GET /invitations/preview?token=...` | 可未登录查询邀请空间、角色、有效期与共享范围说明；也支持 POST JSON |
| `POST /invitations/accept` | 已登录用户提交 `token` 加入邀请空间 |
| `GET /spaces` | 当前用户所属空间列表，含角色 |
| `POST /spaces` | `name`, 可选 `base_currency`（CNY/HKD/USD）；创建者成为 Owner |

邀请创建仅向调用人返回一次完整 token；持有 token 者可在有效期内使用，因此不要写入日志或公开链接。邀请使用后不可复用，可由 Owner 撤销。

## 4. 幂等、乐观锁与不可变事实

以下命令必须带 `Idempotency-Key`（1—160 字符，推荐一次用户提交对应一个 UUID）：

- POST 创建账户、产品、价格、汇率、快照：`accounts` / `instruments` / `prices` / `fx` / `snapshots`。账户连同期初余额创建也在同一幂等命令中。
- POST 创建规划或文字资源：`plans` / `loans` / `goals` / `scenarios` / `reservations` / `notes` / `budgets` / `reconciliations` / `strategies` / `todos` / `watchlist`。
- `POST /spaces/{s}/holdings`、`POST /spaces/{s}/market/refresh`
- `investment-tags`、`market-watchlist`、`signal-rules`、`dashboard-preferences` 的 POST/PATCH/PUT 配置写入，以及 `POST /spaces/{s}/signals/evaluate`
- `POST /spaces/{s}/events`
- `POST /spaces/{s}/events/{id}/reverse`、`.../correct`
- `POST /spaces/{s}/imports/{id}/commit`、`.../reverse`
- `POST /spaces/{s}/occurrences/{id}/confirm`（`installments` 别名同样适用）

幂等作用域为“空间＋操作者＋命令路径＋键”。同键、同请求内容返回首次结果；同键、不同内容返回 409 `idempotency_conflict`。网络超时后重试必须沿用原键，不能生成新键。这个机制提供命令去重，不等于外部支付已经执行；系统没有真实扣款接口。

不在上述清单中的写入不能一概假设具有同样的幂等响应缓存。更新已有账户/产品、规划资源和期次时提供 `If-Match: "当前版本"`，也可在 JSON 提供 `version`。缺版本返回 428，版本已变更返回 412。成员角色和邀请管理目前不使用该版本约束。

事件与已入账分录不能原地修改或删除。冲正提交 `reason`；更正提交 `reason` 与完整 `replacement` 事件。存在后续阶段或持仓依赖时需按逆序处理。原始事件与冲正链保留，不能把修订解释成删除历史。

## 5. 查询与分页

空间内公共前缀记作 `/spaces/{s}`。

| 路径（GET） | 参数与说明 |
| --- | --- |
| `/overview` | `as_of`, `currency`；返回净资产、可动用资金、账户、持仓、缺口、待办与 `data_revision`。默认查询只命中同修订、同当日的缓存；不满足条件则实时计算 |
| `/positions` | `as_of`；返回正式价格口径持仓，含成本未知状态与价格来源 |
| `/holdings` | `as_of`, `account_id`, `instrument_id`, `kind`；账户持仓、正式/人工估值与参考估值、原买入日期及历史提示 |
| `/profit-calendar` | `start`, `end`, `period`（day/week/month/year）, `selected_day`, `account_id`, `instrument_id`, `kind`；详见 6.3 |
| `/market/search` | `q`, `kind`, `market`, `remote`；默认仅本地公共目录，`remote=1` 显式联网，详见 6.2 |
| `/market/quotes` | 当前空间产品的行情及更新状态，不自动写交易 |
| `/market/valuation` | 按品类汇总持仓估值与参考报价，期货名义额不进入资产 |
| `/net-worth-comparison` | `as_of`, `currency`；前一日结算与当日估算、完整/已知净资产和缺口，详见 6.4 |
| `/portfolio-analysis` | `as_of`；主标签唯一归属的持仓配置、权重及类型分布，详见 6.5 |
| `/tag-series` | `tag_id`, `start`, `end`；固定当前份额的历史正式价格序列，详见 6.5 |
| `/investment-tags` | 本空间标签列表、目标权重和主标签产品；支持通用分页 |
| `/market-watchlist` | 本空间市场观察及行情、回撤、历史序列，详见 6.6 |
| `/dashboard-preferences` | 首页显示配置单例，返回普通对象而非 items 数组 |
| `/signal-rules` | 本空间用户定义提醒规则；支持通用分页 |
| `/signals` | 规则最新评估、逐条件依据与未读数量，详见 6.7 |
| `/performance` | `start`, `end`；当前 HTTP 接口按投资类账户组合统计；内部计算函数支持自选账户，但尚未暴露为 HTTP 参数 |
| `/calendar` | `start`, `end`；事件、计划和可计算的收益日期；缺数据日期不伪造零收益 |
| `/forecast` | `days`（30/90/365）、可选 `scenario_id`, `monthly_income`, `monthly_expense`；也支持 POST JSON；预测不写账本 |
| `/events` | `offset`, `limit`, `account_id`, `q`, `kind`（逗号分隔）, `currency`, `start`, `end` |
| `/events/{id}` | 事件详情、分录、持仓变化、证据链接、`reversed` |
| `/search?q=...` | 当前查询账户名称及笔记标题/正文；不是全库全文搜索 |
| `/adapters` | 适配器能力与验证状态；机构 `planned` 不表示已原生兼容 |
| `/audit` | 最近至多 200 条本空间审计 |
| `/jobs` | 最近至多 100 条持久任务，含状态、尝试次数、错误代号和 `dispatched_at` |

通用分页响应：

```json
{
  "items": [],
  "count": 0,
  "offset": 0,
  "limit": 100,
  "has_more": false,
  "data_revision": 1
}
```

通用列表 `limit` 最大 1000；事件默认 100，规划资源默认 500，账户/产品/价格/汇率/快照默认 1000。`positions`、`holdings`、`market/*`、成员、邀请及日历没有同一套分页封装。`occurrences` / `installments` 当前最多返回 1000 条，尚无完整游标分页，客户端不能把截断列表当作所有历史。

## 6. 账户、产品、行情与快照

`accounts`, `instruments`, `prices`, `fx`, `snapshots` 均提供 GET 列表/详情与 POST 创建。账户/产品支持带版本的 PATCH/PUT；价格、汇率和快照通过追加新记录修订，不能覆盖旧观察。账户与产品支持受关联检查约束的可恢复删除及恢复，详见第 18 节；真实财务事件不因此删除。账户归档继续保留原有条件。

| 资源 | 关键字段 |
| --- | --- |
| `accounts` | `name`, `kind`, `currency`, `institution`, `owner_label`, `tail`, `valuation_mode`, `frozen`, `archived`。核心类型 bank/cash/wallet/fund/broker/securities/futures/loan/credit/property；计值模式 `detailed` 或 `snapshot` |
| `instruments` | `name`, `code`, `market`, `currency`, `share_class`, `kind`, `specification`，可传 `account_ids`。身份由空间＋代码＋市场＋币种＋份额类别区分；响应含 account_ids/account_names/accounts |
| `prices` | `instrument_id`, `value`, `kind`, `economic_date`, `published_at`, `source`。正式估值使用 official_nav/close/official_close/settlement/institution_settlement；trade 是成交观察，estimate/reference 为参考值，不充当正式期末价格 |
| `fx` | `base`, `quote`, `rate`, `economic_date`, `source`, `purpose`。估值采用 `purpose="valuation"`，表示 1 单位 base＝rate 单位 quote |
| `snapshots` | `account_id`, `economic_date`, `equity`, `currency`, `coverage`, `complete`, `includes_options`, `included_event_ids`, `details`。details 可含 available/margin/source/positions |

快照必须声明期权覆盖：`includes_options: true` 表示已含期权价值；`false` 表示未含，只有同时提交 `no_option_positions: true` 明确确认无期权持仓，才不会因期权缺口标为不完整。后一字段保存在 `details` 中，也可随创建请求直接提交。这些确认字段接受真正的布尔值，不接受 `"false"` 字符串。未知覆盖使用 `null` 并保持不完整。保证金、名义本金和持仓明细不会再次加到机构权益上。`included_event_ids` 明确新快照已经吸收哪些出入金；只存在同日日期但未声明覆盖时，报告保持不完整。新快照不得包含未来资金事项或其他账户资金事项。

产品页面按 fund/stock/etf/future/option/gold 分类；index 仅用于市场观察，不能建立普通持仓。创建或更新时传入 `account_ids`，必须为 1—100 个同空间、同币种、未归档账户，并满足产品类型约束；响应也会合并实际持仓的对应账户。期货仅匹配 future/futures 账户，股票/ETF 匹配 broker/securities，期权匹配券商或期货账户。已有持仓、价格或行情任务后，代码/市场/币种/份额类别/品类不可直接换成另一产品。

`snapshots` 提交 `asset_kind="future"` 时服务端也校验账户类型，不仅依赖前端筛选。黄金期货搜索返回 future 和 `specification.is_derivative=true`，不能伪装实物黄金建仓；连续合约标记 `reference_only`。

期货、期权产品不能套用股票/基金的买卖成本分录；相关请求返回 `derivative_snapshot_required`。首版使用机构权益快照、实际出入金与明确的期权覆盖口径。

不应把 `accounts` 列表中的汇总 `balance` 当作正式净值；它是账本分录汇总。显示总财富应使用 `/overview`，现金可用性使用相应现金字段。

### 6.1 已有持仓录入

`POST /spaces/{s}/holdings` 需会话、CSRF、写权限与 `Idempotency-Key`。必需 `account_id`, `instrument_id`, `quantity`, `cost`；可选 `as_of`（建账时点，默认今天）、`purchase_date`（原买入日）、`history_mode`, `description`。日期须满足买入日 ≤ 建账日 ≤ 今天。数量必须大于零，成本非负。该入口仅用于明细计值的基金/股票/ETF/实物类持仓，衍生品与快照账户返回 `derivative_snapshot_required`。

`history_mode` 有两种：`snapshot_only`（默认，仅录入建账时点）和 `unchanged_holding`（用户明确确认自原买入日起份额未变，允许历史分析回算）。二者都只创建一项建账事件，现金 amount=0；原买入日期作为元数据保存，不倒造过去现金扣款、买卖或定投执行。

可从 `current_value` 或 `current_profit` 中选一个填写；不能同时传。前者是当前该账户的持仓总市值，后者是持有收益，市值由成本＋收益得出且不能为负。手工值保存为账户与产品对应的持仓估值，不写共享产品 Price；后续持仓变化或较新的正式估值可能使该手工值失效。

```json
{
  "account_id": "{基金账户 UUID}",
  "instrument_id": "{产品 UUID}",
  "quantity": "1000",
  "cost": "1200.00",
  "purchase_date": "2026-05-06",
  "as_of": "2026-09-25",
  "history_mode": "unchanged_holding",
  "current_profit": "180.00"
}
```

响应含 `event`、`holding`；行情启用时另含 `market_refresh` 排队结果。补录时会请求从买入日开始的历史行情，最多回溯五年；异步尚未完成不应显示收益为零。`GET /holdings` 返回 `profit_type="unrealized"`、`profit`、`profit_rate`、`market_value`、`price_kind`、`purchase_date`、`history_mode`，另含 `estimate_price/value/profit/date/published_at/source/status`、`corporate_actions` 和 `history_warning`。当前持有收益不是包含所有已卖出产品及现金分红的累计总收益。

### 6.2 行情检索、更新与估值

- `GET /market/search?q=110022&kind=fund&market=CN&remote=0` 默认只查询持久化公共目录，不产生网络请求。名称、代码与公开别名按规范化文本检索；参数 `market` 为 CN/HK/US，`kind` 为 fund/stock/etf/future/option/index/gold，q 最多 80 字符。只有 `remote=1` 才尝试公开提供方检索。
- 搜索响应含 `items`, `status`, `message`, `source`（local/remote/mixed）、`local_count`, `refreshed_at`, `remote_requested`, `remote_status`。条目含 code/name/kind/market/currency/specification 及目录来源、验证状态。公共目录只保存固定公开条目或提供方确认的元数据，不保存家庭账户关联、自定义私有名称或原始搜索词；搜索结果尚不是空间投资档案。
- 境内商品期权可输入 `2701豆粕沽3300` 或 `m2701-P-3300`。仅格式解析成功的条目标为 `unverified`，不写入已验证目录，也不证明合约当前上市或行情可用；联网失败仍可保留本地目录结果。产品选择后，普通投资需关联相容账户，指数通过市场观察配置建立。
- `POST /market/refresh` 接受可选 `instrument_ids`（最多 100 个本空间产品；省略时最多取 100 个）、`history`（真正的布尔值）、`start`。返回 queued/up_to_date、instrument_ids、refresh_interval_seconds。`history=true` 的范围不超过五年，关闭行情时返回 409 `market_disabled`。
- `GET /market/quotes` 返回 `items`, `refreshed_at`, `refresh_interval_seconds=300`, `enabled`。每项 `kind` 为产品类型，`price_kind` 才是报价类型；不要混用。金额是十进制字符串，未取到价格为 null。
- `GET /market/valuation` 返回按品类分组的 `market_value`、`estimated_value`、`estimated_profit`、计值数量、来源、日期及 quotes。状态 complete/partial/stale/quotes_only/unavailable；缺汇率不按 1:1 折算。期货/期权参考价格可展示，不能把合约价格乘数量并入净资产。 首页使用 `display_value`/`display_profit` 及 `display_basis`（formal/estimate/manual/mixed/quotes_only）；每项持仓依可用数据选参考或正式值，完整分类才返回 display 合计，不完整时仅提供 `known_display_value`/`known_display_profit`。`priced_count` 包含有正式价的持仓；没有盘中估值但有正式净值的基金仍可展示正式市值。`estimated_value` 不把只有部分持仓的参考金额冒充完整合计。

单项报价状态为 ok/stale/unavailable/unsupported；刷新状态为 not_requested/pending/queued/running/ready/failed。`economic_date` 是价格所属日，`published_at` 是源提供的时刻，`fetched_at` 是系统抓取时刻。基金主报价为 official_nav，盘中估值另置 `estimate` 对象；当前证券/衍生品为 market，落库仅作 reference，历史已收盘日行情为 close。不能因为 fetched_at 是今天就把上一交易日或 QDII 的净值标为今天。

后台每五分钟扫描；支持类别按小时补最新正式价格之前 14 天以来的历史，首次可显式回填。未收盘的今日证券日 K 不作为 close：内地当地 16:00、香港 17:00、美股纽约 17:00 后才接纳当天日 K。失败保留旧价并标陈旧，十分钟未成功刷新也显示陈旧。手动/后台抓取从不创建现金事项。

`history_error` 表示历史抓取独立失败，不能用实时价格成功掩盖。`corporate_actions` 保存提供方分红/折算提示的 date/description/source，提示不等于实际分红入账。支持范围、货币基金万份收益限制、报价单位与源可用性见[行情研究](research/market-data-v3.md)。

### 6.3 收益日历

`GET /profit-calendar` 支持不超过三年的 start/end 区间；period 为 day/week/month/year，selected_day 决定返回哪一天明细，账户/产品必须属于当前空间。返回 `days`, `buckets`, `details`, `summary`, `currency`, `data_revision`、`return_basis`、`currency_policy` 和 `history_warnings`。

每一天含 date/amount/known_amount/return_rate/status/items。状态为 confirmed/partial/unavailable/no_position/future；amount 为完整可计算值，否则 null；known_amount 只表示已知部分。未来日期、无持仓、无正式价格、缺汇率和未核对公司行动不能展示成零收益。

日收益依据正式价格、已记录的持仓变化及关联产品的实际分红计算；期货/期权账户依据机构权益和已知出入金。单个合约没有独立结算资料时，不把整个账户盈亏归到该合约。收益率以日初市值加正向投入为基础，完整观察区间按日收益率复合，不能简单相加，也不等同 XIRR。跨币种日收益按当日汇率折算，独立汇兑损益不混入产品收益。

`unchanged_holding` 仅将确认份额不变的原买入日期用于分析重建，不移动真实建账事件。遇分红或折算提示且缺对应 dividend/reinvest/split 记录时，该日保持待核对。现金分红、拆股和交易须依据实际情况另行录入。

### 6.4 昨日结算与今日估算

`GET /net-worth-comparison?as_of=YYYY-MM-DD&currency=CNY` 返回 `as_of`, `currency`, `previous`, `estimated`, `change`, `message`, `data_revision`。日期不允许在未来，展示币种支持 CNY/HKD/USD。

- `previous` 对应 as_of 的前一日，`estimated` 对应 as_of；二者含 `date`, `net_assets`, `known_net_assets`, `completeness`, `gaps`, `accounts`, `source_dates`。
- `net_assets` 只有完整时可用；不完整为 null，`known_net_assets` 仅是已知部分，必须连同缺口标记展示。`source_dates` 披露采用的账户/产品、价格或汇率来源及有效日；不能把抓取日期当作价格日期。
- `estimated` 另含 `formal_net_assets` 和可计算时的 `reference_delta`。参考行情只改变估值展示，不产生现金或持仓事项；机构权益依覆盖口径处理，衍生品合约名义金额不能加到权益上。
- `change` 含 `amount`, `known_amount`, `completeness`, `message`, `kind="net_worth_change"`, `includes_cashflows=true`, `is_investment_return=false`。任一侧不完整时 amount 与 known_amount 均为 null，显示暂不可比及 message 原因，不能用两侧不同范围的已知部分相减。该变化包含收入、支出、入出金与估值变化，**不是投资收益**。

### 6.5 主标签配置与标签历史

`investment-tags` 提供 GET 列表/详情、POST 新建与带版本 PATCH/PUT。写入使用幂等键；不提供 DELETE，可设 `archived=true` 停用。关键字段：

| 字段 | 语义 |
| --- | --- |
| `name` | 本空间唯一名称，最多 60 字符 |
| `color` | `#RRGGBB`，默认 `#527765` |
| `target_weight` | 百分数十进制字符串，例如 `"10"` 为 10%；0—100，未停用标签合计不能超过 100 |
| `instrument_ids` | 本空间关联产品，可以在多个标签出现 |
| `primary_instrument_ids` | 本次指定以该标签为唯一配置主标签的产品列表；返回时由产品主标签关系反查 |
| `archived` | 布尔值，默认 false；停用时解除产品对该主标签的归属 |

主归属保存在 `Instrument.specification.allocation_tag_id`。修改标签时省略 primary_instrument_ids 保留主归属；明确传空数组解除该标签的主归属。重复观察标签不重复计入组合金额。

`GET /portfolio-analysis?as_of=...` 返回 `currency`, `as_of`, `total_value`, `known_total_value`, `status`, `groups`, `holdings`（`items` 同义字段）、`kind_distribution`, `target_weight_total`, `target_status`, `gaps`, `basis`, `message`, `data_revision`。

- groups 含 `tag_id`（null 表示未分配）、name/color、`value`, `known_value`, `current_weight`, `target_weight`, `deviation_pp`、product_count/holding_count、basis/sources/source_dates/status。权重与偏离使用**百分数/百分点**，不是收益日历中 return_rate 的小数比例。
- total_value/value 只在对应范围完整时提供，known_* 不能替代完整结论。权重按主标签唯一分组，普通账户闲置现金不纳入投资配置；机构权益依自身范围计入，合约报价不能替代权益。
- 明细含账户、产品、数量、原币及本位币价值、价格日期/来源/状态、`primary_tag_id` 与 `labels`。标签不产生交易或资金预留。

`GET /tag-series?tag_id={id}&start=...&end=...` 默认最近 365 天，范围最多 1825 天。该序列**固定当前持仓数量**，用历史正式价格及可用汇率比较，不回放真实申赎和仓位变动，不能标成实际历史组合收益。返回：

- 顶层 tag_id/name、start/end、as_of、current_value/currency/status/source、`quantity_basis`, `quantity_as_of`, `method="frozen_current_quantity_formal_price"`、`corporate_actions`, `gaps`, `message`。
- days 每日包含 date、observation_date、value/known_value、status、source_dates/gaps、change_percent/drawdown_percent；周末沿用已有正式价格时保留实际 observation_date。
- `effective_points` 按有效正式观察时点去重；单日涨跌不将同一旧净值在周末重复计为新观察。summary 提供 return_percent/change_percent/current_drawdown_percent/max_drawdown_percent，均为百分数。
- 正式价格/汇率缺口、未核对的分红折算或不足两个不同观察点时保留缺口，不生成看似连续可靠的回撤结论。机构权益与合约报价不混入固定数量产品序列。

### 6.6 市场观察与首页偏好

`GET/POST /market-watchlist`、`GET/PATCH/PUT /market-watchlist/{id}` 管理本空间市场观察。每个空间最多 100 项，同一产品不重复创建；停用通过 `enabled=false`，不使用 DELETE。POST 可传 `instrument_id`，或传 `product: {code,name,kind,market,currency,specification}` 由服务端创建/复用空间产品。指数不要求账户，也不能据此创建普通持仓。

配置字段为 `instrument_id`, `show_on_home`（默认 true）, `enabled`（默认 true）, `lookback_days`（整数，7—1825，默认 365）。新建/启用时可排队补历史价格，但响应成功不等于历史已补全。列表以 `{items, data_revision}` 返回，每项增加：

- instrument_name/name、code/kind/currency；quote 的 price、change_percent、economic_date、published_at、source、status、quote_unit。
- drawdown_percent、baseline_price、baseline_date、metric_status、message、series（date/value）。历史不足则回撤为 null，不用当前报价猜测区间高点。
- 指数点位按 quote_unit 展示，不能把它当作可买资产或货币金额；商品黄金的每克/金衡盎司及合约报价单位也须保留。

`GET /dashboard-preferences` 返回普通单例对象：id/version（已保存时）、`show_market_environment`, `show_valuation`, `show_signals`。`POST /dashboard-preferences` 建立或更新；更新已有单例须携带 version，所有开关为布尔值，写入须幂等键。配置控制整个首页模块，watchlist.show_on_home 控制单个观察项，两者同时生效。

页面中的纳指100、标普500、VIX、红利低波为可选择模板；选择仅预填编辑表单，明确保存后才创建市场关注，不能自动创建用户投资组合或启用条件提醒。

### 6.7 条件提醒

`signal-rules` 提供 GET 列表/详情、POST 新建、带版本 PATCH/PUT；每空间最多 200 条，停用通过 enabled=false，不提供 DELETE。新规则默认停用。字段为：

```json
{
  "name": "回撤 10% 观察",
  "enabled": false,
  "match": "all",
  "cooldown_hours": 24,
  "conditions": [{
    "scope": "instrument",
    "instrument_id": "{本空间产品 UUID}",
    "metric": "drawdown",
    "operator": "gte",
    "threshold": "10",
    "baseline": "rolling_high",
    "lookback_days": 365
  }]
}
```

每条规则有 1—8 个条件；`match=all/any` 表示 AND/OR，cooldown_hours 为 0—720 整数。scope 为 instrument（instrument_id）或 tag（tag_id，不能使用停用标签）；operator 为 gte/lte。metric 与单位如下：

| metric | 解释与限制 |
| --- | --- |
| `drawdown` | 从基准回撤的正百分数，threshold 大于 0 且不超过 100；`"10"` 表示回撤 10% |
| `change_percent` | 单日涨跌百分数，threshold 为 −100—1000；单日跌 10% 可配置 lte `"-10"` |
| `price` | 原币价格或指数点位，threshold 非负；VIX ≥ 25 配置 gte `"25"` |

drawdown 的 baseline 为 rolling_high/cost/manual；lookback_days 为 7—1825 整数。manual 另需正的 reference_price。成本基准依赖可核对持仓成本；指数不支持成本基准。标签条件采用 6.5 的固定当前份额序列，同样不能解释成实际历史组合收益。

10% 与 20% 阶梯分别建立规则，各自去重与计时。VIX ≥ 25 与纳指区间回撤 ≥ 10% 的示例是用户可编辑条件模板，默认停用，不是系统推荐的买入点。

- `GET /signals` 返回 `{items, unread_count}`。每项含 id/rule_id/name、status（triggered/not_triggered/unavailable/disabled）、triggered、conditions、evaluated_at、last_triggered_at、trigger_count、unread、message。
- 逐条件结果含 value、matched（true/false/null）、status、source、as_of、message 及原条件。数据不可用时不强制算作 false，更不能用零触发条件。
- `POST /signals/evaluate` 带幂等键立即检查；后台行情刷新后也会更新。保存规则可排队补行情，不能把保存成功解释为已触发。
- `POST /signals/{rule_id}/ack` 将该规则当前未读状态设为已读，不改变规则和触发历史。

持续满足同一条件不会每轮重复提醒；条件解除后再次满足、且冷却期已过，才产生新提醒。AND 组合使用不同有效日期时不伪装同时成立，返回 unavailable 等待可比资料。提醒只记录“符合用户设定条件”，**不会自动交易、自动补仓或承诺安全与盈利**。

## 7. 实际事件输入

银行账户到期货账户的 transfer 在界面称“银期转入”，反向称“银期转出”；底层仍为 transfer，普通同币种账户间称“同币种账户转账”，均不会发起实际银行操作。

普通“记一笔”不要求上传凭证或填写凭证说明；`description` 可省略或为空。金额、账户、关联阶段等必要业务字段仍须满足各业务规则，选填凭证不代表可以省略财务事实。

公共字段：`kind`, `account_id`, 建议必填 `economic_date`, 可选 `currency`（默认账户币种）、`description`, `category`。`related_event_id` 表示原始业务阶段，须为未冲正的同空间同币种事件。`occurrence_id` 可把已经证实的事实关联期次；`reservation_id` 可释放对应资金预留。客户端不能提交任意借贷分录，服务端由业务模板生成并按币种校验平衡。

| kind | 主要字段及实际语义 |
| --- | --- |
| `opening` | `amount` 为期初现金/负债；可加 `instrument_id`, `quantity`, `cost` 记录期初持仓，未知 cost 省略。期初不是收入 |
| `expense`, `income` | 正数 `amount`，真实消费或收入 |
| `refund` | `amount`, `related_event_id` 指向原消费；累计退款不得超过原消费 |
| `transfer` | `target_account_id`, `amount`, 可选 `fee`；来源减少 amount，目标增加 amount−fee。同币种 |
| `fx` | `target_account_id`, `amount`, `received_amount`, 可选 `fee`；来源减少 amount＋fee，目标增加 received_amount，跨币种各自平衡 |
| `fund_debit` | `amount`；扣现金并进入在途，不增持份额 |
| `fund_confirm` | `related_event_id` 指向 fund_debit；`instrument_id`, `quantity`, `price`, 可选 `fee`, `target_account_id`。确认成本为 quantity×price＋fee，不可超过剩余在途 |
| `fund_refund` | `related_event_id`, `amount`；退还该申购剩余在途，不重复记收入 |
| `buy` | `instrument_id`, `quantity`, `price`, 可选 `fee`, `tax`；确认持仓和应付款，买入费用/税费纳入管理成本，尚不扣交收现金 |
| `sell`, `fund_redeem` | `instrument_id`, `quantity`, `price`, 可选 `fee`, `tax`；减持仓、确认应收款；未到账前不加现金。未知成本可记录真实处置，相关收益保持未知 |
| `settlement` | `related_event_id` 指向 buy/sell/fund_redeem，可选 `amount`（默认剩余交收额）；本金现金只结转一次，可分次实际交收 |
| `dividend` | 毛额 `amount`，可选 `tax`, `fee`；现金增加净额，分列收入、预扣税、费用 |
| `reinvest` | `instrument_id`, `quantity`, `price`, 可选 `fee`；红利再投形成持仓，不作为组合外部本金投入 |
| `split` | `instrument_id`, `ratio`；如 1 拆 2 为 `"2"`；不改变管理成本 |
| `position_transfer` | `instrument_id`, `quantity`, `target_account_id`；同资产内部转仓保持管理成本；组合边界收益计算使用转移日正式市值 |
| `repayment` | `target_account_id` 为负债账户，`amount`；已知拆分可传 `principal`, `interest`, `fee`。未知 principal 时现金先扣一次，进入待分配清算 |
| `repayment_allocate` | `related_event_id` 指向原 repayment，原贷款 `target_account_id`, `principal`, `interest`, `fee`；只分配原扣款，不再次扣现金 |
| `borrow`, `lend`, `receivable_collect` | `amount`, `target_account_id`；真实借入、借出、收回本金 |
| `property_purchase` | `target_account_id` 为房产，`liability_account_id` 为贷款，`amount` 为房价，`loan_amount` 为实际贷款直付，`fee` 为费用化税费 |
| `unclassified` | `amount`, `direction`（in/out）；已知真实现金但待归类，报告显示不完整 |

不支持该业务类型的非零 `fee` / `tax` 会被拒绝，不能让客户端把任意金额字段当作会自动入账。买卖与确认的 `amount` 由数量、价格、费用等计算并以响应为准；若同时提供非零核对金额且与计算不一致，返回 `amount_mismatch`。

### 最小实际消费示例

```http
POST /api/v1/spaces/{space_id}/events
Content-Type: application/json
X-CSRFToken: {当前 CSRF token}
Idempotency-Key: 14f0b5cc-7a91-4a9f-a735-bc8719f44986
```

```json
{
  "kind": "expense",
  "account_id": "{同空间现金账户 UUID}",
  "economic_date": "2026-09-25",
  "currency": "CNY",
  "amount": "48.50",
  "category": "餐饮",
  "description": "已核实的午餐付款"
}
```

上述 UUID 占位符需要替换为实际响应值。返回事件包含 `id`, `revision`, `operation_id`, `payload`, `lines`, `movements`, `evidence`, `reversed`。`lines.amount` 为有符号十进制字符串；这是凭证详情，展示消费额仍应依据业务语义而非将所有分录相加。

### 基金分阶段示例

依次以不同幂等键提交：① fund_debit 扣款 `"1000"`；② fund_confirm 关联扣款 ID，`quantity="495"`, `price="2.00"`, `fee="10"`；③ fund_redeem `quantity="495"`, `price="2.04"`, `fee="5"`；④ settlement 关联赎回 ID。全过程净收益为 `"4.80"`，不是再次减买入费后的负数。QDII 的预计 T+2 日期本身不能替代确认或到账事实。

## 8. 导入三阶段与撤销

1. **上传证据**：`POST /spaces/{s}/imports`，multipart 字段 `file`, `source`, `account_id`。支持 CSV/TXT/XLSX，单文件最多 10 MiB、50,000 行；不支持 PDF/OCR。返回 ImportBatch，无实账变化。
2. **映射与预览**：`POST /spaces/{s}/imports/{batch_id}/preview`，JSON 包含 `account_id`、可选 `mapping`, `default_kind`, `currency`。规范映射键为 date/amount/currency/description/external_id/type/category，值为上传文件表头。返回 `preview_version`, `ledger_revision`, `rows`, `row_count`，逐行含 `errors`, `duplicate`, `existing_event_id`, `candidates`。
3. **确认提交**：`POST /spaces/{s}/imports/{batch_id}/commit`，须携带幂等键及最新预览版本。账本或预览改变后返回 409 `stale_preview`，先重新预览。

```json
{
  "preview_version": 2,
  "ledger_revision": 7,
  "row_ids": ["{已检查的来源行 UUID}"],
  "links": {
    "{另一已检查来源行 UUID}": "{已存在实际事件 UUID}"
  }
}
```

`row_ids` 指定本次已确认的行；省略表示该批次全部来源行，不等于当前页。客户端应按用户确认集合显式提交，不能把当前预览一页误认为全部。`links` 仅对选中行生效，用于人工核实后把另一来源证据关联已有实际事项；不能把同日同额候选当作已证明重复。

`GET /imports/{id}` 默认预览 500 行，支持 offset/limit，最大 10,000；POST preview 也最多直接返回 10,000 行，使用 row_count 判断是否还有未读部分。通用适配只负责映射已支持的业务类型；转账/退款缺少目标账户或原消费身份时需人工关联已有事项，不能无依据自动确认。

`POST /imports/{id}/reverse` 提交 `reason` 与幂等键。撤销该批次引入的事实时，保留其他证据所支持的既有事项；有后续依赖时拒绝直接撤销。`GET /imports/{id}/file` 仅 Owner 可下载原文件。重复上传与来源记录身份去重是两层机制，来源记录修订须显式更正而非覆盖。

## 9. 规划、期次与笔记

`plans`, `loans`, `goals`, `scenarios`, `reservations`, `notes`, `budgets`, `reconciliations`, `strategies`, `todos`, `watchlist` 提供 GET 列表/详情、POST 创建、带版本 PATCH/PUT。响应同时带 `data` 对象及顶层业务字段，客户端不应重写服务端的 tenant/created_by/id 等元数据。

| 资源 | 最小业务字段或动作 |
| --- | --- |
| `plans` | name, account_id, amount, currency, start_date, frequency（daily/weekly/monthly）, kind（income/expense/dca）；定投还须 instrument_id |
| `loans` | name, account_id, liability_account_id, principal, annual_rate, term_months, first_due_date, method（annuity/equal_principal/custom）；自定义须 custom_rows |
| `goals` / `scenarios` | name, amount/target_date 或 payment_nodes；scenario 必须 goal_id，同目标方案互斥启用 |
| `reservations` | account_id, amount, currency，可选 linked_freeze_amount/scenario_id；相同冻结不再扣预留，超额会阻断 |
| `notes` | title/body/status，可关联事件/账户/产品；发布与修改留版本，文字不会生成交易事实 |
| `reconciliations` | account_id, as_of, kind（cash/position/liability/equity 等）, institution_value，按口径需要 instrument_id |

`POST /plans/{id}/generate` 与 `/loans/{id}/generate`（另有 generate-schedule 别名）仅生成稳定期次；`GET /occurrences` 与 `/installments` 查看。`GET /plans` 可按 `kind=dca`、`instrument_id` 与 `account_id` 精确过滤，以支持持仓行内管理。后台扫描到期只设 pending，不产生现金分录。

`POST /occurrences/{id}/confirm` 提交真实 `event_id` 与幂等键，验证类型、金额、账户、币种及贷款/产品关联。`PATCH /occurrences/{id}` 配合版本，仅允许改为 skipped 或 pending；已有实账者不能改成跳过。

预留的 `amount` 是剩余用途分配。实际事项携带 `reservation_id` 或付款节点/期次事后关联实际事项时，按预留账户与币种的现金负向分录消费，购房按首付加费用消费，不按房产总价消费。重复关联同一事实不会重复扣预留；跨预留的合计分配不得超过实际付款。全部用完标记 `consumed`，冲正付款时恢复对应预留，目标付款节点回到 `pending`。这些变化保存资源版本及审计，不另外产生现金分录。服务端 `_payment_*` 字段是派生分配记录，客户端不得修改。

`GET /notes/{id}/versions` 查看历史版本。`POST /notes/{id}/attachments` 上传 JPG/PNG/WebP 图片（最大 5 MiB、20 百万像素），`GET /notes/{id}/attachments` 列出，`GET /notes/{id}/attachments/{attachment_id}` 返回图片。图片仅在当前空间授权下访问，不提供公开存储地址。

## 10. 管理、导出与后台状态

| 路径 | 权限/操作 |
| --- | --- |
| `GET /members` | 空间成员列表 |
| `PATCH /members/{membership_id}` | Owner 变更 role；不能降级最后一个 Owner |
| `DELETE /members/{membership_id}` | Owner 移除成员；不能移除最后一个 Owner |
| `GET/POST /invitations` | 仅 Owner；创建字段 role, expires_days（1—30，默认 7） |
| `POST /invitations/{id}` | Owner 撤销邀请 |
| `POST /exports` | Owner 创建 ZIP 导出，返回 id/status/download_url；当前为同步生成 |
| `GET /exports/{id}/download` | 须仍为 Owner 且是该导出请求人；返回 ZIP |

ZIP 包含结构化账本和可用证据/附件，不等同于数据库灾难恢复备份。大数据导出目前未证明可异步、断点续传或达到完整规模性能目标。

Outbox 状态为 pending/queued/failed/done/superseded。业务修订与 Outbox 同一数据库事务提交；投递租约按 `dispatched_at` 计算，五分钟后可重投。重算按空间与修订防止重复输出及旧版本覆盖。`broker_unavailable` 与 `projection_failed` 是诊断代号，不包含敏感堆栈。该方案是至少一次投递＋幂等处理，不承诺消息“恰好一次”。

## 11. 报表状态与错误处理

- `/overview.completeness` 为 complete/partial；必须同时展示 gaps、as_of、data_revision。缺价格或汇率时总额只是可核实部分，不能把数值本身当作完整结论。
- 账户状态 complete/partial/unknown；持仓价格状态 official/stale/unknown，另有 cost_status=known/unknown。快照的 roll_forward 只调整已证实的新出入金，不代表后续盈亏已获覆盖。
- `/performance.net_profit`、`realized_profit` 可以为 null；known_profit/known_realized_profit 仅是已知部分的诊断值，不能替代完整收益。fees/taxes 已在成本或净额中计入，不应再减一次。
- XIRR 状态：ok/multiple_roots/no_solution/not_converged/insufficient_data；仅 ok 的 rate 可用于展示，并保留 ACT/365、搜索区间、短期年化提示。期初/期末估值及真实外部资金流才构成输入；计划不参与实际收益。

常见业务错误响应：

```json
{
  "code": "stale_preview",
  "message": "预览已过期，请重新预览后确认",
  "fields": {},
  "request_id": "{诊断 UUID}"
}
```

| HTTP | 常见 code | 客户端处理 |
| --- | --- | --- |
| 400 | invalid_json / idempotency_required | 修正请求格式或补齐原提交幂等键 |
| 401 | unauthenticated / invalid_credentials | 重新登录或核对凭据 |
| 403 | forbidden；或 CSRF 中间件拒绝 | 核对角色、会话、CSRF；不要自动降级权限 |
| 404 | not_found | 当前空间不可见或对象不存在 |
| 409 | conflict / constraint_conflict / idempotency_conflict / stale_preview / source_revision / dependency / historical_dependency | 刷新相关数据或按依赖处理，不能盲目循环重试 |
| 412 | version_conflict | 取新版本并让用户合并修改 |
| 422 | invalid / validation_error | 展示字段/业务错误，保留草稿 |
| 428 | version_required | 提供当前版本 |
| 429 | rate_limited | 等待后再登录 |
| 503 | 健康接口 database_unavailable | 服务不可用，保留原请求幂等键 |

`fields`、`request_id` 并非当前所有错误分支都有（例如部分 Django ValidationError/约束冲突）；客户端须按可选字段处理。未知 5xx 或非 JSON 响应显示统一故障提示，避免把原始响应当账单正文渲染。

## 12. 2.3 平台管理、菜单偏好与产品识别（历史接口说明）

管理员空间和账号类型的最新规则以 [2.5 发布记录](release-2.5.md)为准：管理员 `auth/me.spaces` 为空，通过专用平台接口明确进入用户空间，管理员自身不能成为空间成员，账号类型不能直接互换。

`GET /auth/me` 的 user 增加 `is_platform_admin`。平台管理员返回全部可协助空间，空间含 `administration:true`、`membership_role`；该能力不创建隐式成员关系、不改变实际操作人，也不绕过数据库 tenant context。普通用户的空间集合不变。

- `GET/PUT /me/navigation-preferences`：`{version,groups:{groupId:{order:[key],hidden:[key]}}}`。按当前登录用户存储；初始 version 为 0，PUT 必须匹配。恢复默认写空 groups。
- `GET /admin/users`：分页返回 id、username、email、is_active、is_platform_admin、version、space_count、date_joined、last_login，不返回密码。POST 新建用户：username/password/email?/space_name?。`PATCH /admin/users/{id}` 支持 version 与用户名/邮箱/启用/平台管理员字段；`POST /admin/users/{id}/password` 接受 version/password，限重设他人密码。
- `GET/POST /admin/spaces`：分页列出账簿和成员；新建指定 name、owner_user_id、base_currency。`PATCH /admin/spaces/{id}` 使用 version（账簿 revision），可改 name/timezone。成员编辑沿用空间成员 API；平台管理员可额外 `POST /spaces/{id}/members {user_id,role}` 添加现有用户。
- `GET /admin/audit`：平台操作审计。上述 admin 接口都要求后端平台管理员，写操作使用 Idempotency-Key。
- `GET/PUT /admin/data-sources`：`{version,config,providers}`，PUT 仅 version/config。config 为 `{schema_version:1,enabled:{providerId:boolean},priority:{kind:[providerId]}}`；未知提供方、任意 URL、密钥等字段拒绝。providers 列出内置能力及适用市场/操作。
- `GET /spaces/{id}/market/catalog`：q/kind/market/offset/limit（上限受后端限制），空 q 也可浏览缓存候选，不访问外部接口；返回 items/count/has_more。
- `GET/POST /spaces/{id}/market/resolve`：code、kind?、market?、currency?、name?、specification?、overrides?，也可用当前空间 instrument_id。返回识别后的产品字段、specification、calendar、settlement_rule、status、sources、warnings。六位数字的跨类型歧义不强猜。
- `GET/POST /spaces/{id}/market/trade-dates`：产品信息或 instrument_id，application_at（带时间的 ISO）/application_date，允许手工 trade_date/confirmation_date 和规则 overrides。返回 trade_date、expected_confirmation_date、calendar、settlement_rule、status、warnings，固定 `is_forecast:true`、`creates_ledger_event:false`。

基金 `settlement_rule.confirmation_days` 表示申请后的预期份额确认交易日数，与净值日期和资金实际交收日期不同。默认同类规则为 `estimated`，手工规则为 `manual`；不得把日期预览当作机构确认记录自动记账。产品保存时会使用相同识别服务补全规格，已有事实引用的身份字段仍受不可直接变更规则保护。


## 13. 2.5.1 期权参考持仓

以下路径均在 `/api/v1/spaces/{space_id}` 下，并沿用空间权限、CSRF、`Idempotency-Key` 和精确十进制字符串约定。

- `POST/PATCH /instruments[/{id}]` 可附带 `option_position` 对象，产品与期权参考在同一事务保存；无效持仓会回退产品修改。对象至少包含 account_id、side（long/short）、quantity（正整数手数）、contract_multiplier（正数）、opening_price、current_value（非负总市值）、purchase_date、as_of。修改既有参考还须带 id/version。
- `GET /option-holdings` 返回 items，可按 account_id、instrument_id、as_of、status（active/closed/all）筛选；`GET /option-holdings/{id}` 读取具体记录。
- `POST /option-holdings` 为已有产品新增参考，需 instrument_id；`PATCH /option-holdings/{id}` 使用当前 version 更新，身份 account_id/instrument_id/side 不可直接更换。同账户、同合约、同方向只允许一条 active 记录。
- settlement_price 与 settlement_date 均可省略；填价格时必须同时填日期，日期不晚于 as_of。价格 0 为有效值。PATCH 清空结算信息时将两项均设为 null。
- 返回 opening_premium、signed_market_value、reference_profit 等参考数据，并固定 `is_reference_position:true`、`contributes:false`。这不是净资产或正式日结记录，不生成资金分录、持仓变动或共享行情价格。
- `GET /holdings` 的原 items 保持原义，新增 reference_items 独立返回期权参考明细；报表不得把该数组再加入账户权益。
- 更新保存 ResourceRevision 与审计。以 status=closed 关闭参考不会执行真实平仓或确认收益；直接删除不受支持。

产品已有期权参考时，不能直接改变其合约身份。账户币种、类型和归档同样受保护。没有包含期权的完整机构权益时，资产汇总保留缺口，不能仅凭一份手工合约市值认定账户资产完整。

## 14. 2.5.1 存量持仓核对与更正

- 普通持仓录入可附 `institution_profit`（允许负数）、`reference_nav`（正数）。系统以本次原始市值、成本、份额核对，差额超过 0.02 默认拒绝，不自动生成在途交易或倒推成本。
- 确实无法核实范围时，可显式提交 `reconciliation_mode:pending`、`confirm_unreconciled:true` 和机构收益；原持仓与核对记录在同一事务保存。主收益状态为待核对，报表不得把机构收益当作当日已实现收益。
- `POST /holdings/{opening_event_id}/check`：`version`（首次为 0，随后使用当前核对记录版本）、`institution_profit`，以及可选 `reference_nav`、`reference_date`、`available_quantity`、`note`。可用份额仅为辅助资料。该接口只保存核对记录，不修改现金、份额、成本或共享行情。
- `GET /holdings` 普通行增加 `reconciliation`、`reconciliation_eligibility` 与 `correction` 元数据。未解决差异时主 `profit`、`profit_rate` 与估算收益不作为确定收益返回，原计算值和机构值另存用于核对。
- `POST /holdings/{opening_event_id}/correct`：必须提供 `expected_revision` 和更正原因 `reason`，允许更正 `quantity`、`cost`、`purchase_date` 并补核对证据。账户、产品、原核对日期、市值和资金分配等沿用 `correction.initial_values`，不得改变。
- 更正限有效存量持仓、固定原始市值、无其他实际持仓变动或复杂依赖。原子冲正重录并保留原补资引用；失败整体回滚，不重新划转资金。已存在的未解决核对证据不能通过清空字段悄悄绕过。

这些写接口沿用当前空间权限、CSRF、幂等键、版本保护及审计，不改变既有账簿的历史记录。

## 15. 2.5.2 历史定投预览与占位持仓撤销

- `POST /plans/{id}/history-preview`：请求 `start`、`end`、`as_of`，可附 `excluded_dates` 日期数组、`pause_ranges:[{start,end}]`、`fee_mode:unknown|zero|fixed`，固定费用模式填写 `fee_amount`。日期须满足开始 ≤ 结束 ≤ 估值日 ≤ 今天，单次最多三年。只支持同币种普通单位净值基金、每日一次且未设置期数上限的定投计划。
- 此预览是只读计算，空间查看者也可使用；不调用写命令，不写事件、计划期次、行情、审计、幂等记录或空间版本。返回固定 `is_estimate:true`、`creates_ledger_event:false`。
- 响应包含逐日 `items`、参考日历、净值来源与日期、`summary`、`gaps`、`overlap`、`corporate_actions`、`settlement_rule`。逐期申购净值必须精确匹配日期，估值净值可取截至估值日最新正式净值。未知或不完整的全量字段为 null，已知子集另列 `known_*`；未扣费理论数据另列 `theoretical_*`，不是实际确认份额。
- `expected_confirmation_date` 和 `pending_forecast` 仅为日期预测；汇总的 `estimated_pending_count/amount` 不证明真实扣款或实际确认。费用从每期计划金额中扣减用于算份额，成本仍为完整付款额。
- `POST /market/refresh` 补历史数据时需 `history:true`、`start` 和当前计划的 `instrument_ids`；返回表示后台任务提交，不能表示历史净值已补齐。
- `GET /holdings` 增加 `placeholder_void` 元数据，仅为满足窄条件的存量录入提供入口。`POST /holdings/{opening_event_id}/void-placeholder` 需要 `expected_revision`、`reason`，并沿用写权限、幂等键与审计。资格在锁定后重核：份额不大于 0.00000001，零成本、原市值零、原分录均零且无后续事实依赖；以冲正保留历史，不硬删除、不产生新扣款。

## 16. 2.5.3 历史定投实际补录

在空间路径下使用 `GET /plans/{id}/history-import` 读取已补录的期次与当前账簿、计划版本。`POST /plans/{id}/history-import/validate` 只计算校验结果，不创建扣款、持仓、期次或审计。写入使用 `POST /plans/{id}/history-import/commit`，须携带 `Idempotency-Key`、校验返回的 `expected_revision`、`expected_plan_version`、`validation_digest`，以及 `confirm_actual_records:true`。

两个 POST 均传 `holding_account_id` 和 `rows`（最多 500 项）。每项包括 `scheduled_date`、`debit_date`、`amount`、`funding_account_id`、`status`。状态为 `debited` 时只记录扣款和申购在途；为 `confirmed` 时另需实际 `confirmation_date`、`quantity`、`nav`、`fee`。有份额取整尾差时填写 `rounding_adjustment` 并明确 `rounding_confirmed:true`；它不能替代手续费或掩盖较大金额差异。

校验返回 `ready`、版本与摘要、逐期 `action/normalized/errors/warnings`、全局 `blockers`、汇总 `summary` 及分账户 `account_effects`。动作包括新扣款、新扣款并确认、仅确认已有扣款、跳过已录期次。实际确认后的追加记录不会再次扣款；原计划未来付款设置保持不变。

提交会重新校验并以事务整批写入。账簿或计划变化返回 `412 version_conflict`；期初之前的扣款、历史可用资金不足、已有持仓或无法明确归属的实际记录等情况阻断，不会自动补资或重复增加资产。历史预览的份额、预计确认日期始终不构成实际记录。此入口只记录用户已经发生的交易，不向金融机构发送任何交易指令。

## 17. 2.5.4 按预览补录与来源

历史补录的逐期 `rows` 新增 `entry_basis:institution|preview_confirmed`。省略时兼容旧客户端，按 `institution` 处理；使用预览计算资料登记时须明确填 `preview_confirmed`，提交另须 `confirm_preview_entries:true`。混合来源的提交须同时包含两种确认。校验仍只读，校验摘要绑定来源，提交仍重新检查版本、资金、持仓和重复记录。

预览中完整的扣款日期、费用、净值、参考确认日期可带入补录草稿，前端自动计算份额取整尾差并展示，由一次总确认覆盖。未知费用不会默认为零，未知净值和日历不得造值。预览日仍在途的期次保持在途；已经登记的在途须显式操作才补确认，不能仅因重新打开页面而改状态。

扣款与确认分别保存 `debit_entry_basis`、`confirmation_entry_basis`，后续机构确认不会覆盖旧扣款来源。已保存记录的来源不能改写。旧记录读取默认兼容，不迁移或重写数据库。事件、期次、版本、审计与导出保留相应来源。

持仓返回 `contains_preview_entries`；含有效且未冲正的专用定投预览补录时，增加 `entry_basis:preview_confirmed|mixed`、`entry_basis_label`、`entry_basis_description`。这是账簿录入依据，与行情的正式净值或盘中估值来源独立；通用事件里自行填写标签不能冒认该来源。

## 18. 2.5.5 期初日期更正与可恢复删除

以下路径均位于 `/api/v1/spaces/{space_id}`。读取需空间访问权限；写入仅允许 Owner、Editor 或显式代管该空间的平台管理员，并要求 CSRF 与 `Idempotency-Key`。写入会锁定账簿、重新检查权限和依赖；同一操作、用户及幂等键的相同请求返回原结果，不同请求返回 `409 idempotency_conflict`。本节版本均在 JSON 请求体提供。

| 方法与路径 | 请求与响应 |
| --- | --- |
| `GET /accounts/{id}/opening-date` | 返回 `account_id`、`available`、`editable`、`kind:cash\|snapshot\|null`、`opening_date`、`amount`、`currency`、`version`、`data_revision`、`source_id`、`min_date`、`max_date`、`reason`、`method` |
| `POST /accounts/{id}/opening-date` | 仅接受 `version`、`expected_revision`、`opening_date`、`reason`；响应为更新后的上述元数据，另含 `changed`、`previous_date`、`new_source_id`，有实际更正时另含 `reversal_id`（机构权益更正为 null） |
| `GET /accounts/{id}/deletion`、`GET /instruments/{id}/deletion` | 返回 `object`、`deleted`、`can_delete`、`can_restore`、`blockers`、`restore_blockers`、`impact`、`retained`、`deletion`、`data_revision`；已删除档案也可读取此预览 |
| `DELETE /accounts/{id}`、`DELETE /instruments/{id}` | 请求 `version`、`expected_revision`、`confirm:true`；返回 `item`、`deleted:true`、`deletion`、`data_revision` |
| `POST /accounts/{id}/restore`、`POST /instruments/{id}/restore` | 请求 `version`、`expected_revision`，无需 `confirm`；返回 `item`、`deleted:false`、`deletion`、`data_revision` |
| `GET /accounts?status=deleted`、`GET /instruments?status=deleted` | 分页读取已删除档案。`status` 默认 `active`，表示未删除；归档和删除是不同状态。不支持 `status=all` |

`version` 使用账户或产品本身的版本，`expected_revision` 使用刚读取的 `data_revision`，不是删除记录的版本。日期更正缺账户版本返回 `428 version_required`，缺账簿版本返回 `428 revision_required`；版本过期返回 `412 version_conflict`。删除/恢复缺失或过期版本均返回 `412 version_conflict`。

日期更正只适用于可追溯的账户现金期初或开户机构权益，不修改金额、币种、权益包含范围或持仓买入日期。`reason` 为 1—500 字，日期须不晚于今天且在元数据给出的可更正区间内；多条不明期初、归档账户、业务阶段依赖等返回不可编辑原因。相同日期返回 `changed:false`。现金期初采用冲正并按原分录金额重录；机构权益追加替代观察，通过审计关联旧观察。原事件、分录、快照与更正原因保留，统计使用更正后的有效来源。不可更正返回 `409 opening_date_not_editable`，超出依赖允许日期返回 `409 opening_date_dependency`。

删除限未使用的产品，以及没有记录或仅有系统开户期初及其受信更正链的账户；只存在初始金额不等于允许删除任意实际流水。真实交易、持仓、已冲正交易历史、后续权益、导入记录、产品关联、计划及期次、期权参考等依赖均可阻止删除。行情价格与允许保留的行情缓存不会因删除而清除。`blockers/restore_blockers` 每项包含 `code`、`message`、`count` 与最多 20 个 `items`（id/name）。

删除影响的 `impact` 包含 `currency`、`removed_value`、`net_asset_change`、`valuation_basis`、`valuation_date` 和 `warnings`；金额未知时保留 null，不按零解释。`retained` 说明保留的期初事件、行情等数量。删除仅登记状态和审计，原财务事实及外键保留，账户同时归档；资产、收益、配置选择及行情更新排除已删除档案。恢复账户还原其删除前归档状态，并重新纳入统计；恢复产品前须先恢复其关联账户。

有依赖返回 `409 catalog_has_dependencies`，恢复依赖不满足返回 `409 catalog_restore_dependencies`，两者在 `fields.preview` 附当前预览。未明确确认删除返回 `422 catalog_delete_confirmation_required`；重复状态操作返回 `409 already_deleted/not_deleted`。普通详情、修改或新增业务引用已删除档案返回 `409 catalog_deleted`，客户端应引导进入已删除列表恢复。这不是永久删除接口，不能借通用资源接口改写删除标记。本轮无数据库迁移。


## 19. 2.6.0 管理员代管业务数据

`/api/v1/spaces/{space_id}/administration` 仅限有效平台管理员，保留真实操作者身份与租户隔离。GET 返回管理分类与创建默认值。

`/{category}` GET 支持 q、status=active/deleted/all、offset、limit；POST 创建。`/{category}/{id}` GET 返回 item（id、version、values、deleted）、data_revision、关联依赖及适用的删除影响；PATCH 更正；DELETE 可恢复移除（交易为冲正）。`/{category}/{id}/restore` POST 恢复非交易记录。

写入提供 Idempotency-Key、expected_revision、reason；修改、删除、恢复另提供 version。新增/修改使用 values 对象。删除要求 confirm=true；有关联交易时另要求 include_related=true。账簿版本或对象版本冲突返回 412。越权返回 403，跨空间记录返回 404，仍有必须先处理的依赖或在用的替代版本返回 409。所有变更在同一事务内验证并保存审计。

分类：accounts、instruments、events、prices、fx、snapshots、option-holdings、plans、loans、goals、scenarios、reservations、budgets、notes、strategies、todos、watchlist、reconciliations、investment-tags、market-watchlist、signal-rules、dashboard-preferences。

价格、汇率及权益更正返回新的 item.id；原始观察可从 status=deleted 查询。恢复旧观察之前需先处理仍在使用的替代版本。配置恢复重新执行对应的领域校验。账户与产品的管理员移除保留历史事实，与普通成员的未使用档案删除约束不同；依赖配置单独恢复，防止恢复档案时意外重启计划。不可通过此接口修改身份字段、内部删除标志、原始账务分录或审计。

## 20. 2.6.2 持仓买卖与申购开放日

`POST /api/v1/spaces/{space_id}/investment-trades` 登记已发生的基金、股票、ETF、黄金买卖，使用空间写权限和 `Idempotency-Key`。字段为 `instrument_id`、`account_id`、可选 `cash_account_id`、`side=buy/sell`、`economic_date`、`quantity`、`price`、可选 `amount/fee/tax/description`、`pending`、`settled`。金额和费用至多两位小数，份额和价格可保留十八位；默认按份额乘价格及费用计算实际金额并舍入到分。显式金额与计算金额的差异超过允许舍入范围会拒绝。

场外基金 `pending=true` 仅支持买入，此时只填已扣款金额，不填份额、净值和费用。已确认买入在同一事务中建立扣款与确认事项；其他现货买卖按 `settled` 决定是否同时登记交收。`settled=false` 保留应收/应付，等待实际到账。资金账户必须同币种且符合类型规则，扣款不足、超额卖出、未来日期和跨空间对象均拒绝，失败不会留下半笔交易。接口不向外部机构下单。

`POST /api/v1/spaces/{space_id}/investment-trades/confirm` 接受原申购扣款关联及实际确认份额、净值、费用，使用现有基金确认协议处理已核实的份额舍入差。基金流水的 `next_stage` 提供下一步确认/交收的类型、金额、账户与产品信息，重复执行受剩余在途金额和幂等保护。

产品 `specification.subscription_calendar` 支持 `auto/domestic/cn_us/cn_hk`；识别结果 `subscription_rule` 返回规则来源、适用日历及说明。定投历史估算、计划和申购日期预览采用同一规则。期次 GET 中 `plan_kind` 表示资源类型，`operation_kind` 表示收支/定投业务；`auto_skip` 与 `subscription_day` 表示因已知休市自动跳过。真实已发生事项不会仅因休市而被禁止登记。没有日历覆盖的日期为未知，不能按推定成功执行批量补录。

## 21. 2.6.3 每日收益与持仓展示

`GET spaces/{id}/net-worth-comparison?as_of=YYYY-MM-DD&currency=CNY` 新增 `daily_return`；`GET spaces/{id}/holdings` 同时提供顶层汇总、每行 `daily_return`、`latest_confirmed_return` 与 `labels`。

汇总字段为 `date,currency,amount,known_amount,return_rate,status,known_count,total_count,missing_count,items,currency_policy,message`。`status` 为 `estimated|confirmed|partial|unavailable|no_position`；只有全部可计算时 `amount` 和汇总收益率才完整，否则用 `known_amount` 展示已知部分，未知不能转换为零。指定显示币种会用于收益汇总。

明细保留 `account_id,account_name,instrument_id,instrument_name,name,currency,date,amount,base_amount,base_currency,return_rate,status,price_date,interval_start,source,message`，以及实际汇率日期/来源。`amount` 为原币收益，`base_amount` 为显示币种折算；机构总权益的 `instrument_id` 为 null。`latest_confirmed_return` 保留最近正式报价日和其缺失状态，不静默回退为旧日完整收益。

计算使用实际仓位变动和正式/当日有效估值、已记分红及已核对资金流水。机构权益覆盖的合约明细不再加总；外币口径为 `local_profit_converted_daily_excludes_fx`。上述接口均为只读，无补记交易副作用。

## 2.6.4 增量：定投自动补录

本节新增于 2026-09-28，部署状态见 [2.6.4 发布记录](release-2.6.4.md)。以上历史契约的其他部分不因本节而宣称已全面重新审计。

普通场外基金 `plans` 记录支持 `automation` 对象：`enabled`（布尔）、`start_date`（明确生效日）、`holding_account_id`、`fee_mode`（`unknown` / `zero` / `fixed`）、`fee_amount`（fixed 时每期固定金额）、`excluded_dates`（日期数组）、`pause_ranges`（`{start,end}` 数组）。资金来源沿用计划的 `account_id`。配置由原计划 POST/PATCH 接口维护，仍要求幂等键、空间权限及修改版本。缺省不开启；未知费用不等同于零费用。

- `GET /spaces/{space_id}/plans/{plan_id}/automation`：只读状态，返回 `enabled`、`start_date`、`plan_version`、`data_revision`、`total_count`、`has_more`、`summary`、最近最多500期 `items`。
- `POST /spaces/{space_id}/plans/{plan_id}/automation/run`：使用既有幂等写入接口，请求必须仅包含整数 `expected_plan_version`。Viewer 不可执行；版本不一致返回412。后台每五分钟检查启用的计划。
- 每期含 `date`、`amount`、`status`、`message`、`debit_event_id`、`confirmation_event_id`；已具备相关数据时附 `nav_date`、`confirmation_date`、`nav`、`quantity`。等待情况保留空值，不补零。
- 状态包括 `scheduled`、`disabled`、`paused`、`excluded`、`waiting_calendar`、`waiting_cash`、`waiting_nav`、`waiting_confirmation`、`waiting_fee`、`recorded_estimate`、`already_recorded`、`needs_review`。`recorded_estimate` 是本账簿推算，不能显示为机构成交确认。
- 自动扣款/确认与历史补录共用计划＋计划日期＋阶段唯一标识；重试不会重复写账。资金不足、记录冲突、已撤销、部分实际确认等情况留待核对。份额会参与持仓与估值，`contains_automatic_estimates` 和 `entry_basis_label` 保留来源；正式行情不将推算份额对应的收益升级为机构确认。

导入预览新增 `automatic_match` 及候选的 `automatic_estimate` 标记。同账户、同日、同币种同金额的自动基金扣款不能直接新增第二笔；可通过既有 `links` 关联证据，或经明确核对在提交体的 `distinct_rows` 中传选定来源行 ID 表示独立交易。该数组必须属于本次所选来源行；关联凭证不改写原推算份额来源。

## 2.6.5 增量：买入待确认

`holdings` 顶层及每行、`overview` 及其账户、`net-worth-comparison` 各日期状态及其账户新增只读 `pending_purchases`。摘要包括 `as_of,currency,amount,known_amount,completeness,count,by_currency,items,included_in_assets,added_to_net_assets,message`。账户摘要按资金来源账户归集，持仓行按目标账户和产品归集，二者不能再次相加。`amount=null` 表示无法完整折算；`known_amount` 保留已知部分。

明细含 `debit_event_id,source_account_id,source_account_name,holding_account_id,holding_account_name,instrument_id,instrument_name,code,amount,currency,debit_date,scheduled_date,expected_confirmation_date,is_dca,entry_basis,automatic_estimate,target_status,valuation_scope`。预计确认日仅是日历预测；金额来自截至统计日仍未确认或退款的申购在途分录。归属不明确时保留空目标，不擅自归属资金账户为持仓账户。

`added_to_net_assets=false`：本投影不额外增加净资产；涉及机构快照时 `included_in_assets=null`，避免声称每笔在途均已被机构快照覆盖。只存在在途的持仓行 `pending_only=true,contributes=false`，数量、成本、市值、收益为空，保留产品展示，不参与已确认仓位的收益或配置计算。

`GET plans?holding_account_id=…` 可按持仓账户筛选定投，资金来源 `account_id` 仍单独保留。优先使用计划明确的持仓账户，其次使用可靠且一致的历史补录目标；无上述信息时兼容原计划账户。所有查询继续在当前账簿租户范围内执行。
# 2.7.0 基金分阶段记录补充

以下接口位于 `/api/v1/spaces/{space}/`，遵循既有空间权限、写入幂等和资源版本规则；只读成员不能写入。

| 接口 | 用途 |
| --- | --- |
| `GET entry-defaults` | 当前用户在当前空间的普通收支默认账户、分类及币种 |
| `GET fund-orders` | 申购进度，支持 `pending=true`、`instrument_id`、`account_id` 筛选及 `offset`/`limit` 分页（默认20，最多100） |
| `GET fund-orders/defaults?instrument_id=…&account_id=…` | 此基金、此持仓账户的默认扣款与费用设置 |
| `POST fund-orders` | 建立申请，或同时记录明确的扣款、确认事实 |
| `POST fund-orders/{id}` | 通过 `version` 编辑尚未扣款的申请 |
| `POST fund-orders/{id}/transition` | 通过 `version` 执行 `paid`、`configure`、`estimate`、`confirm`、`verify`、`associate`、`cancel` |
| `POST fund-orders/convert` | 原子记录已执行的基金转换，目标份额可待确认 |

买入最少需要 `instrument_id`、`account_id`、`amount`；日期可默认为今天，状态默认为 `submitted`。`paid` 明确表示已扣款，`confirmed` 要求实际份额、净值、确认日期及费用规则。`funding_source=account` 默认从所选持仓账户资金扣款，可指定 `cash_account_id`；`untracked` 明确记为账外追加本金，不伪造银行账户，不计为收入。`associate` 可之后关联实际资金账户。

`fee_mode` 可为 `unknown`、`zero`、`fixed`、`rate`，`fee_value` 保留十进制精度。`auto_estimate` 默认关闭，开启后才按正式净值推算份额并标记 `estimated`；它不是机构确认。`remember_defaults` 保存此基金的默认值。自动定投亦支持显式的 `automation.funding_source=untracked` 与费率规则。

账户返回 `recording_mode`、`history_status`、`recording_start_date`。余额记录不推断投资收益；缺失历史不提供完整年化。待确认明细的 `source_account_id` 始终表示在途资金记账位置，补关联后的实际付款来源另由 `actual_funding_account_id` 表示，避免改动资金归属或重复加总。
# 2.11.0 数据源增量

- `GET /admin/data-sources` 增加 `akshare` 公共渠道，无需凭证；能力仅为本版已实现的境内市场接口。`config.schema_version` 升至 3，兼容 1、2 的旧配置；新版显式关闭及排序生效。
- 行情及来源详情增加 `source_group`、`source_group_name`、`upstream_provider_id`；AKShare 行情含 `interface_name`。查询渠道与原始发布方分别展示。
- 基金 `data_quality` 增加 `agreeing_source_groups`、`independent_source_count`。AKShare 与 `eastmoney_fund` 归入同一发布方，二者一致为 `single_source`；差异仍为 `conflict`。隔离恢复要求至少两家独立发布方一致。
- 原有市场刷新、历史行情、价格存储及定投接口保持兼容，不新增个人持仓或交易获取接口。
- 部分期货行情另含 `source_clock`、`timestamp_quality`、`timestamp_message`；夜盘自然日期未核实时公布时间为空，不能从获取时间推出成交或公布时间。
