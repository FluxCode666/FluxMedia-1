<!--
本文面向统一账号池管理员，说明 API 类型供应商账号的六操作上游适配配置、
JavaScript 契约、安全边界、无网络测试与日志监控方式。
-->

# API 上游适配器管理员手册

API 类型供应商账号可把 FluxMedia 的文生图、图生图和生视频标准请求适配到不同
供应商协议。适配器不是任意 HTTP 代理：管理员固定 URL、认证和模型映射，JavaScript
只处理有界请求数据或响应数据。

脚本留空时使用系统内置协议。只有供应商字段、状态或结果结构与内置协议不兼容时，
才填写脚本。

## 六个供应商操作

每个操作独立保存相对路径、请求脚本和响应脚本。HTTP Method 由系统固定，管理员和
脚本均不能修改。

| 媒体 | 操作 ID | Method | 空路径的内置值 | 正文类型 |
| --- | --- | --- | --- | --- |
| 文生图生成 | `images.generate` | `POST` | `/images/generations` | JSON |
| 文生图查询 | `images.generate.query` | `GET` | 无，异步时必须填写 | 无 Body |
| 图生图生成 | `images.edit` | `POST` | `/images/edits` | multipart |
| 图生图查询 | `images.edit.query` | `GET` | 无，异步时必须填写 | 无 Body |
| 生视频生成 | `videos.generate` | `POST` | `/videos/generations` | JSON |
| 生视频查询 | `videos.query` | `GET` | `/videos/{task_id}` | 无 Body |

图片供应商同步返回结果时可以不配置图片查询路径。一旦文生图或图生图生成响应返回
`pending` 或 `processing`，对应查询路径必须存在，否则按账号配置错误失败。图片异步
任务在现有图片管线内部轮询，不增加公开图片异步 API。

### 异步图片跨重启边界

异步文生图和图生图只在接收任务的当前 Web 进程中轮询。进程正常运行时，平台会固定
原账号和适配配置版本完成查询；容器重启、进程崩溃或强制终止后，平台不会恢复该远端
任务，也不会自动再次提交生成请求。

当前标准图片请求没有向供应商转发统一幂等键。调用方在结果未知时自行重试，可能产生
远端孤儿任务、重复生成和额外供应商费用。上线异步图片账号前，管理员必须确认供应商
自身的幂等能力和费用处理方式；本版本不能承诺跨重启 exactly-once。视频使用持久任务
恢复，不受此图片边界影响。

## 推荐配置顺序

1. 在账号的“支持模型”中只选择平台真实模型 ID，例如 `seedance2`。
2. 只为名称不同的模型添加稀疏映射，例如 `seedance2 -> seedande-2.0`。
3. 配置 `baseUrl`、共享认证模式和账号密钥。
4. 按文生图、图生图、生视频三个区块填写六操作路径。
5. 先保留脚本为空，用内置协议验证；仅为不兼容部分增加脚本。
6. 使用管理页无网络测试器测试请求和响应脚本，再保存完整配置版本。

运行中任务会固定提交时的账号和适配配置版本。管理员保存新版本只影响新任务；密钥
在相同凭据域内可轮换。若仍有有效租约或非终态任务，修改 `baseUrl` origin、认证模式
或认证 Header 名称会跨越凭据域，系统将拒绝保存。

## URL 与认证

### Base URL 和相对路径

`baseUrl` 支持 HTTP、HTTPS、私网、局域网和 Docker 内部地址，但不能包含用户信息、
Query 或 Fragment。操作路径必须：

- 以 `/` 开头且不能以 `//` 开头；
- 不包含反斜杠、Query、Fragment、控制字符、`.` 或 `..` 路径段；
- 生成路径不能包含 `{task_id}`；
- 查询路径必须恰好包含一个 `{task_id}`。

查询时仅由宿主把固定任务 ID编码到 `{task_id}`。上游响应中的 `poll_url`、
`status_url` 或其他动态查询地址一律不可信，也不会改变管理员配置的查询地址。

### 认证模式

六个操作共享同一认证模式，密钥只保存在账号当前凭据中，不进入适配历史版本。

| 模式 | 宿主最终写入的 Header |
| --- | --- |
| Bearer | `Authorization: Bearer <apiKey>` |
| Raw Authorization | `Authorization: <apiKey>` |
| 自定义 Header | `<headerName>: <apiKey>` |
| 无认证 | 不写认证 Header |

