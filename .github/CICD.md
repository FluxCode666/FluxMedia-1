# FluxMedia CI/CD 指南

FluxMedia 使用 GitHub Actions 完成 Pull Request 质量门禁、版本发布（GHCR 镜像与带部署包、
应用包的 GitHub Release）和 Docker Compose 生产部署。CI 不包含生产机密；生产运行时配置只
保存在目标服务器的 `deploy/.env`，GitHub Actions 仅通过 `production` Environment 提供 SSH
（及可选的 GHCR）访问凭据。推送版本 tag 后，Release 流水线发布版本但不接触生产服务器；
生产环境由运维手动运行 Deploy Production 换镜像，或在平台指纹不变时由超级管理员站内更新
应用代码（见第 10 节）。

## 1. 流水线总览

| 工作流 | 文件 | 触发方式 | 作用 |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | Pull Request 到 `main`，或手动触发 | 文档一致性、lint、类型检查、单元测试、媒体集成测试、Web 构建和 PR 容器构建校验 |
| Release | `.github/workflows/release.yml` | 推送合规版本 tag `v*.*.*`，或在同名 tag 上手动触发 | 质量门、构建并推送 GHCR 统一镜像、创建带部署包与应用包的 GitHub Release；不接触生产服务器 |
| Deploy Production | `.github/workflows/deploy-production.yml` | 仅 `workflow_dispatch` 手动触发 | 下载并校验已发布版本的部署包，经 SSH 在生产服务器执行 `apply-release.sh` |

当前 CI **不会因为 push 到 `main` 自动触发**。推送合规版本 tag 只触发 Release，不会
更新生产环境。换镜像只有一个入口：运维在 `Actions → Deploy Production → Run workflow`
手动输入版本号，工作流消费该版本的 Release 部署包并经 SSH 发布；服务器上的
`release-state/deploy.lock` 保证同一时间只有一个部署在执行。平台指纹不变的版本也可由
超级管理员在控制台站内更新，它只替换 `app` 持久卷中的应用代码，不经过 Actions 与 SSH。

```text
Pull Request → main
       │
       └─ CI：文档 / lint / typecheck / test / integration / build / Docker 校验

合规版本 tag 推送（git push origin vX.Y.Z）
       │
       └─ Release
             ├─ quality：全部质量门与部署脚本测试
             ├─ build-and-push：GHCR 统一 app 镜像（<version> 与 latest）
             └─ publish-release：build-app-bundle.sh → GitHub Release
                   + fluxmedia-release.env + fluxmedia-deploy.tar.gz + fluxmedia-app-linux-amd64.tar.gz

换镜像（手动，持有 release-state/deploy.lock）
       └─ Deploy Production → fetch-release-bundle.sh（runner）→ scp 部署包
             → production Environment 审批 → SSH apply-release.sh → deploy-release.sh

站内更新（超级管理员，仅平台指纹不变）
       └─ 控制台版本号弹窗 → Go 下载应用包并校验 → pg_dump 备份 → 容器重启
             → boot.mjs 维护响应下迁移 → 切换版本
```

工作流文件和 `deploy/` 下的发布脚本是执行契约；修改工作流、部署 Compose、发布脚本或
服务器环境要求时，必须同步更新本文和 [生产部署说明](../deploy/README.md)。

## 2. 相关文件

