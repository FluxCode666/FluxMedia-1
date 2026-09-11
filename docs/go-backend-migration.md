# Go 后端全量迁移契约

本文定义 FluxMedia 从 Next.js 服务端 API 切换到 Go 的最终形态。前端页面仍可由
Next.js 渲染，但所有后端 API、认证、数据库访问、媒体任务、队列、Webhook、文件存储
和后台接口必须由 Go 服务直接实现。Go 服务不得把请求转发给 Next.js。

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

切换完成后，生产 Compose 不再为 Go backend 设置 `GO_BACKEND_UPSTREAM_URL`；Go 进程
启动时必须直接建立 PostgreSQL 和 Redis 连接，`/readyz` 必须同时检查两者。

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

使用现有容器：

```bash
docker start fluxcode-local-postgres fluxmedia-local-redis
docker exec fluxcode-local-postgres pg_isready -U fluxcode -d fluxcode
docker exec fluxmedia-local-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping
```

Go 集成测试使用：

```bash
DATABASE_URL="$DATABASE_URL" \
REDIS_ADDR=127.0.0.1:6379 REDIS_PASSWORD="$REDIS_PASSWORD" \
go test -tags=integration ./services/api-gateway/...
```

只有所有 API 契约和 worker 验证通过后，Nginx 才把 API 路径切换到 Go；切换动作是一次
生产变更，不保留 Go→Next.js 的业务回退代理。
