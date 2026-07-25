# CI/CD 流水线说明

> 落实 `CLAUDE.md` / `AGENTS.md` 第 0 章协作准则的**自动化执法层**。
> 所有协作者与 PR 贡献者的提交都必须通过本流水线的门禁。

## 总览

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | PR / push → `main`，手动 | 提交门禁：文档镜像、风格、类型、测试、构建、容器可构建性 |
| `.github/workflows/docker-release.yml` | push tag `v*.*.*`，手动 | 上游发布：构建并推送 4 个镜像到 GHCR + 起草 GitHub Release |
| `.github/workflows/deploy-production.yml` | 手动 | FluxMedia 生产部署：质量门、web/migrate 镜像、GHCR、SSH + Docker Compose |
| `.github/actions/setup/action.yml` | 被 ci.yml 复用 | 统一 Node 22 + pnpm + frozen-lockfile 安装 |
| `.github/dependabot.yml` | 每周 | 依赖 / Action 安全更新自动开 PR |

## ci.yml —— 提交门禁（6 个 job）

并行运行，各自在 PR 的 Checks 面板独立显示，便于设为「必须通过」。

1. **docs-mirror**（push + PR）：断言 `CLAUDE.md` 与 `AGENTS.md` 逐字一致（镜像文件约束）。秒级、免依赖。
2. **lint（仅 PR、仅改动文件）**：用仓库锁定的 Biome 2.3.11，对本次 **PR 触及的文件**执行 `biome lint --changed --since=<base.sha>`。
   - **为何用 `biome lint` 而非 `biome ci`**：仓库历史代码从未全量 biome 格式化（全仓 `biome ci` 有 300+ 格式报错），团队既有约定 `turbo lint` 即 `biome lint`。强制格式会误伤大量历史文件，故只查 lint 规则、不查格式。
   - **为何只在 PR**：贡献者门禁的精确点是 PR，diff = PR 相对目标分支的净改动（小而准）。push（尤其合并提交）改动集巨大，会把所触碰文件里的历史 lint 债一并暴露，造成无关失败。
   - **退出码**：有 lint 错误（如 `noExplicitAny` / `noUnusedImports`）即失败；告警级规则（如 `noNonNullAssertion: warn`）不阻断（与本地 `biome lint` 一致）。
   - 纯文档 PR（无 JS/TS 改动）→ `Checked 0 files` → 通过。
3. **typecheck**（push + PR）：先 `pnpm --filter @repo/web exec fumadocs-mdx` 生成 Fumadocs 的 `.source`（被 .gitignore 忽略、平时由 `next dev/build` 的 createMDX 产出；独立 `tsc` 不会触发，缺失会引发 `src/lib/source.ts` 找不到 `.source/server` 的连锁 any 报错），再 `pnpm turbo typecheck`（全仓 strict `tsc --noEmit`）。
4. **test**（push + PR）：`pnpm turbo test`（全仓 vitest，DB-free）。覆盖积分/扣费/幂等/API 等核心逻辑。
5. **build**（push + PR）：`pnpm turbo build --filter=@repo/web`（Next standalone 生产构建，`next build` 会自行生成 `.source`）。环境变量为占位值，与 `Dockerfile.web` 的 build-args 一致；**不设 `NODE_ENV=production`**（否则 pnpm 跳过 devDependencies 导致构建失败）。
6. **docker-build（仅 PR）**：用 `Dockerfile.web` 实打实构建 web 镜像但**不推送**，验证多阶段 Dockerfile（turbo prune → install → build → standalone）未损坏。在前 4 个 job 通过后才跑（`needs`），gha 缓存加速。

> 门禁有效性已本地验证：`biome lint --changed` 对含 `noExplicitAny` 的改动文件失败（EXIT≠0），对仅含 `noNonNullAssertion` 告警的文件通过；纯文档改动 `Checked 0 files` 通过。
> 首次推送（2026-05-30）经 CI 实跑修正：typecheck 因缺 `.source` 失败 → 增生成步骤；lint 原用 `biome ci`（含格式）在大合并改动集上暴露 300+ 历史格式债 → 改 `biome lint` 且仅 PR。

