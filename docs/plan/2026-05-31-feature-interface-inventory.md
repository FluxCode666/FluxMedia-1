# 统一接口层功能盘点

本文记录现行 UOL operation 域及媒体重构后的主要入口。注册表与 operation 定义是代码
权威；新增功能必须先注册 operation，再由 Server Action、API route、cron 或 MCP 做薄适配。

## 调用边界

`invokeOperation` 统一执行 Principal 校验、声明式权限、套餐能力、审计、错误映射与幂等
装饰。底层 service 负责自己的数据库事务，传输层不得复制业务校验或嵌套外层事务。

## 媒体与号池 operation

| 域 | 主要 operation | Principal | 说明 |
| --- | --- | --- | --- |
| 图片 | `image.generate` | 用户或 API Key | 图片生成、编辑与蒙版编辑，唯一委托单一图片管线 |
| 图片 | `image.getStatus` | 用户或 API Key | 校验所有者后读取图片任务 |
| 图片 | `image.delete`、历史查询 | 用户或管理员 | 删除本人产物或读取授权范围内历史 |
| 视频 | `video.generate` | 用户或 API Key | 以 Principal 作用域和 `clientRequestId` 幂等创建任务 |
| 视频 | `video.getStatus` | 用户或 API Key | 同时校验 `userId` 与外部调用的 `apiKeyId` |
| 号池 | `pool.getGroupOptions` | 已登录用户 | 返回当前可用分组选项 |
| 号池 | `pool.getAdminPool` | 管理员 | 读取统一分组、成员与调度状态 |
| 号池 | `pool.saveGroup`、`pool.deleteGroup` | 管理员 | 管理分组及其授权范围 |
| 号池 | `pool.saveMember`、`pool.resetMemberStatus`、`pool.deleteMember` | 管理员 | 管理 `api | adobe` 统一成员、显式模型能力及暂态运行健康 |
| 系统设置 | `settings.getSnapshot`、`settings.update`、`settings.getPaginationConfig` | 管理员 / 系统 | 读取或动态更新全局配置；站内列表通过 system-only 只读接口获取分页大小白名单 |

## 模型配置与模型广场 operation

| Operation | Principal | 幂等与副作用 | 传输与边界 |
| --- | --- | --- | --- |
| `settings.getModelConfiguration` | `observer_admin`、`admin`、`super_admin` 用户 | 只读、自然幂等、无副作用 | 管理端 Server Action；返回规范化配置清单，只有真实 `super_admin` 的 `canEdit` 为 `true` |
| `settings.updateModelConfigurationEntry` | 仅真实 `super_admin` 用户 | `clientRequestId` 按用户必填幂等；破坏性；声明 `storage`、`cache`、`audit` 副作用 | `POST /api/admin/model-configuration` multipart 薄适配器；价格、展示配置、封面引用、回执与审计在底层单事务收敛 |
| `modelMarketplace.listPublicModels` | 仅站内 `system` | 只读、自然幂等、无副作用 | `/models` 与首页 Server Component 进程内调用；不提供匿名 API，也不投影到 Admin/User MCP |

三个 operation 均为 `human-only`。展示开关只控制 `/models` 与首页公开模型区，不参与
`/v1/models`、创作目录、套餐能力、后端调度或实际计费。详细运行与存储边界见
[model-marketplace-operations.md](../model-marketplace-operations.md)。

## 支撑域

| 域 | 示例 operation | 关键不变量 |
| --- | --- | --- |
| 积分 | `credits.consume`、`credits.refund`、余额与流水查询 | 使用稳定 `sourceRef` 和数据库唯一约束保证幂等 |
| 存储 | `storage.getSignedUploadUrl`、`storage.readObject`、`storage.deleteFile` | 校验对象键与资源归属，不把第三方响应直接暴露给用户 |
| 审核 | `moderation.moderateContent`、风险策略 operation | 生成链路 fail-closed，关闭时才跳过且不收费 |
| 外部 API | `externalApi.getModels`、`externalApi.getCredits`、API Key 管理 | Bearer Principal 与用户归属一致 |
| 用户与套餐 | `user.*`、订阅与能力查询 | 套餐能力唯一来源是 `plan-capabilities.ts` |
| 管理与作业 | 用户管理、支付、分析、维护 operation | 管理权限和副作用必须显式声明 |

