# 时间与时区策略

## 不变量

- PostgreSQL 应用连接固定使用 `options: "-c timezone=UTC"`。
- Web 与迁移 Node 进程固定使用 `TZ=UTC`；`pg` 会按进程时区解析
  `timestamp without time zone`，因此禁止把 `TZ` 设置为站内展示时区。
- 数据库时间字段按 UTC 语义写入和读取；外部 API 只返回 Unix epoch 或带 `Z` 的 ISO 8601。
- `APP_TIME_ZONE` 只存在于部署环境，不属于系统设置，不得从 `system_setting` 覆盖进程环境。

## generation 历史迁移

- `0052` 不得使用迁移连接的 `TimeZone` 推断历史写入口径，因为 drizzle-kit 连接固定为 UTC。
- 历史候选只使用已取证的 `Asia/Shanghai`；其他旧时区不猜测，证据不足时迁移整体失败。
- 优先使用服务端生成的 `metadata.upstreamStream.startedAt` UTC ISO 锚点；缺失时仅允许用
  `completed_at` 的 45 分钟运行窗口判断。两类证据冲突、锚点非法或无证据均拒绝更新。
- 迁移只更新逐行证明为旧口径的记录，并核对实际影响行数；`generation.created_at` 的数据库
  默认值与 ORM schema 均固定为 `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`。

## 站内展示优先级

```text
user.time_zone > process.env.APP_TIME_ZONE > UTC
```

- `user.time_zone` 保存 IANA 时区名称；`NULL` 表示继承部署默认值。
- `APP_TIME_ZONE` 可设为 `Asia/Shanghai`，但仅用于展示；它与必须为 `UTC` 的进程
  `TZ` 是两个独立配置。
- 用户输入必须通过 `Intl.DateTimeFormat` 兼容性校验，不接受 `UTC+8` 这类固定偏移别名。
- 使用 `Europe/Berlin` 等 IANA 名称自动处理夏令时，禁止手工加减小时。

## 日志时间

- Pino 的标准 `time` 字段保持 UTC ISO 8601，供日志平台排序、检索和跨服务关联。
- Pino 同时写入按 `APP_TIME_ZONE` 格式化的 `localTime` 与实际 `timeZone`，供运维直接
  阅读；非法或缺失的 `APP_TIME_ZONE` 回退 UTC。
- Docker `--timestamps` 输出的前缀固定为 UTC；排查应用日志时以 JSON 内的
  `localTime` 为本地展示时间，不得为改变日志前缀而修改 Web 进程 `TZ`。
- Nginx `$time_local` 使用宿主机/Nginx 进程时区，与应用 `APP_TIME_ZONE` 无关。

## 接口与实现

- UOL：`user.getMyTimeZone`、`user.updateMyTimeZone`。
- 服务端解析：`packages/shared/src/time-zone/server.ts`。
- 管理后台不再展示或写入 `APP_TIME_ZONE`；迁移 `0053_user_time_zone.sql` 清理旧数据库行。
