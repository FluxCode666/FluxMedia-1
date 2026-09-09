# Secure Skill Banana（Gemini Image）上游适配

本文是给 FluxMedia 管理页使用的完整 API 上游适配配置。供应商只开放图片异步
任务，因此不启用视频能力；图片查询由 FluxMedia 宿主按固定任务 ID 轮询，脚本本身
不执行网络请求。

## 已确认事实与待确认项

已确认：

- `baseUrl`：`https://token.secure-skill.com`
- 提交：`POST /v1/jobs`
- 查询：`GET /v1/jobs/{job_id}`
- 认证：`Authorization: Bearer <API Key>`
- 提交响应至少包含 `id`；查询终态使用 `status=completed|failed`，完成图片 URL 在
  `url` 字段，失败信息在 `error` 字段。
- 查询间隔：供应商示例要求每 3 秒查询一次；脚本对非终态返回
  `pollAfterSeconds: 3`，若响应带 `Retry-After`，宿主会取更长值。
- 请求使用 `messages` 与 `generationConfig.imageConfig.aspectRatio/imageSize`；参考图
  使用 `messages[].content[]` 中的 `image_url`。

待确认：

- `/v1/models` 对当前 API Key 实际返回的模型和每个模型的 2K/4K 能力；Lite 按供应商
  文档只配置 1K，Flash 的 4K 不在文档中保证。
- 查询非终态的完整枚举和 `progress` 是否总是返回。脚本会把除已知失败/完成外的有
  `status` 状态视为处理中，并在缺失 `status` 时失败关闭。

## 管理页基础配置

按以下值填写 API 成员：

| 字段 | 值 |
| --- | --- |
| Base URL | `https://token.secure-skill.com` |
| 认证模式 | `Bearer` |
| Use stream | `false` |
| 图生图参考图转公网 URL | `true`（必须） |
| 视频协议 | `custom`（该账号不声明视频模型） |

账号支持模型只选择平台真实模型 ID，并添加以下稀疏映射。若 `/v1/models` 尚未确认某个
ID 可用，先不要把它加入账号：

| 平台模型 ID | 上游模型 ID | 建议分辨率能力 |
| --- | --- | --- |
| `nano-banana-pro` | `gemini-3.0-pro-image` | `1k`、`2k`、`4k` |
| `nano-banana-2` | `gemini-3.1-flash-image` | `1k`、`2k`（4K 以 `/v1/models` 为准） |
| `nano-banana` | `gemini-3.1-flash-lite-image` | `1k` |

`credentialScope` 不需要手填，保存成员时由宿主根据 Base URL 和认证模式生成：
`https://token.secure-skill.com|bearer`。

## 六个操作路径

| 操作 | Method（宿主固定） | Path | 请求脚本 | 响应脚本 |
| --- | --- | --- | --- | --- |
| `images.generate` | POST | `/v1/jobs` | 使用下方“文生图提交” | 使用下方“提交响应” |
| `images.generate.query` | GET | `/v1/jobs/{task_id}` | 留空 | 使用下方“查询响应” |
| `images.edit` | POST | `/v1/jobs` | 使用下方“图生图提交” | 使用下方“提交响应” |
| `images.edit.query` | GET | `/v1/jobs/{task_id}` | 留空 | 使用下方“查询响应” |
| `videos.generate` | POST | 留空（内置路径） | 留空 | 留空 |
| `videos.query` | GET | 留空（内置路径） | 留空 | 留空 |

视频操作必须保持留空；不要把该账号加入任何视频模型。查询路径中的 `{task_id}` 由
宿主替换，脚本不能读取或改写查询 URL。

## 请求脚本

以下内容是函数体，直接粘贴到管理页脚本编辑器；不要再包一层
`function transform(...)`。

### `images.generate` 请求脚本

平台标准尺寸会转换为供应商要求的分辨率档位：最长边不超过 1536 为 `1K`，不超过
2560 为 `2K`，其余为 `4K`。FluxMedia 会把尺寸规整到 16px 步长，例如 `16:9` 可能
变成 `1248x704`，所以脚本对已确认比例使用不超过 2% 的规整误差；明显无法表示的
自定义比例仍会在外呼前失败关闭，避免静默改变构图。`size=auto` 时省略
`imageConfig`，交给上游默认值。

