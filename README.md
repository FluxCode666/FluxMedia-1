# FluxMedia

FluxMedia 是面向图片与视频生成业务的全栈平台。项目使用 Turborepo、Vite、
React、TypeScript、Go、Drizzle ORM 与 PostgreSQL，支持站内创作和 OpenAI 风格的媒体 API。

当前 Go 服务 `services/api-gateway` 是统一 backend 入口，直接连接 PostgreSQL 与
Redis，并提供健康检查。`apps/web` 是 Vite 构建的 React SPA，生产构建通过 `go:embed`
打进 Go 二进制，由 Go 同源提供页面、静态资源与 API；后端 API 必须在 Go 中实现。

## 核心能力

- 图片生成、图片编辑与蒙版编辑统一进入 `runImageGenerationForUser`。
- 视频生成使用持久状态机、数据库认领租约与幂等请求键完成跨进程恢复。
- 单一媒体号池仅管理 API 供应商成员；每个成员通过 API 上游配置声明能力。
- 成员通过显式模型 ID 声明能力，不根据模型名称或前缀决定成员类型。
- 全局调度策略可动态选择 `priority`、`least_acquired` 或 `least_load`。
- 统一接口层负责权限、能力、审计与幂等，HTTP 路由只做薄适配。

## 仓库结构

```text
apps/web/                       Vite + React SPA：站点页面、控制台与管理后台
services/api-gateway/       Go backend HTTP 入口
packages/database/              Drizzle schema、迁移与数据库连接
packages/shared/                UOL、积分、存储、审核等共享业务逻辑
packages/ui/                    共享 UI 组件
deploy/                         生产 Compose、Nginx 与部署脚本
```

## Go 迁移当前状态

**全量迁移尚未完成，当前分支不能作为 Go 后端最终验收或生产发布版本。**
Go 已有认证主流程、外部积分/模型查询和原生 SQL 迁移；媒体生成、后台任务、管理端
操作、支付、存储等仍需迁移，未迁移的接口返回 `501 route_not_migrated`。完整清单与验证记录见
[迁移契约](docs/go-backend-migration.md)，生产发布会检查实际 Go 路由覆盖并阻止未完成的切换。

## 本地开发

