<!--
本文记录文生视频、首尾帧和多参考图视频的请求与异步任务适配模式，供主 Skill 在处理
videos.generate 与 videos.query 时按需读取。
-->

# 生视频适配参考

## 目录

- [操作和标准请求](#操作和标准请求)
- [Seedance 模型映射](#seedance-模型映射)
- [基础字段改名](#基础字段改名)
- [首尾帧和参考图结构](#首尾帧和参考图结构)
- [client_request_id](#client_request_id)
- [同步视频响应](#同步视频响应)
- [异步视频任务](#异步视频任务)
- [无网络夹具](#无网络夹具)
- [生视频审查重点](#生视频审查重点)

## 操作和标准请求

| 操作 | Method | 内置路径 | Body |
| --- | --- | --- | --- |
| `videos.generate` | POST | `/videos/generations` | JSON |
| `videos.query` | GET | `/videos/{task_id}` | 禁止 |

`videos.generate` 标准 Body：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `client_request_id` | string | 平台提交幂等标识，必须保留或等价移动 |
| `model` | string | 已映射的供应商模型 ID |
| `prompt` | string | 提示词 |
| `duration` | number | 时长；公开 API 的 `duration_seconds` 已规范到此字段 |
| `aspect_ratio` | string | 比例，例如 `16:9` |
| `resolution` | string | 分辨率，例如 `1080p` |
| `generate_audio` | boolean | 是否生成声音 |
| `negative_prompt` | string，可选 | 负向提示词 |
| `first_frame` | 媒体令牌，可选 | 首帧 |
| `last_frame` | 媒体令牌，可选 | 尾帧 |
| `reference_images` | 媒体令牌数组，可选 | 参考图 |

首尾帧模式和参考图模式对所有模型互斥。Seedance 家族支持首尾帧和多参考图；模型配置
中的参考图上限默认 10，管理员可调整，适配器不设置硬上限。脚本不得截断数组。

## Seedance 模型映射

平台与某供应商模型名称不同：

```json
{
  "supportedModelIds": ["seedance2", "seedance2-fast"],
  "modelMappings": [
    {
      "modelId": "seedance2",
      "upstreamModelId": "seedande-2.0"
    },
    {
      "modelId": "seedance2-fast",
      "upstreamModelId": "seedande-2.0-fast"
    }
  ]
}
```

注意供应商示例中的 `seedande` 拼写必须来自文档或 HAR，不要自行纠正。脚本读取的
`request.body.model` 已是映射目标。

## 基础字段改名

供应商要求 `duration_seconds`、`ratio`、`audio.enabled`：

```js
const source = request.body;
const body = { ...source };
if (source.duration !== undefined) {
  body.duration_seconds = source.duration;
  delete body.duration;
}
if (source.aspect_ratio !== undefined) {
  body.ratio = source.aspect_ratio;
  delete body.aspect_ratio;
}
if (source.generate_audio !== undefined) {
  body.audio = { enabled: source.generate_audio };
  delete body.generate_audio;
}
return { body };
```

不要根据字段名称猜时长单位。若供应商使用毫秒，必须先取得明确证据再乘以 1,000。

## 首尾帧和参考图结构

视频 JSON 允许把媒体令牌移动到嵌套字段。以下示例把两种互斥模式规范为供应商
`inputs`，并在冲突时失败关闭：

```js
const body = { ...request.body };
const hasFrames =
  body.first_frame !== undefined || body.last_frame !== undefined;
const hasReferences =
  Array.isArray(body.reference_images) && body.reference_images.length > 0;
if (hasFrames && hasReferences) {
  throw new Error("frames and references are mutually exclusive");
}
if (hasFrames) {
  body.inputs = {
    ...(body.first_frame !== undefined
      ? { first_frame: body.first_frame }
      : {}),
    ...(body.last_frame !== undefined
      ? { last_frame: body.last_frame }
      : {}),
  };
  delete body.first_frame;
  delete body.last_frame;
} else if (hasReferences) {
  body.inputs = { reference_images: body.reference_images };
  delete body.reference_images;
}
return { body };
```

令牌只能移动，不能同时留在原字段和 `inputs` 中。不要为了满足供应商较低上限而切片
`reference_images`；应调整模型能力或移除该账号对模型的支持。

## client_request_id

供应商使用 `idempotency_key`：

```js
const body = { ...request.body };
if (body.client_request_id !== undefined) {
  body.idempotency_key = body.client_request_id;
  delete body.client_request_id;
}
return { body };
```

供应商完全不支持幂等键时，保留字段可能导致拒绝，删除字段可能增加超时后的重复任务
风险。先明确报告并取得用户确认，不能静默删除。

## 同步视频响应

供应商同步返回视频 URL：

```js
return {
  status: "completed",
  outputs: [
    { kind: "video", url: response.body.result.video_url },
  ],
};
```

视频标准输出不支持 Base64。供应商只返回 Base64 时，报告需要宿主或供应商 URL 产物
支持，不要把它伪装为图片或 data URL。

## 异步视频任务

路径示例：

| 操作 | 路径 |
| --- | --- |
| `videos.generate` | `/v1/video/jobs` |
| `videos.query` | `/v1/video/jobs/{task_id}` |

生成响应脚本：

```js
if (response.statusCode === 429) {
  return {
    status: "failed",
    error: { category: "rate_limit", code: "video_rate_limited" },
    retryable: true,
  };
}
return {
  status: "processing",
  taskId: String(response.body.job_id),
  progress: 0,
};
```

省略 `pollAfterSeconds` 时默认 5 秒。生成脚本取得 `taskId` 后，平台固定原账号和配置
版本，不再向其他账号重新提交。

查询请求通常留空。供应商额外要求版本 Query 时：

```js
return {
  query: { ...request.query, api_version: "2026-08-01" },
};
```

任务 ID 已由宿主放入路径，不要读取响应 `poll_url`。查询响应脚本：

```js
const body = response.body;
if (body.state === "failed") {
  return {
    status: "failed",
    error: { category: "upstream", code: "video_job_failed" },
  };
}
if (body.state !== "completed") {
  return {
    status: "processing",
    progress:
      typeof body.progress === "number" ? body.progress : undefined,
  };
}
return {
  status: "completed",
  outputs: [{ kind: "video", url: body.output.video_url }],
};
```

查询响应可省略 `taskId`，系统使用 `context.taskId`。查询阶段的配置、请求或响应脚本、
响应读取连续失败 3 次后进入现有失败和退款；平台繁忙与传输失败不计入该阈值。不得把
`retryable: true` 用于重投生成。

## 无网络夹具

参考图请求输入：

```json
{
  "query": {},
  "body": {
    "client_request_id": "video-fixture-001",
    "model": "seedande-2.0",
    "prompt": "synthetic video prompt",
    "duration": 8,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "generate_audio": true,
    "reference_images": [
      "mock://media/reference-1",
      "mock://media/reference-2"
    ]
  }
}
```

首尾帧请求输入：

```json
{
  "query": {},
  "body": {
    "client_request_id": "video-fixture-002",
    "model": "seedande-2.0",
    "prompt": "synthetic transition",
    "duration": 8,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "generate_audio": false,
    "first_frame": "mock://media/first-frame",
    "last_frame": "mock://media/last-frame"
  }
}
```

异步查询响应输入：

```json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json",
    "retry-after": "5"
  },
  "body": { "state": "processing", "progress": 55 }
}
```

分别验证参考图和首尾帧令牌各出现一次，并增加两种模式同时存在的失败夹具。

## 生视频审查重点

- 模型映射是否与供应商真实拼写一致；
- 时长、比例、分辨率是否是独立参数而非复合模型 ID；
- `client_request_id` 是否保留等价幂等语义；
- 首尾帧与参考图是否互斥；
- 多参考图是否未截断且每项令牌恰好一次；
- 声音和负向提示词是否仅在存在时转换；
- 异步任务是否固定 `{task_id}` 路径并忽略响应查询 URL；
- 完成结果是否是视频 URL，而非 Base64。
