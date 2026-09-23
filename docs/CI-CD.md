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

`.github/workflows/deploy-production.yml` 是 `media.flux-code.cc` 的生产发布入口。
它先运行 Web 质量门、数据库迁移测试、Go backend 测试与 Compose 校验，再使用
`Dockerfile.unified` 构建：

- `fluxmedia-1-app`

该工作流是唯一镜像发布链路；推送合规版本 tag 会自动构建并部署，也可从 `main` 或与
输入版本一致的 tag 手动触发。版本必须符合
`v<MAJOR>.<MINOR>.<PATCH>[-<alpha|beta|rc>.<N>]`。

部署阶段将 `deploy/docker-compose.yml` 与维护脚本同步到目标机，并更新
`FLUXMEDIA_APP_IMAGE_REF` 为本次构建的不可变 `${image}@sha256:...` 引用。目标机的
其余 `.env` 与业务机密不会由仓库覆盖。生产 Compose 只启动一个 `app` 服务，在同一
容器内监管 Next.js、Go backend、QuickJS 和图片处理四个进程；内部运行时分别使用
`127.0.0.1:8090` 和 `127.0.0.1:8091`。PostgreSQL、Redis 和 Nginx 仍在应用容器之外。

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
Nginx 备份，覆盖 SSH/runner/宿主机在部分停服时消失的场景。不可逆边界使用原子写入的
`release-state/migration-in-progress.env`；marker 存在时它优先于 `.env` 和 Compose 的
中间状态，后续工作流只执行幂等迁移、校验和前向启动。联合健康检查及公网 smoke 成功后
才删除这两个文件。

详细目标机准备、备份与 Nginx 配置见 [deploy/README.md](../deploy/README.md)。
生产访问日志只允许记录不含查询字符串的 `$uri`，不得记录原始 `$request` 或
`Referer`；应用和 Nginx 均使用 `Referrer-Policy: same-origin`，防止分页筛选与
签名 cursor 离开同源站点。