| 文件 | 说明 |
|---|---|
| `.github/workflows/ci.yml` | PR 与手动 CI 门禁；push 到 `main` 不触发 |
| `.github/workflows/release.yml` | 版本 tag 触发的质量门、GHCR 镜像发布和带部署包的 GitHub Release |
| `.github/workflows/deploy-production.yml` | 手动生产部署：下载校验部署包、上传并经 SSH 执行 `apply-release.sh` |
| `.github/actions/setup/action.yml` | 统一 Node.js 22、pnpm 10 与冻结依赖安装 |
| `Dockerfile.unified` | 构建统一生产镜像：内嵌 Web SPA 的 Go 二进制、QuickJS 与图片处理运行时 |
| `deploy/docker-compose.yml` | 生产单一 `app` 服务；PostgreSQL、Redis 与 Nginx 仍是外部基础设施 |
| `deploy/.env.example` | 生产服务器 `.env` 模板，不包含真实机密 |
| `deploy/build-release-bundle.sh` | Release 流水线构建部署包与 manifest；部署包是生产部署文件的唯一清单 |
| `deploy/build-app-bundle.sh` | Release 流水线从已推送的统一镜像导出站内更新应用包（`/app` 与 `/backend`，不含媒体模型） |
| `deploy/compute-platform-fingerprint.sh` | 计算平台指纹：站内更新无法替换的基础镜像、系统依赖、入口脚本、`boot.mjs`、健康检查、媒体模型与 Compose/Nginx 配置 |
| `deploy/read-release-manifest.sh` | 严格解析 `fluxmedia-release.env`（不 source），供构建、下载与落地三处复核 |
| `deploy/fetch-release-bundle.sh` | 在 Actions runner 上匿名 HTTPS 下载公开 Release 部署包，校验 SHA-256，只接受扁平普通文件；不进入部署包 |
| `deploy/apply-release.sh` | 在 `release-state/deploy.lock` 下原子落地部署包文件，再执行 `deploy-release.sh` |
| `deploy/deploy-release.sh` | 真正的生产发布状态机：备份、门禁、迁移、Nginx、smoke 与安全证据输出；越过迁移边界后撤下站内更新记录 |
| `services/api-gateway/system_update.go` | 站内更新 API：查询 GitHub Release、下载校验解压应用包、备份数据库并请求容器重启 |
| `services/unified-runtime/boot.mjs` | 容器入口的启动选择器：选择运行版本，站内更新时在维护响应下迁移并切换 |
| `deploy/release-bundle.test.sh` | manifest 解析、部署包构建/下载/校验、路径穿越拒绝，以及 `apply-release.sh` 落地、部署锁与缺失文件拒绝的回归测试（需 Linux） |
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
| `build` | PR、手动 | Vite 构建 Web SPA，并执行 API upstream worker smoke test |
| `docker-build` | 仅 PR | 用 `Dockerfile.unified` 构建统一镜像（含镜像内自检）；不推送镜像 |

CI 使用的数据库、Redis 和 `BETTER_AUTH_SECRET` 均为测试/构建占位值。不要把生产
`.env`、支付密钥、对象存储密钥、代理密钥或 SSH 凭据加入 CI 环境。

本地交付前可运行与 CI 等价的核心检查：

```bash
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm --filter @repo/web build
(cd services/api-gateway && gofmt -l . && go vet ./... && go test -race ./...)
node --test services/unified-runtime/*.test.mjs
```

## 4. 版本发布与生产部署

### 4.1 Release 流水线（`release.yml`）

触发方式：

- 推送符合 `v*.*.*` 的 Git tag，例如 `git tag v0.8.1 && git push origin v0.8.1`；
- 在 `Actions → Release → Run workflow` 选择**同名 tag** 作为 ref 手动重跑，并输入与 tag
  完全一致的 `version`。

| 输入 | 必需 | 说明 |
|---|:---:|---|
| `version` | 手动触发时是 | 必须符合 `v<MAJOR>.<MINOR>.<PATCH>[-<alpha 或 beta 或 rc>.<N>]`，例如 `v0.8.1`、`v0.9.0-rc.1`，且与所选 tag 一致 |

`quality` 首先校验：版本号严格符合 SemVer（不接受不带 `v` 的版本号）；运行 ref 必须是
`refs/tags/<version>`，不能从分支运行；tag 指向的提交必须已在 `main` 上。同一 tag 的
Release 运行按 `fluxmedia-release-<ref>` 串行，不同版本互不阻塞。

三个 job 依次执行，前一个成功才进入下一个：

1. `quality`：启动临时 PostgreSQL 16 和 Redis 7.4；运行部署脚本测试（含
   `bash deploy/release-bundle.test.sh`）、Nginx 路由契约与数据库发布门禁；Go 格式、vet、
   race 测试；Fumadocs source 生成、lint、typecheck、全仓测试和集成测试；Vite 构建 Web
   SPA，执行 API upstream worker smoke test。
2. `build-and-push`：用 `deploy/compute-platform-fingerprint.sh` 计算平台指纹，使用
   `Dockerfile.unified` 和 Docker Buildx 构建并推送统一应用镜像（指纹、版本与提交写入镜像
   `/app/release.json`），输出镜像名、digest 与指纹。
3. `publish-release`（`contents: write`、`packages: read`）：用 `GITHUB_TOKEN` 登录 GHCR，
   运行 `deploy/build-app-bundle.sh` 从刚推送的 digest 导出应用包，再运行
   `deploy/build-release-bundle.sh` 生成部署包与 manifest，用自动生成的变更说明创建 GitHub
   Release 并附带三个资产；`-alpha`/`-beta`/`-rc` 版本标记为 prerelease。同一版本重跑时以
   `--clobber` 重新上传资产，使部署包、应用包与本次构建的镜像 digest 一致。

