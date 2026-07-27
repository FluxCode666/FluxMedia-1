# FluxMedia 持久事实索引

本文件只记录后续开发必须复用的现行不变量，详细设计放在对应文档或计划中。

## 媒体边界

- 产品只承载图片生成、图片编辑、蒙版编辑、视频生成与结果查询。
- 五个外部 v1 图片 handler 最终汇入 `runImageGenerationForUser`，不得建立平行图片管线。
- 图片与视频均不使用会话粘性；视频被上游接受后固定成员、Adobe token 与轮询地址。

## 统一媒体号池

- 顶层成员类型只有 `api | adobe`；Adobe 内部模式只有 `gateway | direct`。
- `supportedModelIds` 是候选能力的唯一权威，模型名称不承担调度语义。
- 成员模型选项来自管理端模型配置快照；图像使用配置键，视频族展开为可执行完整
  ID。`pool.saveMember` 服务端再次校验目录来源；公开展示开关不得过滤调度能力。
- API 成员只使用 OpenAI Images 协议；`useStream` 属于保留的图片上游能力，
  Responses/Mixed-to-Responses 配置不得迁入统一号池。
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

## 模型配置与公开目录

- 管理端“模型配置”以单条目保存价格、展示开关、简介和封面；公开目录由
  `modelMarketplace.listPublicModels` 提供，接口与运维边界见
  [model-marketplace-operations.md](model-marketplace-operations.md)。
- 模型广场中的图像模型必须同时运行时可达、已显式配置完整四档价格且 `visible` 为
  `true`；未定价图像在管理端标记为“未配置价格”，不能计费或公开。
- 展示开关只影响 `/models` 与首页，不影响 `/v1/models`、创作目录、套餐能力、调度或
  实际计费。
- 自定义封面使用独立模型资产 bucket；该 bucket 必须与 avatars、generations 互异，
  匿名读取只接受严格内容寻址的静态 WebP，不能扩大 generations 的访问权限。
- 默认封面与品牌图标的来源、完整性和许可见
  [model-marketplace-assets.md](model-marketplace-assets.md)。

## 财务、存储与恢复

- 财务真相位于 `credits_transaction`，`generation` 只用于历史与画廊。
- 扣费幂等键为 `(user_id, type, source_ref)`；发放与退款幂等键位于
  `credits_batch(source_type, source_ref)`。
- 视频请求以 Principal 所有者和 `clientRequestId` 派生稳定任务、扣费与存储键。
- 视频恢复使用数据库 claim token、租约与 `stateVersion` 比较交换；旧 worker 不得完成、
  退款或覆盖新 worker 的状态。

## 生图并发

- 用户套餐并发与全站生图并发使用必填标准 Redis 原子槽位；Redis 缺失时 Web 不启动，
  运行中不可用时失败关闭，不得回退进程内计数。
- 号池成员并发仍以 PostgreSQL `image_backend_member_lease` 为唯一事实；Redis 用户槽位
  不得成为号池成员负载的第二口径。

详见 [image-generation-concurrency.md](image-generation-concurrency.md)。

## 部署与迁移

- Drizzle 迁移手写幂等 SQL，并手动登记 `packages/database/drizzle/meta/_journal.json`。
- 统一号池迁移 `0060` 只允许在维护窗口执行；API/Adobe 旧成员、分组、Adobe 子池、
  历史指标和终态视频引用必须原子迁移，只有旧 Web 数据、有效租约/粘性绑定、无法
  恢复的运行中视频状态、不兼容协议或非法配置才阻断。API/Adobe 关系 ID 在合并时
  增加类型前缀，顶层成员仍保留原 ID。
- Adobe direct 只通过 `services/media-upstream-proxy` 访问代码内允许的 Adobe HTTPS
  主机；代理与 Web 共享必填 secret。
- 生产部署顺序和恢复边界见 [CI-CD.md](CI-CD.md)。
