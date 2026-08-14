<!-- 本文记录运营总览在本地 PostgreSQL 18.4 上完成的不变量与查询计划验证证据。 -->

# 运营总览 PostgreSQL 验证记录

验证日期为 2026-08-14，目标数据库为本地 `fluxmedia`，数据库会话时区为 UTC。验证过程
只输出数据库版本、约束名、索引名、行数和执行计划，不输出连接串、密钥或业务敏感数据。
临时夹具统一使用 `codex-ops-verify-20260814-*` 标识，并在测试后精确清理。

## 已通过的不变量

### 运营统计起点

- `operations_analytics_epoch` 恰好一行，应用日期为 `2026-08-14`，UTC 起点为
  `2026-08-13T16:00:00.000Z`，与 `Asia/Shanghai` 自然日零点一致。
- 存在且仅存在一条匹配 `operations.initializeEpoch` 的审计记录，其应用日期和
  request ID 与 epoch 一致。
- 第二行被 `operations_analytics_epoch_singleton_check` 以 SQLSTATE `23514` 拒绝。
- 更新和删除被不可变 trigger 以 SQLSTATE `P0001` 拒绝，失败操作后唯一行未改变。

以上 epoch 仅用于本地验收，不代表生产统计起点。生产环境仍须按运行手册重新预演、
复核和初始化。

### 网页访问并发去重

对同一临时用户和同一自然日并发执行 8 次
`INSERT ... ON CONFLICT DO NOTHING`，只有 1 次成功插入，数据库最终恰好保留一行。
复合主键 `user_web_visit_user_app_date_pk` 能够在数据库层阻止同日重复访问事实。

### 支付生命周期事件

- 首次事件插入一行；相同订单、事件类型和 `source_ref` 重放不新增事实。
- 强制重复插入被 `payment_lifecycle_event_order_type_source_unique` 以 SQLSTATE
  `23505` 拒绝。
- 同一事务内先更新订单状态，再制造事件唯一键冲突，整笔事务回滚；订单恢复为
  `pending`，事务内事件没有残留。

### 导出任务状态与租约

- 重复 `(created_by, client_request_id)` 被
  `operations_export_task_creator_request_unique` 以 SQLSTATE `23505` 拒绝。
- `running` 缺少完整租约，或 `queued` 携带租约，均被
  `operations_export_task_lease_shape_check` 以 SQLSTATE `23514` 拒绝。
- 两个事务并发认领时，第一个 worker 持有 queued A 的行锁，第二个 worker 在约 3ms
  内通过 `FOR UPDATE SKIP LOCKED` 认领 queued B，没有等待或重复认领。
- 过期 `running` 任务可被新 worker 回收，`attempt_count` 从 0 增至 1；旧 fencing token
  的终态更新影响 0 行，新 token 的终态更新影响 1 行；未过期租约不可被抢占。
- 已到期 `completed` 任务转为 `expired`；对象尚未删除的 `expired` 任务可再次进入清理
  批次；未到期任务不受影响，存储定位字段不会因状态过期而被清空。

### 导出微秒高水位与同毫秒分页

- `test:operations-boundaries` 在专用 PostgreSQL 数据库的随机隔离 schema 中执行生产
  `readOperationsExportSnapshot` SQL；时间 `2000-01-02 12:34:56.123403` 被原样冻结为
  `2000-01-02T12:34:56.123403Z`，没有经过 JavaScript `Date` 丢失后三位微秒。
- 三条记录分别使用 `.123403`、`.123402`、`.123401`，但明细排序统一截断到同一毫秒，
  再以稳定 ID 打破平局。页大小为 2 时第一页返回 `z、y`，第二页返回 `x`，无重复或
  漏行。
- 聚焦 DB-free 回归 33/33 通过；真实 PostgreSQL 边界集成测试 2/2 通过。隔离 schema
  在测试结束后删除，不修改既有 epoch 或浏览器夹具。