Release 资产：

| 资产 | 内容 |
|---|---|
| `fluxmedia-release.env` | manifest：`RELEASE_TAG`、`GIT_SHA`、`APP_IMAGE`、`APP_DIGEST`、`BUNDLE_SHA256`，以及成对出现的 `APP_BUNDLE_SHA256`、`PLATFORM_FINGERPRINT` |
| `fluxmedia-deploy.tar.gz` | 扁平部署包：候选 Compose（`docker-compose.next.yml`）、Nginx 站点配置 `fluxmedia.conf`，以及 `create-database-backup.sh`、`read-release-ledger-digest.sh`、`release-recovery-policy.sh`、`read-env-value.sh`、`smoke-production-routing.sh`、`deploy-release.sh`、`apply-release.sh`、`read-release-manifest.sh` |
| `fluxmedia-app-linux-amd64.tar.gz` | 站内更新应用包：镜像内 `/app`（去掉 `storage`、`releases` 与媒体模型）加 `/backend`；Deploy Production 不使用 |

Release 流水线不使用 `production` Environment，也不连接生产服务器。只有由该流水线发布、
带部署包的版本才能被 Deploy Production 部署；旧流水线创建的 Release 没有部署包，
不能再用于部署。manifest 不带应用包键的版本不能站内更新。

manifest 的 `APP_BUNDLE_SHA256`/`PLATFORM_FINGERPRINT` 只有新版
`deploy/read-release-manifest.sh` 能解析。Deploy Production 在 runner 上使用触发分支的
`deploy/` 脚本，因此引入这两个键的变更必须先合入 `main`，再对带应用包的版本运行部署。

### 4.2 Deploy Production（`deploy-production.yml`）

只支持 `workflow_dispatch`，不构建镜像、不运行质量门：

| 输入 | 必需 | 说明 |
|---|:---:|---|
| `version` | 是 | 已由 Release 流水线发布的版本号，例如 `v0.8.1` 或 `v0.9.0-rc.1` |

建议从 `main` 运行。job 使用 `production` Environment，同一时间只允许一个部署
（`fluxmedia-production` 并发组，不取消已开始的部署），步骤如下：

1. 稀疏检出 `deploy/`，用 `deploy/fetch-release-bundle.sh` 匿名下载该版本的
   `fluxmedia-release.env` 与 `fluxmedia-deploy.tar.gz`，严格解析 manifest、校验部署包
   SHA-256，并拒绝非扁平或非普通文件。
2. 校验 SSH 参数，把部署包 `scp` 到 `${DEPLOY_PATH}/incoming/<run_id>-<attempt>/`。
3. 若配置了 `GHCR_PAT`，在目标机执行 `docker login ghcr.io`；GHCR 包公开时无需此步。
4. 经 SSH 执行 `apply-release.sh --deploy-path ${DEPLOY_PATH} --bundle-dir <incoming 目录>`。
5. 从远程输出提取安全证据并校验：纯中转预检计数为 `0`、备份存储为 `local` 或 `s3`、
   备份 artifact 与 SHA-256、销毁截止时间、archive manifest 与最终存储校验均为 `true`、
   Nginx 配置备份存在、`deployed_image_ref` 等于 manifest 中的 `APP_IMAGE@APP_DIGEST`、
   `deployment_completed=true`。任一缺失即判定失败。
6. 写入 Actions summary，并在结束时（无论成败）删除服务器上的 incoming 目录。

Deploy Production 不校验版本新旧，可用于部署预发布版本或回退到仍带部署包的旧版本。

### 4.3 GHCR 镜像

| 服务 | 镜像 |
|---|---|
| `app` | `ghcr.io/fluxcode666/fluxmedia-1-app:<version>` |

镜像同时推送 `<version>` 和 `latest` 两个 tag，平台为 `linux/amd64`。构建端使用 GitHub
自动提供的 `GITHUB_TOKEN` 推送。GHCR 包设为公开时，目标服务器可匿名拉取；包为私有时，
Deploy Production 通过可选的 `GHCR_PAT` 让目标机登录。Release manifest 记录构建产物
digest，发布时把 `${image}@sha256:...` 写入服务器的 `FLUXMEDIA_APP_IMAGE_REF`，并把
版本号写入 `FLUXMEDIA_RELEASE_TAG` 作为发布记录；Compose 始终按 digest 启动，不能用
可变 tag 作为部署或回滚标识。

