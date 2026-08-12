<!--
本文定义视频提交结果不确定、人工核对、退款和跨供应商账号恢复的稳定日志标识、
字段及告警规则，供管理员配置本地或集中式日志采集。
-->

# 视频提交异常恢复日志标识

本文是 FluxMedia 视频提交异常恢复日志的运维契约。日志采集应优先匹配 `event` 和 `errorCategory`，不要把自由文本 `msg`、错误堆栈或供应商原始响应作为唯一告警条件。

## 适用范围

当视频请求已经发向 API 供应商，但平台无法确认上游是否创建任务时，内部任务进入提交不确定恢复流程。公开 API 在人工窗口、退款、切换账号和继续轮询期间统一返回 `in_progress`，不会暴露内部 `needs_attention` 状态。

日志分为三类：

- **需要管理员及时查看：** 首次提交不确定和人工窗口即将或已经到期。
- **自动恢复进度：** 退款、供应商账号切换、重新提交和恢复查询。
- **需要立即处置：** 退款失败、恢复流程异常或所有可用账号耗尽。

## 稳定字段

以下字段名称属于稳定采集契约。事件不适用某个可选字段时可以省略或写入 `null`，不得伪造占位值。`event`、`videoTaskId`、`supplierName` 和 `errorCategory` 在本文所有事件中均为必填字段。

| 字段 | 类型 | 含义 | 告警用途 |
| --- | --- | --- | --- |
| `event` | string | 本文定义的稳定事件标识 | 首要过滤条件 |
| `videoTaskId` | string | FluxMedia 视频任务 ID | 关联用户任务全链路 |
| `supplierId` | string 或 null | 供应商实体 ID；没有独立供应商实体时可使用成员归属 ID | 供应商聚合 |
| `supplierName` | string | 提交时安全快照中的非空供应商名称 | 人工识别与告警标题 |
| `memberId` | string 或 null | 实际供应商账号或后端成员 ID | 定位具体账号 |
| `protocol` | string | 例如 `api`、`adobe_direct` | 区分恢复方式 |
| `model` | string | FluxMedia 真实模型 ID | 模型维度聚合 |
| `attemptNumber` | number | 当前任务第几次供应商提交尝试，从 1 开始 | 判断升级程度 |
| `attemptedAccountCount` | number | 已尝试的不同账号数 | 判断账号耗尽风险 |
| `enteredAt` | string 或 null | 本轮提交不确定状态进入时间，ISO 8601 | 计算滞留时间 |
| `deadlineAt` | string 或 null | 首次人工处理截止时间，ISO 8601 | 即将逾期告警 |
| `errorCategory` | string | 本文定义的稳定错误分类 | 次要过滤和聚合条件 |
| `requestId` | string 或 null | 当前请求或恢复执行的关联 ID | 日志链路检索 |
| `outcome` | string 或 null | 例如 `accepted`、`not_accepted`、`switched`、`failed` | 操作结果筛选 |
| `durationMs` | number 或 null | 当前步骤耗时 | 性能和卡顿排查 |

管理员人工操作还应写入独立审计记录，至少包含操作者 ID、`videoTaskId`、处理结论和时间。管理员审计不替代本文结构化运行日志。

## 禁止记录的内容

以下信息不得出现在本文事件的结构化字段、消息或错误上下文中：

- prompt、negative prompt 或其他用户创作内容；
- 完整请求或响应正文、上游原始载荷和请求快照；
- API Key、Authorization、Cookie、签名、令牌或用户凭据；
- 输入媒体 URL、输出媒体 URL、签名 URL 或对象存储私有地址；
- 未经脱敏的供应商错误响应、脚本内容、SQL 或数据库连接信息。

## 事件标识

### `video_submission_needs_attention`

- **级别：** `warn`
- **触发：** 首个供应商账号的提交结果无法确认，人工处理窗口刚建立时立即输出一次。
- **目的：** 在默认 60 秒窗口内提醒管理员查询供应商并填写上游 task ID。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`model`、`attemptNumber`、`enteredAt`、`deadlineAt`、`errorCategory`、`requestId`。
- **建议告警：** 单条即时通知；同一 `videoTaskId` 去重，截止时间前保持可见。

### `video_submission_manual_recovered`

- **级别：** `info`
- **触发：** 管理员在窗口内填写上游 task ID，任务成功恢复上游查询。
- **目的：** 关闭对应人工告警并建立人工操作追踪。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`protocol`、`model`、`outcome=accepted`、`requestId`。
- **建议告警：** 不单独呼叫；用于自动关闭 `video_submission_needs_attention` 告警。
- **安全要求：** 不记录上游 task ID 原文；如运维必须关联，应记录不可逆摘要或仅保存在受权限保护的任务数据中。

### `video_submission_manual_not_accepted`

