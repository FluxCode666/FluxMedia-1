/**
 * API 类型账号上游适配的站内管理员文档。
 *
 * 使用方：管理员系统文档页。内容覆盖六操作、脚本输入输出、资源限制、
 * 容量估算与图片异步跨重启边界，并与账号池生产契约保持一致。
 */

import { Badge } from "@repo/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { CodeBlock } from "@repo/ui/components/code-block";

const operationRows = [
  ["images.generate", "POST", "/images/generations", "JSON"],
  ["images.generate.query", "GET", "管理员配置 /{task_id}", "无 Body"],
  ["images.edit", "POST", "/images/edits", "multipart"],
  ["images.edit.query", "GET", "管理员配置 /{task_id}", "无 Body"],
  ["videos.generate", "POST", "/videos/generations", "JSON"],
  ["videos.query", "GET", "/videos/{task_id}", "无 Body"],
] as const;

const englishOperationRows = [
  ["images.generate", "POST", "/images/generations", "JSON"],
  ["images.generate.query", "GET", "Admin path with /{task_id}", "No body"],
  ["images.edit", "POST", "/images/edits", "multipart"],
  ["images.edit.query", "GET", "Admin path with /{task_id}", "No body"],
  ["videos.generate", "POST", "/videos/generations", "JSON"],
  ["videos.query", "GET", "/videos/{task_id}", "No body"],
] as const;

const requestExample = `const body = { ...request.body };
body.ratio = body.aspect_ratio;
delete body.aspect_ratio;
return {
  query: { ...request.query, api_version: "2026-08-01" },
  body,
};`;

const responseExample = `const body = response.body;
if (body.state === "failed") {
  return {
    status: "failed",
    error: { category: "upstream", code: "job_failed" },
  };
}
if (body.state !== "completed") {
  return {
    status: "processing",
    progress: body.progress,
  };
}
return {
  status: "completed",
  outputs: [{ kind: "video", url: body.output.video_url }],
};`;

const localLogQuery = `docker compose -f deploy/docker-compose.yml logs \\
  --no-color --no-log-prefix -f web \\
  | jq -c 'select(.event == "api_upstream_script_failed")'`;

