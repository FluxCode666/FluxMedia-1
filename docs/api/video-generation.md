# FluxMedia 视频接口

## 创建

当前视频协议的规范创建地址是：

```text
POST /v1/videos/generations
POST /api/v1/videos/generations
```

请求继续使用平台现有的 `clientRequestId`/`client_request_id`、`model`、时长、比例、
分辨率、提示词和媒体输入字段。平台在任务持久化后返回 HTTP 202 与 `video.task`，使用
`GET /v1/videos/{taskId}`（或 `/api/v1/videos/{taskId}`）查询同一任务。

`POST /v1/videos` 和 `/api/v1/videos` 的创建语义已下线并返回 HTTP 410；它们不会创建
任务，也不会回退到 generations 地址。

## 兼容协议入口

除平台原生协议外，外部客户端还可以使用 FluxMedia API Key 按以下协议创建和查询视频
任务。它们都会归一为同一原生视频输入，共享计费、幂等、媒体暂存和调度规则：

- Gemini `predictLongRunning`：见 [gemini-video.md](gemini-video.md)；
- 火山方舟 Seedance 内容生成任务（`POST /api/v3/contents/generations/tasks`）：见
  [seedance-video.md](seedance-video.md)。

入站协议与下文的上游协议模式相互独立：客户端使用哪种协议提交，不决定平台向上游发送
哪种协议。

## 上游协议模式

管理员为每个 API 后端成员显式选择 `gemini`、`seedance` 或 `custom`。模式只决定该成员
发送给上游的请求格式，不由模型名称、成员名称或供应商名称推断。存量适配版本缺失模式
时按 `custom` 读取。

custom 模式保留原有行为：请求脚本输入是标准化 snake_case body、query、受保护媒体令牌
和脱敏 context；没有脚本时继续采用原有内置 `/videos/generations` 与
`/videos/{task_id}` 路径及解析器。

custom 成员还可选择参考图片输入格式：默认 `url` 会把首尾帧和参考图作为短期签名
HTTPS URL 发送；选择 `base64` 时，宿主会在脚本执行后恢复为对应 MIME 的
`data:<mime>;base64,...`，用于 Leonardo 等只接受内联图片的供应商。真实媒体不会进入
QuickJS；参考视频和音频始终使用签名 URL。

`seedance` 模式使用火山方舟内容生成任务协议，不读取 `videos.generate` 和
`videos.query` 的自定义路径：创建请求发送到成员 `baseUrl` 下的
`/api/v3/contents/generations/tasks`，查询发送到同一路径加固定任务 ID。请求体使用
`model`、`content`、`ratio`、`duration`、`resolution`、`watermark` 和
`generate_audio`。平台模型支持音频时，`generate_audio` 总是按任务快照显式发送（包括
`false`），避免方舟按默认值 `true` 生成音频；其他模型只在需要生成音频时发送该字段。
`content` 首项为提示词，其后每个媒体都显式声明 `role`：首尾帧和参考图为 `image_url`
（`first_frame`、`last_frame`、`reference_image`），参考视频为 `video_url`
（`reference_video`），参考音频为 `audio_url`（`reference_audio`）。成功结果读取
`content[].video_url.url`；方舟任务状态 `expired` 与 `failed`、`cancelled` 一样按终态
失败处理并退款。如果 `baseUrl` 已包含 `/api/v3`，平台不会重复追加该路径。

方舟会解析提示词中的 `--dur`、`--rs`、`--rt`、`--seed`、`--cf`、`--wm`、`--frames` 等
参数（含全称形式）并覆盖请求体取值。为保证实际生成规格与计费一致，原生接口对
`seedance2`、`seedance2-fast` 模型在扣费前拒绝包含这些参数的提示词（HTTP 400）；其他
模型的任务如被路由到 `seedance` 模式成员且提示词包含这些参数，任务会在提交上游前以
`invalid_request` 失败并退款。请改用请求体中的时长、比例和分辨率字段。

三种模式共享有限提交重试、重试预算耗尽后的账号切换、幂等扣费和任务恢复规则。一旦
上游返回有效任务身份，成员、模式和适配版本即固定，后续查询不会换号重提。
