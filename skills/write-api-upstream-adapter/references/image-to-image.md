<!--
本文记录图生图、蒙版和多图编辑的 multipart 字段与媒体令牌适配模式，供主 Skill 在
处理 images.edit 与 images.edit.query 时按需读取。
-->

# 图生图适配参考

## 目录

- [操作和标准请求](#操作和标准请求)
- [单图或多图字段改名](#单图或多图字段改名)
- [蒙版与文本字段](#蒙版与文本字段)
- [业务 Header 与 Query](#业务-header-与-query)
- [同步响应](#同步响应)
- [异步图生图](#异步图生图)
- [无网络夹具](#无网络夹具)
- [图生图审查重点](#图生图审查重点)

## 操作和标准请求

| 操作 | Method | 内置路径 | Body |
| --- | --- | --- | --- |
| `images.edit` | POST | `/images/edits` | multipart |
| `images.edit.query` | GET | 无 | 禁止 |

`images.edit` 的文本字段与文生图大体相同，包括 `model`、`prompt`、`n`、
`response_format` 以及可选尺寸、质量、审核、输出格式、压缩、背景和流式字段。

multipart 文本值进入脚本时都是字符串，包括 `n`、`width`、`height`、布尔值和压缩值。
不要在上游未要求时擅自转为 number 或 boolean。

如果账号打开 `convertReferenceImagesToPublicUrl`，宿主会先把参考图转存到对象存储，
再以 JSON `image_urls` 数组发送绝对公网 HTTP(S) URL。该模式最多支持 10 张图，
不会携带 multipart 文件或蒙版；转存、签名或公网基址失败时请求会在外呼前失败关闭。
关闭或旧配置仍使用下面的 multipart 契约。

Seedream 5 的 `images.generate` 与 `images.edit` 共用创建接口时，可将下面的请求脚本
同时配置到两个操作。宿主在图生图开启转换开关后会完成多图转存和 `image_urls` 构造；
文生图则不带参考图字段。脚本会清理平台专用字段，并校验存在的公网参考图地址：

```js
const body = { ...request.body };
if (Object.hasOwn(body, "image_urls")) {
  if (
    !Array.isArray(body.image_urls) ||
    body.image_urls.length < 1 ||
    body.image_urls.length > 10
  ) {
    throw new Error("image_urls must contain 1-10 URLs");
  }
  for (const url of body.image_urls) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error("image_urls must be absolute HTTP(S) URLs");
    }
  }
}
if (Object.hasOwn(body, "image_url")) {
  if (
    typeof body.image_url !== "string" ||
    !/^https?:\/\//i.test(body.image_url)
  ) {
    throw new Error("image_url must be an absolute HTTP(S) URL");
  }
}
delete body.response_format;
delete body.stream;
delete body.partial_images;
delete body.quality;
delete body.moderation;
delete body.output_format;
delete body.output_compression;
delete body.background;
if (body.size === "auto") delete body.size;
return { body };
```

媒体字段：

| 字段 | 形状 | 说明 |
| --- | --- | --- |
| `image` | 单个令牌 | 单张输入图 |
| `image[]` | 令牌数组 | 多张输入图，保持顺序 |
| `mask` | 单个令牌，可选 | 蒙版 |

平台不会同时产生 `image` 和 `image[]`。输出顶层数组会由宿主重建为同名重复 multipart
字段。媒体不能放入嵌套对象或嵌套数组。

## 单图或多图字段改名

供应商用顶层重复字段 `source_images` 接收单图或多图：

```js
const body = { ...request.body };
const hasSingle = Object.hasOwn(body, "image");
const hasMultiple = Object.hasOwn(body, "image[]");
if (hasSingle && hasMultiple) {
  throw new Error("conflicting image fields");
}
if (
  (hasSingle || hasMultiple) &&
  Object.hasOwn(body, "source_images")
) {
  throw new Error("conflicting source image fields");
}
if (hasSingle) {
  body.source_images = [body.image];
  delete body.image;
} else if (hasMultiple) {
  body.source_images = body["image[]"];
  delete body["image[]"];
}
return { body };
```

每个令牌只出现在返回 Body 一次。不能同时保留源字段和目标字段。

## 蒙版与文本字段

供应商把 `mask` 改名为顶层 `edit_mask`，把 `prompt` 改名为 `instruction`：

```js
const body = { ...request.body };
if (body.prompt !== undefined) {
  body.instruction = body.prompt;
  delete body.prompt;
}
if (body.mask !== undefined) {
  if (body.edit_mask !== undefined) {
    throw new Error("conflicting mask fields");
  }
  body.edit_mask = body.mask;
  delete body.mask;
}
return { body };
```

如果供应商要求把文件嵌入 `input.images` 之类的对象，当前 multipart 契约无法安全支持。
报告宿主编码器改造需求，不要生成会失败或损坏文件的脚本。

## 业务 Header 与 Query

如果供应商要求固定业务版本：

```js
return {
  query: { ...request.query, api_version: "2026-08-01" },
  headers: { "X-Edit-Mode": "mask-aware" },
};
```

不需要修改 Header 时省略 `headers`。不能手写 `Content-Type` 或 multipart boundary，宿主
编码器会负责。

## 同步响应

图生图标准响应与文生图相同，允许一个或多个图片 URL/Base64。

供应商返回 URL：

```js
const outputs = Array.isArray(response.body.outputs)
  ? response.body.outputs
  : [];
return {
  status: "completed",
  outputs: outputs.map((item) => ({
    kind: "image",
    url: item.image_url,
  })),
};
```

供应商返回 Base64：

```js
const images = Array.isArray(response.body.images)
  ? response.body.images
  : [];
return {
  status: "completed",
  outputs: images.map((item) => ({
    kind: "image",
    base64: item.b64_json,
    mediaType: item.media_type || "image/png",
  })),
};
```

响应中的受保护 Base64 令牌也必须恰好移动一次。

## 异步图生图

路径示例：

| 操作 | 路径 |
| --- | --- |
| `images.edit` | `/v3/edit/jobs` |
| `images.edit.query` | `/v3/edit/jobs/{task_id}` |

生成响应脚本：

```js
if (response.statusCode === 429) {
  return {
    status: "failed",
    error: { category: "rate_limit", code: "edit_rate_limited" },
    retryable: true,
  };
}
return {
  status: "pending",
  taskId: String(response.body.job_id),
};
```

查询响应脚本：

```js
const body = response.body;
if (body.status === "failed") {
  return {
    status: "failed",
    error: { category: "upstream", code: "edit_job_failed" },
  };
}
if (body.status !== "succeeded") {
  return {
    status: "processing",
    progress:
      typeof body.percent === "number" ? body.percent : undefined,
    pollAfterSeconds: 5,
  };
}
return {
  status: "completed",
  outputs: body.images.map((item) => ({
    kind: "image",
    url: item.url,
  })),
};
```

`pollAfterSeconds` 可省略；默认即为 5 秒。上游返回的查询 URL 不参与配置。

异步图生图同样只在当前 Web 进程内轮询。进程重启不会恢复远端任务；调用方在结果未知
时重试可能产生孤儿任务、重复编辑和额外费用。当前平台图片请求没有统一供应商幂等
键，交付时必须记录该边界并建议监控 `api_upstream_image_task_orphan_risk`。

Seedream 5 的异步响应（创建 `202 + id + in_progress`，查询 `in_progress`、
`succeeded + data[].url` 或 `failed`）可直接使用以下两个响应脚本：

创建响应脚本（`images.generate` 与 `images.edit`）：

```js
const body = response.body;
if (response.statusCode < 200 || response.statusCode >= 300) {
  return {
    status: "failed",
    error: {
      category: response.statusCode === 429 ? "rate_limit" : "upstream",
      code: "seedream_submit_http_error",
    },
    retryable: response.statusCode === 429,
  };
}
if (!body || typeof body.id !== "string" || !body.id) {
  throw new Error("missing generation id");
}
return {
  status: "pending",
  taskId: body.id,
  pollAfterSeconds: 5,
};
```

查询响应脚本（`images.generate.query` 与 `images.edit.query`）：

```js
const body = response.body;
if (response.statusCode < 200 || response.statusCode >= 300) {
  return {
    status: "failed",
    error: {
      category: response.statusCode === 429 ? "rate_limit" : "upstream",
      code: "seedream_query_http_error",
    },
  };
}
if (body.status === "failed") {
  return {
    status: "failed",
    error: { category: "upstream", code: "seedream_generation_failed" },
  };
}
if (body.status === "succeeded") {
  const data = Array.isArray(body.data) ? body.data : [];
  if (data.length === 0) throw new Error("succeeded response has no data");
  return {
    status: "completed",
    outputs: data.map((item) => ({ kind: "image", url: item.url })),
  };
}
return {
  status: "processing",
  progress: typeof body.progress === "number" ? body.progress : undefined,
  pollAfterSeconds: 5,
};
```

## 无网络夹具

多图和 mask 请求输入：

```json
{
  "query": {},
  "body": {
    "model": "upstream-edit-model",
    "prompt": "synthetic edit instruction",
    "n": "1",
    "image[]": [
      "mock://media/source-1",
      "mock://media/source-2"
    ],
    "mask": "mock://media/mask-1",
    "response_format": "b64_json"
  }
}
```

预期请求输出必须包含三个不同媒体占位符且各出现一次。再增加以下负向夹具：

- 同时提供 `image` 与 `image[]`；
- 源字段和目标字段同时存在；
- 把媒体移入嵌套对象；
- 删除、复制或截断任一媒体值。

以上负向夹具均应失败关闭且不访问供应商。

## 图生图审查重点

- multipart 文本类型是否符合供应商要求；
- 单图、多图和 mask 是否覆盖完整；
- 顶层数组是否保持顺序；
- 是否避免嵌套媒体、复制媒体和覆盖冲突；
- `Content-Type` 与 boundary 是否完全交给宿主；
- 异步查询是否有固定 `{task_id}` 路径；
- 是否明确记录进程重启不可恢复、无统一幂等键和可能重复计费；
- 输出图片数量是否未被静默截断。
