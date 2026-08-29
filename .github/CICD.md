# FluxMedia CI/CD 指南

FluxMedia 使用 GitHub Actions 完成 Pull Request 质量门禁、生产镜像构建和 Docker
Compose 部署。CI 不包含生产机密；生产运行时配置只保存在目标服务器的
`deploy/.env`，GitHub Actions 仅通过 `production` Environment 提供 SSH 与 GHCR
访问凭据。

## 1. 流水线总览

| 工作流 | 文件 | 触发方式 | 作用 |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | Pull Request 到 `main`，或手动触发 | 文档一致性、lint、类型检查、单元测试、媒体集成测试、Web 构建和 PR 容器构建校验 |
| Deploy Production | `.github/workflows/deploy-production.yml` | GitHub Actions 页面手动触发 | 质量门禁、构建并推送三个 GHCR 镜像、可选 SSH 生产部署 |

当前 CI **不会因为 push 到 `main` 自动触发**。合并后的生产发布必须从
`Actions → Deploy Production → Run workflow` 手动发起。

```text
Pull Request → main
       │
       └─ CI：文档 / lint / typecheck / test / integration / build / Docker 校验

main 或匹配版本 tag
       │
       └─ 手动 Deploy Production
             ├─ Quality gate
             ├─ GHCR：web + migrate + media-upstream-proxy
             └─ production Environment 审批（如已配置）→ SSH 部署
```

生产工作流文件是执行契约；修改工作流、部署 Compose 或服务器环境要求时，必须同步更新
本文和 [生产部署说明](../deploy/README.md)。

## 2. 相关文件

| 文件 | 说明 |
|---|---|
| `.github/workflows/ci.yml` | PR 与手动 CI 门禁；push 到 `main` 不触发 |
| `.github/workflows/deploy-production.yml` | 生产质量门、镜像发布和 SSH 部署 |
| `.github/actions/setup/action.yml` | 统一 Node.js 22、pnpm 10 与冻结依赖安装 |
| `deploy/docker-compose.yml` | 生产 `web`、`media-upstream-proxy` 与维护迁移服务 |
| `deploy/.env.example` | 生产服务器 `.env` 模板，不包含真实机密 |
| `deploy/README.md` | 服务器初始化、Redis、备份、Nginx 和迁移操作手册 |
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
(cd services/media-upstream-proxy && go test ./...)
```

## 4. 生产发布工作流

### 4.1 触发和输入

生产工作流只有 `workflow_dispatch` 触发，不会因为普通分支或 tag push 自动部署。

| 输入 | 必需 | 说明 |
|---|:---:|---|
| `version` | 是 | 必须符合 `v<MAJOR>.<MINOR>.<PATCH>[-<alpha 或 beta 或 rc>.<N>]`，例如 `v0.8.1`、`v0.9.0-rc.1` |
| `skip_deploy` | 否 | `true` 时只构建并推送镜像，不连接生产服务器；默认 `false` |

工作流只接受从 `main` 手动运行，或从 `refs/tags/<version>` 手动运行且 tag 名与输入
`version` 完全一致。工作流不接受不带 `v` 的版本号，也不自动从 tag push 启动发布。

### 4.2 质量门和构建顺序

生产发布先执行 `quality`，成功后才进入 `build-and-push`：

1. 启动临时 PostgreSQL 16 和 Redis 7.4。
2. 验证版本与分支/tag 关系。
3. 运行 Go 代理测试、部署脚本测试和数据库发布门禁。
4. 运行 Fumadocs source 生成、lint、typecheck、全仓测试和集成测试。
5. 构建 Web standalone，执行 API upstream worker 检查与 smoke test。
6. 使用 Docker Buildx 构建并推送 Web、migrate 和 Adobe direct 代理镜像。

### 4.3 GHCR 镜像

| 服务 | 镜像 |
|---|---|
| Web | `ghcr.io/fluxcode666/fluxmedia-web:<version>` |
| 数据库迁移 | `ghcr.io/fluxcode666/fluxmedia-migrate:<version>` |
| Adobe direct 代理 | `ghcr.io/fluxcode666/fluxmedia-media-upstream-proxy:<version>` |

每个镜像同时推送 `<version>` 和 `latest` 两个 tag，平台为 `linux/amd64`。构建端使用
GitHub 自动提供的 `GITHUB_TOKEN` 推送；目标服务器拉取私有镜像时使用 `GHCR_PAT`。
生产版本应使用不可变版本号，不要依赖 `latest` 作为唯一回滚标识。

Web 镜像构建期使用固定公开配置：`NEXT_PUBLIC_APP_URL` 和 `BETTER_AUTH_URL` 为
`https://media.flux-code.cc`，`NEXT_PUBLIC_APP_NAME` 为 `FluxMedia`，支付 provider
为 `none`。数据库 URL、认证密钥和代理 secret 不在镜像构建期注入。

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
| `DEPLOY_PATH` | 否 | `/root/flux-media` | 服务器部署目录，必须是部署用户可写的绝对路径 |
| `GHCR_USERNAME` | 否 | 触发工作流的 GitHub 用户名 | 创建 `GHCR_PAT` 的 GitHub 用户名；建议固定配置 |

