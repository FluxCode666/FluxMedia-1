# FluxMedia

FluxMedia 是面向图片与视频生成业务的全栈平台。项目使用 Turborepo、Next.js、
React、TypeScript、Drizzle ORM 与 PostgreSQL，支持站内创作和 OpenAI 风格的媒体 API。

## 核心能力

- 图片生成、图片编辑与蒙版编辑统一进入 `runImageGenerationForUser`。
- 视频生成使用持久状态机、数据库认领租约与幂等请求键完成跨进程恢复。
- 单一媒体号池仅管理 API 供应商成员；每个成员通过 API 上游配置声明能力。
- 成员通过显式模型 ID 声明能力，不根据模型名称或前缀决定成员类型。
- 全局调度策略可动态选择 `priority`、`least_acquired` 或 `least_load`。
- 统一接口层负责权限、能力、审计与幂等，HTTP 路由只做薄适配。

## 仓库结构

```text
apps/web/                       Next.js 主应用、管理后台与媒体路由
packages/database/              Drizzle schema、迁移与数据库连接
packages/shared/                UOL、积分、存储、审核等共享业务逻辑
packages/ui/                    共享 UI 组件
deploy/                         生产 Compose、Nginx 与部署脚本
```

## 本地开发

需要 Node.js 20+、pnpm 10、PostgreSQL 16。复制 `.env.example` 为
`.env.local`，至少配置 `DATABASE_URL`、`BETTER_AUTH_SECRET` 与
`BETTER_AUTH_URL`，然后执行：

```bash
pnpm install
pnpm --filter @repo/database db:push
pnpm dev
```

数据库迁移
```bash
pnpm --filter @repo/database db:migrate
```

常用质量门：

```bash
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm --filter @repo/web build
```

本地开发账号密码：
test@test.com
123456

## 容器与生产部署

根目录 `docker-compose.yml` 提供包含 PostgreSQL、Redis、迁移与 Web 的自托管组合。生产环境使用 `deploy/docker-compose.yml`，数据库和 Redis
由外部基础设施提供，迁移只在维护 profile 中运行。

```bash
GPT2IMAGE_ENV_FILE=.env.docker.example docker compose config --quiet
docker compose up -d
```

生产部署、维护窗口和备份要求见 [docs/CI-CD.md](docs/CI-CD.md) 与
[deploy/README.md](deploy/README.md)。统一号池调度契约见
[docs/image-backend-pool-scheduling.md](docs/image-backend-pool-scheduling.md)。

## 许可证

AGPL-3.0-only。
