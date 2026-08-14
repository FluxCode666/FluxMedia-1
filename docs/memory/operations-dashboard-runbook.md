<!-- 本文记录运营总览的生产初始化、导出恢复、数据核对与回滚边界。 -->

# 运营总览运行手册

运营总览路由为 `/dashboard/admin/operations`。它只统计正式上线后的新增、访问、
创作留存和支付生命周期事实，因此生产统计起点必须在迁移完成后由运维显式初始化，
不能由迁移时间、当前时间或历史数据自动推断。

## 初始化运营统计起点

### 前置条件

1. `0093_operations_dashboard.sql` 已在目标数据库执行。
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

该命令在随机隔离 schema 中执行生产导出快照和新增用户明细 SQL，必须同时证明六位微秒
高水位原样保留，以及同一毫秒内多条记录跨 keyset 页面不重复、不遗漏。测试结束后会
删除隔离 schema，不读取或清理专用库中的其它夹具。

## 发布与回滚

发布顺序固定为：迁移结构、部署事实双写与 UOL、预演并初始化 epoch、开启导出 worker、
完成三类小范围导出和浏览器冒烟、完成零差异对账、最后开放导航。

应用回滚可以隐藏运营页面并关闭两个导出任务，但不能删除事实表、支付生命周期事件或
已经初始化的 epoch。若出现支付事件缺口，先关闭商业化漏斗入口并修复写入路径，禁止用
近似时间静默回填。
