<!-- 本文记录运营总览的生产初始化、导出恢复、数据核对与回滚边界。 -->

# 运营总览运行手册

运营总览路由为 `/dashboard/admin/operations`。它只统计正式上线后的新增、访问、
创作留存和支付生命周期事实，因此生产统计起点必须在迁移完成后由运维显式初始化，
不能由迁移时间、当前时间或历史数据自动推断。

## 生产预建运营明细索引

`0093_operations_dashboard.sql` 与 `0094_operations_detail_cursor_indexes.sql` 依赖四个
复合索引服务无损微秒 keyset。已有生产数据时，必须在运行对应迁移前并发预建；迁移中
的普通 `CREATE INDEX IF NOT EXISTS` 只负责新建或重置库，不能替代生产在线 DDL。

在专用 `psql` 会话中保持 autocommit，禁止使用 `BEGIN`、`COMMIT`、事务包装脚本或
Drizzle 迁移器执行以下命令。`CREATE INDEX CONCURRENTLY` 和
`DROP INDEX CONCURRENTLY` 均不能在事务块中运行。

先检查同名索引是否存在、定义是否正确，以及 PostgreSQL 是否已将其标记为 ready 和
valid：

```sql
SELECT
  indexrelid::regclass AS index_name,
  indisready,
  indisvalid,
  pg_get_indexdef(indexrelid) AS definition
FROM pg_index
WHERE indexrelid = ANY (ARRAY[
  to_regclass('public.user_created_at_id_idx'),
  to_regclass('public.payment_order_operations_fulfilled_cursor_idx'),
  to_regclass('public.payment_lifecycle_event_occurred_id_idx'),
  to_regclass('public.user_output_usage_event_operation_cursor_idx')
]);
```

- 无返回行：可以开始预建。
- `indisready = true` 且 `indisvalid = true`：确认定义与下方命令逐列、排序方向和部分
  谓词一致后跳过对应预建。
- 任一标志为 `false`：上次并发建索引失败或被取消，`IF NOT EXISTS` 不会修复；必须先
  清理 invalid 索引，再重新预建。
- 同名 valid 索引定义不一致：停止发布并人工核对，禁止直接删除生产索引。

预建使用独立会话级 timeout。短 `lock_timeout` 避免与其它 DDL 或长事务无限等待，
有界 `statement_timeout` 避免发布会话永久悬挂；若生产表规模已知无法在 60 分钟内完成，
须由 DBA 根据实测窗口提高上限并记录审批，不能改为无界执行。

```sql
SET lock_timeout = '5s';
SET statement_timeout = '60min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_created_at_id_idx"
  ON public."user" ("created_at", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "payment_order_operations_fulfilled_cursor_idx"
  ON public."payment_order" ("fulfilled_at" DESC, "id" DESC)
  WHERE "status" = 'fulfilled'
    AND "purpose" IN ('credit_top_up', 'credit_package')
    AND "fulfilled_at" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "payment_lifecycle_event_occurred_id_idx"
  ON public."payment_lifecycle_event" ("occurred_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "user_output_usage_event_operation_cursor_idx"
  ON public."user_output_usage_event" (
    "operation_created_at" DESC,
    "output_kind" DESC,
    "source_task_id" DESC
  );

RESET lock_timeout;
RESET statement_timeout;
```

命令成功、超时或连接中断后都必须重新执行 catalog 检查。只有 `indisready` 和
`indisvalid` 同时为 `true` 且定义正确时，才允许继续执行 `0093`/`0094`。若留下 invalid
索引，在同样保持 autocommit 的会话中执行：

```sql
-- 只执行 catalog 检查确认 invalid 的对应语句，不删除 valid 索引。
DROP INDEX CONCURRENTLY IF EXISTS public."user_created_at_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS
  public."payment_order_operations_fulfilled_cursor_idx";
DROP INDEX CONCURRENTLY IF EXISTS
  public."payment_lifecycle_event_occurred_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS
  public."user_output_usage_event_operation_cursor_idx";
```

清理后重新设置 timeout 并执行并发预建。不要在索引仍为 invalid 时直接运行迁移，
因为迁移中的 `IF NOT EXISTS` 会跳过同名对象，查询仍无法获得有效访问路径。

## 初始化运营统计起点

### 前置条件

1. `0093_operations_dashboard.sql` 与 `0094_operations_detail_cursor_indexes.sql` 已在
   目标数据库执行。
2. 新版 Web 已部署，旧实例已经退出，不再存在缺少运营事实双写的进程。
3. 产品与运维共同确认正式上线的应用自然日和 `APP_TIME_ZONE`。
4. 将该自然日零点转换为 UTC 瞬间，并由第二位操作者复核。
5. 为本次发布生成稳定且不会复用到其它日期的 request ID。

初始化命令只读取以下一次性输入，不应把它们长期写入 `.env`：

- `OPERATIONS_EPOCH_APP_DATE`：应用时区自然日，格式为 `YYYY-MM-DD`。
- `OPERATIONS_EPOCH_STARTS_AT`：该自然日零点对应的带偏移 ISO 8601 瞬间。
- `OPERATIONS_EPOCH_INITIALIZED_BY`：发布版本、工单或值班身份标识。
- `OPERATIONS_EPOCH_REQUEST_ID`：本次初始化的全局幂等键。

