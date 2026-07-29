# 系统设置动态配置与 Redis 缓存

## 目标与边界

- PostgreSQL `system_setting` 始终是真相来源。
- 业务运行时通过 `getRuntimeSetting*` 读取配置，不直接访问 `process.env`。
- L1 是每进程 1 秒缓存；L2 是 Redis 全量设置缓存；Redis miss 才查询 PostgreSQL。
- Redis 使用 `REDIS_HOST`、`REDIS_PORT`、可选的 `REDIS_USERNAME` 与 `REDIS_PASSWORD`，
  逻辑库由 `REDIS_DB` 指定，默认 `4`。
- Redis 属于可选加速层：连接或命令超时后回退 PostgreSQL，不能阻断启动、保存或业务读取。
- Better Auth 密钥、OAuth 凭据等启动期对象仍需重启；`NEXT_PUBLIC_*` 仍需重新构建。

## 一致性语义

1. `setSystemSettings`、环境变量导入和默认值初始化在数据库提交后清理本进程 L1，
   并通过 Lua 原子递增共享 epoch、删除 Redis 全量缓存 key。
2. 数据 key 为 `fluxmedia:v1:system-settings`，epoch key 为
   `fluxmedia:v1:system-settings:epoch`；数据默认 TTL 60 秒并带抖动，损坏或旧版本
   payload 会删除并回源。
3. 同进程并发 miss 会合并为一次回源，避免 Redis/DB 击穿。
4. Redis miss 回源前会记录共享 epoch；回填使用 Lua CAS，仅 epoch 未变化时写入。
   CAS 冲突会有界重读一次，连续冲突的结果不会进入 L1，从而阻止其他实例把保存前的
   旧数据库结果重新写回 L1 或 L2。
5. Redis 失效失败时记录本地失效代次；本进程恢复后的首次读取会重试原子失效，旧操作
   不能清除较新的待失效状态。其他实例已经存在的 L1 最坏仍有 1 秒陈旧窗口。
6. bootstrap 覆盖 `process.env` 前会保留真实部署环境回退值，后台清空 DB 行后不会再次
   读到旧 DB 注入值。

## 动态客户端

- 邮件：SMTP 与 Resend 按配置 SHA-256 指纹复用；配置变化后关闭旧 SMTP 连接并创建新客户端。
- 存储：local/S3 provider 与 S3Client 按 HMAC 指纹切换；endpoint、region、凭据或本地路径变化无需重启。
- 限流：Upstash URL、Token 与各类阈值按运行时配置重建；失败时保留单实例内存限流。
- 调度器：常驻 5 秒控制循环支持运行时启停和任务间隔重排。
- 支付：`PAYMENT_PROVIDER=none` 是有效动态状态，服务端拒绝新结账并隐藏运行时购买入口。

## 部署与安全

- 生产 Compose 不启动 Redis；外部 Redis 必须由基础设施提供鉴权、网络访问控制和必要的 TLS。
- 生产部署只读取服务器 `.env` 中的 `REDIS_HOST`、`REDIS_PORT`、可选
  `REDIS_USERNAME`、`REDIS_PASSWORD`，系统设置缓存默认使用 `REDIS_DB=4`。
- Redis 配置来自部署环境而不是系统设置，避免“读取 Redis 配置必须先连接 Redis”的循环依赖。
- 回滚应用不需要回滚缓存数据；旧版本可忽略 Redis key，必要时直接删除缓存或重启 Redis。

## 验证重点

- Redis hit/miss、并发回源合并、损坏 payload、Redis 故障降级。
- 保存与清空后立即读取、epoch CAS 拒绝跨实例旧回填、部署 env 回退、跨实例 L1 短窗口。
- SMTP/Resend 凭据轮换、local/S3 切换、限流阈值变化、调度器启停。
- Compose 配置展开、全仓 typecheck、lint、test 与生产 build。
