<!-- 本文件索引 FluxMedia 后续开发必须复用的持久事实，并链接到详细设计文档。 -->

# FluxMedia 持久事实索引

本文件只记录后续开发必须复用的现行不变量，详细设计放在对应文档或计划中。

## 媒体边界

- 产品只承载图片生成、图片编辑、蒙版编辑、视频生成与结果查询。
- 五个外部 v1 图片 handler 最终汇入 `runImageGenerationForUser`，不得建立平行图片管线。
- 图片与视频均不使用会话粘性；视频被上游接受后固定原账号、提交时可信源和轮询地址，
  恢复时只加载该账号的当前协议凭据。

## 统一媒体号池

- 顶层成员类型只有 `api | adobe`；Adobe 内部模式只有 `gateway | direct`。
- `supportedModelIds` 是候选能力的唯一权威，模型名称不承担调度语义。
- 成员模型选项来自管理端模型配置快照；图片与视频都只保存真实模型 ID，不得把时长、
  比例或分辨率编码进模型 ID。`pool.saveMember` 服务端再次校验目录来源；公开展示开关
  不得过滤调度能力。
- API 成员支持 Images 与 Videos 兼容协议，Adobe Direct 支持图片与视频，Adobe
  Gateway 仅支持图片；`useStream` 属于保留的图片上游能力，Responses/
  Mixed-to-Responses 配置不得迁入统一号池。
- API 成员的 `supportedModelIds`、调度、计费、任务和响应始终使用平台真实模型 ID；
  账号级稀疏模型映射只在出站最后一跳替换供应商模型 ID。旧 `copy|move` 参数映射与
  模板已删除，请求体差异统一由隔离 JavaScript 脚本处理。
- 管理员配置的媒体 Base URL 可使用 HTTP 或私网；上游派生的跨源轮询、产物地址及
  每一跳重定向不得继承该信任，只能通过公网 DNS pin，且不得携带账号凭据。
- 全局调度策略为 `priority | least_acquired | least_load`，缺失或非法时回退
  `priority`。
- 调度排序、容量检查、获租与计数更新必须在同一个 PostgreSQL 事务中完成。
- 调度指标不得记录 prompt、媒体、Cookie、token 或 API Key。
- 管理员可通过 `pool.resetMemberStatus` 手动清除成员的健康降级、错误 EWMA、失败连击、
  冷却和最近错误；重置不得伪造凭据有效、修改启用开关、累计指标或运行中租约。

详见 [image-backend-pool-scheduling.md](image-backend-pool-scheduling.md)、
[api-account-upstream-adaptation.md](memory/api-account-upstream-adaptation.md) 与
[api-upstream-adapter-admin.md](api-upstream-adapter-admin.md)。

## 统一接口层

- 新功能先在 `packages/shared/src/uol/` 注册 `defineOperation()`，传输层只做解析、
  Principal 构造、调用与编码。
- 图片、视频、号池和系统设置的现行 operation 见
  [feature-interface-inventory.md](plan/2026-05-31-feature-interface-inventory.md)。
- 公开 `/api-docs` 与控制台镜像共用同一数据源，必须同步展示模型、积分、图片与视频八个
  现行端点；所有示例和 API 密钥控制台统一读取 `NEXT_PUBLIC_APP_URL`。视频文档只使用
  真实模型 ID，并明确独立时长、比例、分辨率、输入图互斥、声音能力与持久任务轮询契约。
- MCP 与站内调用共享 registry、Principal、权限、幂等与审计网关。
- 所有可见分页列表默认每页 20 条；可选大小由系统设置
  `PAGINATION_PAGE_SIZE_OPTIONS` 统一配置，必须包含 20，默认 `[10, 20, 50]`。
  页面通过 `settings.getPaginationConfig` 读取，切换大小时必须重置页码或签名 cursor。

## 模型配置与公开目录

- 管理端“模型配置”以单条目保存价格、展示开关、简介和封面；公开目录由
  `modelMarketplace.listPublicModels` 提供，接口与运维边界见
  [model-marketplace-operations.md](model-marketplace-operations.md)。