### 预演

不传 `--apply` 时命令完全不初始化 UOL，也不连接数据库，只校验输入与时区边界并
输出规范化计划：

```bash
APP_TIME_ZONE=Asia/Shanghai \
OPERATIONS_EPOCH_APP_DATE=2026-08-15 \
OPERATIONS_EPOCH_STARTS_AT=2026-08-14T16:00:00.000Z \
OPERATIONS_EPOCH_INITIALIZED_BY=release-v0.9.0 \
OPERATIONS_EPOCH_REQUEST_ID=operations-epoch-2026-08-15 \
pnpm --filter @repo/web operations:epoch:init
```

确认输出中的 `timeZone`、`appDate` 和 `startsAt` 后，保留命令输出到发布记录。

### 正式执行

使用完全相同的四个输入追加 `--apply`：

```bash
APP_TIME_ZONE=Asia/Shanghai \
OPERATIONS_EPOCH_APP_DATE=2026-08-15 \
OPERATIONS_EPOCH_STARTS_AT=2026-08-14T16:00:00.000Z \
OPERATIONS_EPOCH_INITIALIZED_BY=release-v0.9.0 \
OPERATIONS_EPOCH_REQUEST_ID=operations-epoch-2026-08-15 \
pnpm --filter @repo/web operations:epoch:init -- --apply
```

首次成功返回 `initialized: true`。使用相同日期、UTC 起点和 request ID 重试返回
`initialized: false`，不会产生第二行。任何不同日期或起点都会返回冲突；不要直接修改
数据库，变更统计起点必须经过新的迁移和产品审批。

执行后用只读查询核对唯一行和审计记录：

```sql
SELECT app_date, starts_at, initialized_by, initialization_request_id, created_at
FROM operations_analytics_epoch
WHERE id = 1;

SELECT action, actor_id, resource_type, resource_id, created_at
FROM admin_audit_log
WHERE action = 'operations.initializeEpoch'
ORDER BY created_at DESC
LIMIT 5;
```

## 导出任务启用与恢复

运营 CSV 处理和文件清理默认关闭。完成存储读写、下载鉴权与审计冒烟后，再通过系统
设置分别开启：

- `INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_ENABLED`
- `INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_ENABLED`

处理任务和清理任务使用不同的 scheduler job 与 advisory lock。恢复时遵循以下边界：

- `queued` 长时间不推进：检查内部 scheduler 总开关、处理开关、advisory lock 和存储
  配置；恢复 worker 后继续认领，不手工改成 `completed`。
- `running` 租约过期：新 worker 使用新的 fencing token 重新认领；旧 worker 的终态写入
  必须失败，不能覆盖新结果。
- `failed`：管理员通过运营总览创建关联原任务的新重试记录；保留原任务和审计。
- `completed` 到达 `expires_at`：先转为 `expired` 并立即拒绝下载，再重试删除物理对象。
- 删除失败：保持 `expired`，记录清理错误；对象仍存在也不能恢复下载权限。

## 发布前数据核对

固定一个同时包含以下事实的区间：真实零值、API Key-only 创作、多币种订单、支付
失败、生成失败积分退回、成熟和未成熟 Cohort。

对每个范围保存并比较：

1. 源事实 SQL 的行数、金额和积分。
2. `operations.getOverview` 返回的汇总和趋势。
3. `operations.getDetail` 的全部 keyset 分页记录。
4. 三类 CSV 的行数、字节数和 SHA-256 校验和。

计数、金额和两位小数积分必须完全相等；比率只允许 UI 格式化产生舍入差异。任何差异
都阻止开放导航。不得使用 `payment_order.updated_at` 回填支付阶段，也不得把上线前空白
显示成真实零值。

发布前还应在名称包含 `test` 的专用数据库执行 PostgreSQL 边界测试：

```bash
OPERATIONS_DASHBOARD_TEST_DATABASE_URL=<专用测试库连接串> \
pnpm --filter @repo/integration-tests test:operations-boundaries
```

该命令在随机隔离 schema 中执行生产迁移、导出快照和直接事实明细 SQL，必须同时证明
六位微秒高水位原样保留、3005 行跨多页不重复不遗漏，并确认用户、订单、履约订单、
支付生命周期和成功产物的深 cursor 进入复合 `Index Cond` 且不产生 `Sort`。测试结束后
会删除隔离 schema，不读取或清理专用库中的其它夹具。

## 发布与回滚

发布顺序固定为：并发预建运营复合索引、迁移结构、部署事实双写与 UOL、预演并初始化
epoch、开启导出 worker、完成三类小范围导出和浏览器冒烟、完成零差异对账、最后开放
导航。

应用回滚可以隐藏运营页面并关闭两个导出任务，但不能删除事实表、支付生命周期事件或
已经初始化的 epoch。若出现支付事件缺口，先关闭商业化漏斗入口并修复写入路径，禁止用
近似时间静默回填。
