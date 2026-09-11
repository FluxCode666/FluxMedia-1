# Go 后端全量迁移契约

本文定义 FluxMedia 从 Next.js 服务端 API 切换到 Go 的最终形态。前端页面仍可由
Next.js 渲染，但所有后端 API、认证、数据库访问、媒体任务、队列、Webhook、文件存储
和后台接口必须由 Go 服务直接实现。Go 服务不得把请求转发给 Next.js。

## 当前实现状态（2026-09-11）

全量迁移未完成。不能把 Go 服务可启动、健康检查通过或下面单项测试通过当作全量迁移完成。
前端尚未切到新增 Go 业务端点，Next.js 仍持有业务、数据库和 Redis 依赖。

已实现的 Go 原生能力：

- 邮箱密码登录/注册、当前会话、退出、资料与密码更新、会话列表/撤销。
- 注册验证码、密码找回和一次性重置、邮箱验证、GitHub/Google OAuth（PKCE + 单次 state）。
- `/api/v1/credits`、`/v1/credits`，保留账户余额、Key 额度和批次过期行为。
- `/api/v1/models`、`/v1/models`，保留 Key 分组、成员启用状态和模型停用过滤。
- Go 读取原 Drizzle journal 与 SQL，在同一事务内迁移并沿用已有迁移记录；并发启动受数据库锁保护。
- 先迁移后监听；`--healthcheck` 请求实际 HTTP `/readyz`，不会提前把迁移中的服务判为健康。

未完成：图片/视频及 Gemini API、上传/存储、审核、支付回调、MCP、搜索、后台任务、
管理端业务、112 个 Server Actions 的调用替换，以及前端数据库/Redis 依赖移除。
认证的账号管理/删号等其他扩展也需对照旧调用继续收口。backend 镜像暂时保留 Node
维护脚本运行环境，现有发布回填/治理脚本仍依赖它；SQL 迁移已经由 Go 执行。

`docs/go-migration-inventory.json` 是从源码抽取的清单：51 个路由文件、83 个 HTTP 方法、
112 个 Server Actions、184 个 operation、79 个静态数据库导入。数字存在重叠，不能相加成迁移进度。
运行下列命令会按实际 Go ServeMux 路由检查覆盖，并明确返回非零状态阻止未完成的生产发布：

```bash
node scripts/audit-go-migration.mjs --write
go -C services/api-gateway run . --route-audit
```

当前检查结果：覆盖 29 个展开后的 HTTP 方法，仍缺 70 个，前端仍有 79 个静态数据库导入。
路由覆盖只证明有 handler，不替代权限、数据和业务行为测试。

本地验证：`make test-go-integration` 通过，使用独立 `fluxmedia_go_test_local` 数据库，
复用指定 PostgreSQL/Redis 容器，不改原 `DATABASE_URL` 或业务库。覆盖原密码/Cookie 兼容、
登录、封禁、跨账号会话隔离、OTP 错误次数/单次消费、重置令牌重放、OAuth 模拟上游、
模型分组过滤、积分过期幂等，以及迁移重复执行、错误回滚和锁取消。
`go test -race ./...`、`go vet ./...`、`go mod verify` 已通过；Go 1.26.6 下
`govulncheck` 未发现可达漏洞。真实 OAuth/邮件供应商未发出请求，Docker 镜像构建因
Docker Hub token 端点连接超时未通过。

## 最终运行拓扑

```text
Nginx
  ├── 页面与静态资源 → Next.js web
  └── /api、/v1、/v1beta、/webhooks → Go backend

Go backend
  ├── PostgreSQL（事实、认证、积分、任务、后台配置）
  ├── Redis（BullMQ 等价队列、锁、缓存）
  ├── 对象存储（图片、视频、导出文件）
  └── 外部媒体供应商
```

生产 Compose 不设置 `GO_BACKEND_UPSTREAM_URL`；Go 进程启动时直接建立 PostgreSQL 和
Redis 连接，`/readyz` 同时检查两者。backend entrypoint 在同一容器内执行数据库迁移。

## API 契约范围

以下路由必须由 Go 原生处理，保持现有 HTTP 状态码、JSON 字段、认证、幂等键、分页
游标和错误结构：

- 外部 API：`/api/v1/models`、`/api/v1/credits`、图片生成/编辑/状态、视频生成/状态/能力。
- Gemini 兼容 API：`/api/v1beta/models/*` 的长任务创建和 operation 查询。
- 站内媒体：`/api/images/*`、`/api/videos/*`、上传预签名、存储读取。
- 认证与会话：`/api/auth/*`、`/api/session/current`、注册验证。
- 管理与运维：模型配置、站点品牌、视频对账、运营导出、MCP、搜索和定时任务。
- 支付与回调：Epay、Creem、支付宝 Webhook 和支付回跳。

## 数据和运行时迁移

- PostgreSQL 继续使用现有 0103 迁移后的表结构；Go 使用显式 SQL 仓储和事务，不复制
  Drizzle 运行时。
- Better Auth 的用户、会话、账号和验证码表由 Go 认证服务直接读写；Cookie 名称、会话
 过期时间和 OAuth 回调地址保持兼容。
- BullMQ 的最小任务消息契约迁移为 Go Redis producer/worker；消息只携带任务 ID、任务
  类型、状态版本和投递版本，不携带提示词、密钥或供应商响应。
- 图片和视频状态机、积分账本、API Key 配额、幂等键和租约必须以 PostgreSQL 事务为
  权威来源，Redis 只负责即时投递和唤醒。
- 对象存储签名、媒体下载、缩略图和导出文件必须在 Go 中实现访问控制和响应头策略。

## 本地验证入口

```bash
make dev-backend          # 使用原 .env/.env.local；先迁移后监听 :8080
make dev-frontend         # 另一个终端；当前仍是原 Next.js 业务 :3000
make test-go
make test-go-integration  # 自动创建/复用专用本地测试库，绝不清空业务库
```

集成测试数据库 URL 如需自定义，使用 `GO_BACKEND_TEST_DATABASE_URL`；只允许本地地址且库名
以 `fluxmedia_go_test_` 开头。`GO_TEST_POSTGRES_ADMIN` 默认 `fluxcode`，用于在
`fluxcode-local-postgres` 容器中创建测试库，所有者沿用原连接串用户。

只有业务实现、前端调用替换、任务验证与部署验证全部完成后才能统一切换。生产发布门禁
当前应失败；不得为发布而绕开这个检查。
