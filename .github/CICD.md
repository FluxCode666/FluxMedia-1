# FluxMedia CI/CD 指南

FluxMedia 使用 GitHub Actions 完成 Pull Request 质量门禁、生产镜像构建和 Docker
Compose 部署。CI 不包含生产机密；生产运行时配置只保存在目标服务器的
`deploy/.env`，GitHub Actions 仅通过 `production` Environment 提供 SSH 与 GHCR
访问凭据。推送版本 tag 后，流水线会创建 GitHub Release；生产部署需管理员手动触发。

## 1. 流水线总览

| 工作流 | 文件 | 触发方式 | 作用 |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | Pull Request 到 `main`，或手动触发 | 文档一致性、lint、类型检查、单元测试、媒体集成测试、Web 构建和 PR 容器构建校验 |
| Deploy Production | `.github/workflows/deploy-production.yml` | 推送合规版本 tag，或 GitHub Actions / 站内超管手动触发 | tag 推送执行质量门、构建并发布 GHCR 镜像和 GitHub Release；生产部署由手动触发 |

当前 CI **不会因为 push 到 `main` 自动触发**。推送合规版本 tag 会自动构建并发布
GitHub Release，但不会直接更新生产环境；超管可从站内“系统更新”页触发部署，也可以从
`Actions → Deploy Production → Run workflow` 手动发起。

```text
Pull Request → main
       │
       └─ CI：文档 / lint / typecheck / test / integration / build / Docker 校验

合规版本 tag 推送
       │
       └─ Deploy Production
             ├─ Quality gate
             ├─ GHCR：统一 app（迁移命令也使用同一镜像）
             └─ GitHub Release（自动生成变更说明）

站内超管 / Actions 手动部署
       └─ 同一版本工作流 → production Environment 审批 → SSH 部署
```

生产工作流文件是执行契约；修改工作流、部署 Compose 或服务器环境要求时，必须同步更新
本文和 [生产部署说明](../deploy/README.md)。

## 2. 相关文件

| 文件 | 说明 |
|---|---|
| `.github/workflows/ci.yml` | PR 与手动 CI 门禁；push 到 `main` 不触发 |
| `.github/workflows/deploy-production.yml` | 生产质量门、镜像发布和 SSH 部署 |
| `.github/actions/setup/action.yml` | 统一 Node.js 22、pnpm 10 与冻结依赖安装 |
| `Dockerfile.unified` | 构建包含 Next.js、Go、QuickJS 与图片处理运行时的统一生产镜像 |
| `deploy/docker-compose.yml` | 生产单一 `app` 服务；PostgreSQL、Redis 与 Nginx 仍是外部基础设施 |
| `deploy/.env.example` | 生产服务器 `.env` 模板，不包含真实机密 |
| `deploy/README.md` | 服务器初始化、Redis、备份、Nginx 和迁移操作手册 |
| `deploy/configure-system-updates.sh` | 服务器端一键配置站内超管更新能力并重建 `app` |
| `docs/CI-CD.md` | CI/CD 设计摘要和维护窗口契约 |

## 3. CI 质量门禁

`.github/workflows/ci.yml` 在 PR 中运行全部适用门禁；手动运行时，只有明确标记为 PR
专用的 job 会跳过。

| Job | 运行条件 | 检查内容 |
|---|---|---|
| `lint` | 仅 PR | 对相对 PR base 变更的文件运行 Biome lint |
| `typecheck` | PR、手动 | 生成 Fumadocs source 后运行 `pnpm turbo typecheck` |
| `test` | PR、手动 | 运行全仓 `pnpm turbo test` |
| `media-integration` | PR、手动 | 使用临时 PostgreSQL 16 与 Redis 7.4，验证号池、媒体任务队列、视频恢复和财务恢复 |
| `build` | PR、手动 | 构建 Web standalone，并执行 API upstream worker 检查和 smoke test |
| `docker-build` | 仅 PR | 构建 runner 镜像并执行容器 smoke test；不推送镜像 |

CI 使用的数据库、Redis 和 `BETTER_AUTH_SECRET` 均为测试/构建占位值。不要把生产
`.env`、支付密钥、对象存储密钥、代理密钥或 SSH 凭据加入 CI 环境。