## 查询计划证据

本地业务样本很小，所有计划均为缓存命中且 `shared read = 0`。以下结果证明 SQL 与索引
访问路径可执行，但不能外推生产 p95。

| 查询 | 已观察访问路径 | 本地耗时 |
| --- | --- | ---: |
| 用户增长日期范围 | 小表默认顺序扫描；强制计划使用 `user_created_at_id_idx` 的 Index Only Scan，无 Sort | 0.014ms |
| 网页访问去重 | `user_web_visit_first_visited_user_idx`；为 `COUNT(DISTINCT user_id)` 执行语义所需排序 | 0.020ms |
| 支付生命周期聚合 | `payment_lifecycle_event_type_occurred_order_idx` 与 `payment_order_admin_recharge_created_id_idx`；按订单 flags 聚合排序 | 0.278ms |
| 导出认领 | 小表默认 Seq Scan；强制计划为状态条件 BitmapOr 后排序，再 LockRows/Limit | 0.099ms 至 0.107ms |
| 导出过期 | 小表默认 Seq Scan；强制计划为状态索引 BitmapOr 后排序，再 LockRows/Limit | 0.100ms 至 0.296ms |

增长、访问和支付的日期范围索引已经证明可用。导出认领与过期查询中的 `OR` 条件可能在
生产候选量较大时扫描并排序所有匹配行；本地 `LIMIT` 只限制返回行数，不能证明候选扫描
成本有界。发布前必须使用接近生产规模的数据重新记录跨多年聚合 p95、buffers 和
claim/expire 排序成本。若排序成本超出预算，应评估拆分 `OR` 分支或增加部分索引。

## 隔离浏览器验收

Playwright 使用专用数据库 `fluxmedia_operations_e2e_test`、专用数据库角色、独立 Redis
逻辑库 15 和隔离 local storage 目录启动真实 Next.js。夹具通过真实表写入同一条运营事实
链，而不是拦截接口或模拟响应：

- 一个 epoch 后新增并访问的普通用户，外加 `observer_admin`、`admin`、
  `super_admin` 三种控制角色；四种角色均通过登录表单建立 Better Auth 会话。
- 一次成功生图任务，对应 3 张图片、12.34 净积分用量；一次成功视频任务，对应
  12 秒视频、4.56 净积分用量。
- 一笔人民币 19.90 元、200 积分的已履约充值订单，以及创建、确认、履约成功三阶段
  支付生命周期事件。
- completed、failed、expired 三种导出任务；completed 与 expired 均绑定真实 CSV
  对象、SHA-256、行数和字节数。

完整浏览器套件 28/28 通过，覆盖默认近 30 日、本周、本月、本年、自定义日期和日/周/月
粒度，增长与内容下钻，视频数量/秒数切换，真实 Recharts hover、方向键焦点浏览，四级
权限以及桌面和 390px 响应式布局。axe WCAG A/AA、图表等价表、dialog 名称和
reduced-motion 检查均通过；桌面与 390px 两份首屏视觉基线在不更新快照的复跑中 2/2
通过。合并 `main` 后再次完整执行 28/28，通过期间未出现 node-postgres
`client.query()` 并发弃用警告。

测试结束后固定用户、account、session、导出任务均为 0；端口 3107 无监听进程，隔离
storage 目录不存在。测试进程创建的三个 Redis 元数据键已按精确键名删除，专用 DB 15
最终 `DBSIZE` 为 0。

## 清理与结论

验证前后用户、网页访问、支付订单、支付事件和导出任务行数完全恢复；审计计数未改变，
数据库中不存在 `codex-ops-verify-*` 临时用户或关联事实。

本地已通过约束、并发唯一性、支付事务回滚、租约 fencing、`SKIP LOCKED` 和过期状态
不变量。跨多年聚合性能以及导出候选排序成本保留为生产规模发布门禁，不能依据本地毫秒
级小样本结果关闭。