## 管理端支付 operation

| Operation | Principal | 口径与传输边界 |
| --- | --- | --- |
| `payment.getAdminOverview` | `admin`、`super_admin` 用户 | 人工会话只读；按部署时区日期范围读取已履约积分充值收入，并按 `created_at` 读取全部状态的充值订单数；默认当前自然月 |
| `payment.listAdminOrders` | `admin`、`super_admin` 用户 | 人工会话只读；按部署时区中的 `created_at` 日期范围、邮箱、精确本地订单号和持久状态查询；默认今天及前 6 天，使用绑定管理员、日期范围与其他筛选的签名 keyset cursor |
| `payment.searchAdminOrderUsers` | `admin`、`super_admin` 用户 | 人工会话只读；服务端有界搜索存在充值订单的用户邮箱 |

三个 operation 均为 `human-only`，由管理端 Server Action 薄适配器调用。其收入范围只
覆盖 `payment_order` 中的 `credit_top_up | credit_package`，不包含订阅、手续费、拒付、
退款净额或统一支付订单上线前的历史数据。详细设计见
[admin-payment-management.md](2026-07-28-admin-payment-management.md)。

## 用户钱包支付 operation

| Operation | Principal | 口径与传输边界 |
| --- | --- | --- |
| `payment.listMyRecentOrders` | 当前登录用户 | 只读最近 8 笔、最多 20 笔统一积分充值订单；身份仅从 Principal 派生，不返回用户 ID、渠道交易号或支付快照 |

钱包页由 Server Action 薄适配器将该 operation 与余额、充值能力、订阅能力并行聚合。
订单范围只包含 `payment_order` 中的 `credit_top_up | credit_package`，按
`created_at DESC, id DESC` 稳定排序；面向用户的状态与统一支付结果页保持一致。

## 用户数据看板 operation

| Operation | Principal | 口径与传输边界 |
| --- | --- | --- |
| `analytics.getMyDataDashboard` | 仅当前登录 `user` Principal | 只读、自然幂等、无副作用；输入不接受 `userId`，返回账号有效时区中最多 30 个自然日的同一 `asOf` 整页快照 |

Web 首屏与刷新 Server Action 都经 UOL 调用该 operation；binding 在聚合事务前使用
`analytics-dashboard:<userId>` 和 `global` 桶限流。readiness、数据库时钟、日期范围、
成功产出、净积分、模型与失败任务全部位于同一只读 repeatable-read 快照。首版不加入
User MCP 白名单，也不投影到 Admin MCP；站内 Agent 未来只能使用真实 user Principal
进程内调用。

## 媒体传输映射

| 传输 | operation |
| --- | --- |
| 页面图片生成、编辑与状态路由 | `image.generate`、`image.getStatus` |
| `/v1` 与 `/api/v1` 图片路由 | 同一图片 operation 与 handler |
| 页面视频生成与状态路由 | `video.generate`、`video.getStatus` |
| `/v1` 与 `/api/v1` 视频路由 | 同一视频 operation 与 handler |
| 号池管理页 Server Action | `pool.*` |
| 系统设置页 Server Action | `settings.getSnapshot`、`settings.update` |
| 模型配置管理读取 | `settings.getModelConfiguration` |
| 模型配置 multipart 保存 | `settings.updateModelConfigurationEntry` |
| `/models` 与首页公开模型区 | `modelMarketplace.listPublicModels` |

任何新媒体入口都必须复用这些 operation，不得直接调用调度仓储、积分 service 或存储
service 建立旁路。
