# 生图并发控制

本文定义两层互不替代的媒体并发事实，避免把用户套餐并发与号池成员容量混成同一套
计数。

## 用户与全局生图槽位

`withImageGenerationQueue` 只在本进程保存不可序列化的任务回调和本地优先级顺序。
全站并发上限与单用户套餐并发上限由必填标准 Redis 统一裁决：

- 全局槽位使用带 `{image-generation}` Redis Cluster hash tag 的有序集合。
- 用户槽位使用相同 hash tag 与 SHA-256 用户标识构造独立有序集合，Redis key 不包含
  原始用户 ID；两个 key 在 Redis Cluster 中始终落入同一槽位，使 Lua 原子操作可用。
- Lua 脚本使用 Redis `TIME` 清理过期租约，同时检查两级容量并写入同一个 token，
  获取过程不可被其他副本插入。
- 正常完成、上游失败或抛异常都会以 token 同时释放两个集合；重复释放保持幂等。
- 租约默认 22 分钟，覆盖单次生图 20 分钟总预算。进程崩溃后无需清理任务，过期租约
  会在后续获槽时删除。
- 其他副本释放槽位不会触发本进程回调，因此仅在存在等待任务时进行带抖动的短轮询。

Redis 是并发正确性的必需依赖。Node.js 启动阶段必须连接并收到 `PONG`；配置缺失、认证
失败或连接不可用都会阻止 Web 启动。运行期间 Redis 命令失败会拒绝所有当前进程的等待
请求，不得回退进程内计数或放行请求。

生产必须使用高可用 Redis，并避免在生图任务运行期间无状态重建 Redis。租约属于临时
运行状态，不启用无限期持久化；Redis 整体丢失会使已有任务的租约同时消失，因此发布和
故障切换应先排空任务，或由托管 Redis 的高可用复制保证数据连续性。

必填环境变量：

- `REDIS_HOST`
- `REDIS_PASSWORD`

可选连接变量为 `REDIS_PORT`、`REDIS_USERNAME`、`REDIS_DB`。槽位行为可通过
`IMAGE_GENERATION_SLOT_LEASE_TTL_MS` 和 `IMAGE_GENERATION_QUEUE_POLL_MS` 调整；修改
租约 TTL 时必须保证它大于完整生图执行预算。

## 号池成员并发

API 成员的 `concurrency` 继续由 `image_backend_member_lease` PostgreSQL 租约执行。
候选锁定、有效租约聚合、调度策略、容量检查、租约插入和累计获租计数位于同一
数据库事务，供 `priority`、`least_acquired` 与 `least_load` 共享。

这一层不能迁入上述 Redis 用户槽位，也不能同时写 Redis 作为第二事实来源。它需要支持
视频任务跨进程恢复、owner token 续租及历史调度指标，数据库租约仍是唯一正确口径。