## docker-release.yml —— 发布（tag 触发）

- 触发：推送形如 `v*.*.*` 的 tag（含预发布 `v1.0.0-rc.1`，glob `v*.*.*` 同样匹配）。
- 构建 + 推送到 GHCR（`ghcr.io`）5 个镜像：`web`、`migrate`、`chatgpt-web-proxy`、`chatgpt-register`、`ab-shadow-relay`，tag 含语义 tag、`latest`、`sha-<sha>`。
- 起草（draft）一份 GitHub Release，附 docker-compose 部署包（`.tar.gz` / `.zip`）。

## deploy-production.yml —— FluxMedia 生产部署

- 允许从 `main` 或与输入版本完全一致的 Git tag 手动触发，版本号必须符合项目版本
  格式；可选择只构建镜像。tag 与输入版本不一致时会在质量门阶段拒绝部署。
- 发布前执行文档镜像、全仓 lint、typecheck、DB-free test、临时 PostgreSQL 迁移与审核
  事务集成测试、Web production build，随后构建 `linux/amd64` 的 `fluxmedia-web` 与
  `fluxmedia-migrate` 镜像并推送不可变版本 tag 与 `latest` 到 GHCR。
- 使用 SSH 账号密码连接目标机，同步 `deploy/docker-compose.yml`、数据库备份脚本与受测
  dotenv 读取器；SSH 参数与 FluxCode 一致，不校验主机指纹。连接后先拉取新镜像，再停止
  旧 Web、排空 `fluxmedia-web` 数据库连接、执行只读迁移预检、创建本地或加密版本化备份，
  最后迁移并只启动新 Web，不会启动注册机。
- 目标机的真实 `.env` 不离开服务器；流水线只输出不含数据的预检计数、备份存储类型、
  artifact ID、SHA-256 与销毁截止时间。迁移开始后的任何失败都保持维护状态，不自动启动
  旧 schema 镜像。完整初始化见 `deploy/README.md`，破坏性迁移手册见
  `docs/plan/2026-07-23-api-key-moderation-rollout.md`。

## 生产部署配置清单

生产配置分为两处：GitHub `production` Environment 保存部署凭据和目标机信息；目标
服务器 `/root/flux-media/.env` 保存应用运行时配置。`DATABASE_URL`、认证密钥、支付密钥
等运行时机密不得复制到 GitHub Actions，也不得提交到仓库。

### GitHub production Environment

在仓库 `Settings → Environments → production` 中配置下列 Secrets。建议为生产
Environment 启用审批保护，避免误触发生产部署。

| 名称 | 必填 | 用途与要求 |
|---|---|---|
| `DEPLOY_HOST` | 是 | 目标服务器 IP 或主机名，不含协议和端口。 |
| `DEPLOY_USER` | 是 | SSH 部署用户，必须能写入部署目录并执行 Docker；默认目录位于 `/root`，通常需要填写 `root`。 |
| `DEPLOY_PASSWORD` | 是 | SSH 登录密码，必须使用高强度随机密码并仅保存在 GitHub Secret 中。 |
| `GHCR_PAT` | 是 | 目标机拉取私有镜像使用；创建者必须与 `GHCR_USERNAME` 一致，至少授予 `read:packages`，并按 GitHub 要求完成 Organization SSO 授权。 |
| `DEPLOY_PORT` | 否 | SSH 端口，留空时使用 `22`，有效范围 `1` 至 `65535`。 |

目标机 SSH 服务必须允许密码认证，部署账号还必须具备目标目录写权限和 Docker 执行权限；
Workflow runner 会自动安装 `sshpass`，不会将密码写入文件或命令参数。为与 FluxCode
保持一致，流水线设置 `StrictHostKeyChecking=no` 和 `UserKnownHostsFile=/dev/null`，不校验
服务器主机指纹；请仅在你接受该安全取舍的网络环境中使用。

