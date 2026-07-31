# API 账号上游请求适配

本文记录 API 类型账号在统一号池中的模型身份与请求处理安全边界，供图片、视频、管理端
和后续迁移复用。

## 模型身份

- `supportedModelIds` 只保存平台真实模型 ID，是调度资格的唯一权威。
- 管理员可以按账号配置稀疏的 `modelId -> upstreamModelId` 映射；未配置的模型同名透传。
- 映射只在账号获租后、请求发往供应商前生效。调度、能力、计费、任务记录、幂等键与
  API 响应仍使用平台模型 ID。
- 同一平台模型在不同账号上可以映射到不同供应商 ID；多个平台模型可以映射到同一个
  供应商 ID。

## 请求处理顺序

每条 API Images/Videos 请求固定执行以下步骤：

1. 以平台契约构造标准请求体。
2. 根据当前账号解析供应商模型 ID。
3. 在隔离 QuickJS 中执行当前账号的 JavaScript 请求处理脚本。
4. 校验脚本输出、媒体令牌和序列化体积。
5. 使用宿主保存的 URL、Method、Header 与 API Key 请求上游。

脚本只接收请求体，以及 `operation`、`contentType`、`platformModelId`、
`upstreamModelId` 四个脱敏上下文字段。脚本不能读取或修改 URL、Method、Header、
API Key、用户身份或账号池分组。

## 隔离与失败边界

- 脚本源码不超过 32,768 个 UTF-16 代码单元，同步执行不超过 50 ms；VM
  内存上限 32 MiB、栈上限 512 KiB，输入输出序列化上限 2 MiB。
- QuickJS 不提供 Node 模块、进程、网络、文件、定时器、Promise、动态代码执行、时间
  或随机数能力。
- 图片 multipart 文件和视频输入图先替换为不可预测的宿主令牌，真实 Blob 或 data URL
  不进入 VM。每个令牌必须在输出中恰好出现一次，禁止删除、复制和伪造。
- multipart 媒体只允许成为顶层字段值或顶层数组元素；嵌套媒体会在 JSON 编码时损坏，
  因此发送前失败关闭。
- 语法错误在账号保存前拒绝。执行超时、异常或输出非法时不得发出网络请求；视频提交
  将其归类为尚未被上游接受的可切换账号故障。

迁移 `0075_api_account_upstream_adaptation` 将合法的历史 `copy|move` 规则转换为等价
JavaScript，并删除旧参数映射列、模板表和对应 UOL 操作。