const localizedContent = {
  zh: {
    title: "API 账号上游适配",
    description:
      "在账号池的 API 类型账号中配置模型映射、认证，以及文生图、图生图和生视频各自的生成与查询操作。路径和认证由系统控制，JavaScript 只处理有界请求与响应数据。",
    operationTitle: "六个固定操作",
    operationHeaders: ["操作", "方法", "空路径默认值", "Body"],
    scriptTitle: "脚本可读取与返回的值",
    requestInput:
      "请求脚本读取 request.query、可选 request.body 和只读 context；返回可省略 query、headers、body 的对象。省略任一字段表示保留系统内置值，return {} 表示全部保留。不修改 Header 时直接省略 headers；非空脚本仍必须 return 对象。",
    responseInput:
      "响应脚本读取 response.statusCode、response.body，以及 content-type、retry-after、request-id、x-request-id 四个安全 Header；返回 pending、processing、completed 或 failed。pollAfterSeconds 可选，省略时图片与视频均为 5 秒。",
    contextInput:
      "context 仅包含 operation、stage、contentType、platformModelId、upstreamModelId 和查询阶段可选 taskId，不包含密钥、账号、用户、完整 URL 或请求 Header。",
    requestExampleTitle: "请求脚本示例",
    responseExampleTitle: "响应脚本示例",
    safetyTitle: "安全、媒体和异步边界",
    safetyItems: [
      "允许普通函数、箭头函数和同步对象处理；禁止 import、第三方库、Promise、网络、文件、时间、随机数和动态代码。",
      "模型映射来源只使用平台真实模型 ID；时长、比例和分辨率保持独立参数。",
      "首尾帧与参考图对所有模型互斥；媒体令牌只能移动一次，不能删除、复制、伪造或截断。Seedance 参考图默认上限 10，管理员可调整且适配器没有硬上限。",
      "查询路径固定由管理员配置，系统不会采用响应中的 poll_url 或 status_url。",
      "图片供应商异步任务只在当前 Node 进程内尽力轮询。进程崩溃后不会恢复远端图片任务；供应商不支持幂等键时，客户端重试可能产生孤儿任务、重复生成和额外供应商费用。",
      "供应商接受异步图片任务时会输出 api_upstream_image_task_orphan_risk 脱敏事件；它用于发布和重启前统计风险窗口，不表示任务已经失败。",
      "脚本失败只向用户展示 apiu_ 请求标识和联系管理员文案；日志不得包含密钥、脚本、Prompt、媒体或上游正文。",
    ],
    failureTitle: "响应、轮询与失败处理",
    failureItems: [
      "pending 或 processing 可返回 progress（0-100）和 pollAfterSeconds；生成响应必须返回 taskId，查询响应省略 taskId 时沿用固定任务 ID。",
      "pollAfterSeconds 只允许用于非终态，必须是 1-300 的整数，表示平台最早再次查询的提示而非下游硬限制。若 Retry-After 更长则采用较长值；终态携带该字段会被拒绝。",
      "failed.error 必须包含 category 和稳定的小写 code，可选 adminDetails 最多 1,024 字符、retryable 仅用于允许安全重试的生成失败；查询失败禁止 retryable: true。",
      "请求脚本在外呼前失败时可换账号；请求发出后不得换号重提。任务已受理后固定原账号和适配版本，查询适配连续失败 3 次才终止；platform_busy 与 transport_failed 不计入该阈值。",
      "Worker Pool 饱和返回平台繁忙和至少 1 秒重试提示，不处罚供应商账号健康。",
    ],
    observabilityTitle: "结构化日志与通用监控",
    observabilityItems: [
      "api_upstream_script_failed 包含 operation、stage、code、requestSent、retryAction、memberId、groupId、platformModelId、requestId 和 taskSummary；用 requestId 关联用户提供的 apiu_ 标识。",
      "api_upstream_script_runtime_saturated 包含 reason、state、queuedRequests、queuedResponses 和 activeResponsePermits；持续出现时应告警。",
      "api_upstream_image_task_orphan_risk 表示异步图片任务已跨过不可安全重投边界，不表示任务失败；发布或重启前应统计活跃风险窗口。",
      "Pino JSON 从容器标准输出采集，按 event 建规则，再按 operation、stage、code、requestSent 聚合。Datadog、Loki、OpenSearch、Vector 或 Fluent Bit 都可消费同一字段契约。",
      "日志禁止记录 API Key、认证 Header、脚本、请求或响应正文、Prompt、媒体、完整 URL、堆栈和供应商原始 task ID。",
    ],
    localLogQueryTitle: "本地查看脚本失败日志",
    capacityTitle: "资源限制与理论容量",
    capacityDescription:
      "每个 Worker 同时只运行一个脚本。50 ms 是执行上限而非平均耗时；若一次 HTTP 同时使用请求和响应脚本，理论周期吞吐约为 Worker 数 × 10 次/秒。实际 QPS 还受脚本耗时、序列化、上游延迟、账号并发和容器内存限制。",
    capacityHeaders: [
      "Worker",
      "最大并行脚本",
      "理论脚本吞吐",
      "理论请求/响应周期",
    ],
    capacityRows: [
      ["1（默认）", "1", "20 jobs/s", "10 cycles/s"],
      ["2", "2", "40 jobs/s", "20 cycles/s"],
      ["4", "4", "80 jobs/s", "40 cycles/s"],
      ["8（上限）", "8", "160 jobs/s", "80 cycles/s"],
    ],
    copyLabels: { copy: "复制", copied: "已复制", copyFailed: "复制失败" },
  },
  en: {
    title: "API account upstream adapters",
    description:
      "Configure model mappings, authentication, and separate generation and query operations for text-to-image, image-to-image, and video API accounts. The host controls paths and credentials; JavaScript only transforms bounded request and response data.",
    operationTitle: "Six fixed operations",
    operationHeaders: ["Operation", "Method", "Empty-path default", "Body"],
    scriptTitle: "Script inputs and outputs",
    requestInput:
      "Request scripts read request.query, optional request.body, and read-only context. Return an object with optional query, headers, and body. Omitting a field preserves the built-in value, and return {} preserves all fields. Omit headers when unchanged; every non-empty script must still return an object.",
    responseInput:
      "Response scripts read response.statusCode, response.body, and the four safe headers content-type, retry-after, request-id, and x-request-id, then return pending, processing, completed, or failed. pollAfterSeconds is optional and defaults to 5 seconds for both images and videos.",
    contextInput:
      "context only contains operation, stage, contentType, platformModelId, upstreamModelId, and optional taskId for queries. It never contains credentials, account or user identity, full URLs, or request headers.",
    requestExampleTitle: "Request script example",
    responseExampleTitle: "Response script example",
    safetyTitle: "Security, media, and async boundaries",
    safetyItems: [
      "Regular functions, arrow functions, and synchronous object operations are allowed. Imports, third-party libraries, Promise, network, files, time, randomness, and dynamic code are forbidden.",
      "Model mappings use real platform model IDs; duration, aspect ratio, and resolution remain separate parameters.",
      "First/last frames and reference images are mutually exclusive for every model. Media tokens may only be moved once. Seedance defaults to 10 reference images; admins may change it and the adapter adds no hard cap.",
      "Query paths are fixed by administrators; poll_url and status_url from responses are ignored.",
      "Async image supplier tasks are polled on a best-effort basis inside the current Node process. A process crash does not recover the remote task; without supplier idempotency, client retries may create orphan tasks, duplicate generations, and extra supplier charges.",
      "When a supplier accepts an async image task, FluxMedia emits the redacted api_upstream_image_task_orphan_risk event. Use it to assess deployment or restart risk windows; it does not mean the task has failed.",
      "Script failures expose only an apiu_ request identifier and contact-admin message. Logs never include credentials, scripts, prompts, media, or upstream bodies.",
    ],
    failureTitle: "Responses, polling, and failure handling",
    failureItems: [
      "pending or processing may return progress (0-100) and pollAfterSeconds. Generation responses must return taskId; query responses inherit the fixed task ID when taskId is omitted.",
      "pollAfterSeconds is valid only for non-terminal states and must be an integer from 1 to 300. It is an earliest-poll hint, not a downstream hard limit. A longer Retry-After wins; terminal results carrying this field are rejected.",
      "failed.error requires category and a stable lowercase code. adminDetails is optional and limited to 1,024 characters; retryable is only for generation failures that are safe to retry. Query failures forbid retryable: true.",
      "A request-script failure before the upstream call may switch accounts; after the request is sent, the generation must not be resubmitted through another account. Accepted tasks stay pinned to the original account and adapter version. Three consecutive query adaptation failures terminate the task; platform_busy and transport_failed do not count toward that threshold.",
      "Worker Pool saturation returns a platform-busy response with at least a one-second retry hint and does not penalize supplier account health.",
    ],
    observabilityTitle: "Structured logs and vendor-neutral monitoring",
    observabilityItems: [
      "api_upstream_script_failed includes operation, stage, code, requestSent, retryAction, memberId, groupId, platformModelId, requestId, and taskSummary. Use requestId to correlate an apiu_ identifier reported by a user.",
      "api_upstream_script_runtime_saturated includes reason, state, queuedRequests, queuedResponses, and activeResponsePermits. Alert when saturation persists.",
      "api_upstream_image_task_orphan_risk means an async image task crossed the unsafe-resubmit boundary; it does not mean failure. Measure active risk windows before deployments or restarts.",
      "Collect Pino JSON from container stdout, route by event, and aggregate by operation, stage, code, and requestSent. Datadog, Loki, OpenSearch, Vector, or Fluent Bit can consume the same contract.",
      "Logs must never include API keys, authentication headers, scripts, request or response bodies, prompts, media, full URLs, stacks, or raw supplier task IDs.",
    ],
    localLogQueryTitle: "Inspect script failures locally",
    capacityTitle: "Resource limits and theoretical capacity",
    capacityDescription:
      "Each Worker runs one script at a time. The 50 ms limit is a ceiling, not average latency. When an HTTP call uses both request and response scripts, theoretical cycle throughput is about worker count × 10 per second. Actual QPS also depends on script time, serialization, upstream latency, account concurrency, and container memory.",
    capacityHeaders: [
      "Workers",
      "Parallel scripts",
      "Script throughput",
      "Request/response cycles",
    ],
    capacityRows: [
      ["1 (default)", "1", "20 jobs/s", "10 cycles/s"],
      ["2", "2", "40 jobs/s", "20 cycles/s"],
      ["4", "4", "80 jobs/s", "40 cycles/s"],
      ["8 (maximum)", "8", "160 jobs/s", "80 cycles/s"],
    ],
    copyLabels: { copy: "Copy", copied: "Copied", copyFailed: "Copy failed" },
  },
} as const;

