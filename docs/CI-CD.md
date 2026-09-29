# CI/CD

本文记录 FluxMedia 当前持续集成、镜像发布与生产部署契约。流水线文件是最终权威；
修改流水线时必须同步本文。

详细的 GitHub Actions 配置、Environment 凭据、服务器初始化和发布排障手册见
[.github/CICD.md](../.github/CICD.md)。

## 持续集成

`.github/workflows/ci.yml` 在 pull request 与手动触发时运行；推送到 `main` 不会重复触发：

1. `lint`：仅在 pull request 对相对基线变更的文件运行 Biome lint。
2. `typecheck`：生成 Fumadocs source 后运行全仓 strict typecheck。
3. `test`：运行全仓 Vitest 单元测试。
4. `build`：使用非机密占位环境变量构建 Web。
5. `docker-build`：pull request 前述门禁通过后验证 Web runner 镜像可构建。

本地交付前执行与 CI 等价的核心门禁：

```bash
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm --filter @repo/web build
(cd deploy/nginx && sh ./url-privacy-canary.test.sh)
```

## 镜像发布与生产部署

发布与部署拆分为两条流水线，生产服务器只消费 GitHub Release 中的部署包：

- `.github/workflows/release.yml`（Release）：推送 `v*.*.*` tag（或在同名 tag 上手动
  重跑）触发；tag 提交必须已在 `main` 上。`quality` 运行全部质量门（含
  `bash deploy/release-bundle.test.sh`），`build-and-push` 使用 `Dockerfile.unified`
  构建并推送 `ghcr.io/fluxcode666/fluxmedia-1-app`（`<version>` 与 `latest`），
  `publish-release` 用 `deploy/build-release-bundle.sh` 生成部署包并创建 GitHub
  Release（`-alpha`/`-beta`/`-rc` 为 prerelease），附带 `fluxmedia-release.env`
  （`RELEASE_TAG`、`GIT_SHA`、`APP_IMAGE`、`APP_DIGEST`、`BUNDLE_SHA256`）与
  `fluxmedia-deploy.tar.gz`（候选 Compose、Nginx 配置与部署脚本）。
  该流水线不接触生产服务器。
- `.github/workflows/deploy-production.yml`（Deploy Production）：仅手动触发，输入已发布
  的 `version`。它在 Actions runner 上用 `deploy/fetch-release-bundle.sh` 下载并校验
  部署包，上传到 `${DEPLOY_PATH}/incoming/`，经 SSH 执行 `apply-release.sh`，校验安全
  证据后清理上传目录。不构建镜像、不运行质量门；仅当 GHCR 包私有时才需要 `GHCR_PAT`。

生产发布只有 Deploy Production 一个入口：`deploy/apply-release.sh` 持有服务器
`release-state/deploy.lock` 防止并发部署，原子落地部署包后调用
`deploy/deploy-release.sh`。
它可部署预发布版本，也可回退到仍带部署包且镜像仍存在于 GHCR 的旧版本；宿主机需具备
`flock` 与 `curl`。版本必须符合 `v<MAJOR>.<MINOR>.<PATCH>[-<alpha|beta|rc>.<N>]`。

部署阶段从部署包原子同步候选 Compose、Nginx 配置与维护脚本，并更新
`FLUXMEDIA_APP_IMAGE_REF` 为 manifest 中不可变的 `${image}@sha256:...` 引用、
`FLUXMEDIA_RELEASE_TAG` 为本次版本（用于发布记录与回滚定位）。目标机的其余 `.env`
与业务机密不会由仓库覆盖。
生产 Compose 只启动一个 `app` 服务，在同一容器内监管 Next.js、Go backend、QuickJS 和
图片处理四个进程；内部运行时分别使用 `127.0.0.1:8090` 和 `127.0.0.1:8091`。
PostgreSQL、Redis 和 Nginx 仍在应用容器之外；`app` 不持有任何部署权限。

本地源码开发仍可分别启动四个进程；原有四个专项 Dockerfile 继续用于开发和专项测试，
但不再是生产发布单元。根目录自托管 Compose 也使用统一 `app` 镜像。

## 维护窗口与恢复边界

统一号池迁移是破坏性切换。候选 Compose 先以 `docker-compose.next.yml` 同步，现役
Compose 在停服前归档；这使首次发布能在不可逆迁移开始前从单容器候选恢复到旧四容器
拓扑。发布流程必须：

1. 停止旧应用并等待数据库连接排空。
2. 执行迁移前只读检查；发现旧成员或未结束的视频引用时停止。
3. 创建并校验数据库备份。
4. 使用统一应用镜像执行数据库迁移。
5. 使用同一镜像回填并零差异对账尚未 ready 的控制台统计读模型。
6. 验证新 schema，启动单一 `app` 服务。
7. 通过 system-only `operations.ensureCurrentEpoch` 确保运营 epoch：仅空表按生产
   `APP_TIME_ZONE` 当前自然日初始化，已有值不随发布漂移。
8. epoch 门禁成功后，联合健康检查必须同时通过 Next.js、Go、QuickJS 和图片处理四个
   内部进程，再宣告发布完成。

迁移开始后不得自动启动依赖旧 schema 的镜像。失败时由值班人员选择前向修复，
或先恢复迁移前备份再恢复旧镜像。

停服前的 `release-state/deployment-attempt.env` 持久记录上一版 Compose、镜像元数据与
Nginx 备份，覆盖 SSH、Actions runner 或宿主机在部分停服时消失的场景。不可逆边界使用原子写入的
`release-state/migration-in-progress.env`；marker 存在时它优先于 `.env` 和 Compose 的
中间状态，后续发布只执行幂等迁移、校验和前向启动。联合健康检查及公网 smoke 成功后
才删除这两个文件。

详细目标机准备、备份与 Nginx 配置见 [deploy/README.md](../deploy/README.md)。
生产访问日志只允许记录不含查询字符串的 `$uri`，不得记录原始 `$request` 或
`Referer`；应用和 Nginx 均使用 `Referrer-Policy: same-origin`，防止分页筛选与
签名 cursor 离开同源站点。