脚本看不到 API Key，也不能覆盖认证 Header。密钥不得放入路径或 Query。

### 内置视频协议模式

管理员在成员表单中显式选择视频协议，模式不会根据模型名称推断：

- `custom`：沿用本手册前述 `videos.generate`/`videos.query` 脚本和无脚本内置路径。
- `gemini`：使用 Gemini `v1beta/models/{model}:predictLongRunning` 和 Operation 查询，
  忽略视频六操作路径与脚本。
- `seedance`：使用火山方舟 `POST /api/v3/contents/generations/tasks` 及固定任务查询，
  忽略视频六操作路径与脚本。成员 `baseUrl` 可填写根地址，也可填写已经包含 `/api/v3`
  的地址；模型、内容、比例、时长、分辨率和音频字段由平台适配器生成。

Gemini 和 Seedance 模式仍会经过同一套提交尝试账本、有限同账号重试和耗尽后切换账号；
一旦上游返回有效任务身份，成员与适配版本固定，后续查询不会换号重提。

## 模型映射

调度、能力、计费、任务记录和公开 API 始终使用平台真实模型 ID。模型映射只在账号
获租后的出站最后一跳生效：

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

未配置项同名透传。`context.platformModelId` 是平台 ID，
`context.upstreamModelId` 和请求 Body 中的 `model` 已是映射后的供应商 ID；脚本不能
把平台 ID写回 Body。

## JavaScript 执行方式

编辑器中的内容是同步函数体。运行时提供可修改的 `request`、`response` 别名和只读
`context`，不需要再声明外层 `function transform(...)`。

可以声明普通函数、箭头函数、局部常量和标准同步 JavaScript 对象：

```js
function readObject(value) {
  return value && typeof value === "object" ? value : {};
}
const rename = (value) => ({ ...value, ratio: value.aspect_ratio });
const body = rename(readObject(request.body));
delete body.aspect_ratio;
return { body };
```

不能使用：

- `import`、`export`、`require` 或第三方库；
- `async`、`await`、`Promise`；
- `fetch`、XHR、WebSocket、网络或文件访问；
- `setTimeout`、`setInterval` 或其他计时器；
- `process`、宿主环境、时间、随机数；
- `eval`、`Function` 或其他动态代码执行。

## 请求脚本契约

### 可读取值

请求脚本读取：

```ts
type RequestInput = {
  query: Record<string, string | number | boolean | Array<string | number | boolean>>;
  body?: unknown;
};

type Context = {
  operation:
    | "images.generate"
    | "images.generate.query"
    | "images.edit"
    | "images.edit.query"
    | "videos.generate"
    | "videos.query";
  stage: "request";
  contentType: "application/json" | "multipart/form-data";
  platformModelId: string;
  upstreamModelId: string;
  taskId?: string;
};
```

查询操作通过 `context.taskId` 读取固定任务 ID，且没有请求 Body。脚本看不到账号、
用户、密钥、完整 URL 或宿主已有 Header。

### 返回请求信封

非空请求脚本必须返回普通对象：

```ts
type RequestEnvelope = {
  query?: Record<
    string,
    string | number | boolean | Array<string | number | boolean> | null
  >;
  headers?: Record<string, string>;
  body?: unknown;
};
```

`query`、`headers` 和 `body` 均可省略。省略某部分表示保留系统内置值；不需要修改
Headers 时直接省略 `headers`，不必原样返回：

```js
const body = { ...request.body, ratio: request.body.aspect_ratio };
delete body.aspect_ratio;
return { body };
```

整个非空脚本仍必须 `return` 请求信封。`return {};` 表示不修改任何部分；只有编辑器
完全留空时才不启动 QuickJS，并完整使用系统内置请求构造。

Query 合并规则：新值覆盖同名内置值，数组按顺序编码为重复参数，`null` 删除内置键。

```js
return {
  query: {
    ...request.query,
    expand: ["output", "usage"],
    legacy: null,
  },
};
```

查询操作固定为 GET，返回 `body` 会失败。业务 Header 示例：

```js
return {
  headers: { "X-Client-Mode": "async" },
};
```

