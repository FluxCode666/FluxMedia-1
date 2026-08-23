# Gemini 视频兼容接口

FluxMedia 提供 Gemini Developer API `predictLongRunning` 的兼容网关。它使用 FluxMedia
API Key 和成员级上游配置，不是 Google 官方主机；客户端不需要也不能提交 Google API
Key。上游真实账号、Operation name 和凭据不会出现在响应中。

## 创建任务

```bash
curl https://your-fluxmedia.example/v1beta/models/veo-3.1-generate-preview:predictLongRunning \
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: video-request-001" \
  -d '{
    "instances": [{
      "prompt": "A hero walking through a neon city at sunset"
    }],
    "parameters": {
      "aspectRatio": "16:9",
      "resolution": "1080p",
      "durationSeconds": "8"
    }
  }'
```

响应为平台生成的不透明 Operation：

```json
{
  "name": "models/veo-3.1-generate-preview/operations/opaque-operation-id",
  "done": false
}
```

使用完整 `name` 查询：

```bash
curl https://your-fluxmedia.example/v1beta/models/veo-3.1-generate-preview/operations/opaque-operation-id \
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"
```

处理中返回 `done: false`。成功时返回 `done: true`，视频地址位于
`response.generateVideoResponse.generatedSamples[].video.uri`，该地址由平台重新托管。
失败时返回 `done: true` 与脱敏的 Google `Status` 风格 `error`。

`instances` 只接受一个实例。当前支持 `prompt`、`image`、`lastFrame`、最多三张
`referenceImages`，以及 `parameters.aspectRatio`、`resolution`、`durationSeconds`。
其中 `durationSeconds` 遵循 Gemini REST 的 `int64` JSON 表示，使用字符串 `"4"`、
`"6"` 或 `"8"`。
不接受 body 中的 `model`、输入视频、`negativePrompt`、`personGeneration`、`seed` 或关闭音频字段；未知字段会在
扣费和调度前拒绝。首帧/尾帧与参考图互斥。

## 与现有视频协议的关系

现有 FluxMedia 视频协议的规范创建地址是 `POST /v1/videos/generations`，查询仍使用
`GET /v1/videos/{taskId}`。`POST /v1/videos` 已下线。两种公共协议进入同一个
`video.generate` UOL 操作，共享计费、回调、有限提交重试和接受后固定账号的恢复规则。

管理员在 API 后端成员上显式选择 `gemini`、`seedance` 或 `custom`。该模式只决定发送给
上游的请求格式，不由模型名称推断。历史成员缺少模式时按 `custom` 处理；custom 成员
的请求脚本继续接收现有标准化 snake_case body、受保护媒体令牌和脱敏 context。

Gemini 方法不可用或账号没有权限时，发布前真实冒烟测试必须阻断发布；平台不会自动改用
`generateContent`、Seedance 或其他协议。