如果 `DEPLOY_USER` 不是 `root`，必须把 `DEPLOY_PATH` 改为该账号可写的绝对路径。

在 Repository Variable 或 `production` Environment Variable 中配置：

| 名称 | 必填 | 默认值 | 用途与要求 |
|---|---|---|---|
| `DEPLOY_PATH` | 否 | `/root/flux-media` | 目标机 Compose 与 `.env` 所在目录；必须是不含空格的绝对路径。 |
| `GHCR_USERNAME` | 否 | Workflow 触发者 | 创建 `GHCR_PAT` 的 GitHub 用户名；建议固定配置，避免其他用户触发时与 PAT 所属账号不一致。 |

以下值无需人工配置：

- `GITHUB_TOKEN`：GitHub Actions 自动提供，构建端用它把镜像推送到当前仓库 owner 的
  GHCR 命名空间；目标机拉取私有镜像则使用 `GHCR_USERNAME` 与 `GHCR_PAT`。
- `version`：手动触发 Workflow 时输入，不是 Secret；必须符合
  `v<MAJOR>.<MINOR>.<PATCH>[-<alpha|beta|rc>.<N>]`。
- `PUBLIC_APP_URL`：当前在 Workflow 中固定为 `https://media.flux-code.cc`。修改域名时
  必须同步修改该值并重新构建镜像，不能只修改服务器 `.env`。

### 目标服务器必填环境变量

首次部署时将 `deploy/.env.example` 复制为 `/root/flux-media/.env`，权限设为 `0600`。
以下值必须在启动前确认：

| 名称 | 是否机密 | 用途与要求 |
|---|---|---|
| `DATABASE_URL` | 是 | 外部 PostgreSQL 连接串。迁移器需要建表、改表和索引权限，Web 需要正常读写权限；不要使用示例口令。 |
| `BETTER_AUTH_SECRET` | 是 | 会话和 Cookie 签名密钥，使用 `openssl rand -base64 32` 生成，轮换会使现有会话失效。 |
| `BETTER_AUTH_URL` | 否 | 站点完整 HTTPS 地址，例如 `https://media.flux-code.cc`，必须与浏览器实际访问地址一致。 |
| `NEXT_PUBLIC_APP_URL` | 否 | 前端公开站点地址，必须与 `BETTER_AUTH_URL` 和 Workflow 的 `PUBLIC_APP_URL` 一致。 |
| `BETTER_AUTH_TRUSTED_ORIGINS` | 否 | 可信来源，单域部署填写与站点相同的 origin；多域名用逗号分隔。 |

`NEXT_PUBLIC_APP_URL` 会写入浏览器端产物。修改域名后，即使服务器 `.env` 已更新，也
必须重新运行生产 Workflow 构建镜像，否则客户端仍会使用旧地址。

### 生产迁移备份配置

目标机必须安装与数据库主版本兼容的 PostgreSQL 客户端。`DEPLOY_BACKUP_S3_BUCKET`
留空时，Workflow 将备份写入 `${DEPLOY_PATH}/backups/<version>/`，目录权限为 `0700`、
文件权限为 `0600`，并复核 custom-format manifest 与最终文件 SHA-256。这是同机恢复点，
不能替代异地灾备。

填写 `DEPLOY_BACKUP_S3_BUCKET` 后才启用远端模式；此时目标机必须安装 age 和 AWS CLI v2，
bucket 必须启用版本控制，age 私钥只放在批准的离线恢复介质，服务器仅保存公钥。S3 预检、
权限或上传校验失败会拒绝迁移，不会静默回退到本地。

