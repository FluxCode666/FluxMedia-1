# FluxMedia 生产部署

本目录提供 `media.flux-code.cc` 的生产部署配置。Docker Compose 默认启动 `web` 与
`media-upstream-proxy`；Redis、PostgreSQL 与数据库迁移均为外部依赖或显式维护 profile，
不会常驻运行。宿主机 Nginx 负责 TLS 终止并反向代理到 `127.0.0.1:3001`。

## 文件

- `docker-compose.yml`：`web`、Adobe direct 专用上游代理，以及默认关闭的
  `maintenance` 数据库迁移服务；超管与外部 Redis 连接信息由服务器 `.env` 注入。
- `read-env-value.sh`：生产 Workflow 使用的 fail-closed dotenv 单键读取器。
- `read-env-value.test.sh`：读取器的引号、拒绝路径与不执行配置内容回归测试。
- `.env.example`：不含真实机密的服务器环境变量模板。
- `nginx/nginx.conf`：参考 user-service 的宿主机 Nginx 主配置。
- `nginx/conf.d/fluxmedia.conf`：`media.flux-code.cc` 的 HTTPS 站点配置。
- `.github/workflows/deploy-production.yml`：质量门、GHCR 构建与 SSH 部署流水线。

## 首次配置服务器

目标机需要 Docker Engine、Docker Compose v2、Nginx、Certbot，以及不低于数据库主版本的
PostgreSQL `pg_dump`/`pg_restore` 客户端。生产 Workflow 会在停止旧 Web 前执行真实的
schema-only archive 探测，在停止旧 Web 后用 `pg_dump` 创建一致性备份；配置了
S3 bucket 时使用 age 公钥加密并上传到启用版本控制的 bucket，未配置时持久化到部署目录的
`backups/`。先准备部署目录和真实环境变量：

```bash
sudo install -d -m 750 /root/flux-media
sudo cp deploy/docker-compose.yml /root/flux-media/docker-compose.yml
sudo cp deploy/create-database-backup.sh deploy/read-env-value.sh /root/flux-media/
sudo cp deploy/.env.example /root/flux-media/.env
sudo chmod 600 /root/flux-media/.env
sudo editor /root/flux-media/.env
```

至少填写 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`REDIS_HOST`、`REDIS_PORT`、
`REDIS_PASSWORD`、`ADOBE_DIRECT_PROXY_SECRET`、`FLUXMEDIA_SUPER_ADMIN_EMAIL` 和
`FLUXMEDIA_SUPER_ADMIN_PASSWORD`；`REDIS_USERNAME` 可选。数据库必须已创建；外部 Redis
必须可从 Web 容器访问。Redis 连接参数通过独立变量传递，密码不需要 URL 编码；系统设置
缓存默认使用逻辑库 4。迁移由部署流水线在切换 `web` 前执行。本 Compose 不启动 PostgreSQL
或 Redis。

## Redis MQ 运行要求

图片和视频异步任务统一由 BullMQ 即时投递，但 PostgreSQL 始终是任务状态、幂等结果、
生成记录和财务账本的事实来源。Redis 只保存即时投递、延迟唤醒与重试状态；低频数据库
扫描会补投遗漏任务。因此 Redis 故障可能延迟任务，但不得导致重复扣费或丢失数据库终态。

生产 Redis 必须满足以下要求：

- `maxmemory-policy` 使用 `noeviction`，禁止在内存压力下逐出 BullMQ 键。容量告警应早于
  内存耗尽，不能依赖逐出策略维持服务。
- 至少启用 AOF `everysec` 或可靠的 RDB 持久化；推荐使用带复制、自动故障切换和备份的
  托管高可用 Redis。持久化仍不能取代 PostgreSQL 补投器。
- 公网或托管 Redis 设置 `REDIS_TLS=true`；仅受控内网明文连接可设为 `false`。当前配置
  使用主机名作为 TLS SNI，证书必须覆盖 `REDIS_HOST`。
- 当前运行时支持单节点或提供稳定主节点地址的 HA Redis，可继续使用默认 `REDIS_DB=4`。
  Redis Cluster 只支持逻辑库 0，且当前未创建 Cluster client；接入前必须扩展连接实现、
  改为 `REDIS_DB=0` 并验证 BullMQ Cluster 拓扑。
- `MEDIA_IMAGE_WORKER_CONCURRENCY` 与 `MEDIA_VIDEO_WORKER_CONCURRENCY` 分别控制单个
  Web 进程的图片、视频 Worker 并发；水平扩容时总并发会按副本数线性增加，应结合上游
  配额、数据库连接池和生图并发槽共同定值。