需要 Node.js 22、pnpm 10、Go 1.26.6+ 以及 PostgreSQL/Redis。已有本地配置时继续使用原来的
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
make dev-frontend      # Vite 页面 :3000（/api 等后端路径代理到 :8080）
make dev-script-runtime # 私有 QuickJS 脚本运行时 :8090
make dev-media-processing-runtime # 私有 ONNX / sharp 运行时 :8091
# 或使用 make dev 一次启动上述四个进程
```

常用质量门：

```bash
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm --filter @repo/web build
(cd services/api-gateway && gofmt -l . && go vet ./... && go test -race ./...)
node --test services/unified-runtime/*.test.mjs
```

生产构建产物位于 `apps/web/dist`；Go 以 `-tags embed` 构建时把它编进二进制，未带该 tag
的开发构建不含页面，由 Vite 开发服务器提供。

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

根目录 `docker-compose.yml` 提供 PostgreSQL、Redis 与统一 `app` 容器的自托管组合；
源码开发的 `make dev` / `pnpm dev` 将 Vite、Go、QuickJS 与 ONNX/Sharp 分别启动，便于
独立调试。生产环境使用 `deploy/docker-compose.yml`：`Dockerfile.unified` 先构建 SPA 并以
`-tags embed` 编进 Go 二进制，再与 QuickJS、ONNX/Sharp 两个 Node 运行时打进一个 `app`
镜像和容器，PostgreSQL、Redis 与宿主机 Nginx 继续作为外部基础设施。生产启动命令为
`docker compose up -d app`。

```bash
cp .env.docker.example .env   # 按需修改 POSTGRES_PASSWORD、BETTER_AUTH_SECRET 与超管账号
docker compose config --quiet
docker compose up -d --build
```

根 Compose 的 `app` 容器中，Go 进程固定监听 `8080`，同源提供页面与 API；宿主机映射
端口由 `WEB_PORT` 配置，默认是 `3000`，需与 `NEXT_PUBLIC_APP_URL`、`BETTER_AUTH_URL`
保持一致。如需修改，在 Compose 使用的 env 文件中设置：

```bash
WEB_PORT=3000
```

根 Compose 的 `app` 启动时自动执行未应用的迁移（`GO_BACKEND_SKIP_MIGRATION` 默认
`false`），数据库中没有超级管理员时按 `FLUXMEDIA_SUPER_ADMIN_EMAIL` /
`FLUXMEDIA_SUPER_ADMIN_PASSWORD` 创建，已有账号不会被重置。本地构建的镜像版本为
`0.0.0-dev`，不支持站内更新。

生产 Compose 的统一健康检查同时探测三个内部进程；任一进程退出都会使容器失败。
生产 `app` 常驻启动时跳过迁移：换镜像时由 Deploy Production 在维护窗口中执行一次，
站内更新时由容器重启后的 `boot.mjs` 执行（见下文）。
`Dockerfile.api-gateway` 等专项 Dockerfile 仍保留用于组件级构建和诊断（不含 Web 页面），
不代表 Compose 仍使用多容器拓扑。
生产部署、维护窗口和备份要求见 [docs/CI-CD.md](docs/CI-CD.md) 与
[deploy/README.md](deploy/README.md)。统一号池调度契约见
[docs/image-backend-pool-scheduling.md](docs/image-backend-pool-scheduling.md)。

## 站内更新

推送版本 tag 后，Release 流水线发布 GHCR 统一镜像 `ghcr.io/fluxcode666/fluxmedia-1-app`
与 GitHub Release。Release 除部署包外还附带应用包 `fluxmedia-app-linux-amd64.tar.gz`
（镜像内的 `/app` 与 `/backend`，不含媒体模型），manifest 中记录应用包 SHA-256 与
**平台指纹**。生产环境有两条升级路径：

| 路径 | 适用条件 | 做法 |
|---|---|---|
| 站内更新 | 最新正式 Release（不含 prerelease）比当前版本新，且平台指纹与运行中的镜像一致 | 超级管理员点击侧栏品牌区的版本号，在弹窗中查看更新说明并确认 |
| Deploy Production | 平台指纹变化，或需要换镜像 | 在 Actions 手动运行 Deploy Production（见 [.github/CICD.md](.github/CICD.md)） |

平台指纹由 `deploy/compute-platform-fingerprint.sh` 计算，覆盖站内更新无法替换的内容：
基础镜像与系统依赖（`Dockerfile.unified` 中 `platform-fingerprint` 标记段）、入口脚本、
`boot.mjs`、健康检查、媒体模型，以及根/生产 Compose 与 Nginx 配置。修改这些内容的版本
在弹窗中提示需要通过 Deploy Production 发布，不能站内安装。

站内更新流程（精简安全链）：

1. Go 从 GitHub Release 下载应用包到持久卷，按 manifest 校验 SHA-256 与平台指纹，
   安全解压到 `releases/<版本>`（拒绝路径穿越、绝对链接与特殊文件）。
2. 用镜像内的 `pg_dump` 备份数据库到 `releases/backups/`，只保留最近 3 份。
3. 在 `releases/state.json` 写入待切换版本，请求进程监管器退出；容器按
   `restart: unless-stopped` 重启。
4. 重启后 `boot.mjs` 先在业务端口提供维护响应（页面自动刷新，API 返回
   `503 SYSTEM_UPDATING`），再用新版本 backend 执行 `--migrate`，随后回填控制台统计
   读模型（失败只记警告）；Go 启动时幂等确保运营统计 epoch。
5. 迁移成功则切换到新版本并清理旧版本目录；迁移失败（事务整体回滚）、版本目录不完整或
   连续 3 次未完成时，保持原版本运行并在弹窗中显示失败原因。

持久卷在生产环境为 `/root/docker-data/fluxmedia-releases`（Deploy Production 会以应用
用户 uid 1001 创建），根 Compose 为 `app-releases` 卷，均挂载到 `/app/releases`。
`boot.mjs` 只在卷内版本记录的基础镜像与当前镜像一致时使用它；Deploy Production 越过迁移
边界后还会把 `state.json` 改名为 `state.superseded-<tag>.json`，因此通过 Deploy Production
部署的版本（包括重新部署同一镜像）始终以镜像为准。

回滚：站内更新后的迁移已提交，不能只切回旧代码。需要回退时，先用
`releases/backups/` 中更新前的备份恢复数据库，再用 Deploy Production 部署旧版本镜像。
开发构建、非 `linux/amd64` 平台、缺少 `pg_dump` 或持久卷不可写时，弹窗会说明原因并禁用更新。