| 名称 | 必填 | 默认值 | 用途与要求 |
|---|---|---|---|
| `DEPLOY_BACKUP_S3_BUCKET` | 否 | 空 | 配置后使用专用版本化备份 bucket；不得与公开静态资源共用；留空使用本地备份。 |
| `DEPLOY_BACKUP_S3_PREFIX` | 否 | `fluxmedia-production` | 部署身份被授权写入的最小对象前缀。 |
| `DEPLOY_BACKUP_AGE_RECIPIENT` | 条件 | 无 | S3 模式必填的标准 `age1...` 公钥；对应私钥不得进入目标机或 GitHub。 |
| `DEPLOY_BACKUP_RETENTION_DAYS` | 否 | `7` | 回滚窗口，允许 1 至 30 天；摘要会计算并记录销毁截止时间。 |
| `DEPLOY_BACKUP_AWS_PROFILE` | 否 | 空 | 目标机专用 profile；使用实例角色时留空。 |

S3 模式优先使用目标机实例角色；否则 profile 凭据只存目标机标准 AWS 凭据文件。部署身份
仅授予指定前缀的 `s3:GetBucketVersioning`、`s3:PutObject`、`s3:GetObjectVersion`；
`s3:DeleteObjectVersion` 由独立值班销毁身份持有。

### 流水线托管的镜像变量

这些变量必须存在于服务器 `.env`，但正常发布时不应手工修改。流水线会在拉取镜像前
写入本次构建结果，并在应用回滚时恢复上一组值。

| 名称 | 模板初始值 | 流水线行为 |
|---|---|---|
| `FLUXMEDIA_IMAGE` | `ghcr.io/fluxcode666/fluxmedia-web` | 写入当前仓库 owner 对应的 Web 镜像名。 |
| `FLUXMEDIA_MIGRATE_IMAGE` | `ghcr.io/fluxcode666/fluxmedia-migrate` | 写入同版本数据库迁移镜像名。 |
| `FLUXMEDIA_TAG` | `latest` | 发布时覆盖为手动输入的不可变版本，例如 `v0.8.1`；生产 Workflow 不使用 `latest` 部署。 |

`GHCR_USERNAME` 只决定登录身份，不改变镜像命名空间。镜像仍推送到当前仓库 owner 下，
即 `ghcr.io/fluxcode666/fluxmedia-web` 和 `ghcr.io/fluxcode666/fluxmedia-migrate`。

### 目标服务器基础运行变量

除超管密码外，以下值不是机密；模板已提供适合当前单机 Nginx 反代拓扑的默认值。修改时
必须同步 Compose、Nginx 或应用约束。

| 名称 | 当前建议值 | 说明 |
|---|---|---|
| `BIND_HOST` | `127.0.0.1` | 只允许宿主机 Nginx 访问 Web 端口，禁止直接暴露公网。 |
| `WEB_PORT` | `3000` | 必须与 Nginx upstream `127.0.0.1:3000` 一致。 |
| `NEXT_PUBLIC_APP_NAME` | `FluxMedia` | 应用显示名称；生产 Workflow 以构建参数固定为 `FluxMedia`，如需修改生产镜像中的名称，必须同步修改 Workflow 后重新构建。 |
| `LOCAL_STORAGE_PATH` | `/app/storage` | 本地文件存储目录，对应 `app-storage` 命名卷。 |
| `NEXT_PUBLIC_AVATARS_BUCKET_NAME` | `avatars` | 头像存储桶名称。 |
| `NEXT_PUBLIC_GENERATIONS_BUCKET_NAME` | `generations` | 生成内容存储桶名称。 |
| `SELF_USE_MODE_ENABLED` | `true` | 启用单用户自用模式和首次超管初始化。 |
| `FLUXMEDIA_SUPER_ADMIN_EMAIL` | 无 | 首次创建超管所用邮箱；自用模式启用且尚无超管时必须设置。 |
| `FLUXMEDIA_SUPER_ADMIN_PASSWORD` | 无 | 首次创建超管所用密码；机密，仅保存在服务器 `.env` 或 Secret Manager，绝不写入镜像、日志或凭据文件。 |
| `INTERNAL_JOB_SCHEDULER_ENABLED` | `true` | 单实例启用内部定时任务；多实例前必须先实现任务互斥。 |
| `APP_TIME_ZONE` | `Asia/Shanghai` | 用户未设置个人时区时的站内展示兜底，仅由部署环境管理；数据库连接和外部 API 始终使用 UTC。 |
| `TZ` | `Asia/Shanghai` | 容器进程的系统时区；不会改变固定为 UTC 的 PostgreSQL 会话。 |
| `RATE_LIMIT_TRUSTED_PROXY` | `true` | 仅因请求只经过受控宿主机 Nginx 才可启用；直连公网部署必须设为 `false`。 |
| `REDIS_HOST` | 无 | 外部 Redis 的 IP 或主机名；必须由服务器 `.env` 提供。 |
| `REDIS_PORT` | `6379` | 外部 Redis 端口，必须是 `1` 到 `65535` 的整数。 |
| `REDIS_USERNAME` | 无 | Redis ACL 用户名；不使用 ACL 时留空。 |
| `REDIS_PASSWORD` | 无 | Redis 密码；作为独立参数传递，无需 URL 编码。 |
| `REDIS_DB` | `4` | 系统设置共享缓存使用的逻辑库编号，默认固定为 4。 |