脚本不能写入 `Authorization`、`Cookie`、`Host`、`Content-Type`、`Content-Length`、
逐跳 Header、代理 Header、`Forwarded`、`Origin`、`Referer`、`sec-*`、
`x-forwarded-*`、`x-fluxmedia-*` 或当前自定义认证 Header。

### 三种生成 Body

字段均可能因公开请求和账号设置而省略，脚本必须先检查再转换。

| 操作 | 当前平台标准字段 |
| --- | --- |
| `images.generate` | `model`、`prompt`、`n`、`size`、可选 `width`、`height`、`quality`、`moderation`、`output_format`、`output_compression`、`background`、`stream`、`partial_images`、`response_format` |
| `images.edit` | 上述图片文本字段；单图 `image`、多图重复字段 `image[]`、可选 `mask` |
| `videos.generate` | `client_request_id`、`model`、`prompt`、`duration`、`aspect_ratio`、`resolution`、`generate_audio`、可选 `negative_prompt`、`first_frame`、`last_frame`、`reference_images` |

图生图 multipart 文本值进入脚本时均为字符串，包括数值和布尔语义字段；重复字段表现
为数组。视频公开 API 的 `duration_seconds` 在上游标准 Body 中规范为 `duration`。

`prompt` 可能已包含平台缓存 nonce 或图片引用展开结果，应作为不透明文本完整保留。
`client_request_id` 出现时必须保留，或移动到供应商等价幂等字段。供应商不支持幂等键
时，应在上线前记录重复提交风险，不能静默删除。

## 响应脚本契约

### 可读取值

响应脚本读取：

```ts
type ResponseInput = {
  statusCode: number;
  headers: {
    "content-type"?: string;
    "retry-after"?: string;
    "request-id"?: string;
    "x-request-id"?: string;
  };
  body: unknown;
};
```

`context` 与请求阶段结构相同，但 `stage` 为 `response`。查询响应还可读取固定的
`context.taskId`。响应脚本看不到请求凭据、请求 Header、账号、用户、完整 URL 或原始
二进制正文。

### 标准状态

非空响应脚本必须返回以下四种状态之一：

```ts
type NonTerminalResult = {
  status: "pending" | "processing";
  taskId?: string;
  progress?: number;
  pollAfterSeconds?: number;
};

type CompletedResult = {
  status: "completed";
  outputs: Array<ImageOutput | VideoOutput>;
};

type ImageOutput = {
  kind: "image";
  url?: string;
  base64?: string;
  mediaType?: string;
};

type VideoOutput = {
  kind: "video";
  url: string;
};

type FailedResult = {
  status: "failed";
  error: {
    category:
      | "invalid_request"
      | "authentication"
      | "permission"
      | "rate_limit"
      | "capacity"
      | "moderation"
      | "not_found"
      | "timeout"
      | "upstream"
      | "unknown";
    code: string;
    adminDetails?: string;
  };
  retryable?: boolean;
};
```

约束如下：

- 生成响应为 `pending` 或 `processing` 时必须返回 `taskId`；
- 查询响应可省略 `taskId`，系统沿用固定任务 ID；若返回则必须与原任务一致；
- `progress` 可选，范围为 `0-100`；
- 图片 `outputs` 至少一项，每项必须二选一返回绝对 HTTP(S) `url` 或 `base64`；
- `mediaType` 只可与图片 `base64` 一起返回；
- 视频 schema 接受至少一项绝对 HTTP(S) URL 形态的 `video` 输出，但当前视频管线使用第一项，
  适配脚本应只返回一项；视频不接受 Base64；
- `error.code` 必须是小写字母开头、只含小写字母、数字或下划线的稳定码；
- `adminDetails` 最多 1,024 字符，只供授权管理员诊断；不要放入密钥、正文或 Prompt；
- 查询阶段 `failed` 不能通过 `retryable: true` 重新提交生成。

### 轮询间隔

`pollAfterSeconds` 是可选的内部轮询提示，只允许出现在 `pending` 或 `processing`，值为
`1-300` 的整数。省略时图片和视频均默认 5 秒。它表示平台下一次供应商查询的最早
时间，不是公开 API 的硬性轮询限制，也不是供应商 SLA。

如果响应同时带有效 `Retry-After`，系统使用两者中更长的等待时间，并把结果限制在
`1-300` 秒。终态返回 `pollAfterSeconds` 会被拒绝。

### 同步与异步示例

同步图片 URL：

