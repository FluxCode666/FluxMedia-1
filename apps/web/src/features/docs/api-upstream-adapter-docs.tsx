/**
 * API 类型账号上游适配的站内管理员文档。
 *
 * 使用方：管理员系统文档页。内容覆盖六操作、脚本输入输出、资源限制、
 * 容量估算与 Go 持久图片任务恢复，并与账号池生产契约保持一致。
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
  --no-color --no-log-prefix -f backend \\
  | jq -c 'select(.msg == "backend operation failed")'`;

const localizedContent = {
  zh: {
    title: "API 账号上游适配",
    description:
      "在账号池的 API 类型账号中配置模型映射、认证、视频协议模式，以及文生图、图生图和生视频各自的生成与查询操作。视频模式可选 Gemini、Seedance 或 custom，且不由模型名称推断；路径和认证由系统控制，JavaScript 只处理有界请求与响应数据。",
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
      "视频协议模式由管理员按成员显式选择：Gemini 与 Seedance 使用内置适配，custom 保留现有脚本或无脚本内置路径；历史缺失模式的成员按 custom 处理。",
      "首尾帧与参考图对所有模型互斥；媒体令牌只能移动一次，不能删除、复制、伪造或截断。Seedance 参考图默认上限 10，管理员可调整且适配器没有硬上限。",
      "查询路径固定由管理员配置，系统不会采用响应中的 poll_url 或 status_url。",
      "Go 持久保存图片任务、供应商任务 ID、原账号和适配版本。进程崩溃后，Worker 接管租约并继续查询已接受的任务；不会因重启改用另一个账号重新生成。",
      "若供应商已接受请求但连接在任务 ID 保存前中断，且供应商没有幂等保证，仍可能出现结果不确定的孤儿任务。应对照持久提交状态排查，避免盲目重提。",
      "脚本测试由 Go 管理员接口调用私有运行时，失败返回 SCRIPT_EXECUTION_FAILED；生产任务错误可结合任务 ID 排查。日志不得包含密钥、脚本、Prompt、媒体或上游正文。",
    ],
    failureTitle: "响应、轮询与失败处理",
    failureItems: [
      "pending 或 processing 可返回 progress（0-100）和 pollAfterSeconds；生成响应必须返回 taskId，查询响应省略 taskId 时沿用固定任务 ID。",
      "pollAfterSeconds 只允许用于非终态，必须是 1-300 的整数，表示平台最早再次查询的提示而非下游硬限制。若 Retry-After 更长则采用较长值；终态携带该字段会被拒绝。",
      "failed.error 必须包含 category 和稳定的小写 code，可选 adminDetails 最多 1,024 字符、retryable 仅用于允许安全重试的生成失败；查询失败禁止 retryable: true。",
      "请求脚本在外呼前失败时可换账号；请求发出后不得换号重提。任务已受理后固定原账号和适配版本，查询适配连续失败 3 次才终止；platform_busy 与 transport_failed 不计入该阈值。",
      "运行时 HTTP 429、5xx 或连接失败视为平台暂不可用；已接受的任务等待恢复，不计入供应商脚本错误次数。",
    ],
    observabilityTitle: "结构化日志与通用监控",
    observabilityItems: [
      "Go 从容器标准输出写出 JSON 日志。HTTP 错误包含 request_id 和 error_code；按请求 ID、任务 ID 关联管理员使用记录与任务详情。",
      "脚本测试接口 POST /api/admin/image-backend/script-runtime/test 仅管理员可用；使用样例检查请求与响应适配。",
      "GET /api/admin/image-backend/script-runtime/diagnostics 返回私有运行时实时快照：lifecycle、workerCount、liveWorkerCount、requestQueueLength、responseQueueLength、responsePermitsInUse、responsePermitCapacity、saturationCount 和 replacementCount。运行时不可达时返回错误，不以全零计数伪装正常状态。",
      "Datadog、Loki、OpenSearch、Vector 或 Fluent Bit 可采集 backend 与 script-runtime 容器日志；健康检查和持久任务状态应一起监控。",
      "日志禁止记录 API Key、认证 Header、脚本、请求或响应正文、Prompt、媒体、完整 URL 和供应商原始 task ID。",
    ],
    localLogQueryTitle: "本地查看 Go 请求失败日志",
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
      "Configure model mappings, authentication, an explicit Gemini/Seedance/custom video protocol mode, and separate generation and query operations for text-to-image, image-to-image, and video API accounts. The host controls paths and credentials; JavaScript only transforms bounded request and response data.",
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
      "Admins choose the video protocol per member: Gemini and Seedance use built-in adapters, while custom preserves existing scripts or built-in no-script paths. Legacy snapshots without a mode use custom.",
      "First/last frames and reference images are mutually exclusive for every model. Media tokens may only be moved once. Seedance defaults to 10 reference images; admins may change it and the adapter adds no hard cap.",
      "Query paths are fixed by administrators; poll_url and status_url from responses are ignored.",
      "Go persists image tasks, provider task IDs, original accounts, and adapter versions. After a process crash, a worker acquires the lease and resumes queries for accepted tasks; a restart does not regenerate through another account.",
      "If a provider accepts a request but the connection fails before its task ID is saved, providers without idempotency guarantees may still leave orphan tasks with uncertain results. Inspect persistent submission state before resubmitting.",
      "The Go administrator script-test endpoint invokes the private runtime and reports SCRIPT_EXECUTION_FAILED on failure. Correlate production failures with task IDs. Logs must exclude credentials, scripts, prompts, media, and upstream bodies.",
    ],
    failureTitle: "Responses, polling, and failure handling",
    failureItems: [
      "pending or processing may return progress (0-100) and pollAfterSeconds. Generation responses must return taskId; query responses inherit the fixed task ID when taskId is omitted.",
      "pollAfterSeconds is valid only for non-terminal states and must be an integer from 1 to 300. It is an earliest-poll hint, not a downstream hard limit. A longer Retry-After wins; terminal results carrying this field are rejected.",
      "failed.error requires category and a stable lowercase code. adminDetails is optional and limited to 1,024 characters; retryable is only for generation failures that are safe to retry. Query failures forbid retryable: true.",
      "A request-script failure before the upstream call may switch accounts; after the request is sent, the generation must not be resubmitted through another account. Accepted tasks stay pinned to the original account and adapter version. Three consecutive query adaptation failures terminate the task; platform_busy and transport_failed do not count toward that threshold.",
      "Runtime HTTP 429, 5xx, or connection failures indicate temporary platform unavailability. Accepted tasks wait for recovery without consuming their provider script-failure budget.",
    ],
    observabilityTitle: "Structured logs and vendor-neutral monitoring",
    observabilityItems: [
      "Go emits JSON logs to container stdout. HTTP errors include request_id and error_code; correlate request and task IDs with administrator usage records and task details.",
      "POST /api/admin/image-backend/script-runtime/test is administrator-only. Use samples to check request and response adapters.",
      "GET /api/admin/image-backend/script-runtime/diagnostics returns a live private-runtime snapshot: lifecycle, workerCount, liveWorkerCount, requestQueueLength, responseQueueLength, responsePermitsInUse, responsePermitCapacity, saturationCount, and replacementCount. An unreachable runtime returns an error instead of healthy-looking zero counters.",
      "Datadog, Loki, OpenSearch, Vector, or Fluent Bit can collect backend and script-runtime container logs. Monitor health checks together with persistent task status.",
      "Logs must exclude API keys, authentication headers, scripts, request and response bodies, prompts, media, full URLs, and raw provider task IDs.",
    ],
    localLogQueryTitle: "Inspect Go request failures locally",
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