MQ 消息只携带任务 ID、任务类型和契约版本，不应写入提示词、媒体内容、API Key、Cookie
或上游响应。排障时先查 PostgreSQL 任务状态，再查 BullMQ 等待、延迟和失败作业；禁止把
Redis 队列内容视为业务审计记录。

`DEPLOY_BACKUP_S3_BUCKET` 留空时无需安装 `age` 或 AWS CLI，流水线把权限为 `0600` 的
custom-format 数据库备份写入 `${DEPLOY_PATH}/backups/<version>/`，并在迁移前复核
archive manifest 与最终文件 SHA-256。该回退只能应对数据库迁移失败，不能防止目标机磁盘
损坏、主机丢失或主机权限失陷。生产环境仍建议配置独立版本化 S3 bucket；一旦填写 bucket，
`DEPLOY_BACKUP_AGE_RECIPIENT`、`age`、AWS CLI 和可用的目标机 AWS 身份会同时成为必需项，
任何 S3 预检或上传失败都会拒绝迁移，不会静默降级到本地。

配置完成后先验证默认服务：

```bash
cd /root/flux-media
docker compose config --quiet
docker compose up -d web
docker compose ps web
```

手工执行迁移时显式启用维护 profile。迁移成功后再启动主服务：

```bash
install -d -m 700 state
docker compose --profile maintenance pull migrate
docker compose stop --timeout 60 web
docker compose --profile maintenance run --rm --no-deps --interactive=false migrate \
  pnpm --dir packages/database db:release-gate -- drain
```

早期预检确认订阅、Epay 和其他迁移前置条件均满足：

```bash
docker compose --profile maintenance run --rm --no-deps --interactive=false migrate \
  pnpm --dir packages/database db:release-gate -- preflight-early
```

此时必须先用 `create-database-backup.sh create` 创建迁移前备份，并保存其 manifest；传入
本次镜像 tag 和对应的 40 位 Git SHA。备份成功后再继续：

```bash
docker compose --profile maintenance run --rm --no-deps --interactive=false migrate \
  node apps/web/scripts/migrate-video-input-assets.mjs migrate \
  --confirm-no-legacy-writers
release_preflight="$(docker compose --profile maintenance run --rm --no-deps \
  --interactive=false migrate \
  pnpm --dir packages/database db:release-gate -- preflight \
  | tee /dev/stderr)"
release_credits_ledger_digest="$(printf '%s\n' "${release_preflight}" \
  | bash ./read-release-ledger-digest.sh)"
docker compose --profile maintenance run --rm --no-deps --interactive=false migrate
docker compose --profile maintenance run --rm --no-deps --interactive=false \
  -e "RELEASE_CREDITS_LEDGER_DIGEST=${release_credits_ledger_digest}" migrate \
  pnpm --dir packages/database db:release-gate -- postcheck
docker compose up -d web
```

自动部署必须关闭 migrate 容器的 stdin。远程脚本通过 SSH stdin 传入；若保留 Compose
默认的交互输入，迁移容器会读取后续 Web 启动命令，导致只完成迁移却未启动服务。

自动部署先拉取新镜像，再停止旧 Web、确认 `fluxmedia-web` 数据库连接已排空，并执行早期
只读预检。创建本地或 S3 备份后，先幂等收编历史视频输入，再执行完整 preflight、0074 与
postcheck。资产收编开始后，任何迁移、后置校验、启动或健康检查失败都会保持 Web 停止，
绝不自动启动旧 schema 镜像。资产收编开始前失败时，只有上一版 Web 在本轮停服前确实处于
运行状态且镜像元数据完整，退出状态机才恢复同一上一版 Web 与代理；该证据证明数据库尚未
改变且上一版已运行在当前 schema 上。恢复迁移前数据库备份后手工启动旧 schema 镜像时，
仍必须让 `legacy-startup` 门禁证明三个旧视频列完整。完整步骤见
`docs/plan/2026-07-23-api-key-moderation-rollout.md`。

资产收编会先把本轮新对象以 0600 NDJSON 写入部署目录 `state/`。若选择恢复迁移前数据库
备份，必须在数据库恢复完成且旧 Web 仍停止时，用同一 migrator 镜像执行幂等对象回滚：

```bash
docker compose --profile maintenance run --rm --no-deps --interactive=false migrate \
  node apps/web/scripts/migrate-video-input-assets.mjs rollback \
  --confirm-database-restored
```