```js
const images = Array.isArray(response.body.data) ? response.body.data : [];
return {
  status: "completed",
  outputs: images.map((item) => ({ kind: "image", url: item.url })),
};
```

同步图片 Base64：

```js
const images = Array.isArray(response.body.images) ? response.body.images : [];
return {
  status: "completed",
  outputs: images.map((item) => ({
    kind: "image",
    base64: item.base64,
    mediaType: "image/png",
  })),
};
```

异步生成：

```js
return {
  status: "processing",
  taskId: String(response.body.job_id),
  progress: 0,
};
```

异步查询完成：

```js
if (response.body.state !== "done") {
  return {
    status: "processing",
    progress: Number(response.body.progress || 0),
    pollAfterSeconds: 5,
  };
}
return {
  status: "completed",
  outputs: [{ kind: "video", url: response.body.result.video_url }],
};
```

## 媒体令牌

真实 multipart 文件、视频 data URL 和响应中的大图片 Base64 不进入 QuickJS。宿主用
不可预测令牌替换媒体，脚本只能移动令牌，返回后再由宿主恢复真实值。

每个令牌必须在输出中恰好保留一次。禁止删除、复制、拼接、截断或伪造。图生图
multipart 媒体只能位于顶层字段或顶层数组元素；视频 JSON 媒体可移动到嵌套字段。
响应 Base64 令牌可以移动到标准图片输出，但视频标准输出不接受 Base64。

首尾帧与参考图对所有模型都互斥。脚本不能把两种输入合并，也不能复制输入图。
参考图数量由模型配置约束；Seedance 家族默认上限为 10，管理员可调整且适配器不设置
硬上限。脚本不得截断 `reference_images`。

## 安全与资源边界

| 项目 | 限制 |
| --- | --- |
| 单脚本源码 | 最多 32,768 个 UTF-16 代码单元 |
| 单次同步执行 | 50 ms |
| 普通 JSON 输入或输出 | 最多 2 MiB |
| 普通 JSON 深度 | 最多 16 |
| 普通 JSON 节点 | 最多 10,000 |
| Query | 最多 64 个值，编码后最多 16 KiB |
| 业务 Header | 最多 32 个；单值最多 8 KiB且不能含换行 |
| QuickJS 内存 | 默认 32 MiB，可部署级配置为 16-128 MiB |
| QuickJS 栈 | 默认 512 KiB，可部署级配置为 256-2,048 KiB |
| Worker 数 | 每个 Node 进程默认 1，可部署级配置为 1-8 |

受保护媒体不计入普通 JSON 的 2 MiB，但仍受图片或视频宿主媒体预算约束。账号不能
覆盖 Worker、内存或栈配置。部署级环境变量为：

```text
API_UPSTREAM_SCRIPT_WORKER_COUNT=1
API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB=32
API_UPSTREAM_SCRIPT_STACK_LIMIT_KB=512
```

Worker 数是每个 Node 进程的 Worker Thread 数；增加 Web 进程或容器会按进程倍增。

## 空脚本的内置行为

- 空请求脚本完全使用系统内置 Query、Header 和 Body。
- 空响应脚本使用现有 Images 或 Videos 兼容解析，不占用响应脚本许可。
- 内置异步响应识别常见 `task_id`、`id`、`generation_id` 以及 `status`、`state`。
- 内置视频完成结果识别 `video_url`、`url`、`output_url`。
- 内置图片结果继续支持现行 URL、Base64 和流式兼容协议。
- 无论脚本是否为空，都不会读取上游 `poll_url` 或 `status_url`。

内置协议只是兼容路径。供应商字段不明确时，应填写响应脚本显式映射，不能依靠猜测。

## 无网络测试器

管理页的请求和响应测试器使用生产 QuickJS Worker、共享 schema 和媒体令牌校验，但：

- 不读取账号密钥或成员配置；
- 不访问上游；
- 不创建真实生成任务，不产生费用；
- 只运行管理员填写的合成 JSON 样例；
- 将 `mock://media/*` 替换为生产格式的模拟媒体令牌。

请求测试样例应与脚本实际输入一致，即包含 `query` 和可选 `body`。响应测试样例应包含
`statusCode`、`headers` 和 `body`。测试成功不能绕过保存时的长度、静态语法、路径和
契约校验。

## 失败、重试与用户提示

