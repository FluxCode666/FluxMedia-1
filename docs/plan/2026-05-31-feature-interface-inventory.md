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
| 号池 | `pool.saveMember`、`pool.deleteMember` | 管理员 | 管理 `api | adobe` 统一成员及显式模型能力 |
| 系统设置 | `settings.getSnapshot`、`settings.update` | 管理员 | 读取或动态更新全局调度策略等配置 |

## 支撑域

| 域 | 示例 operation | 关键不变量 |
| --- | --- | --- |
| 积分 | `credits.consume`、`credits.refund`、余额与流水查询 | 使用稳定 `sourceRef` 和数据库唯一约束保证幂等 |
| 存储 | `storage.getSignedUploadUrl`、`storage.readObject`、`storage.deleteFile` | 校验对象键与资源归属，不把第三方响应直接暴露给用户 |
| 审核 | `moderation.moderateContent`、风险策略 operation | 生成链路 fail-closed，关闭时才跳过且不收费 |
| 外部 API | `externalApi.getModels`、`externalApi.getCredits`、API Key 管理 | Bearer Principal 与用户归属一致 |
| 用户与套餐 | `user.*`、订阅与能力查询 | 套餐能力唯一来源是 `plan-capabilities.ts` |
| 管理与作业 | 用户管理、支付、分析、维护 operation | 管理权限和副作用必须显式声明 |

## 媒体传输映射

| 传输 | operation |
| --- | --- |
| 页面图片生成、编辑与状态路由 | `image.generate`、`image.getStatus` |
| `/v1` 与 `/api/v1` 图片路由 | 同一图片 operation 与 handler |
| 页面视频生成与状态路由 | `video.generate`、`video.getStatus` |
| `/v1` 与 `/api/v1` 视频路由 | 同一视频 operation 与 handler |
| 号池管理页 Server Action | `pool.*` |
| 系统设置页 Server Action | `settings.getSnapshot`、`settings.update` |

任何新媒体入口都必须复用这些 operation，不得直接调用调度仓储、积分 service 或存储
service 建立旁路。
