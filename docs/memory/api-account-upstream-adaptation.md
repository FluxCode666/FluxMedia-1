<!--
本文记录 API 类型账号上游适配的模型身份、六操作版本、脚本隔离与恢复不变量。
-->

# API 账号上游适配

本文记录 API 类型账号在统一号池中的模型身份、不可变版本与脚本处理安全边界，供图片、
视频、管理端和后续迁移复用。管理员使用说明见
[API 上游适配器管理员手册](../api-upstream-adapter-admin.md)。

## 模型身份

- `supportedModelIds` 只保存平台真实模型 ID，是调度资格的唯一权威。
- 管理员可以按账号配置稀疏的 `modelId -> upstreamModelId` 映射；未配置的模型同名透传。
- 映射只在账号获租后、请求发往供应商前生效。调度、能力、计费、任务记录、幂等键与
  API 响应仍使用平台模型 ID。
- 同一平台模型在不同账号上可以映射到不同供应商 ID；多个平台模型可以映射到同一个
  供应商 ID。

## 六操作版本

每个 API 账号的非密钥适配版本固定保存六个供应商操作：

- `images.generate`
- `images.generate.query`
- `images.edit`
- `images.edit.query`
- `videos.generate`
- `videos.query`

每个操作独立保存相对路径、请求脚本和响应脚本。生成固定为 POST，查询固定为 GET；
查询路径必须包含一个 `{task_id}`。图片查询没有内置路径，异步图片必须显式配置对应
查询路径。任何上游 `poll_url` 或 `status_url` 都不能决定查询地址。

API Key 不进入历史版本。同凭据域密钥轮换使用当前密钥；运行中图片租约和视频任务固定
提交时的成员及适配版本。存在活动租约或非终态任务时，跨 origin 或认证域保存失败关闭。

## 请求与响应处理顺序

每条 API Images/Videos 请求固定执行以下步骤：

1. 以平台契约构造标准请求体。
2. 根据当前账号解析供应商模型 ID。
3. 在隔离 QuickJS 中执行当前操作的 JavaScript 请求脚本。
4. 校验部分请求信封、媒体令牌和资源边界。
5. 使用宿主保存的相对路径、固定 Method 与认证请求上游。
6. 空响应脚本走系统内置协议；非空响应脚本把供应商响应规范为标准任务状态。

请求脚本接收 `{ query, body? }`，返回可省略 `query`、`headers` 和 `body` 的部分信封。
省略某部分表示保留内置值；非空脚本仍必须返回对象。响应脚本接收 HTTP 状态码、四个
安全响应 Header 及 JSON 或有界文本，返回 `pending | processing | completed | failed`。

脚本上下文只含 `operation`、`stage`、`contentType`、`platformModelId`、
`upstreamModelId` 和查询时的 `taskId`。脚本不能读取或修改完整 URL、Method、凭据、
宿主已有 Header、用户身份或账号池分组。

## 隔离与失败边界

- 脚本源码不超过 32,768 个 UTF-16 代码单元，同步执行不超过 50 ms；普通 JSON
  输入输出不超过 2 MiB、深度不超过 16、节点不超过 10,000。
- VM 默认内存 32 MiB、栈 512 KiB；部署可分别调整为 16-128 MiB 和
  256-2,048 KiB。Worker 数按 Node 进程配置为 1-8，默认 1。
- QuickJS 不提供 Node 模块、进程、网络、文件、定时器、Promise、动态代码执行、时间
  或随机数能力。
- 图片 multipart 文件和视频输入图先替换为不可预测的宿主令牌，真实 Blob 或 data URL
  不进入 VM。每个令牌必须在输出中恰好出现一次，禁止删除、复制和伪造。
- multipart 媒体只允许成为顶层字段值或顶层数组元素；嵌套媒体会在 JSON 编码时损坏，
  因此发送前失败关闭。
- 语法错误在账号保存前拒绝。请求脚本失败时不得发出网络请求；响应脚本失败时不得
  换号重投生成。取得任务 ID 后固定原账号和版本，查询连续失败 3 次进入现有失败退款。
- `pollAfterSeconds` 仅用于非终态，范围为 1-300 秒且可省略；图片和视频默认均为 5 秒，
  并与安全解析的 `Retry-After` 取更长值。
- 运行时脚本失败写入 `api_upstream_script_failed`；Worker 饱和写入
  `api_upstream_script_runtime_saturated`，且不处罚供应商账号健康。日志不得包含脚本、
  正文、Prompt、媒体、凭据、完整 URL 或原始 task ID。

旧账号级请求脚本由后续适配版本迁移分别包装到三个生成操作；运行时不再保留旧字段
回退。配置保存、无网络脚本测试和运行诊断均通过 UOL operation 暴露，其中测试和诊断
仅允许人工管理员调用。
