<!--
本文是 write-api-upstream-adapter Skill 的共享运行时契约，记录六操作配置、脚本输入
输出、安全资源边界和验证不变量；三类媒体参考文件直接依赖本文。
-->

# FluxMedia API 上游适配运行时契约

## 目录

- [配置结构](#配置结构)
- [固定传输边界](#固定传输边界)
- [脚本包装](#脚本包装)
- [脱敏上下文](#脱敏上下文)
- [请求脚本](#请求脚本)
- [响应脚本](#响应脚本)
- [媒体令牌](#媒体令牌)
- [QuickJS 限制](#quickjs-限制)
- [失败和可观测性](#失败和可观测性)
- [无网络验证](#无网络验证)

## 配置结构

一个 API 账号保存共享 `baseUrl`、认证、模型映射和六个独立操作。API Key 与不可变
适配版本分离。

```ts
type OperationId =
  | "images.generate"
  | "images.generate.query"
  | "images.edit"
  | "images.edit.query"
  | "videos.generate"
  | "videos.query";

type OperationConfig = {
  path: string;
  requestScript: string;
  responseScript: string;
};

type AdapterConfig = {
  baseUrl: string;
  authentication:
    | { mode: "bearer" }
    | { mode: "raw_authorization" }
    | { mode: "custom_header"; headerName: string }
    | { mode: "none" };
  modelMappings: Array<{
    modelId: string;
    upstreamModelId: string;
  }>;
  operations: Record<OperationId, OperationConfig>;
};
```

`supportedModelIds` 和映射来源只使用平台真实模型 ID。映射来源按大小写不敏感语义
唯一，必须属于账号支持模型；目标允许重复。未配置的模型同名透传。

## 固定传输边界

| 操作 | Method | 空路径内置值 | Content-Type |
| --- | --- | --- | --- |
| `images.generate` | POST | `/images/generations` | JSON |
| `images.generate.query` | GET | 无 | 无 Body |
| `images.edit` | POST | `/images/edits` | multipart |
| `images.edit.query` | GET | 无 | 无 Body |
| `videos.generate` | POST | `/videos/generations` | JSON |
| `videos.query` | GET | `/videos/{task_id}` | 无 Body |

生成路径不能含 `{task_id}`。查询路径必须恰好包含一个 `{task_id}`，任务 ID 只由宿主
编码替换。路径以 `/` 开头，不能包含绝对 URL、`//`、反斜杠、Query、Fragment、控制
字符或 dot segment。

`baseUrl` 可使用 HTTP、HTTPS、私网或 Docker 内部地址，但不能含用户信息、Query 或
Fragment。脚本不能改变 origin。供应商响应中的 `poll_url`、`status_url` 和动态 URL
不能决定查询地址。

认证由宿主在脚本后最后注入。请求脚本不能读取或覆盖认证值，也不能把 API Key 放入
Query 或 Body。

## 脚本包装

编辑器内容会放入以下同步包装中：

```js
function transform(input, context) {
  "use strict";
  const request = input;
  const response = input;
  // 管理员脚本正文
}
```

因此请求阶段使用 `request`，响应阶段使用 `response`。可以在正文中声明普通函数、箭头
函数、局部常量和同步对象操作。不要再声明外层 transform，不要写 `async`。

## 脱敏上下文

```ts
type Context = {
  operation: OperationId;
  stage: "request" | "response";
  contentType: "application/json" | "multipart/form-data";
  platformModelId: string;
  upstreamModelId: string;
  taskId?: string;
};
```

`taskId` 只在查询阶段提供。`request.body.model` 已经是 `upstreamModelId`。
`context` 深度冻结，只用于条件分支；不要尝试修改或写回平台模型 ID。

上下文不含账号、用户、密钥、账号池分组、完整 URL、现有请求 Header 或供应商原始
响应以外的数据。

## 请求脚本

### 输入

```ts
type RequestInput = {
  query: Record<
    string,
    string | number | boolean | Array<string | number | boolean>
  >;
  body?: unknown;
};
```

生成操作通常有 `body`，查询操作没有 `body`。`query` 即使为空也存在。

### 输出

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

非空脚本必须返回普通对象：

- 省略 `query`：保留全部内置 Query；
- 省略 `headers`：不新增业务 Header；
- 省略 `body`：保留内置 Body；
- `return {}`：不修改；
- 编辑器留空：不启动 QuickJS，完全采用内置行为。

不修改 Headers 时不需要原样返回。Query 新值覆盖同名值，数组保序编码为重复参数，
`null` 删除同名内置项。GET 查询操作返回 `body` 会失败关闭。

业务 Header 最多 32 个，名称必须符合 HTTP token，单值最多 8 KiB且不得含 CR/LF。
以下命名空间禁止：认证 Header、`Cookie`、`Host`、`Content-Type`、
`Content-Length`、逐跳或代理 Header、`Forwarded`、`Origin`、`Referer`、`sec-*`、
`x-forwarded-*`、`x-fluxmedia-*`。

Query 总值最多 64 个，最终编码最多 16 KiB。限制在内置 Query 与脚本 Query 合并后再次
校验。

## 响应脚本

### 输入

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

响应 Body 由 Content-Type 解析为 JSON；非 JSON 为有界文本，空 JSON 为 `null`。只有
上表四个安全 Header 可见。

### 输出

```ts
type ResponseResult =
  | {
      status: "pending" | "processing";
      taskId?: string;
      progress?: number;
      pollAfterSeconds?: number;
    }
  | {
      status: "completed";
      outputs: Array<
        | {
            kind: "image";
            url?: string;
            base64?: string;
            mediaType?: string;
          }
        | { kind: "video"; url: string }
      >;
    }
  | {
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

生成非终态必须带 `taskId`。查询非终态可省略 `taskId` 并沿用 `context.taskId`；若返回，
必须相同。`progress` 为可选 `0-100` 数值。

`pollAfterSeconds` 可选，只能用于非终态，必须是 `1-300` 的整数。省略时图片和视频默认
均为 5 秒；与有效 `Retry-After` 同时存在时取更长值。它是内部最早查询提示，不是公开
硬限制或 SLA。

图片完成输出至少一项，每项恰好提供绝对 HTTP(S) `url` 或 `base64`；`mediaType` 只和
Base64 一起使用。视频 schema 接受至少一项绝对 HTTP(S) URL，当前视频管线使用第一项，
因此脚本应只返回一项。
失败 `code` 必须匹配
`^[a-z][a-z0-9_]{0,63}$`，`adminDetails` 最多 1,024 字符。查询失败不能设置
`retryable: true` 来重新生成。

## 媒体令牌

宿主把以下真实媒体替换为不可预测令牌后再进入 QuickJS：

- 图生图 multipart 文件和 mask；
- 视频输入 data URL；
- 响应中的图片 data URL、常见 Base64 字段及可识别图片魔数的 Base64。

脚本只能移动令牌。每个令牌在输出中必须恰好出现一次，不能删除、复制、伪造、拼接或
截断。multipart 媒体只能处于顶层字段或顶层数组元素；视频 JSON 可移动到嵌套字段。

受保护媒体不计入 2 MiB 普通 JSON 预算，但仍受宿主媒体总量限制。首尾帧和参考图永远
互斥，脚本不能改变此规则或截断参考图。

## QuickJS 限制

- 脚本最多 32,768 个 UTF-16 代码单元；
- 同步执行最多 50 ms；
- 普通 JSON 输入或输出最多 2 MiB、深度 16、节点 10,000；
- 默认 Runtime 内存 32 MiB、栈 512 KiB；
- 禁止 `import`、`export`、`require`、第三方库；
- 禁止 `async`、`await`、`Promise`；
- 禁止网络、文件、进程、计时器、时间、随机数；
- 禁止 `eval`、`Function` 和动态代码；
- 禁止循环引用、非有限数值和 `__proto__`、`constructor`、`prototype` 键；
- 输出必须是可序列化的普通 JSON 值，并满足阶段专用 schema。

部署级变量：

```text
API_UPSTREAM_SCRIPT_WORKER_COUNT=1
API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB=32
API_UPSTREAM_SCRIPT_STACK_LIMIT_KB=512
```

Worker 数范围 1-8，内存 16-128 MiB，栈 256-2,048 KiB。账号和脚本不能覆盖。

## 失败和可观测性

请求脚本在外呼前失败时可切换账号；外呼后响应脚本失败不得重投生成。取得 task ID 后
固定原成员与版本，查询阶段的配置、请求或响应脚本、响应读取连续失败 3 次后进入现有
失败退款。平台繁忙与传输失败不计入该阈值，运行时饱和也不能处罚供应商账号。

用户脚本失败文案为：

```text
供应商请求处理失败，请联系管理员（请求标识：apiu_...）
```

结构化事件：

- `api_upstream_script_failed`：`operation`、`stage`、`code`、
  `requestSent`、`retryAction`、`memberId`、`groupId`、
  `platformModelId`、`requestId`、`taskSummary`；
- `api_upstream_script_runtime_saturated`：`reason`、`state`、
  `queuedRequests`、`queuedResponses`、`activeResponsePermits`。

日志不得含 API Key、认证 Header、脚本、Query、Header 正文、Body、Prompt、媒体、完整
URL、堆栈或原始 task ID。Datadog 只是 JSON 日志的可选消费者，不能成为脚本或部署
依赖。

## 无网络验证

使用管理测试器时：

- 请求样例传 `{ query, body? }`；
- 响应样例传 `{ statusCode, headers, body }`；
- 媒体叶子传 `mock://media/*`；
- 不填真实 API Key、Prompt 或用户内容；
- 不调用供应商；
- 同时验证正常、非终态、终态、失败和媒体冲突形状。

在仓库中使用生产 QuickJS Worker 或对应 Vitest 测试，不用 Node `eval`、`new Function`
或 `vm` 代替生产契约。