回滚命令只接受清单内严格属于 `migration-v1` 前缀的对象；完成后再运行
`db:release-gate -- legacy-startup`，通过后才可恢复旧镜像。

## 配置 Nginx 与证书

先确保 `media.flux-code.cc` 已解析到服务器。首次签发证书时，必须先保证 80 端口可
访问且 `/var/www/html` 是 Certbot 与 Nginx 共用的 webroot：

```bash
sudo install -d -m 755 /var/www/html
sudo certbot certonly --webroot -w /var/www/html -d media.flux-code.cc
sudo cp deploy/nginx/nginx.conf /etc/nginx/nginx.conf
sudo cp deploy/nginx/conf.d/fluxmedia.conf /etc/nginx/conf.d/fluxmedia.conf
sudo nginx -t
sudo systemctl reload nginx
```

若服务器尚无可处理 ACME challenge 的 Nginx 站点，应先用 HTTP-only 临时站点完成
签发，再安装包含 443 证书路径的完整配置。证书续期任务需要在续期成功后 reload
Nginx，例如通过 Certbot deploy hook 执行 `systemctl reload nginx`。

## 配置 GitHub Environment

在 GitHub 的 `production` Environment 中配置以下 Secrets：

- `DEPLOY_HOST`：目标服务器地址。
- `DEPLOY_PORT`：SSH 端口，可留空使用 `22`。
- `DEPLOY_USER`：具有目标目录和 Docker 权限的 SSH 用户；默认目录位于 `/root`，通常为
  `root`。
- `DEPLOY_PASSWORD`：SSH 登录密码，必须使用高强度随机密码并仅保存在 GitHub Secret 中。
- `GHCR_PAT`：仅用于目标机拉取私有镜像，至少需要 `read:packages`；PAT 创建者必须与
  `GHCR_USERNAME` 一致。

启用 S3 模式时，生产备份身份不放在 GitHub Secrets。优先给目标机绑定只允许指定前缀的
实例角色；否则在目标机配置专用 AWS profile，并把 profile 名写入
`DEPLOY_BACKUP_AWS_PROFILE`。部署身份只需 `s3:GetBucketVersioning`、`s3:PutObject`、
`s3:GetObjectVersion`，备份销毁使用独立值班身份的 `s3:DeleteObjectVersion`。bucket
必须启用版本控制；age 私钥只放离线恢复环境。

可选 Repository Variable `GHCR_USERNAME` 指定创建 `GHCR_PAT` 的 GitHub 用户名，默认
使用 Workflow 触发者。建议固定配置该值，避免其他用户触发时登录用户名与 PAT 所属账号
不一致。构建端使用自动 `GITHUB_TOKEN` 推送；`GHCR_USERNAME` 只决定目标机登录身份，
镜像仍推送到 `ghcr.io/fluxcode666` 命名空间。

目标机 SSH 服务必须允许密码认证；Workflow runner 会自动安装 `sshpass`。为与 FluxCode
保持一致，流水线设置 `StrictHostKeyChecking=no` 和 `UserKnownHostsFile=/dev/null`，不校验
服务器主机指纹。部署账号需要具备目标目录写权限和 Docker 执行权限。

如果部署账号不是 `root`，必须将 `DEPLOY_PATH` 改为该账号可写的绝对路径。

可选 Repository Variable `DEPLOY_PATH` 指定部署目录，默认 `/root/flux-media`。服务器
上的真实 `.env` 由运维持久维护；流水线只同步 `docker-compose.yml`、
`create-database-backup.sh` 和 `read-env-value.sh`，并更新 `.env` 中的 `FLUXMEDIA_IMAGE`、
`FLUXMEDIA_MIGRATE_IMAGE`、`FLUXMEDIA_PROXY_IMAGE`、`FLUXMEDIA_TAG`。部署命令停止旧 Web
并排空数据库连接后，通过 `maintenance` profile 执行只读门禁、备份、迁移和后置校验，
再启动 Adobe 上游代理与新 `web`。外部 Redis 的地址、鉴权和网络连通性由服务器 `.env`
与基础设施负责，流水线不会创建或修改 Redis 服务。

生产部署从 Actions 手动触发，可选择 `main`，也可选择与输入版本完全一致的 Git tag；
版本号必须符合 `v<MAJOR>.<MINOR>.<PATCH>[-<alpha|beta|rc>.<N>]`。tag 与输入版本不一致时
流水线会拒绝部署。新容器未通过健康检查时，流水线保持维护状态并记录备份存储类型、
artifact、SHA-256 和销毁截止时间；不会恢复先前镜像或启动旧 Web。