- 模型广场中的图像模型必须同时运行时可达、已显式配置完整四档价格且 `visible` 为
  `true`；未定价图像在管理端标记为“未配置价格”，不能计费或公开。
- 展示开关只影响 `/models` 与首页，不影响 `/v1/models`、创作目录、套餐能力、调度或
  实际计费。
- 自定义封面、网站品牌和头像可共用一个私有系统公开资产 bucket，并分别使用
  `image|video/`、`logo/`、`avatars/` key 命名空间；`generations` 必须独立。
  匿名模型封面读取只接受严格内容寻址的静态 WebP，不能扩大 generations 的访问权限。
- 默认封面与品牌图标的来源、完整性和许可见
  [model-marketplace-assets.md](model-marketplace-assets.md)。

## 财务、存储与恢复

- 财务真相位于 `credits_transaction`，`generation` 只用于历史与画廊。
- 扣费幂等键为 `(user_id, type, source_ref)`；发放与退款幂等键位于
  `credits_batch(source_type, source_ref)`。
- 视频请求以 Principal 所有者和 `clientRequestId` 派生稳定任务、扣费与存储键。
- 视频恢复使用数据库 claim token、租约与 `stateVersion` 比较交换；旧 worker 不得完成、
  退款或覆盖新 worker 的状态。
- 管理端“支付概览/订单管理”只统计统一 `payment_order` 中的积分充值订单；收入按
  `fulfilled_at`、部署级 `APP_TIME_ZONE` 和币种分别汇总，不代表订阅或渠道净收入。
- 支付概览图表左轴为收入金额、右轴为充值订单数；订单币种与已履约收入币种取并集，
  即使某币种收入为 0 也必须保留零值金额线，且禁止跨币种相加。
- 管理端订单管理按 `payment_order.created_at` 和部署级 `APP_TIME_ZONE` 筛选，默认今天
  及前 6 天；结束日期使用次日零点 UTC 半开边界，签名 cursor 必须绑定原日期范围。
- 用户钱包最近充值订单只读取本人 `payment_order` 中的 `credit_top_up` 与
  `credit_package`，用户身份必须从 Principal 派生，不能接受客户端 `userId`。

详见 [admin-payment-management.md](plan/2026-07-28-admin-payment-management.md) 与
[credit-payment-result-flow.md](memory/credit-payment-result-flow.md)。

## 生图并发

- 用户套餐并发与全站生图并发使用必填标准 Redis 原子槽位；Redis 缺失时 Web 不启动，
  运行中不可用时失败关闭，不得回退进程内计数。
- 号池成员并发仍以 PostgreSQL `image_backend_member_lease` 为唯一事实；Redis 用户槽位
  不得成为号池成员负载的第二口径。

详见 [image-generation-concurrency.md](image-generation-concurrency.md)。

## 部署与迁移

- Drizzle 迁移手写幂等 SQL，并手动登记 `packages/database/drizzle/meta/_journal.json`。
- Web 与迁移进程保持 `TZ=UTC`；业务展示和 Pino 的 `localTime` 使用合法 IANA
  `APP_TIME_ZONE`。详细契约见 [time-zone-policy.md](memory/time-zone-policy.md)。
- 统一号池迁移 `0060` 只允许在维护窗口执行；API/Adobe 旧成员、分组、Adobe 子池、
  历史指标和终态视频引用必须原子迁移，只有旧 Web 数据、有效租约/粘性绑定、无法
  恢复的运行中视频状态、不兼容协议或非法配置才阻断。API/Adobe 关系 ID 在合并时
  增加类型前缀，顶层成员仍保留原 ID。
- Adobe direct 只通过 `services/media-upstream-proxy` 访问代码内允许的 Adobe HTTPS
  主机；代理与 Web 共享必填 secret。
- 生产部署顺序和恢复边界见 [CI-CD.md](CI-CD.md)。