统一镜像构建期使用固定公开配置：`NEXT_PUBLIC_APP_URL` 为 `https://media.flux-code.cc`，
`NEXT_PUBLIC_APP_NAME` 为 `FluxMedia`，支付 provider 为 `none`；这些值内联进 SPA 与
生成的 sitemap，SPA 构建产物随后以 `-tags embed` 编进 Go 二进制。数据库 URL、认证密钥
和代理 secret 不在镜像构建期注入。

`Dockerfile.api-gateway`（不含 Web 页面）、`Dockerfile.api-upstream-script-runtime` 和
`Dockerfile.media-processing-runtime` 继续服务于本地开发或专项构建校验，但 Release 流水线
只发布 `Dockerfile.unified` 生成的统一镜像。

## 5. GitHub `production` Environment

进入仓库的 `Settings → Environments`，创建名为 `production` 的 Environment。只有
Deploy Production 使用该 Environment；建议配置 Required reviewers，并将 Deployment
branches 限制为 `main`。

### 5.1 Secrets

| Secret | 必需 | 说明 |
|---|:---:|---|
| `DEPLOY_HOST` | 是 | 生产服务器 IP 或域名 |
| `DEPLOY_USER` | 是 | SSH 登录用户；需要部署目录写权限与 Docker 执行权限，默认目录位于 `/root`，通常为 `root` |
| `DEPLOY_PASSWORD` | 是 | SSH 登录密码；当前工作流使用密码认证，不读取 SSH 私钥 |
| `DEPLOY_PORT` | 否 | SSH 端口，留空时使用 `22` |
| `GHCR_PAT` | 否 | 仅 GHCR 包为私有时需要，至少 `read:packages`；未配置时按公开镜像匿名拉取 |

### 5.2 Variables

| Variable | 必需 | 默认值 | 说明 |
|---|:---:|---|---|
| `DEPLOY_PATH` | 否 | `/root/fluxmedia` | 服务器部署目录，必须是部署用户可写、不含空格的绝对路径 |
| `GHCR_USERNAME` | 否 | 触发工作流的 GitHub 用户名 | 配置 `GHCR_PAT` 时使用的 GitHub 用户名；建议固定配置 |

`PUBLIC_APP_URL` 当前是工作流中的固定环境值 `https://media.flux-code.cc`，不是 GitHub
Environment Variable。域名变化时必须同时检查 Release 工作流构建参数、服务器 `.env` 和
Nginx 配置。

不要把生产 `DATABASE_URL`、`BETTER_AUTH_SECRET`、Redis 密码、
S3 访问密钥或 age 私钥放入 GitHub Environment。这些值由目标服务器或其基础设施持有。

## 6. 首次初始化生产服务器

目标机至少需要 Docker Engine、Docker Compose v2（2.30 或更高）、Nginx、Certbot、
不低于生产数据库主版本的 PostgreSQL `pg_dump`/`pg_restore` 客户端，以及 `flock`
（`apply-release.sh` 部署锁）与 `curl`（公网路由 smoke）。PostgreSQL、Redis 和 Nginx
都在统一应用容器之外；生产 Compose 不会创建或重建这些基础设施。

```bash
sudo install -d -m 750 /root/fluxmedia
sudo cp deploy/docker-compose.yml /root/fluxmedia/docker-compose.yml
sudo cp deploy/.env.example /root/fluxmedia/.env
sudo chmod 600 /root/fluxmedia/.env
sudo editor /root/fluxmedia/.env
```

如果部署用户不是 `root`，将目录替换为 `DEPLOY_PATH`，并确保该用户拥有目录与 Docker
权限。候选 Compose、Nginx 配置和全部部署脚本由每次发布从 Release 部署包原子同步，
不需要手工复制；发布不会覆盖服务器 `.env`。

服务器 `.env` 至少填写：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 已创建的生产 PostgreSQL 连接串 |
| `BETTER_AUTH_SECRET` | 认证会话密钥；使用高熵随机值 |
| `REDIS_HOST` / `REDIS_PORT` | 外部 Redis 地址和端口 |
| `REDIS_PASSWORD` | Redis 认证密码 |
| `FLUXMEDIA_SUPER_ADMIN_EMAIL` | 首次自用模式超管邮箱 |
| `FLUXMEDIA_SUPER_ADMIN_PASSWORD` | 首次自用模式超管密码 |