- **级别：** `warn`
- **触发：** 管理员确认供应商没有接受原提交，任务进入退款收敛。
- **目的：** 记录人工否定结论并观察退款结果。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`model`、`outcome=not_accepted`、`errorCategory`、`requestId`。
- **建议告警：** 默认不呼叫；退款未在预期时间内完成时升级。

### `video_submission_reconciliation_expired`

- **级别：** `warn`
- **触发：** 首次人工处理截止时间到达，且管理员没有取得处理权。
- **目的：** 标记系统接管恢复流程并开始退款。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`attemptNumber`、`enteredAt`、`deadlineAt`、`errorCategory=reconciliation_deadline_expired`、`requestId`。
- **建议告警：** 用于关闭首次人工告警或将其标记为自动接管；不必再次呼叫管理员。

### `video_submission_refund_succeeded`

- **级别：** `info`
- **触发：** 首次人工窗口到期或人工确认未接受后，用户退款幂等收敛成功。
- **目的：** 证明后续供应商尝试不会再次扣费。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`attemptNumber`、`outcome`、`requestId`。
- **建议告警：** 不呼叫；作为自动切换账号的前置审计信号。

### `video_submission_refund_failed`

- **级别：** `error`
- **触发：** 用户退款失败，自动恢复因此不能安全提交到下一个账号。
- **目的：** 防止出现未退款却由平台继续承担成本，或退款状态无法确认。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`attemptNumber`、`errorCategory`、`requestId`。
- **建议告警：** 立即高优先级呼叫；按 `videoTaskId` 聚合，直到出现退款成功或人工处置审计。

### `video_submission_supplier_switch_started`

- **级别：** `info`
- **触发：** 退款已经完成，系统选中一个本任务尚未尝试的供应商账号并准备重新提交。
- **目的：** 追踪账号选择和尝试顺序。
- **必要字段：** `videoTaskId`、目标账号的 `supplierId`、`supplierName` 和 `memberId`、`attemptNumber`、`attemptedAccountCount`、`model`、`requestId`。
- **建议告警：** 不呼叫；用于诊断账号切换频率和供应商质量。

### `video_submission_supplier_switch_accepted`

- **级别：** `info`
- **触发：** 新账号明确返回上游 task ID 或同步完成结果，原 FluxMedia 任务恢复正常处理。
- **目的：** 证明自动恢复成功，并关闭相关异常告警。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`attemptNumber`、`attemptedAccountCount`、`model`、`outcome=accepted`、`durationMs`、`requestId`。
- **建议告警：** 不呼叫；用于自动关闭恢复中告警和统计恢复成功率。

### `video_submission_supplier_switch_uncertain`

- **级别：** `warn`
- **触发：** 退款后的新账号再次产生提交不确定结果。
- **目的：** 记录无需人工等待的后续切换，并观察连续供应商异常。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`attemptNumber`、`attemptedAccountCount`、`model`、`errorCategory`、`requestId`。
- **建议告警：** 单条通常不呼叫；同一模型或供应商在 5 分钟内达到阈值时聚合告警。

### `video_submission_supplier_accounts_exhausted`

- **级别：** `error`
- **触发：** 所有当前可用且合格的供应商账号均已尝试一次，任务仍无法确认提交结果。
- **目的：** 标记自动恢复终局；任务保持退款并进入 `failed`。
- **必要字段：** `videoTaskId`、最后一个 `supplierName`、`memberId`、`attemptNumber`、`attemptedAccountCount`、`model`、`errorCategory=supplier_accounts_exhausted`、`requestId`。
- **建议告警：** 立即最高优先级呼叫；按模型和供应商组聚合，并创建人工排障事件。

### `video_submission_recovery_failed`

- **级别：** `error`
- **触发：** 退款之外的恢复协调、持久化、账号选择、状态竞争或重新提交发生非预期错误，且没有安全收敛为下一步计划。
- **目的：** 捕获不属于正常供应商结果的系统异常。
- **必要字段：** `videoTaskId`、`supplierName`、`memberId`、`attemptNumber`、`errorCategory`、`requestId`。
- **建议告警：** 立即高优先级呼叫；相同 `errorCategory` 连续出现时升级为系统性故障。

## 稳定错误分类

错误分类应使用低基数、可聚合的 `errorCategory`，详细异常仅作为脱敏消息或错误对象记录。

