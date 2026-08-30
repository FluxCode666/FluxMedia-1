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
它先运行 Web 质量门、数据库迁移测试、代理 Go 测试与 Compose 校验，再构建：

- `fluxmedia-1-web`
- `fluxmedia-1-migrate`

该工作流是唯一镜像发布链路；版本 tag 不再触发另一套旧镜像或 draft Release。
发布时从 `main` 或与输入版本一致的 tag 手动触发，版本必须符合
`v<MAJOR>.<MINOR>.<PATCH>[-<alpha|beta|rc>.<N>]`。

部署阶段将 `deploy/docker-compose.yml` 与维护脚本同步到目标机，并更新
`FLUXMEDIA_IMAGE`、`FLUXMEDIA_MIGRATE_IMAGE` 和 `FLUXMEDIA_TAG`。目标机的 `.env` 与业务机密不会由仓库覆盖。

## 维护窗口与恢复边界

统一号池迁移是破坏性切换。发布流程必须：

1. 停止旧 Web 并等待数据库连接排空。
2. 执行迁移前只读检查；发现旧成员或未结束的视频引用时停止。
3. 创建并校验数据库备份。
4. 运行 `maintenance` profile 的迁移容器。
5. 使用新 Web 镜像回填并零差异对账尚未 ready 的控制台统计读模型。
6. 验证新 schema，启动 Web。
7. 通过 system-only `operations.ensureCurrentEpoch` 确保运营 epoch：仅空表按生产
   `APP_TIME_ZONE` 当前自然日初始化，已有值不随发布漂移。
8. epoch 门禁成功后执行健康检查并宣告发布完成。

迁移开始后不得自动启动依赖旧 schema 的镜像。失败时由值班人员选择前向修复，
或先恢复迁移前备份再恢复旧镜像。

详细目标机准备、备份与 Nginx 配置见 [deploy/README.md](../deploy/README.md)。
生产访问日志只允许记录不含查询字符串的 `$uri`，不得记录原始 `$request` 或
`Referer`；应用和 Nginx 均使用 `Referrer-Policy: same-origin`，防止分页筛选与
签名 cursor 离开同源站点。