本部署不运行注册机。`CHATGPT_REGISTER_URL` 与 `CHATGPT_REGISTER_SECRET` 应保持为空，
生产 Compose 还会显式覆盖为空，防止旧 `.env` 意外连接注册机。

### 按功能启用的可选密钥

以下配置不是最小启动条件，仅在启用相应功能时填写。真实密钥只放目标服务器 `.env`
或专用 Secret Manager；完整非机密参数和示例见仓库根目录 `.env.example`。

| 功能 | 需要保护的变量 | 配置说明 |
|---|---|---|
| GitHub OAuth | `GITHUB_CLIENT_SECRET` | 与 `GITHUB_CLIENT_ID` 配套；回调域名必须使用生产域名。 |
| Google OAuth | `GOOGLE_CLIENT_SECRET` | 与 `GOOGLE_CLIENT_ID` 配套；回调域名必须使用生产域名。 |
| Creem 支付 | `CREEM_API_KEY`、`CREEM_WEBHOOK_SECRET` | 同时配置对应 `NEXT_PUBLIC_CREEM_PRICE_*` 价格 ID。 |
| 易支付 | `EPAY_KEY` | 同时配置 `EPAY_API_URL`、`EPAY_PID`、通知地址和默认支付方式。 |
| 支付宝当面付 | `ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` | 同时配置应用 ID、商家 PID、通知地址和充值比例。 |
| SMTP / Resend | `SMTP_PASS` 或 `RESEND_API_KEY` | 与发件地址、SMTP 主机或 Resend provider 配套。 |
| S3 / R2 存储 | `STORAGE_ACCESS_KEY_ID`、`STORAGE_SECRET_ACCESS_KEY` | 同时配置 endpoint、region 和桶名称；不配置时使用本地命名卷。 |
| 阿里云审核 | `ALIYUN_MODERATION_ACCESS_KEY_ID`、`ALIYUN_MODERATION_ACCESS_KEY_SECRET` | 同时配置文本和图片审核 region、endpoint、service。 |
| OpenAI 审核 | `OPENAI_MODERATION_API_KEY` | 与 `OPENAI_MODERATION_MODEL` 配套。 |
| Upstash 限流 | `UPSTASH_REDIS_REST_TOKEN` | 与 `UPSTASH_REDIS_REST_URL` 配套；未配置时应用按既有降级策略运行。 |
| Axiom 日志 | `AXIOM_TOKEN` | 与 `AXIOM_DATASET` 配套。 |
| Sentry | `SENTRY_AUTH_TOKEN` | 构建上传 sourcemap 时使用；公开 DSN 使用 `NEXT_PUBLIC_SENTRY_DSN`。 |
| 定时任务 / MCP | `CRON_SECRET`、`MCP_ADMIN_SECRET` | 仅启用对应入口时配置，必须使用独立随机密钥。 |