| 分类 | 含义 | 常见关联事件 |
| --- | --- | --- |
| `submission_timeout` | 提交请求超过配置或传输时限，无法确认上游结果 | `video_submission_needs_attention` |
| `submission_connection_lost` | 外呼后连接中断，无法确认供应商是否收到完整请求 | `video_submission_needs_attention` |
| `submission_response_unreadable` | 成功响应无法读取或不是有效协议数据 | `video_submission_needs_attention` |
| `submission_task_id_missing` | 响应表示已接收或成功，但缺少可恢复 task ID | `video_submission_needs_attention` |
| `submission_status_unknown` | 供应商返回无法归类的提交状态 | `video_submission_needs_attention` |
| `reconciliation_deadline_expired` | 首次人工处理窗口到期 | `video_submission_reconciliation_expired` |
| `manual_reconciliation_conflict` | 管理员操作与自动处理或其他管理员操作发生状态竞争 | `video_submission_recovery_failed` |
| `manual_reconciliation_invalid_task_id` | 管理员填写的上游 task ID 无法通过协议校验或查询 | `video_submission_recovery_failed` |
| `refund_failed` | 幂等退款未能安全收敛 | `video_submission_refund_failed` |
| `supplier_selection_unavailable` | 当前没有可选账号，但尚不能证明所有账号已正常完成一次尝试 | `video_submission_recovery_failed` |
| `supplier_switch_submission_uncertain` | 切换后的账号再次无法确认提交结果 | `video_submission_supplier_switch_uncertain` |
| `supplier_accounts_exhausted` | 所有合格账号均已尝试且仍不确定 | `video_submission_supplier_accounts_exhausted` |
| `recovery_state_persist_failed` | 恢复截止、尝试记录或阶段推进无法持久化 | `video_submission_recovery_failed` |
| `recovery_unexpected_error` | 未归入其他稳定分类的恢复系统错误 | `video_submission_recovery_failed` |

## 推荐告警规则

以下示例使用逻辑条件表达，可映射到 Axiom、Loki、Elasticsearch、Datadog 或其他采集平台。

### 首次人工处理提醒

```text
event == "video_submission_needs_attention"
```

- 立即发送管理员通知。
- 告警标题建议包含 `supplierName`、`model` 和 `videoTaskId`。
- 同一 `videoTaskId` 在 `deadlineAt` 前去重。
- 收到 `video_submission_manual_recovered`、`video_submission_manual_not_accepted` 或 `video_submission_reconciliation_expired` 后关闭。

### 退款失败

```text
event == "video_submission_refund_failed"
```

- 立即高优先级呼叫。
- 在出现 `video_submission_refund_succeeded` 或管理员审计确认前保持打开。
- 如果 5 分钟内仍未收敛，升级通知负责人。

### 供应商连续不确定

```text
event == "video_submission_supplier_switch_uncertain"
group by supplierName, model
count >= 3 within 5 minutes
```

- 聚合提醒某供应商或模型出现系统性不确定结果。
- 阈值应结合实际流量调整，但不得通过匹配自由文本替代 `event`。

### 账号耗尽

```text
event == "video_submission_supplier_accounts_exhausted"
```

- 立即最高优先级呼叫并创建人工排障事件。
- 同时检查相同模型在所有供应商上的发生量，判断是协议故障、网络故障还是供应商整体不可用。

### 恢复系统故障

```text
event == "video_submission_recovery_failed"
```

- 单条立即高优先级呼叫。
- 按 `errorCategory` 聚合；`recovery_state_persist_failed` 和 `manual_reconciliation_conflict` 应分别统计。

## 自由文本错误信息

日志实现可以保留以下稳定中文消息作为人工阅读辅助，但告警规则仍应匹配 `event` 与 `errorCategory`：

| 错误信息 | 对应分类 |
| --- | --- |
| `视频上游提交结果不确定，等待管理员核对` | 具体提交不确定分类 |
| `视频提交人工核对窗口已到期` | `reconciliation_deadline_expired` |
| `视频提交人工核对发生状态冲突` | `manual_reconciliation_conflict` |
| `视频提交退款未能安全完成` | `refund_failed` |
| `视频任务没有可用的未尝试供应商账号` | `supplier_selection_unavailable` |
| `视频任务所有可用供应商账号均已尝试` | `supplier_accounts_exhausted` |
| `视频提交异常恢复状态持久化失败` | `recovery_state_persist_failed` |
| `视频提交异常恢复发生未预期错误` | `recovery_unexpected_error` |

## 运维核对流程

1. 收到 `video_submission_needs_attention` 后，在管理员视频异常任务页面按 `videoTaskId` 定位任务。
2. 在供应商后台按请求时间、供应商名称、成员账号和模型查询是否已创建任务。
3. 找到上游 task ID 时，在截止时间内提交“已接受”；API 供应商不需要填写 `pollUrl`。
4. 确认没有创建任务时可提交“未接受”，系统进入幂等退款；不确定时不做否定结论，让自动截止流程接管。
5. 收到账号耗尽或恢复系统故障告警时，检查相同供应商、模型和错误分类的聚合情况，并保留 `videoTaskId` 与 `requestId` 供开发排查。

## 文档变更规则

- 新增事件时必须补充级别、触发条件、必要字段、错误分类和建议告警。
- 修改或移除 `event`、字段名或 `errorCategory` 属于日志采集协议变更，必须提供旧到新映射和明确的采集规则迁移窗口。
- 调整自由文本消息不属于协议变更，但不得删除其对应的稳定事件和错误分类。
- 自动化测试应断言关键事件标识、禁止字段缺失和供应商名称字段存在，避免重构静默破坏告警。
