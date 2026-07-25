# FluxMedia 生产部署

本目录提供 `media.flux-code.cc` 的生产部署配置。Docker Compose 只启动 `web`；Redis、
PostgreSQL 与数据库迁移均为外部依赖或显式维护 profile，不会常驻运行。注册机与
ChatGPT Web 代理均不启动。宿主机 Nginx 负责 TLS 终止并反向
代理到 `127.0.0.1:3001`。

## 文件

- `docker-compose.yml`：`web` 主服务，以及默认关闭的 `maintenance` 数据库迁移服务；
  超管与外部 Redis 连接信息由服务器 `.env` 注入。
- `read-env-value.sh`：生产 Workflow 使用的 fail-closed dotenv 单键读取器。
- `read-env-value.test.sh`：读取器的引号、拒绝路径与不执行配置内容回归测试。
- `.env.example`：不含真实机密的服务器环境变量模板。
- `nginx/nginx.conf`：参考 user-service 的宿主机 Nginx 主配置。
- `nginx/conf.d/fluxmedia.conf`：`media.flux-code.cc` 的 HTTPS 站点配置。
- `.github/workflows/deploy-production.yml`：质量门、GHCR 构建与 SSH 部署流水线。

## 首次配置服务器

目标机需要 Docker Engine、Docker Compose v2、Nginx、Certbot，以及与数据库主版本兼容的
PostgreSQL 客户端。生产 Workflow 会在停止旧 Web 后用 `pg_dump` 创建一致性备份；配置了
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
`REDIS_PASSWORD`、`FLUXMEDIA_SUPER_ADMIN_EMAIL` 和 `FLUXMEDIA_SUPER_ADMIN_PASSWORD`；
`REDIS_USERNAME` 可选。数据库必须已创建；外部 Redis 必须可从 Web 容器访问。Redis 连接
参数通过独立变量传递，密码不需要 URL 编码；系统设置缓存默认使用逻辑库 4。迁移由部署
流水线在切换 `web` 前执行。本 Compose 不启动 PostgreSQL 或 Redis。

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
docker compose --profile maintenance pull migrate
docker compose --profile maintenance run --rm --no-deps --interactive=false migrate
docker compose up -d web
```

自动部署必须关闭 migrate 容器的 stdin。远程脚本通过 SSH stdin 传入；若保留 Compose
默认的交互输入，迁移容器会读取后续 Web 启动命令，导致只完成迁移却未启动服务。

自动部署先拉取新镜像，再停止旧 Web、确认 `fluxmedia-web` 数据库连接已排空，并执行只读
预检。预检通过后才创建本地或 S3 备份并执行迁移。迁移一旦开始，任何迁移、后置校验、启动或
健康检查失败都会保持 Web 停止，绝不自动启动旧 schema 镜像。恢复只能由值班人员选择
前向修复，或先恢复 Workflow 记录的迁移前数据库备份，再恢复旧镜像。完整步骤见
`docs/plan/2026-07-23-api-key-moderation-rollout.md`。

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
`FLUXMEDIA_MIGRATE_IMAGE`、`FLUXMEDIA_TAG`。部署命令停止旧 Web 并排空数据库连接后，
通过 `maintenance` profile 执行只读门禁、备份、迁移和后置校验，再启动新 `web`，不会
启动注册机。外部 Redis 的地址、鉴权和网络连通性由服务器 `.env` 与基础设施负责，
流水线不会创建或修改 Redis 服务。

生产部署从 Actions 手动触发，可选择 `main`，也可选择与输入版本完全一致的 Git tag；
版本号必须符合 `v<MAJOR>.<MINOR>.<PATCH>[-<alpha|beta|rc>.<N>]`。tag 与输入版本不一致时
流水线会拒绝部署。新容器未通过健康检查时，流水线保持维护状态并记录备份存储类型、
artifact、SHA-256 和销毁截止时间；不会恢复先前镜像或启动旧 Web。