`FLUXMEDIA_APP_IMAGE_REF` 与 `FLUXMEDIA_RELEASE_TAG` 由每次发布写入（用于发布记录与
回滚定位），不需要手工维护。
完整变量模板见 [`deploy/.env.example`](../deploy/.env.example)。Redis 应使用
`maxmemory-policy noeviction`；公网或托管 Redis 使用 `REDIS_TLS=true`。更多 Redis、
备份和 Nginx 要求见 [`deploy/README.md`](../deploy/README.md)。

## 7. 自动部署状态机

Deploy Production 经 SSH 调用 `apply-release.sh`，由它在 `release-state/deploy.lock`
下原子落地部署包文件（临时文件加 rename，正在执行的旧脚本不会读到半新内容），再以
非交互 stdin 执行 `deploy-release.sh`：

1. 校验服务器存在 `.env`、现役与候选 Compose、环境读取器、备份脚本、恢复策略脚本、
   Nginx 配置与路由 smoke 脚本。
2. 记录上一版 Compose 与镜像引用，验证候选 Compose，按 digest 拉取本次统一镜像。
3. 使用统一镜像执行停服前门禁；紧贴停服备份并安装版本化 Nginx 配置（全部转发到 Go），
   然后停止旧应用并确认数据库连接排空。
4. 执行 drain、API upstream 预检、数据库备份、视频输入资产收编、数据库迁移和 postcheck。
5. 使用统一镜像回填并零差异对账运营统计读模型，再启动单一 `app` 服务。
6. 确保运营统计 epoch，等待包含三个内部进程的联合健康检查，并执行公网路由 smoke，最后
   输出 `deployment_completed=true` 等安全证据。

迁移容器必须使用非交互 stdin。调用方是 SSH 会话，迁移命令继承 stdin 会吞掉后续 Web
启动和健康检查命令。

迁移开始前失败时，仅当上一版应用本轮停服前确实运行且旧 Compose、镜像元数据完整，才
恢复上一版应用与代理。迁移开始后失败则保持维护状态，停止新 `app`，**不自动启动旧
schema 镜像**。
恢复迁移前数据库备份后，必须执行资产回滚并通过 `db:release-gate -- legacy-startup`。

发布脚本在停服前原子写入 `release-state/deployment-attempt.env`。如果执行器在部分停服后
硬中断、来不及运行 EXIT trap，下一次发布会先验证该账本引用的 Compose、镜像元数据与
Nginx 备份并恢复上一版。不可逆边界由
`release-state/migration-in-progress.env` 原子标记；marker 存在时，不要求 `.env` 已经
完成 digest 提升，后续发布会保持维护并使用新的候选 digest 前向续跑。只有三进程联合健康
检查与公网 smoke 全部通过后才清理两个状态文件。

备份默认写入 `${DEPLOY_PATH}/backups/<version>/`，权限为 `0600`。宿主机没有 PostgreSQL
客户端时，在服务器 `.env` 配置 `DEPLOY_BACKUP_POSTGRES_CONTAINER` 指向运行中的共享
PostgreSQL 容器；备份脚本会在该容器内执行 `pg_dump/pg_restore`，不会停止或重建容器。配置
`DEPLOY_BACKUP_S3_BUCKET` 后，必须同时配置 age recipient、目标机的 age/AWS CLI 和最小
权限 AWS 身份；S3 预检或上传失败会阻止迁移，不会静默降级为本地备份。

## 8. 日常发布和回滚

1. 创建 PR 并等待 CI 所有必需检查通过。
2. 合并到 `main`；合并 push 不会再次触发 CI，这是当前配置的预期行为。
3. 在 `main` 上创建并推送合规版本 tag：`git tag vX.Y.Z && git push origin vX.Y.Z`。
4. 等待 Release 流水线完成，确认 GitHub Release 附带 `fluxmedia-release.env`、
   `fluxmedia-deploy.tar.gz` 与 `fluxmedia-app-linux-amd64.tar.gz`。
5. 选择升级路径：
   - 平台指纹未变：超级管理员在控制台侧栏点击版本号，确认后站内更新（见第 10 节）；
   - 平台指纹变化，或需要同步 `.env`/Nginx：运维在 Actions 手动运行 Deploy Production
     并输入该版本（如配置了 Required reviewers，需等待审批）。
