<!--
本文记录文生图生成与查询操作的标准字段、同步和异步供应商适配模式，供主 Skill 在
处理 images.generate 与 images.generate.query 时按需读取。
-->

# 文生图适配参考

## 目录

- [操作和标准请求](#操作和标准请求)
- [模型映射示例](#模型映射示例)
- [同步 JSON 供应商](#同步-json-供应商)
- [Base64 图片响应](#base64-图片响应)
- [异步供应商](#异步供应商)
- [无网络夹具](#无网络夹具)
- [文生图审查重点](#文生图审查重点)

## 操作和标准请求

| 操作 | Method | 内置路径 | Body |
| --- | --- | --- | --- |
| `images.generate` | POST | `/images/generations` | JSON |
| `images.generate.query` | GET | 无 | 禁止 |

`images.generate` 当前标准 Body 常见字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 已映射的供应商模型 ID |
| `prompt` | string | 不透明文本，完整保留平台 nonce |
| `n` | number | 生成数量 |
| `size` | string | 例如 `1024x1024` |
| `width`、`height` | number，可选 | 已解析尺寸 |
| `quality` | string，可选 | 质量枚举 |
| `moderation` | string，可选 | 审核选项 |
| `output_format` | string，可选 | 输出格式 |
| `output_compression` | number，可选 | 压缩参数 |
| `background` | string，可选 | 背景选项 |
| `stream` | boolean，可选 | 内置流式开关 |
| `partial_images` | number，可选 | 流式中间图数量 |
| `response_format` | string | 当前内置值通常为 `b64_json` |

不要假设可选字段必然存在。只有供应商文档明确单位或枚举时才转换。

## 模型映射示例

平台使用 `flux-pro`，供应商要求 `black-forest-labs/flux-pro`：

```json
{
  "modelMappings": [
    {
      "modelId": "flux-pro",
      "upstreamModelId": "black-forest-labs/flux-pro"
    }
  ]
}
```

请求脚本看到的 `request.body.model` 已是供应商 ID，不要再次覆盖。

## 同步 JSON 供应商

假设供应商要求：

```json
{
  "model": "black-forest-labs/flux-pro",
  "input": { "text": "...", "width": 1024, "height": 1024 },
  "count": 2
}
```

请求脚本：

```js
const source = request.body;
const body = {
  model: source.model,
  input: {
    text: source.prompt,
    ...(source.width !== undefined ? { width: source.width } : {}),
    ...(source.height !== undefined ? { height: source.height } : {}),
  },
  count: source.n,
};
return { body };
```

若供应商返回：

```json
{
  "result": {
    "images": [
      { "url": "https://cdn.example.com/1.png" },
      { "url": "https://cdn.example.com/2.png" }
    ]
  }
}
```

响应脚本：

```js
const result = response.body.result;
const images = Array.isArray(result.images) ? result.images : [];
return {
  status: "completed",
  outputs: images.map((image) => ({ kind: "image", url: image.url })),
};
```

## Base64 图片响应

供应商返回 `images[].base64_data` 时，把受保护值移动到标准图片输出：

```js
const images = Array.isArray(response.body.images)
  ? response.body.images
  : [];
return {
  status: "completed",
  outputs: images.map((image) => ({
    kind: "image",
    base64: image.base64_data,
    mediaType: image.media_type || "image/png",
  })),
};
```

不要解码或复制 Base64。只有供应商明确输出格式恒定时才写默认 `mediaType`。

## 异步供应商

配置示例：

| 操作 | 路径 |
| --- | --- |
| `images.generate` | `/v2/image/jobs` |
| `images.generate.query` | `/v2/image/jobs/{task_id}` |

生成响应：

```json
{
  "job_id": "job-123",
  "state": "queued"
}
```

生成响应脚本：

```js
if (response.statusCode >= 400) {
  return {
    status: "failed",
    error: { category: "upstream", code: "image_submit_rejected" },
    retryable: response.statusCode === 429,
  };
}
return {
  status: "pending",
  taskId: String(response.body.job_id),
};
```

省略 `pollAfterSeconds` 时默认 5 秒。不要读取响应中的 `status_url`。

查询请求如果无需新增 Query 或 Header，脚本保持为空。必须设置脚本时，GET 只能返回
`query` 或业务 `headers`：

```js
return {
  query: { ...request.query, include: ["status", "output"] },
};
```

查询响应脚本：

```js
const body = response.body;
if (body.state === "failed") {
  return {
    status: "failed",
    error: { category: "upstream", code: "image_job_failed" },
  };
}
if (body.state !== "completed") {
  return {
    status: "processing",
    progress:
      typeof body.progress === "number" ? body.progress : undefined,
  };
}
const images = Array.isArray(body.output?.images)
  ? body.output.images
  : [];
return {
  status: "completed",
  outputs: images.map((image) => ({ kind: "image", url: image.url })),
};
```

查询非终态不必返回 `taskId`；宿主沿用 `context.taskId`。不要把错误任务 ID 返回给平台。

## 无网络夹具

请求输入：

```json
{
  "query": {},
  "body": {
    "model": "black-forest-labs/flux-pro",
    "prompt": "synthetic prompt",
    "n": 1,
    "size": "1024x1024",
    "width": 1024,
    "height": 1024,
    "response_format": "b64_json"
  }
}
```

异步查询响应输入：

```json
{
  "statusCode": 200,
  "headers": { "content-type": "application/json" },
  "body": { "state": "processing", "progress": 42 }
}
```

再提供 `state=completed` 的 URL 或 Base64 夹具，验证至少一项标准图片输出。

## 文生图审查重点

- `prompt` 是否完整保留，不修剪、不重新拼接；
- `n`、尺寸、质量和格式是否仅按已确认语义转换；
- 多图输出是否保持顺序和数量；
- Base64 是否只移动一次；
- 异步图片是否配置固定查询路径；
- 查询失败是否不触发生成重投。