```js
const source =
  request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body
    : {};

function readDimension(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function readSize(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) return undefined;
  const width = readDimension(match[1]);
  const height = readDimension(match[2]);
  return width && height ? { width, height } : undefined;
}

function readAspectRatio(width, height) {
  const supported = [
    [1, 1, "1:1"],
    [16, 9, "16:9"],
    [9, 16, "9:16"],
    [2, 3, "2:3"],
    [3, 2, "3:2"],
    [4, 3, "4:3"],
    [3, 4, "3:4"],
    [21, 9, "21:9"],
    [9, 21, "9:21"],
    [4, 5, "4:5"],
    [5, 4, "5:4"],
  ];
  const actual = width / height;
  let best;
  let bestError = Number.POSITIVE_INFINITY;
  for (const [ratioWidth, ratioHeight, label] of supported) {
    const expected = ratioWidth / ratioHeight;
    const error = Math.abs(actual - expected) / expected;
    if (error < bestError) {
      best = label;
      bestError = error;
    }
  }
  return bestError <= 0.02 ? best : undefined;
}

function readImageConfig(value) {
  let width = readDimension(value.width);
  let height = readDimension(value.height);
  if (!width || !height) {
    const parsedSize = readSize(value.size);
    width = parsedSize?.width;
    height = parsedSize?.height;
  }
  if (!width || !height) return undefined;

  const aspectRatio = readAspectRatio(width, height);
  if (!aspectRatio) {
    throw new Error("secure-skill 上游不支持该图片比例");
  }

  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge <= 1536
    ? "1K"
    : longestEdge <= 2560
      ? "2K"
      : "4K";
  return { aspectRatio, imageSize };
}

const imageConfig = readImageConfig(source);
return {
  body: {
    model: source.model,
    messages: [{ role: "user", content: source.prompt }],
    ...(imageConfig ? { generationConfig: { imageConfig } } : {}),
    stream: false,
  },
};
```

### `images.edit` 请求脚本

该脚本依赖上面的“图生图参考图转公网 URL”开关。宿主会先把参考图转存为公网 URL，
并以 `image_urls` 数组放入 JSON；脚本按原顺序转换为供应商的 `image_url` 内容项。
蒙版在该模式下由宿主阻止，不会发送到上游。

```js
const source =
  request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body
    : {};
const imageUrls = Array.isArray(source.image_urls) ? source.image_urls : [];
if (imageUrls.length === 0) {
  throw new Error("secure-skill 图生图至少需要一张参考图");
}

function readDimension(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function readSize(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) return undefined;
  const width = readDimension(match[1]);
  const height = readDimension(match[2]);
  return width && height ? { width, height } : undefined;
}

function readAspectRatio(width, height) {
  const supported = [
    [1, 1, "1:1"],
    [16, 9, "16:9"],
    [9, 16, "9:16"],
    [2, 3, "2:3"],
    [3, 2, "3:2"],
    [4, 3, "4:3"],
    [3, 4, "3:4"],
    [21, 9, "21:9"],
    [9, 21, "9:21"],
    [4, 5, "4:5"],
    [5, 4, "5:4"],
  ];
  const actual = width / height;
  let best;
  let bestError = Number.POSITIVE_INFINITY;
  for (const [ratioWidth, ratioHeight, label] of supported) {
    const expected = ratioWidth / ratioHeight;
    const error = Math.abs(actual - expected) / expected;
    if (error < bestError) {
      best = label;
      bestError = error;
    }
  }
  return bestError <= 0.02 ? best : undefined;
}

function readImageConfig(value) {
  let width = readDimension(value.width);
  let height = readDimension(value.height);
  if (!width || !height) {
    const parsedSize = readSize(value.size);
    width = parsedSize?.width;
    height = parsedSize?.height;
  }
  if (!width || !height) return undefined;

  const aspectRatio = readAspectRatio(width, height);
  if (!aspectRatio) {
    throw new Error("secure-skill 上游不支持该图片比例");
  }

  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge <= 1536
    ? "1K"
    : longestEdge <= 2560
      ? "2K"
      : "4K";
  return { aspectRatio, imageSize };
}

const imageConfig = readImageConfig(source);
const content = [
  { type: "text", text: source.prompt },
  ...imageUrls.map((url) => ({
    type: "image_url",
    image_url: { url },
  })),
];

return {
  body: {
    model: source.model,
    messages: [{ role: "user", content }],
    ...(imageConfig ? { generationConfig: { imageConfig } } : {}),
    stream: false,
  },
};
```

