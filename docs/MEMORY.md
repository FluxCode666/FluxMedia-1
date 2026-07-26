# FluxMedia 持久事实索引

本文件只记录后续开发必须复用的现行不变量，详细设计放在对应文档或计划中。

## 媒体边界

- 产品只承载图片生成、图片编辑、蒙版编辑、视频生成与结果查询。
- 五个外部 v1 图片 handler 最终汇入 `runImageGenerationForUser`，不得建立平行图片管线。
- 图片与视频均不使用会话粘性；视频被上游接受后固定成员、Adobe token 与轮询地址。

## 统一媒体号池

- 顶层成员类型只有 `api | adobe`；Adobe 内部模式只有 `gateway | direct`。
- `supportedModelIds` 是候选能力的唯一权威，模型名称不承担调度语义。
- 全局调度策略为 `priority | least_acquired | least_load`，缺失或非法时回退
  `priority`。
- 调度排序、容量检查、获租与计数更新必须在同一个 PostgreSQL 事务中完成。
- 调度指标不得记录 prompt、媒体、Cookie、token 或 API Key。

详见 [image-backend-pool-scheduling.md](image-backend-pool-scheduling.md)。

## 统一接口层

- 新功能先在 `packages/shared/src/uol/` 注册 `defineOperation()`，传输层只做解析、
  Principal 构造、调用与编码。
- 图片、视频、号池和系统设置的现行 operation 见
  [feature-interface-inventory.md](plan/2026-05-31-feature-interface-inventory.md)。
- MCP 与站内调用共享 registry、Principal、权限、幂等与审计网关。

## 财务、存储与恢复

- 财务真相位于 `credits_transaction`，`generation` 只用于历史与画廊。
- 扣费幂等键为 `(user_id, type, source_ref)`；发放与退款幂等键位于
  `credits_batch(source_type, source_ref)`。
- 视频请求以 Principal 所有者和 `clientRequestId` 派生稳定任务、扣费与存储键。
- 视频恢复使用数据库 claim token、租约与 `stateVersion` 比较交换；旧 worker 不得完成、
  退款或覆盖新 worker 的状态。

## 部署与迁移

- Drizzle 迁移手写幂等 SQL，并手动登记 `packages/database/drizzle/meta/_journal.json`。
- 统一号池迁移 `0060` 只允许在维护窗口执行；API/Adobe 旧成员、分组、Adobe 子池、
  历史指标和终态视频引用必须原子迁移，只有旧 Web 数据、有效租约/粘性绑定或无法
  恢复的运行中视频状态才阻断。
- Adobe direct 只通过 `services/media-upstream-proxy` 访问代码内允许的 Adobe HTTPS
  主机；代理与 Web 共享必填 secret。
- 生产部署顺序和恢复边界见 [CI-CD.md](CI-CD.md)。
