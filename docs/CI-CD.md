# CI/CD

本文记录 FluxMedia 当前持续集成、镜像发布与生产部署契约。流水线文件是最终权威；
修改流水线时必须同步本文。

## 持续集成

`.github/workflows/ci.yml` 在 pull request、`main` push 与手动触发时运行：

1. `docs-mirror`：验证 `CLAUDE.md` 与 `AGENTS.md` 逐字一致。
2. `lint`：仅在 pull request 对相对基线变更的文件运行 Biome lint。
3. `typecheck`：生成 Fumadocs source 后运行全仓 strict typecheck。
4. `test`：运行全仓 Vitest 单元测试。
5. `build`：使用非机密占位环境变量构建 Web。
6. `docker-build`：pull request 前述门禁通过后验证 Web runner 镜像可构建。

本地交付前执行与 CI 等价的核心门禁：

```bash
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm --filter @repo/web build
(cd services/media-upstream-proxy && go test ./...)
cmp -s CLAUDE.md AGENTS.md
```

## 通用镜像发布

`.github/workflows/docker-release.yml` 由版本 tag 或手动触发，构建并推送四个镜像：

- `gpt2image-pro-web`
- `gpt2image-pro-migrate`
- `gpt2image-pro-media-upstream-proxy`
- `gpt2image-pro-ab-shadow-relay`

版本 tag 同时创建包含 Compose 模板的 draft GitHub Release。正式 tag 使用
`v<MAJOR>.<MINOR>.<PATCH>[-<alpha|beta|rc>.<N>]`。

## 生产部署

`.github/workflows/deploy-production.yml` 是 `media.flux-code.cc` 的生产发布入口。
它先运行 Web 质量门、数据库迁移测试、代理 Go 测试与 Compose 校验，再构建：

- `fluxmedia-web`
- `fluxmedia-migrate`
- `fluxmedia-media-upstream-proxy`

部署阶段将 `deploy/docker-compose.yml` 与维护脚本同步到目标机，并更新
`FLUXMEDIA_IMAGE`、`FLUXMEDIA_MIGRATE_IMAGE`、`FLUXMEDIA_PROXY_IMAGE` 和
`FLUXMEDIA_TAG`。目标机的 `.env` 与业务机密不会由仓库覆盖。

## 维护窗口与恢复边界

统一号池迁移是破坏性切换。发布流程必须：

1. 停止旧 Web 并等待数据库连接排空。
2. 执行迁移前只读检查；发现旧成员或未结束的视频引用时停止。
3. 创建并校验数据库备份。
4. 运行 `maintenance` profile 的迁移容器。
5. 验证新 schema，启动上游代理和 Web，再执行健康检查。

迁移开始后不得自动启动依赖旧 schema 的镜像。失败时由值班人员选择前向修复，
或先恢复迁移前备份再恢复旧镜像。代理健康检查需要正确的
`ADOBE_DIRECT_PROXY_SECRET`，Web 只有在代理健康后才能启动。

详细目标机准备、备份与 Nginx 配置见 [deploy/README.md](../deploy/README.md)。
