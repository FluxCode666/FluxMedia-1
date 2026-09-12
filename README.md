# FluxMedia

FluxMedia 是面向图片与视频生成业务的全栈平台。项目使用 Turborepo、Next.js、
React、TypeScript、Go、Drizzle ORM 与 PostgreSQL，支持站内创作和 OpenAI 风格的媒体 API。

当前 Go 服务 `services/api-gateway` 是统一 backend 入口，直接连接 PostgreSQL 与
Redis，并提供健康检查。页面仍由 Next.js `web` 渲染；后端 API 必须在 Go 中实现。

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
services/api-gateway/       Go backend HTTP 入口
packages/database/              Drizzle schema、迁移与数据库连接
packages/shared/                UOL、积分、存储、审核等共享业务逻辑
packages/ui/                    共享 UI 组件
deploy/                         生产 Compose、Nginx 与部署脚本
```

## Go 迁移当前状态

**全量迁移尚未完成，当前分支不能作为 Go 后端最终验收或生产发布版本。**
Go 已有认证主流程、外部积分/模型查询和原生 SQL 迁移；媒体生成、后台任务、管理端
操作、支付、存储等仍需迁移。前端仍在执行原 Next.js 业务。完整清单与验证记录见
[迁移契约](docs/go-backend-migration.md)，生产发布会检查实际 Go 路由覆盖并阻止未完成的切换。

## 本地开发

需要 Node.js 20+、pnpm 10、Go 1.26.6+ 以及 PostgreSQL/Redis。已有本地配置时继续使用原来的
`.env` / `.env.local`，不要替换数据库名或认证密钥。新环境可参考 `.env.example`，配置
`DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL` 与 `REDIS_*`。
启动命令的配置优先级为：显式环境变量 > 根目录 `.env.local` > 根目录 `.env`。

```bash
pnpm install
```

开发环境启动（Go 启动时会先执行未应用的 SQL 迁移；脚本运行时只接受 Go backend 的内部请求）：

```bash
make dev-infra-up
make dev-migrate       # 可选：仅执行迁移后退出，使用相同的数据库配置
make dev-backend       # Go backend :8080
make dev-frontend      # Next.js 页面 :3000
make dev-script-runtime # 私有 QuickJS 脚本运行时 :8090
# 或使用 make dev 一次启动上述三个服务
```

常用质量门：

```bash
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm --filter @repo/web build
```

## 线上文生图并发测试

仓库提供一个独立的 Node.js 脚本，用于直接请求线上 FluxMedia HTTP 服务，不需要启动
本地 Web、数据库或 Redis。脚本路径为
[`scripts/test-image-concurrency.mjs`](scripts/test-image-concurrency.mjs)，需要 Node.js
20+，API key 只通过环境变量传入。

最小运行示例：

```bash
export FLUXMEDIA_API_KEY="你的 API Key"
export FLUXMEDIA_BASE_URL="https://你的线上域名"

node scripts/test-image-concurrency.mjs
```

默认会测试 `gpt-image-2`、`nano-banana-2` 和 `nano-banana-pro`，每个模型发送 1 次，
同时最多 3 个请求。常用压测示例：

```bash
FLUXMEDIA_API_KEY="你的 API Key" \
node scripts/test-image-concurrency.mjs \
  --base-url "https://你的线上域名" \
  --concurrency 6 \
  --requests-per-model 10 \
  --size 1024x1024 \
  --response-format url
```

请求量计算方式为：

```text
总请求量 = 模型数量 × --requests-per-model
```

例如 3 个模型、`--requests-per-model 10`、`--concurrency 6` 时，总请求量是 30，
`--concurrency 6` 只表示同时最多有 6 个请求在执行。

脚本内置 100 条生图提示词。未传 `--prompt` 时，每个请求会取一条提示词；前 100 个
请求不重复，超过后重新随机打散循环。传入 `--prompt` 可固定所有请求使用同一提示词。

支持的参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--base-url URL` | `FLUXMEDIA_BASE_URL`、`G2I_BASE` 或现有线上地址 | 服务 origin，脚本请求 `/v1/images/generations` |
| `--models A,B,C` | 三个默认模型 | 逗号分隔的模型 ID |
| `--concurrency N` | `3` | 配置的最大同时在途请求数；实际并发数为它与总请求量的较小值 |
| `--requests-per-model N` | `1` | 每个模型的请求数 |
| `--size WIDTHxHEIGHT` | `1024x1024` | 图片尺寸 |
| `--prompt TEXT` | 内置提示词池 | 固定提示词；省略时从 100 条池中取用 |
| `--quality VALUE` | 不发送 | `auto`、`low`、`medium`、`high`，只发给 `gpt-image-2` |
| `--response-format VALUE` | `url` | `url` 或 `b64_json`；压测建议使用 `url` |
| `--output-format VALUE` | 不发送 | `png`、`jpeg` 或 `webp` |
| `--timeout-ms N` | `1200000` | 单请求超时时间，单位毫秒 |
| `--json` | 关闭 | 输出 JSON 汇总，进度写入 stderr |
| `--help` | - | 显示帮助 |

JSON 结果包括总请求数、配置并发数、实际并发数、成功率、吞吐、min/avg/p50/p95/max
延迟、按模型统计、HTTP 错误统计和每个请求的 `promptIndex`。脚本默认不重试失败请求，
以保持并发和请求量可测量。
退出码为 `0`（全部成功）、`2`（有请求失败）、`1`（参数或启动错误）或 `130`（收到中断）。

本地开发账号密码：
test@test.com
123456

## 容器与生产部署

根目录 `docker-compose.yml` 提供 PostgreSQL、Redis、backend 与 Web 的自托管组合；迁移
由 backend entrypoint 执行。生产环境使用 `deploy/docker-compose.yml`，数据库和 Redis
由外部基础设施提供，统一启动命令为 `docker compose up -d backend web`。

```bash
GPT2IMAGE_ENV_FILE=.env.docker.example docker compose config --quiet
docker compose up -d
```

生产 Compose 会同时启动 backend、私有 script-runtime 和 Web；数据库迁移由 backend 容器
entrypoint 执行。生产部署、维护窗口和备份要求见 [docs/CI-CD.md](docs/CI-CD.md) 与
[deploy/README.md](deploy/README.md)。统一号池调度契约见
[docs/image-backend-pool-scheduling.md](docs/image-backend-pool-scheduling.md)。