脚本语法、执行或输出失败时，用户收到：

```text
供应商请求处理失败，请联系管理员（请求标识：apiu_...）
```

主要稳定执行码包括：

- `invalid_configuration`
- `request_script_failed`
- `response_script_failed`
- `transport_failed`
- `response_read_failed`
- `platform_busy`

请求脚本在外呼前失败时可排除当前账号并重新调度。生成请求已经发出后，响应脚本失败
不得换号重新提交。取得任务 ID 后始终固定原账号和配置版本；查询阶段的配置、请求或
响应脚本、响应读取连续失败 3 次后进入现有失败、退款流程。`platform_busy` 与
`transport_failed` 不计入该阈值。Worker Pool 饱和返回“服务繁忙，请稍后重试”和
至少 1 秒重试提示，不处罚供应商账号健康。

## 结构化日志与监控

日志通过 Pino 输出到标准输出，字段与日志采集厂商无关。

脚本失败事件为 `api_upstream_script_failed`，稳定字段包括：

- `event`
- `operation`
- `stage`
- `code`
- `requestSent`
- `retryAction`
- `memberId`
- `groupId`
- `platformModelId`
- `requestId`
- `taskSummary`

运行时饱和事件为 `api_upstream_script_runtime_saturated`，稳定字段包括：

- `event`
- `reason`
- `state`
- `queuedRequests`
- `queuedResponses`
- `activeResponsePermits`

供应商接受异步图片任务时还会写入 warn 级
`api_upstream_image_task_orphan_risk`，稳定字段包括：

- `event`
- `operation`
- `memberId`
- `groupId`
- `platformModelId`
- `durability=process_local`
- `idempotencyProtection=not_available`
- `recoveryAction=do_not_resubmit_automatically`
- `taskSummary=accepted_image_task`

该事件表示任务已经跨过不可安全重投边界，供管理员统计风险暴露和部署维护窗口；它不
表示任务已经失败，也不包含供应商 task ID。

日志不得记录 API Key、认证 Header、脚本源码、请求体、响应体、Prompt、媒体、完整 URL、
堆栈或原始供应商 task ID。

本地查看：

```bash
docker compose -f deploy/docker-compose.yml logs --no-color --no-log-prefix -f web \
  | jq -c 'select(.event == "api_upstream_script_failed")'
```

通用 JSON 日志系统应从容器标准输出采集，按 `event` 建立规则，再按 `operation`、
`stage`、`code` 和 `requestSent` 聚合。建议：

- 对 `api_upstream_script_failed` 持续出现或短时突增告警；
- 对 `api_upstream_script_runtime_saturated` 任意持续出现告警；
- 对 `api_upstream_image_task_orphan_risk` 统计并发存续窗口，在进程重启前确认没有活跃
  图片生成请求；
- 用 `requestId` 关联用户提供的请求标识，不搜索供应商原始任务 ID；
- 对采集后的事件做敏感字段负向扫描。

Datadog 只是可选消费者示例，不是运行依赖。其查询可写为：

```text
service:fluxmedia @event:api_upstream_script_failed
service:fluxmedia @event:api_upstream_script_runtime_saturated
service:fluxmedia @event:api_upstream_image_task_orphan_risk
```

接入 Loki、OpenSearch、Vector、Fluent Bit 或其他系统时，沿用相同 JSON 事件和字段即可。

## 配置审查清单

- 支持模型和模型映射来源是否只使用平台真实模型 ID；
- 路径是否固定在 `baseUrl` 下，查询路径是否只有一个 `{task_id}`；
- 是否选择正确认证模式，脚本是否未触碰认证 Header；
- 请求中出现的 `client_request_id` 是否保留或移动到等价幂等字段；
- Query、Header、Body 和响应是否满足严格返回契约；
- 首尾帧和参考图是否仍互斥，每个媒体令牌是否恰好保留一次；
- 异步图片是否配置对应查询路径；
- 生成和查询是否都覆盖 `pending`、`processing`、`completed`、`failed`；
- 同步和异步合成样例是否都已在无网络测试器通过；
- 日志与错误信息是否不含上游正文、Prompt、媒体、密钥或脚本。

需要根据供应商 HAR 或文档生成完整配置时，使用项目内
[`write-api-upstream-adapter`](../skills/write-api-upstream-adapter/SKILL.md) Skill。
