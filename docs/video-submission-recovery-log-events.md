<!--
本文定义视频 API 供应商创建失败自动恢复的稳定日志标识、字段与告警规则。
旧版人工核对方案已废弃；API 供应商不再等待管理员填写上游 task ID。
-->

# 视频提交自动恢复日志标识

本文是 FluxMedia 视频 API 供应商自动恢复日志的运维契约。采集规则应优先匹配
`event` 和 `failureCode`，不要以自由文本、堆栈或供应商原始响应作为唯一告警条件。

## 处理边界

API 供应商创建请求没有返回有效上游任务 ID 或同步产物时，平台将本次真实外呼记为一次失败：

1. 当前账号仍有任务级额外重试次数时，按系统配置等待后在同一账号重试。
2. 当前账号达到 `1 + videoSubmissionRetryCount` 次实际请求后，排除该账号并切换尚未尝试的账号。
3. 所有候选账号耗尽、没有合格账号或容量等待超时后，任务进入退款阶段并停止上游外呼。
4. 退款在后台幂等执行；退款失败按固定间隔重试，耗尽后只打印一次高优先级错误日志。

Adobe Direct 的既有轮询恢复不使用本契约的 API 提交事件。

## 稳定字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `event` | string | 本文定义的稳定事件标识 |
| `videoTaskId` | string | FluxMedia 视频任务 ID |
| `supplierId` | string | API 供应商 ID（当前使用不含凭据的 credential scope） |
| `supplierName` | string | 实际提交账号的安全名称快照 |
| `memberId` | string | 实际供应商账号 ID（适用时记录） |
| `model` | string | FluxMedia 真实视频模型 ID |
| `protocol` | string | 本契约固定为 `api` |
| `requestId` | string | 服务端生成的执行 request ID；不是客户端可覆盖的值 |
| `externalRequestId` | string | 客户端 `X-Request-Id` 的可选关联值，不作为服务端主标识 |
| `attemptNumber` | number | 当前任务全局实际外呼序号，从 1 开始 |
| `memberAttemptNumber` | number | 当前账号内的实际外呼序号，从 1 开始 |
| `configuredRetryCount` | number | 账号配置的额外重试次数快照，`0-10` |
| `maxAttemptsSnapshot` | number | 当前任务对该账号的总请求上限，恒为 `configuredRetryCount + 1` |
| `httpTimeoutSeconds` | number | 本次创建外呼固定的 HTTP 超时秒数，`1-300` |
| `baseRetryDelaySeconds` | number | 系统配置的同账号基础等待秒数，`0-300` |
| `upstreamRetryAfterSeconds` | number | 上游提示经解析和封顶后的等待秒数，`0-300` |
| `finalRetryDelaySeconds` | number | `max(baseRetryDelaySeconds, upstreamRetryAfterSeconds)` |
| `nextAttemptAt` | string | 已持久化的下一次尝试 ISO 时间 |
| `failureCode` | string | 低基数失败分类 |
| `failureReason` | string | 面向用户的安全失败原因 |
| `operationsReason` | string | 管理员可定位问题的安全失败说明 |
| `capacityWaitDeadlineAt` | string | 容量等待的固定截止 ISO 时间（适用时记录） |
| `refundAttemptCount` | number | 当前退款尝试次数，最多 3 |

字段缺失时省略，不得伪造空身份。供应商名称必须来自安全快照并保留在事件中，便于管理员按供应商聚合告警。

## 禁止记录

任何事件都不得包含 prompt、negative prompt、请求或响应正文、完整 URL、上游 task ID、API Key、Authorization、Cookie、签名、令牌、输入媒体地址、输出媒体地址、SQL、连接信息或堆栈。

## 事件标识

### `video_submission_attempt_failed`

- **级别：** `warn`
- **触发：** 一次真实 API 创建外呼失败并已写入尝试账本。
- **必要字段：** `videoTaskId`、`supplierId`、`supplierName`、`memberId`、`model`、`protocol`、`requestId`、`failureCode`、`failureReason`、`operationsReason`、`attemptNumber`、`memberAttemptNumber`、`configuredRetryCount`、`maxAttemptsSnapshot`、`httpTimeoutSeconds`。
- **告警：** 按 `supplierName`、`failureCode` 聚合；同一任务不因同一次失败重复告警。

### `video_submission_retry_scheduled`

- **级别：** `info`
- **触发：** 当前账号仍有重试额度，任务已持久化下一次执行时间。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`model`、`protocol`、`requestId`、`failureCode`、`attemptNumber`、`baseRetryDelaySeconds`、`finalRetryDelaySeconds`、`nextAttemptAt`；真实外呼后还包含账号内序号、重试快照和 HTTP 超时，上游给出合法提示时包含 `upstreamRetryAfterSeconds`。
- **告警：** 不单独呼叫，用于确认等待计划跨进程生效。

### `video_submission_supplier_switched`

