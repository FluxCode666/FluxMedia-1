# 火山方舟 Seedance 视频兼容接口

FluxMedia 提供火山方舟内容生成任务协议（Seedance 视频生成）的兼容网关。客户端把方舟
Base URL 替换为 FluxMedia 站点地址、把方舟 API Key 替换为 FluxMedia API Key，即可沿用
方舟的请求与响应格式。它不是火山引擎官方主机；上游真实账号、上游任务 ID 和凭据不会
出现在响应中。任务与 FluxMedia 原生视频接口共享计费、幂等、媒体暂存、调度和回调规则。

## 创建任务

```bash
curl https://your-fluxmedia.example/api/v3/contents/generations/tasks \
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: seedance-request-001" \
  -d '{
    "model": "doubao-seedance-2-0-260128",
    "content": [
      {"type": "text", "text": "A paper boat drifting on a quiet lake at dawn"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,<BASE64>"}, "role": "first_frame"}
    ],
    "ratio": "16:9",
    "resolution": "720p",
    "duration": 5
  }'
```

响应只包含任务 ID：

```json
{ "id": "video_0123456789abcdef0123456789abcdef01234567" }
```

## 查询任务

```bash
curl https://your-fluxmedia.example/api/v3/contents/generations/tasks/video_0123456789abcdef0123456789abcdef01234567 \
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"
```

```json
{
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "model": "doubao-seedance-2-0-260128",
  "status": "succeeded",
  "content": { "video_url": "https://your-fluxmedia.example/api/storage/generations/..." },
  "error": null,
  "created_at": 1790000000,
  "updated_at": 1790000090,
  "duration": 5,
  "ratio": "16:9",
  "resolution": "720p",
  "generate_audio": true,
  "service_tier": "default"
}
```

`status` 取值为 `queued`、`running`、`succeeded`、`failed`。平台不会产生 `cancelled`
或 `expired`。成功时返回 `content.video_url`，该地址由平台重新托管；失败时 `error`
为 `{"code": "VideoGenerationFailed", "message": "..."}`。任务只能由创建它的 API Key
查询，经其他入口（FluxMedia 原生接口、Gemini 兼容接口）创建的任务在本接口返回 404。

不提供任务列表、取消和删除接口。

## 模型

| 方舟模型 ID | 平台模型 |
| --- | --- |
| `doubao-seedance-2-0-260128`、`dreamina-seedance-2-0-260128` | `seedance2` |
| `doubao-seedance-2-0-fast-260128`、`dreamina-seedance-2-0-fast-260128` | `seedance2-fast` |

也可以直接传入平台模型 ID。响应中的 `model` 原样返回请求时的名称。可用时长、比例和
分辨率以平台模型能力为准，例如 `seedance2-fast` 不支持 `1080p`。

## content

- `text`：必填且只能出现一次。
- `image_url`：`role` 可为 `first_frame`、`last_frame` 或 `reference_image`。只有一张图片
  且没有视频、音频时可以省略 `role`，此时按首帧处理；其他情况必须显式声明。
  `last_frame` 必须同时提供 `first_frame`。首尾帧不能与参考图、参考视频、参考音频混用。
- `video_url`：`role` 省略或为 `reference_video`。最多 3 个，单条 4-10 秒，合计不超过
  15 秒。
- `audio_url`：`role` 省略或为 `reference_audio`。最多 1 个，不超过 15 秒，并且必须同时
  提供至少一张参考图或一个参考视频。

媒体地址支持两种形式：

- Base64 data URL，例如 `data:image/png;base64,...`；
- 公网 HTTP(S) 地址，路径必须以 `.png`、`.jpg`、`.jpeg`、`.webp`、`.mp4`、`.mov`、
  `.mp3` 或 `.wav` 结尾。

平台会在扣费前下载并按实际内容校验类型。图片和视频不超过 200 MB，音频不超过 15 MB。
方舟素材 ID（`asset://`）和 `draft_task` 不受支持。

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `resolution` | `720p` | 取值以模型能力为准。 |
| `ratio` | `16:9` | 方舟默认值 `adaptive` 不受支持，必须使用明确比例。 |
| `duration` | `5` | 整数秒，`-1` 不受支持。 |
| `generate_audio` | 模型支持音频时为 `true` | 是否生成同步音频。 |
| `callback_url` | 无 | 任务成功或失败后回调，见下文。 |
| `safety_identifier` | 无 | 最长 64 字符，平台接受但不使用。 |

以下参数平台无法如实兑现，只接受括号中的默认值，其他取值返回
`InvalidParameter.UnsupportedParameter`：`watermark`（`false`）、`seed`（`-1`）、
`camera_fixed`（`false`）、`return_last_frame`（`false`）、`draft`（`false`）、
`service_tier`（`default`）、`output_format`（`mp4`）、`omni_reference_task_type`
（`auto`）、`priority`（`0`）。`frames`、`execution_expires_after`、`tools` 与其他未知
字段一律拒绝。

文本末尾的方舟弱校验参数（`--rs`/`--resolution`、`--rt`/`--ratio`、`--dur`/`--duration`、
`--seed`、`--cf`/`--camerafixed`、`--wm`/`--watermark`）会被解析、按上述规则校验并从
提示词中移除。这些参数必须位于文本末尾，并且不能与请求体中的同名参数取值冲突；
`--frames` 不受支持。

## 幂等

通过 `Idempotency-Key` 或 `X-Request-ID` header 提供幂等键，两者同时提供时必须一致，
最长 128 字符。相同键和相同请求体的重试返回原任务 ID；相同键但请求体不同时返回
HTTP 409。两个 header 都未提供时，每次请求都会创建新任务。

## 回调

提供 `callback_url` 时，平台在任务成功或失败后以 POST 投递一次与查询响应结构相同的
JSON，并附带 `Idempotency-Key: video-callback:<投递 ID>` header。非 2xx 响应会按指数
退避重试。排队和运行中的状态变化不会回调。

## 错误

错误响应为 `{"error": {"code": "...", "message": "...", "type": "..."}}`，HTTP 状态码与
平台一致。参数错误使用 `MissingParameter`、`InvalidParameter` 或
`InvalidParameter.UnsupportedParameter`；鉴权失败为 `AuthenticationError`；任务不存在
为 `NotFound`；服务端错误为 `InternalServiceError`。积分不足、并发超限、幂等冲突等
平台特有错误保留 FluxMedia 错误码。