6. 检查站内更新弹窗结果或 Actions summary、`app` 联合健康状态和公网访问。

预发布版本（`-alpha`/`-beta`/`-rc`）只能通过 Deploy Production 部署：站内更新只读取 GitHub
最新正式 Release。回滚时手动运行 Deploy Production，输入仍带部署包且镜像仍存在于 GHCR 的
旧版本。
若迁移已经开始（包括站内更新已完成的迁移），不能只改回旧 tag 启动服务，必须先确认数据库
schema、备份恢复、资产回滚和 legacy-startup 门禁。

## 9. 故障排查和维护规则

合并后没有 CI 是预期行为：`ci.yml` 没有 `push` 触发器。需要重新验证时，在 Actions
页面手动运行 CI；日常变更应通过 PR 触发 CI。

Release 失败时：确认 tag 与 `version` 一致、从 tag 而非分支运行、tag 提交已在 `main`
上；质量门修复后需要新提交与新 tag，或在同名 tag 上重跑。Deploy Production 报“无法下载”
时，确认该版本由新 Release 流水线发布且资产完整。

Environment secret 缺失时检查 `production` Environment。Deploy Production 要求
`DEPLOY_HOST`、`DEPLOY_USER` 和 `DEPLOY_PASSWORD`；`DEPLOY_PORT`、`DEPLOY_PATH`、
`GHCR_USERNAME`、`GHCR_PAT` 可以使用默认值或留空。“另一个生产部署正在进行”表示
`release-state/deploy.lock` 被另一次部署占用，等待其完成后重试。

目标机排障：

```bash
cd /root/fluxmedia
docker compose ps
docker compose logs --tail=200 app
docker compose config --quiet
```

`app` 健康检查会同时探测 Go `8080`（同时提供页面）、QuickJS `8090` 和图片处理
`8091`；任一内部进程退出会由进程监管器终止整个容器。重点检查外部 PostgreSQL、Redis、
宿主机回环端口 `3001`、Nginx upstream 和证书。
不要把 `.env` 或完整容器环境输出到工单、Actions 日志或聊天记录。

工作流文件是最终执行事实；修改触发条件、job、镜像名、Release 资产、Environment 配置、
部署路径或恢复边界时，必须同步更新本文件、`docs/CI-CD.md` 和必要的
`deploy/README.md` 内容。

## 10. 站内更新

站内更新由 `app` 容器自身完成，不需要额外的更新容器、宿主机进程或 SSH：

1. `GET /api/admin/system-update`（仅超级管理员）查询 GitHub 最新正式 Release（不含
   prerelease），仅当它比当前版本新时提示更新；比较 manifest 中的 `PLATFORM_FINGERPRINT`
   与运行中镜像 `/app/release.json` 的指纹，不一致时标记为需要 Deploy Production。
2. `POST /api/admin/system-update` 下载应用包到持久卷（生产为宿主机
   `/root/docker-data/fluxmedia-releases`，挂载到 `/app/releases`），校验
   `APP_BUNDLE_SHA256`，拒绝路径穿越、绝对链接与特殊文件后解压到 `<版本>/`。
3. 用镜像内 `pg_dump` 把数据库备份到 `releases/backups/`（保留最近 3 份），写入
   `releases/state.json` 后请求进程监管器退出；容器按 `restart: unless-stopped` 重启。
4. 入口脚本先运行 `boot.mjs`：它在 `8080` 上返回 `503 SYSTEM_UPDATING` 维护响应，用新版本
   执行 `--migrate` 与控制台统计回填（回填失败只记警告），Go 启动时幂等确保运营 epoch。
5. 迁移成功则切换版本并清理旧版本目录；迁移失败、版本目录不完整或连续 3 次启动未完成时
   保持原版本，失败原因写入 `state.json` 并在弹窗中展示。

`boot.mjs` 只在 `state.json` 记录的基础镜像与当前镜像一致时使用卷内版本。Deploy
Production 越过迁移边界后会把 `state.json` 改名为 `state.superseded-<tag>.json`，因此
任何一次 Deploy Production（包括重新部署同一镜像回滚）都以部署的镜像为准。站内更新的
迁移同样不可逆；回退时先用 `releases/backups/` 中的备份恢复数据库，再用 Deploy Production
部署旧版本。开发构建（版本 `0.0.0-dev`）、非 `linux/amd64` 平台、缺少 `pg_dump` 或持久卷
不可写时，站内更新不可用并在弹窗中说明原因。