/**
 * 读取 API 上游适配站内文档的本地化静态契约。
 *
 * @param locale 路由语言；仅 zh 返回中文，其余语言回退英文。
 * @returns 文档文本、六操作和容量表；无外部副作用。
 */
export function getApiUpstreamAdapterDocsContent(locale = "en") {
  const content = locale === "zh" ? localizedContent.zh : localizedContent.en;
  return {
    ...content,
    operationRows: locale === "zh" ? operationRows : englishOperationRows,
  };
}

/**
 * 渲染管理员可直接阅读的 API 上游适配文档章节。
 *
 * @param locale 路由语言。
 * @returns 响应式文档卡片；只读渲染，不读取账号配置或密钥。
 */
export function ApiUpstreamAdapterDocs({ locale = "en" }: { locale?: string }) {
  const content = getApiUpstreamAdapterDocsContent(locale);

  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="font-serif text-lg tracking-tight">
          {content.title}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {content.description}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{content.operationTitle}</h3>
          <div className="overflow-x-auto rounded-md border">
            <div className="grid min-w-[720px] grid-cols-[1.4fr_0.6fr_1.6fr_0.8fr] border-b bg-muted/40 text-xs font-medium text-muted-foreground">
              {content.operationHeaders.map((header) => (
                <div className="px-3 py-2" key={header}>
                  {header}
                </div>
              ))}
            </div>
            {content.operationRows.map(([operation, method, path, body]) => (
              <div
                className="grid min-w-[720px] grid-cols-[1.4fr_0.6fr_1.6fr_0.8fr] border-b text-sm last:border-b-0"
                key={operation}
              >
                <code className="px-3 py-2 text-xs">{operation}</code>
                <div className="px-3 py-2">
                  <Badge
                    variant="outline"
                    className="rounded-sm font-mono text-[10px]"
                  >
                    {method}
                  </Badge>
                </div>
                <code className="px-3 py-2 text-xs text-muted-foreground">
                  {path}
                </code>
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {body}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{content.scriptTitle}</h3>
          {[
            content.requestInput,
            content.responseInput,
            content.contextInput,
          ].map((item) => (
            <p
              className="text-sm leading-relaxed text-muted-foreground"
              key={item}
            >
              {item}
            </p>
          ))}
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="min-w-0">
              <h4 className="text-sm font-medium">
                {content.requestExampleTitle}
              </h4>
              <CodeBlock
                className="mt-2"
                code={requestExample}
                labels={content.copyLabels}
                language="javascript"
              />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-medium">
                {content.responseExampleTitle}
              </h4>
              <CodeBlock
                className="mt-2"
                code={responseExample}
                labels={content.copyLabels}
                language="javascript"
              />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{content.safetyTitle}</h3>
          <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            {content.safetyItems.map((item) => (
              <li className="flex gap-2" key={item}>
                <span
                  aria-hidden="true"
                  className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{content.failureTitle}</h3>
          <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            {content.failureItems.map((item) => (
              <li className="flex gap-2" key={item}>
                <span
                  aria-hidden="true"
                  className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{content.observabilityTitle}</h3>
          <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            {content.observabilityItems.map((item) => (
              <li className="flex gap-2" key={item}>
                <span
                  aria-hidden="true"
                  className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="min-w-0">
            <h4 className="text-sm font-medium">
              {content.localLogQueryTitle}
            </h4>
            <CodeBlock
              className="mt-2"
              code={localLogQuery}
              labels={content.copyLabels}
              language="bash"
            />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{content.capacityTitle}</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {content.capacityDescription}
          </p>
          <div className="overflow-x-auto rounded-md border">
            <div className="grid min-w-[680px] grid-cols-4 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
              {content.capacityHeaders.map((header) => (
                <div className="px-3 py-2" key={header}>
                  {header}
                </div>
              ))}
            </div>
            {content.capacityRows.map((row) => (
              <div
                className="grid min-w-[680px] grid-cols-4 border-b text-xs last:border-b-0"
                key={row[0]}
              >
                {row.map((value, index) => (
                  <div
                    className="px-3 py-2 text-muted-foreground"
                    key={`${row[0]}-${content.capacityHeaders[index]}`}
                  >
                    {value}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