本地交付前可运行与 CI 等价的核心检查：

```bash
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm --filter @repo/web build
```

## 4. 生产发布工作流

### 4.1 触发和输入

生产工作流会在推送合规版本 tag 时自动构建镜像并创建 GitHub Release，也支持
`workflow_dispatch` 手动触发部署；普通分支 push（包括 `main`）不会自动触发。
tag push 本身不部署生产，部署仅由手动 `workflow_dispatch` 运行执行。

| 输入 | 必需 | 说明 |
|---|:---:|---|
| `version` | 手动触发时是 | 必须符合 `v<MAJOR>.<MINOR>.<PATCH>[-<alpha 或 beta 或 rc>.<N>]`，例如 `v0.8.1`、`v0.9.0-rc.1` |
| `skip_deploy` | 否 | 仅手动触发有效；`true` 时只构建并推送镜像，不部署也不创建 Release；默认 `false` |

工作流接受从 `main` 手动运行，或从 `refs/tags/<version>` 手动运行且 tag 名与输入
`version` 完全一致。tag push 和手动输入都会经过严格 SemVer 校验，不接受不带 `v` 的版本号。
站内“系统更新”页仅供 `super_admin` 使用；它只读取最新稳定 Release，并通过
`workflow_dispatch` 调用同一生产工作流。生产 `.env` 需配置 `FLUXMEDIA_GITHUB_ACTIONS_TOKEN`，
使用仅限本仓库、授予 `Contents: read` 和 `Actions: write` 的 fine-grained token。该 token 只用于站内发起
工作流，部署 SSH/GHCR 权限仍由 GitHub `production` Environment 管理。

### 4.2 质量门和构建顺序

每次发布先执行 `quality`，成功后才进入 `build-and-push`。tag push 随后创建 GitHub
Release；生产部署由超管从站内更新页对该 Release 发起 `workflow_dispatch`：

1. 启动临时 PostgreSQL 16 和 Redis 7.4。
2. 验证版本与分支/tag 关系。
3. 运行部署脚本测试和数据库发布门禁。
4. 运行 Fumadocs source 生成、lint、typecheck、全仓测试和集成测试。
5. 构建 Web standalone，执行 API upstream worker 检查与 smoke test。
6. 使用 `Dockerfile.unified` 和 Docker Buildx 构建并推送统一应用镜像。
7. tag push 后以对应 tag 创建 GitHub Release 和自动生成的变更说明；该触发不部署生产。
8. 站内超管选择最新稳定 Release 后，在同一 tag 上手动触发质量门、镜像构建和生产部署。

### 4.3 GHCR 镜像

| 服务 | 镜像 |
|---|---|
| `app` | `ghcr.io/fluxcode666/fluxmedia-1-app:<version>` |

镜像同时推送 `<version>` 和 `latest` 两个 tag，平台为 `linux/amd64`。构建端使用 GitHub
自动提供的 `GITHUB_TOKEN` 推送；目标服务器拉取私有镜像时使用 `GHCR_PAT`。工作流取得
构建产物 digest，并把 `${image}@sha256:...` 写入服务器的 `FLUXMEDIA_APP_IMAGE_REF`；
Compose 始终按 digest 启动，不能用可变 tag 作为部署或回滚标识。

统一镜像构建期使用固定公开配置：`NEXT_PUBLIC_APP_URL` 和 `BETTER_AUTH_URL` 为
`https://media.flux-code.cc`，`NEXT_PUBLIC_APP_NAME` 为 `FluxMedia`，支付 provider
为 `none`，Next.js 到 Go 的地址固定为 `http://127.0.0.1:8080`。数据库 URL、认证密钥
和代理 secret 不在镜像构建期注入。

`Dockerfile.web`、`Dockerfile.api-gateway`、`Dockerfile.api-upstream-script-runtime` 和
`Dockerfile.media-processing-runtime` 继续服务于本地开发或专项构建校验，但生产工作流
只发布 `Dockerfile.unified` 生成的统一镜像。

## 5. GitHub `production` Environment

进入仓库的 `Settings → Environments`，创建名为 `production` 的 Environment。建议配置
Required reviewers，并将 Deployment branches 限制为 `main` 及实际允许发布的版本 tag。

### 5.1 Secrets