## 响应脚本

### `images.generate` 响应脚本（提交）

只有明确的 429 提交拒绝才标记 `retryable=true`，允许账号池在确认没有任务 ID 时换一
个成员；5xx 和已返回任务 ID 的情况不会触发重新提交，避免重复扣费。

```js
const body =
  response.body && typeof response.body === "object" && !Array.isArray(response.body)
    ? response.body
    : {};

function text(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function categoryForStatus(statusCode) {
  if (statusCode === 401) return "authentication";
  if (statusCode === 403) return "permission";
  if (statusCode === 404) return "not_found";
  if (statusCode === 408 || statusCode === 504) return "timeout";
  if (statusCode === 400 || statusCode === 409 || statusCode === 422) {
    return "invalid_request";
  }
  if (statusCode === 429) return "rate_limit";
  if (statusCode >= 500) return "upstream";
  return "unknown";
}

function failed(category, code, retryable) {
  return {
    status: "failed",
    error: { category, code },
    ...(retryable ? { retryable: true } : {}),
  };
}

if (response.statusCode >= 400) {
  return failed(
    categoryForStatus(response.statusCode),
    "image_job_submit_rejected",
    response.statusCode === 429
  );
}

const state = text(body.status).toLowerCase();
if (state === "failed" || state === "cancelled" || state === "canceled") {
  return failed("upstream", "image_job_failed", false);
}
if (state === "completed") {
  const url = text(body.url);
  if (!url) return failed("upstream", "image_result_missing", false);
  return { status: "completed", outputs: [{ kind: "image", url }] };
}

const taskId = text(body.id);
if (!taskId) return failed("upstream", "image_job_id_missing", false);
return { status: "pending", taskId, pollAfterSeconds: 3 };
```

### `images.generate.query` 和 `images.edit.query` 响应脚本（查询）

查询阶段不返回 `retryable`，也不返回新的任务 ID；宿主自动沿用原始
`context.taskId`。成功结果只读取文档定义的 `url`。

```js
const body =
  response.body && typeof response.body === "object" && !Array.isArray(response.body)
    ? response.body
    : {};

function text(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function categoryForStatus(statusCode) {
  if (statusCode === 401) return "authentication";
  if (statusCode === 403) return "permission";
  if (statusCode === 404) return "not_found";
  if (statusCode === 408 || statusCode === 504) return "timeout";
  if (statusCode === 400 || statusCode === 409 || statusCode === 422) {
    return "invalid_request";
  }
  if (statusCode === 429) return "rate_limit";
  if (statusCode >= 500) return "upstream";
  return "unknown";
}

function failed(category, code) {
  return { status: "failed", error: { category, code } };
}

if (response.statusCode >= 400) {
  return failed(
    categoryForStatus(response.statusCode),
    "image_job_query_rejected"
  );
}

const state = text(body.status).toLowerCase();
if (state === "failed" || state === "cancelled" || state === "canceled") {
  return failed("upstream", "image_job_failed");
}
if (state === "completed") {
  const url = text(body.url);
  if (!url) return failed("upstream", "image_result_missing");
  return { status: "completed", outputs: [{ kind: "image", url }] };
}
if (!state) return failed("upstream", "image_job_status_missing");

const progressValue =
  typeof body.progress === "number"
    ? body.progress
    : typeof body.progress === "string" && body.progress.trim()
      ? Number(body.progress)
      : undefined;
const result = { status: "processing", pollAfterSeconds: 3 };
if (
  typeof progressValue === "number" &&
  Number.isFinite(progressValue) &&
  progressValue >= 0 &&
  progressValue <= 100
) {
  result.progress = progressValue;
}
return result;
```

### 图生图响应脚本的具体粘贴位置

图生图和文生图共用同一个上游任务协议，因此响应脚本源码完全相同，不需要再写一套
不同逻辑。管理页请按下表填写：

| 管理页字段 | 应粘贴内容 |
| --- | --- |
| `images.edit.responseScript` | 复制上方“`images.generate` 响应脚本（提交）”的完整代码 |
| `images.edit.query.responseScript` | 复制上方“`images.generate.query` 和 `images.edit.query` 响应脚本（查询）”的完整代码 |
| `images.edit.query.requestScript` | 留空；GET 查询不需要请求转换 |