`PUBLIC_APP_URL` 当前是工作流中的固定环境值 `https://media.flux-code.cc`，不是 GitHub
Environment Variable。域名变化时必须同时检查工作流构建参数、服务器 `.env` 和 Nginx
配置。

不要把生产 `DATABASE_URL`、`BETTER_AUTH_SECRET`、Redis 密码、Adobe 代理 secret、
S3 访问密钥或 age 私钥放入 GitHub Environment。这些值由目标服务器或其基础设施持有。

## 6. 首次初始化生产服务器

目标机至少需要 Docker Engine、Docker Compose v2、Nginx、Certbot，以及不低于生产数据库
主版本的 PostgreSQL `pg_dump`/`pg_restore` 客户端。PostgreSQL 和 Redis 是外部依赖，
生产 Compose 不会常驻启动它们。

```bash
sudo install -d -m 750 /root/flux-media
sudo cp deploy/docker-compose.yml /root/flux-media/docker-compose.yml
sudo cp deploy/create-database-backup.sh \
  deploy/read-env-value.sh \
  deploy/read-release-ledger-digest.sh \
  deploy/release-recovery-policy.sh \
  /root/flux-media/
sudo cp deploy/.env.example /root/flux-media/.env
sudo chmod 600 /root/flux-media/.env
sudo editor /root/flux-media/.env
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
| `ADOBE_DIRECT_PROXY_SECRET` | Web 与 `media-upstream-proxy` 必须一致的代理密钥 |
| `FLUXMEDIA_SUPER_ADMIN_EMAIL` | 首次自用模式超管邮箱 |
| `FLUXMEDIA_SUPER_ADMIN_PASSWORD` | 首次自用模式超管密码 |

完整变量模板见 [`deploy/.env.example`](../deploy/.env.example)。Redis 应使用
`maxmemory-policy noeviction`；公网或托管 Redis 使用 `REDIS_TLS=true`。更多 Redis、
备份和 Nginx 要求见 [`deploy/README.md`](../deploy/README.md)。

## 7. 自动部署状态机

生产部署 job 使用 `production` Environment，并通过 SSH 执行：

1. 校验服务器存在 `.env`、Compose、环境读取器、备份脚本和恢复策略脚本。
2. 读取旧镜像元数据，验证 Compose 配置并拉取本次三个镜像。
3. 停止旧 Web，等待数据库连接排空，执行 drain、早期预检和 API upstream 预检。
4. 创建迁移前数据库备份，收编旧视频输入资产，执行数据库迁移和 postcheck。
5. 回填并零差异对账运营统计读模型，启动 Adobe 代理与新 Web。
6. 确保运营统计 epoch，等待 Web 健康检查并输出脱敏部署摘要。

迁移容器必须使用非交互 stdin。自动部署通过 SSH stdin 传入远程脚本，迁移命令继承
stdin 会吞掉后续 Web 启动和健康检查命令。

迁移开始前失败时，仅当上一版 Web 本轮停服前确实运行且旧镜像元数据完整，才恢复上一版
Web 与代理。迁移开始后失败则保持维护状态，停止新 Web，**不自动启动旧 schema 镜像**。
恢复迁移前数据库备份后，必须执行资产回滚并通过 `db:release-gate -- legacy-startup`。

备份默认写入 `${DEPLOY_PATH}/backups/<version>/`，权限为 `0600`。配置
`DEPLOY_BACKUP_S3_BUCKET` 后，必须同时配置 age recipient、目标机的 age/AWS CLI 和最小
权限 AWS 身份；S3 预检或上传失败会阻止迁移，不会静默降级为本地备份。

## 8. 日常发布和回滚

1. 创建 PR 并等待 CI 所有必需检查通过。
2. 合并到 `main`；合并 push 不会再次触发 CI，这是当前配置的预期行为。
3. 打开 GitHub `Actions → Deploy Production → Run workflow`。
4. Branch 选择 `main` 或匹配输入版本的 tag，输入版本号并保持 `skip_deploy=false`。
5. 如配置了 Required reviewers，等待生产 Environment 审批。
6. 检查 Actions summary、生产容器健康状态和公网访问。

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
cd /root/flux-media
docker compose ps
docker compose logs --tail=200 web media-upstream-proxy
docker compose config --quiet
```

重点检查数据库、外部 Redis、两端 Adobe proxy secret、端口、Nginx upstream 和证书。
不要把 `.env` 或完整容器环境输出到工单、Actions 日志或聊天记录。

工作流文件是最终执行事实；修改触发条件、job、镜像名、Environment 配置、部署路径或
恢复边界时，必须同步更新本文件、`docs/CI-CD.md` 和必要的 `deploy/README.md` 内容。