| Secret | 必需 | 说明 |
|---|:---:|---|
| `DEPLOY_HOST` | 是 | 生产服务器 IP 或域名 |
| `DEPLOY_USER` | 是 | SSH 登录用户，必须能够访问部署目录并执行 Docker |
| `DEPLOY_PASSWORD` | 是 | SSH 登录密码；当前工作流使用密码认证，不读取 SSH 私钥 |
| `DEPLOY_PORT` | 否 | SSH 端口，留空时使用 `22` |
| `GHCR_PAT` | 是 | 目标服务器拉取私有 GHCR 镜像的 PAT，至少需要 `read:packages` |

### 5.2 Variables

| Variable | 必需 | 默认值 | 说明 |
|---|:---:|---|---|
| `DEPLOY_PATH` | 否 | `/root/fluxmedia` | 服务器部署目录，必须是部署用户可写的绝对路径 |
| `GHCR_USERNAME` | 否 | 触发工作流的 GitHub 用户名 | 创建 `GHCR_PAT` 的 GitHub 用户名；建议固定配置 |

`PUBLIC_APP_URL` 当前是工作流中的固定环境值 `https://media.flux-code.cc`，不是 GitHub
Environment Variable。域名变化时必须同时检查工作流构建参数、服务器 `.env` 和 Nginx
配置。

不要把生产 `DATABASE_URL`、`BETTER_AUTH_SECRET`、Redis 密码、
S3 访问密钥或 age 私钥放入 GitHub Environment。这些值由目标服务器或其基础设施持有。

## 6. 首次初始化生产服务器

目标机至少需要 Docker Engine、Docker Compose v2、Nginx、Certbot，以及不低于生产数据库
主版本的 PostgreSQL `pg_dump`/`pg_restore` 客户端。PostgreSQL、Redis 和 Nginx 都在统一
应用容器之外；生产 Compose 不会创建或重建这些基础设施。

```bash
sudo install -d -m 750 /root/fluxmedia
sudo cp deploy/docker-compose.yml /root/fluxmedia/docker-compose.yml
sudo cp deploy/create-database-backup.sh \
  deploy/read-env-value.sh \
  deploy/read-release-ledger-digest.sh \
  deploy/release-recovery-policy.sh \
  /root/fluxmedia/
sudo cp deploy/.env.example /root/fluxmedia/.env
sudo chmod 600 /root/fluxmedia/.env
sudo editor /root/fluxmedia/.env
```

如果部署用户不是 `root`，将目录替换为 `DEPLOY_PATH`，并确保该用户拥有目录和 Docker
权限。后续发布会自动同步 Compose 及上述维护脚本，但不会覆盖服务器 `.env`。

服务器 `.env` 至少填写：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 已创建的生产 PostgreSQL 连接串 |
| `BETTER_AUTH_SECRET` | 认证会话密钥；使用高熵随机值 |
| `REDIS_HOST` / `REDIS_PORT` | 外部 Redis 地址和端口 |
| `REDIS_PASSWORD` | Redis 认证密码 |
| `FLUXMEDIA_SUPER_ADMIN_EMAIL` | 首次自用模式超管邮箱 |
| `FLUXMEDIA_SUPER_ADMIN_PASSWORD` | 首次自用模式超管密码 |

完整变量模板见 [`deploy/.env.example`](../deploy/.env.example)。Redis 应使用
`maxmemory-policy noeviction`；公网或托管 Redis 使用 `REDIS_TLS=true`。更多 Redis、
备份和 Nginx 要求见 [`deploy/README.md`](../deploy/README.md)。

## 7. 自动部署状态机

生产部署 job 使用 `production` Environment，并通过 SSH 执行：

1. 校验服务器存在 `.env`、现役与候选 Compose、环境读取器、备份脚本和恢复策略脚本。
2. 记录上一版 Compose 与镜像引用，验证候选 Compose，按 digest 拉取本次统一镜像。
3. 使用统一镜像执行停服前门禁，然后停止旧应用并确认数据库连接排空。
4. 执行 drain、API upstream 预检、数据库备份、视频输入资产收编、数据库迁移和 postcheck。
5. 使用统一镜像回填并零差异对账运营统计读模型，再启动单一 `app` 服务。
6. 确保运营统计 epoch，等待包含四个内部进程的联合健康检查，并执行公网路由 smoke。