也就是说，图生图的提交响应同样读取返回的 `id`，查询响应同样读取
`status`/`url`/`progress`。只有请求脚本不同：图生图会把 `image_urls` 转成
`messages[].content[]` 中的 `image_url` 项。

## 无网络测试夹具

在管理页对应操作的测试器中逐项运行以下夹具。所有 URL 均为合成地址，不会访问网络。

### 文生图提交

输入：

```json
{
  "query": {},
  "body": {
    "model": "gemini-3.1-flash-image",
    "prompt": "synthetic prompt",
    "size": "2048x1152",
    "width": 2048,
    "height": 1152,
    "response_format": "b64_json"
  }
}
```

预期请求正文：

```json
{
  "model": "gemini-3.1-flash-image",
  "messages": [{ "role": "user", "content": "synthetic prompt" }],
  "generationConfig": {
    "imageConfig": { "aspectRatio": "16:9", "imageSize": "2K" }
  },
  "stream": false
}
```

### 图生图提交

输入：

```json
{
  "query": {},
  "body": {
    "model": "gemini-3.0-pro-image",
    "prompt": "keep the product color",
    "size": "1024x1024",
    "image_urls": ["https://media.example.test/reference.png"]
  }
}
```

预期请求正文中的 `messages[0].content`：

```json
[
  { "type": "text", "text": "keep the product color" },
  {
    "type": "image_url",
    "image_url": { "url": "https://media.example.test/reference.png" }
  }
]
```

### 提交响应

输入：

```json
{
  "statusCode": 200,
  "headers": { "content-type": "application/json" },
  "body": { "id": "job-synthetic-123" }
}
```

预期：

```json
{ "status": "pending", "taskId": "job-synthetic-123", "pollAfterSeconds": 3 }
```

### 查询处理中

输入：

```json
{
  "statusCode": 200,
  "headers": { "content-type": "application/json", "retry-after": "2" },
  "body": { "status": "processing", "progress": 42 }
}
```

预期：

```json
{ "status": "processing", "progress": 42, "pollAfterSeconds": 3 }
```

### 查询完成

输入：

```json
{
  "statusCode": 200,
  "headers": { "content-type": "application/json" },
  "body": {
    "status": "completed",
    "url": "https://cdn.example.test/generated.png"
  }
}
```

预期：

```json
{
  "status": "completed",
  "outputs": [{ "kind": "image", "url": "https://cdn.example.test/generated.png" }]
}
```

### 查询失败和提交限流

查询失败输入 `{"status":"failed","error":{"code":"provider_error"}}`，预期：

```json
{ "status": "failed", "error": { "category": "upstream", "code": "image_job_failed" } }
```

提交响应使用 `statusCode=429` 时，预期错误码为
`image_job_submit_rejected`、分类为 `rate_limit` 且 `retryable=true`。查询阶段即使是
429 也不应返回 `retryable`。

## 已验证项与上线风险

- 路径均为同源安全相对路径；图片查询路径恰好包含一个 `{task_id}`。
- 请求脚本只返回 JSON Body，不读密钥、不改认证 Header、不发起网络请求。
- 参考图只在公网 URL JSON 模式发送，顺序保持不变；首尾帧/参考图互斥由宿主继续执行。
- 图片异步任务只在当前 Web 进程内轮询。进程崩溃或容器重启不会恢复远端任务，也不会
  自动重提；发布/重启前应确认没有活跃图片生成，并监控
  `api_upstream_image_task_orphan_risk`。
- 供应商未在文档中承诺统一幂等键；结果未知时重复调用可能重复扣费。脚本不会伪造或
  删除幂等语义。
- 尚未访问真实上游，也未验证 API Key 所属分组的 `/v1/models` 返回；发布前必须在管理
  页无网络测试器通过上述夹具，并用低风险 Key 做一次真实测活。

## 与供应商“失败后重新提交”说明的边界

供应商文档建议查询到 `failed` 后重新提交新任务。FluxMedia 的图片适配契约禁止在任务
已经被接受、或查询阶段失败时自动重新提交：此时无法证明原任务没有继续计费，重提会造成
重复生成和额外费用。因此上面的查询脚本只返回标准 `failed`，不设置 `retryable`，也不
把供应商原始 `error` 正文写入用户错误或日志；管理员可依据供应商控制台错误人工决定
是否重新发起一次新的用户请求。提交阶段只有 HTTP 429 且尚未取得任务 ID 时才标记
`retryable=true`。
