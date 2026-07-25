# API 密钥与审核治理发布手册

本文承载 `0056_api_key_moderation_governance.sql` 的生产发布、恢复和备份销毁边界。
实现权威仍是 `docs/plans/2026-07-23-001-feat-api-key-management-moderation-plan.md`。

## 发布前准备

1. 在目标机安装与数据库主版本兼容的 `pg_dump`/`pg_restore`。若启用 S3 远端备份，
   另外安装 age 和 AWS CLI v2。
2. 若启用 S3 远端备份，创建启用版本控制的专用 S3 bucket；部署身份仅授予指定备份前缀的
   `s3:GetBucketVersioning`、`s3:PutObject`、`s3:GetObjectVersion`。销毁权限由独立值班
   身份持有。
3. S3 模式离线生成 age 身份。只把 `age1...` 公钥写入目标机 `.env` 的
   `DEPLOY_BACKUP_AGE_RECIPIENT`；私钥放入批准的离线恢复介质，禁止进入服务器、仓库、
   GitHub Secrets、日志或工单。
4. 远端模式配置 `DEPLOY_BACKUP_S3_BUCKET`、可选前缀、1 至 30 天保留期，以及实例角色或
   专用 `DEPLOY_BACKUP_AWS_PROFILE`。留空 bucket 时使用 `${DEPLOY_PATH}/backups/<version>/`
   的本地恢复点；该目录权限为 `0700`，文件权限为 `0600`，不属于异地灾备。确认目标机
   `.env` 权限为 `0600`。
5. 在 GitHub `production` Environment 启用人工审批。审批人核对目标提交、镜像版本、
   维护窗口和当前数据库主版本；S3 模式还需核对 age 私钥的可用性。
6. S3 模式执行 0056 前，发布审批记录必须关联一次同 bucket/prefix、当前 age 身份和兼容
   PostgreSQL 主版本的隔离恢复演练。演练证据必须包含：按精确 `versionId` 下载对象、
   对下载密文重新计算并核对 SHA-256、使用离线 age 私钥解密、执行
   `pg_restore --list`，以及恢复到隔离数据库后的成功校验。缺少任一证据均为 No-Go。
   本地模式至少应在发布窗口内确认目标机磁盘空间和 `pg_restore --list` 可读；它不是
   异地灾备，不适用于主机丢失场景。

## 自动发布顺序

生产 Workflow 按以下固定状态机执行，任一步失败都会终止后续步骤：

1. 跑全仓 lint、typecheck、DB-free 测试、临时 PostgreSQL 迁移与审核事务集成测试、Web
   production build，再构建并拉取不可变 Web/Migrate 镜像。
2. 根据配置选择本地或 S3 备份模式，检查备份工具、S3 版本控制和最小配置；此时旧 Web
   仍运行，失败可无中断退出。S3 模式的权限、版本控制或上传失败不会回退到本地。
3. 停止旧 Web，确认没有运行容器，并要求 `pg_stat_activity.application_name =
   'fluxmedia-web'` 的连接数为 0。
4. 在只读事务中检查 `external_api_key.relay_only IS TRUE` 的数量。非零时迁移尚未开始，
   Workflow 恢复旧镜像元数据并重启旧 Web；不得人工忽略或直接改值后重跑。
5. 用 `pg_dump --format=custom` 创建完整一致性备份，以 `pg_restore --list` 校验 archive
   manifest。S3 模式使用 age 公钥加密并立即删除明文，再上传到启用版本控制的 S3 对象，
   上传后读取指定 version 的 SHA-256 元数据并比对；本地模式把 custom-format 文件以
   `0600` 权限原子写入部署目录，并重新计算最终文件 SHA-256。
6. 执行 `0056`，随后验证旧三列不存在、全站值合法、所有用户覆盖为空、套餐 JSON 无旧
   节点、覆盖 CHECK 与两个审计索引存在。
7. 只启动新 Web 并等待健康检查。成功摘要记录新镜像/提交、操作者、纯中转预检值、备份
   存储类型、artifact ID、artifact SHA-256 和销毁截止时间。

工作流输出的 `backup_archive_manifest_verified=true` 只表示 custom-format archive 可由
`pg_restore --list` 读取；`backup_storage_verified=true` 在 S3 模式表示指定 version 的
自填 SHA-256 元数据与上传前计算值一致，在本地模式表示最终文件重新计算的 SHA-256 与
写入前一致。自动化不会下载对象、重新计算下载密文、持有离线 age 私钥、解密 archive 或
执行隔离恢复，因此不得把这些字段解释为“恢复已验证”。本地模式还无法防止目标机磁盘
损坏、主机丢失或主机权限失陷；恢复可用性只能由发布前的人工证据证明。

## 迁移后失败

迁移命令开始后，自动恢复旧镜像被禁止。迁移、后置校验、启动或健康检查失败时：

1. 保持 Web 停止和外部流量不可写，不修改回旧镜像标签。
2. 保存 Workflow 日志中的 artifact ID、SHA-256、旧/新提交和失败阶段；不得复制数据库
   行、连接串或凭据。
3. 优先评估前向修复。S3 artifact 按 version ID 下载密文并核对 SHA-256，在隔离环境用
   离线 age 私钥解密并再次运行 `pg_restore --list`；本地 artifact 直接核对文件 SHA-256
   并运行 `pg_restore --list`。
4. 在确认维护状态仍生效后恢复完整数据库备份；核对旧三列和迁移表恢复到发布前状态，
   最后才恢复旧镜像并进行健康与关键路径 smoke。

仅恢复旧镜像而不恢复数据库是被禁止的，因为旧代码会访问已删除列。

## 发布后核对

- 以真实会话检查系统设置页和用户管理页的 effective/source、原因必填和单条审计记录。
- 以同一用户检查 Web、User MCP 和受审核 v1 图像入口生效级别一致；旧治理字段必须稳定
  拒绝，Admin/User MCP 工具列表均不暴露人工策略写操作。
- 检查 `moderation_policy_fallback_high`、数据库 timeout、MCP 拒绝和生成失败日志。生产
  全站行合法时不应出现新的 `fallback_high`。
- 在 375px 与 1440px 验收 API 密钥列表、系统审核设置和用户审核覆盖入口。

## 备份销毁

S3 模式回滚窗口结束后，值班人员从 Workflow 摘要复制 bucket、key 和 version ID，使用独立
销毁身份删除确切对象版本。禁止省略 `--version-id`，否则版本控制 bucket 只会创建 delete
marker，旧密文仍存在。本地模式的文件位于部署目录 `backups/<version>/`，应在确认回滚
窗口结束后由值班人员按 artifact 路径和精确文件名删除，并保留无残留验证记录；不要对
整个 `backups/` 目录执行递归删除。

```bash
aws s3api delete-object \
  --bucket '<bucket>' \
  --key '<key>' \
  --version-id '<version-id>'

aws s3api list-object-versions \
  --bucket '<bucket>' \
  --prefix '<key>'
```

删除后结果中不得再出现该 version ID。把销毁时间、操作者、artifact ID 和无残留验证结果
写入发布审计；不保留密文、明文、age 私钥或数据库内容。