迁移容器必须使用非交互 stdin。自动部署通过 SSH stdin 传入远程脚本，迁移命令继承
stdin 会吞掉后续 Web 启动和健康检查命令。

迁移开始前失败时，仅当上一版应用本轮停服前确实运行且旧 Compose、镜像元数据完整，才
恢复上一版应用与代理。迁移开始后失败则保持维护状态，停止新 `app`，**不自动启动旧
schema 镜像**。
恢复迁移前数据库备份后，必须执行资产回滚并通过 `db:release-gate -- legacy-startup`。

工作流在停服前原子写入 `release-state/deployment-attempt.env`。如果执行器在部分停服后
硬中断、来不及运行 EXIT trap，下一次发布会先验证该账本引用的 Compose、镜像元数据与
Nginx 备份并恢复上一版。不可逆边界由
`release-state/migration-in-progress.env` 原子标记；marker 存在时，不要求 `.env` 已经
完成 digest 提升，后续发布会保持维护并使用新的候选 digest 前向续跑。只有四进程联合健康
检查与公网 smoke 全部通过后才清理两个状态文件。

备份默认写入 `${DEPLOY_PATH}/backups/<version>/`，权限为 `0600`。宿主机没有 PostgreSQL
客户端时，在服务器 `.env` 配置 `DEPLOY_BACKUP_POSTGRES_CONTAINER` 指向运行中的共享
PostgreSQL 容器；备份脚本会在该容器内执行 `pg_dump/pg_restore`，不会停止或重建容器。配置
`DEPLOY_BACKUP_S3_BUCKET` 后，必须同时配置 age recipient、目标机的 age/AWS CLI 和最小
权限 AWS 身份；S3 预检或上传失败会阻止迁移，不会静默降级为本地备份。

## 8. 日常发布和回滚

1. 创建 PR 并等待 CI 所有必需检查通过。
2. 合并到 `main`；合并 push 不会再次触发 CI，这是当前配置的预期行为。
3. 创建并推送合规版本 tag；工作流通过质量门后构建镜像并发布 GitHub Release，不部署生产。
4. 超管从站内“系统更新”页选择该 Release 并发起部署，或在 GitHub Actions 手动运行匹配版本 tag。
5. Actions 手动运行时也可选择 `main` 并输入版本号；保持 `skip_deploy=false` 才会部署。
6. 如配置了 Required reviewers，等待生产 Environment 审批。
7. 检查 Actions summary、`app` 联合健康状态和公网访问。

`skip_deploy=true` 只构建并推送镜像，不会更新服务器 `.env` 或执行数据库迁移。回滚优先
重新运行 Deploy Production，输入仍存在于 GHCR 的旧版本。若迁移已经开始，不能只改回
旧 tag 启动服务，必须先确认数据库 schema、备份恢复、资产回滚和 legacy-startup 门禁。

## 9. 故障排查和维护规则

合并后没有 CI 是预期行为：`ci.yml` 没有 `push` 触发器。需要重新验证时，在 Actions
页面手动运行 CI；日常变更应通过 PR 触发 CI。

Environment secret 缺失时检查 `production` Environment。生产 job 要求 `DEPLOY_HOST`、
`DEPLOY_USER`、`DEPLOY_PASSWORD` 和 `GHCR_PAT`；`DEPLOY_PORT`、`DEPLOY_PATH`、
`GHCR_USERNAME` 可以使用默认值。

目标机排障：

```bash
cd /root/fluxmedia
docker compose ps
docker compose logs --tail=200 app
docker compose config --quiet
```

`app` 健康检查会同时探测 Next.js `3000`、Go `8080`、QuickJS `8090` 和图片处理
`8091`；任一内部进程退出会由进程监管器终止整个容器。重点检查外部 PostgreSQL、Redis、
两个宿主机回环端口、Nginx upstream 和证书。
不要把 `.env` 或完整容器环境输出到工单、Actions 日志或聊天记录。

工作流文件是最终执行事实；修改触发条件、job、镜像名、Environment 配置、部署路径或
恢复边界时，必须同步更新本文件、`docs/CI-CD.md` 和必要的 `deploy/README.md` 内容。