- **级别：** `info`
- **触发：** 当前账号耗尽后选择下一个未尝试账号。
- **必要字段：** `videoTaskId`、目标 `supplierId`、`supplierName`、`memberId`、`model`、`protocol`、`requestId`、`failureCode`。
- **告警：** 按供应商和模型统计切号频率，不单独呼叫。

### `video_submission_capacity_wait_started`

- **级别：** `info`
- **触发：** 存在合格 API 账号但所有并发槽暂满，任务进入有界容量等待。
- **必要字段：** `videoTaskId`、`supplierName`、`model`、`protocol`、`requestId`、`capacityWaitDeadlineAt`。首次获租前还没有供应商身份时允许使用明确的未知供应商哨兵，不伪造账号 ID。
- **告警：** 可用于容量趋势看板；等待超时后由终局事件告警。

### `video_submission_recovery_exhausted`

- **级别：** `error`
- **触发：** 所有合格账号均已耗尽，或容量等待/账号选择无法继续，任务停止外呼并退款。
- **必要字段：** `videoTaskId`、最后一个 `supplierName`、`model`、`protocol`、`requestId`、`failureCode`。
- **告警：** 立即高优先级告警，按供应商和失败码聚合。

### `video_refund_attempt_failed`

- **级别：** `warn`
- **触发：** 一次退款尝试失败并已安排下一次固定间隔重试。
- **必要字段：** `videoTaskId`、`supplierName`、`model`、`protocol`、`requestId`、`failureCode`、`refundAttemptCount`。
- **告警：** 观察退款失败率，不把退款错误返回为用户生成失败原因。

### `video_refund_retry_exhausted`

- **级别：** `error`
- **触发：** 退款总尝试次数达到 3 次，停止自动退款。
- **必要字段：** `videoTaskId`、`supplierName`、`model`、`protocol`、`requestId`、`failureCode`、`refundAttemptCount`。
- **告警：** 立即最高优先级告警；同一任务只保留一条，后续扫描不得重复打印。

## 失败分类

提交账本和事件只允许以下稳定代码：

`submission_timeout`、`network_error`、`response_read_failed`、`response_parse_failed`、`missing_upstream_task_id`、`rate_limited`、`upstream_unavailable`、`authentication_failed`、`permission_denied`、`invalid_request`、`moderation_rejected`、`submission_conflict`、`capacity_wait_timeout`、`no_eligible_api_account`、`unknown_submission_failure`。

面向用户的任务和 API 查询只返回最后一次生成失败的安全原因；管理端全局使用记录展示每次失败的序号、供应商名称、失败码、失败原因、运营说明和失败时间。服务端 `requestId` 仅用于日志采集与全链路排查，不在使用记录页面展示。退款结果不覆盖生成失败原因。

## 推荐告警规则

```text
event == "video_submission_recovery_exhausted"
```

立即通知管理员，标题包含 `supplierName`、`failureCode` 和 `videoTaskId`。

```text
event == "video_refund_retry_exhausted"
```

立即通知财务/运营负责人；同一 `videoTaskId` 去重，直到人工确认退款事实。

```text
event == "video_submission_attempt_failed"
group by supplierName, failureCode
count >= 3 within 5 minutes
```

用于发现单个供应商或账号的系统性协议、网络或认证问题。

```text
event == "video_submission_capacity_wait_started"
count >= 10 within 5 minutes
```

用于发现容量配置或账号池拥塞；不要将容量等待本身视为供应商故障。

## 旧事件迁移

旧版人工核对事件不再产生，采集规则应迁移如下：

| 旧事件 | 新事件 | 说明 |
| --- | --- | --- |
| `video_submission_needs_attention` | `video_submission_attempt_failed` | 首次无有效响应按真实失败记录，不再建立人工窗口 |
| `video_submission_manual_recovered` | 无；成功时记录后续正常提交/轮询日志 | 不再填写或保存上游 task ID |
| `video_submission_manual_not_accepted` | `video_submission_recovery_exhausted` | 自动恢复耗尽后统一终结并退款 |
| `video_submission_reconciliation_expired` | `video_submission_recovery_exhausted` | 旧人工截止语义由自动恢复终局替代 |
| `video_submission_refund_succeeded` | 无；退款成功只保留财务审计事实 | 不覆盖用户生成失败原因 |
| `video_submission_refund_failed` | `video_refund_attempt_failed` | 退款失败进入固定重试 |
| `video_submission_supplier_switch_uncertain` | `video_submission_supplier_switched` | 切号由系统自动完成 |
| `video_submission_supplier_accounts_exhausted` | `video_submission_recovery_exhausted` | 统一终局事件名称 |
| `video_submission_recovery_failed` | `video_submission_recovery_exhausted` 或对应稳定失败事件 | 按实际失败分类迁移，不使用自由文本匹配 |

旧事件可保留为历史查询兼容标识，但从当前版本起不得新增；下个版本在旧事件查询为零后移除兼容映射。