### 部署前核对

```bash
cd /root/flux-media
chmod 600 .env
docker compose --profile maintenance config --quiet
docker compose --profile maintenance pull migrate web
command -v pg_dump pg_restore sha256sum
bash ./create-database-backup.sh preflight \
  .env /root/flux-media '<IMAGE_TAG>' '<GIT_SHA>'
```

如果配置了 `DEPLOY_BACKUP_S3_BUCKET`，预检命令还会检查 `age`、AWS CLI 和 bucket 版本控制；
如果留空，则只创建本地备份目录并检查 PostgreSQL 客户端。S3 模式的 artifact 是带
`versionId` 的对象 URI；本地模式的 artifact 是 `file:///root/flux-media/backups/...`
路径。两种模式都必须完成备份后才允许迁移。

检查展开配置时不要执行不带 `--quiet` 的 `docker compose config` 并复制输出到工单或
日志，因为完整输出会包含 `DATABASE_URL`、认证密钥和第三方凭据。

## 版本与发布流程（对齐 §0.2）

版本格式：`v<MAJOR>.<MINOR>.<PATCH>-<alpha|beta|rc>.<N>`（正式版去后缀）。

```bash
# 在 main 验证通过后，在目标提交上打 tag 触发发布：
git tag v0.2.0-rc.1
git push origin v0.2.0-rc.1   # → 触发 docker-release.yml
```

## 分支保护（已启用）

`main` 已通过 gh API 启用分支保护（2026-05-30）。Required status checks（5 个）：
`Docs mirror (CLAUDE == AGENTS)`、`Lint & format (changed files)`、`Typecheck`、`Unit tests`、`Build web`。
另：`strict=true`（合并前须与目标分支同步）、禁 force-push、禁删除、要求会话解决；`enforce_admins=false`（管理员可应急直推）。
`docker-build` 在 PR 上运行但未列为 required（保 PR 迭代速度），可按需提升。

修改配置示例：
```bash
gh api -X PUT repos/MeowFree/GPT2Image-Pro/branches/<dev|main>/protection --input <config>.json
gh api repos/MeowFree/GPT2Image-Pro/branches/<dev|main>/protection/required_status_checks  # 查看当前
```

## 已知边界 / 后续

- **第三方 Action 已钉 SHA**：`ci.yml` / `docker-release.yml` / `deploy-production.yml` / `actions/setup` 中的第三方 Action 均钉到 40 位 commit SHA（行尾注释保留可读大版本），防 tag 重指向供应链攻击；由 dependabot 周更自动维护。升级大版本（如 checkout v5→v6）是单独的人工决策。
- **lint 仅覆盖改动文件**：若未来对全仓做一次性 `biome format` 重排，可将门禁升级为全仓 `biome ci`。
- **build 与 docker-build 在 PR 上各构建一次**：分别校验「代码可构建」与「镜像可打包」，刻意保留以提高鲁棒性；如需省额度可二选一。
- **普通 CI 测试仍为 DB-free**：生产 Workflow 另起临时 PostgreSQL，应用全部迁移后运行审核
  策略并发、锁等待和审计回滚集成门；其他真实数据库集成面仍需按对应发布计划补充。
- **Windows 本地 `turbo build` 会在 standalone 拷贝阶段报 `EINVAL`**：Next 生成的 trace 文件名含冒号（`[externals]_node:fs_promises...`），Windows 文件名非法。编译本身成功；CI（Linux runner）与 Docker 构建不受影响——本仓库生产构建走 Docker/Linux。
- **行尾**：`.mjs` 等文件的 git blob 为 LF，CI（Linux）下 biome 检查通过；Windows 开发机因 `core.autocrlf=true` 本地工作副本为 CRLF，本地直接跑 `biome` 可能报 `format`（CRLF）告警，属本地假象，不影响 CI。
