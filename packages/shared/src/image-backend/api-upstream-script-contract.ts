/**
 * API 上游脚本的共享运行契约。
 *
 * 职责：定义六个供应商适配操作、请求信封、响应结果、脱敏上下文和资源边界。
 * 使用方：账号池保存与测试 UOL、Web Worker 运行时、图片和视频上游执行器。
 * 本模块只处理可序列化数据，不依赖数据库、网络、QuickJS 或账号凭据。
 */
import { z } from "zod";

/** 六个供应商适配操作；它们不是 UOL operation。 */
export const API_UPSTREAM_ADAPTER_OPERATION_IDS = [
  "images.generate",
  "images.generate.query",
  "images.edit",
  "images.edit.query",
  "videos.generate",
  "videos.query",
] as const;

/** 供应商适配操作 ID。 */
export type ApiUpstreamAdapterOperationId =
  (typeof API_UPSTREAM_ADAPTER_OPERATION_IDS)[number];

/** 供应商适配操作 ID 的严格 schema。 */
export const apiUpstreamAdapterOperationIdSchema = z.enum(
  API_UPSTREAM_ADAPTER_OPERATION_IDS
);

/** 请求和响应脚本允许的最大 UTF-16 代码单元数。 */
export const API_UPSTREAM_MAX_SCRIPT_CHARACTERS = 32_768;

/** 普通 JSON 输入或输出的最大 UTF-8 字节数。 */
export const API_UPSTREAM_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

/** 普通 JSON 树允许的最大深度。 */
export const API_UPSTREAM_MAX_JSON_DEPTH = 16;

/** 普通 JSON 树允许的最大节点数。 */
export const API_UPSTREAM_MAX_JSON_NODES = 10_000;

/** 请求 Query 编码后的最大 UTF-8 字节数。 */
export const API_UPSTREAM_MAX_QUERY_BYTES = 16 * 1024;

/** 请求 Query 允许的参数值总数。 */
export const API_UPSTREAM_MAX_QUERY_VALUES = 64;

/** 请求脚本允许写入的业务 Header 数量。 */
export const API_UPSTREAM_MAX_HEADER_COUNT = 32;

/** 单个业务 Header 值允许的最大 UTF-8 字节数。 */
export const API_UPSTREAM_MAX_HEADER_VALUE_BYTES = 8 * 1024;

/** 响应未提供轮询提示时使用的图片和视频默认秒数。 */
export const API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS = 5;

const BLOCKED_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const STABLE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const BLOCKED_HEADER_NAMES = new Set([
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

/** 同步 JavaScript 脚本源码；空白内容规范为空字符串。 */
export const apiUpstreamScriptSourceSchema = z
  .string()
  .max(API_UPSTREAM_MAX_SCRIPT_CHARACTERS)
  .transform((script) => (script.trim() ? script : ""));

const queryScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

/** Query 中的标量、保序一维数组或删除标记。 */
export const apiUpstreamQueryValueSchema = z.union([
  queryScalarSchema,
  z.array(queryScalarSchema),
  z.null(),
]);

/** 单个请求 Query 值。 */
export type ApiUpstreamQueryValue = z.infer<typeof apiUpstreamQueryValueSchema>;

/** 判断脚本 Header 是否属于宿主保留命名空间。 */
export function isBlockedApiUpstreamHeaderName(headerName: string): boolean {
  const normalized = headerName.trim().toLowerCase();
  return (
    BLOCKED_HEADER_NAMES.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("sec-") ||
    normalized.startsWith("x-fluxmedia-")
  );
}

/** 统计可序列化 JSON 的 UTF-8 字节数；循环引用或不可序列化值返回无穷大。 */
function getSerializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return Number.POSITIVE_INFINITY;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 校验 JSON 树深度、节点数、危险键和可序列化类型。
 *
 * @param value 外部或脚本返回的未知值。
 * @returns 第一个稳定失败原因；安全时返回 null。
 */
function findUnsafeJsonReason(value: unknown): string | null {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > API_UPSTREAM_MAX_JSON_NODES) return "JSON node limit exceeded";
    if (depth > API_UPSTREAM_MAX_JSON_DEPTH) return "JSON depth limit exceeded";
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return null;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? null : "JSON number must be finite";
    }
    if (typeof current !== "object") return "Value must be JSON serializable";
    if (seen.has(current)) return "JSON value must not contain cycles";
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) {
        const reason = visit(item, depth + 1);
        if (reason) return reason;
      }
      seen.delete(current);
      return null;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return "JSON object must use a plain prototype";
    }
    for (const [key, child] of Object.entries(current)) {
      if (BLOCKED_JSON_KEYS.has(key)) return "JSON contains a blocked key";
      const reason = visit(child, depth + 1);
      if (reason) return reason;
    }
    seen.delete(current);
    return null;
  };
  return visit(value, 0);
}

/** 普通 JSON 正文的有界安全 schema。 */
export const apiUpstreamJsonValueSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const reason = findUnsafeJsonReason(value);
    if (reason) {
      ctx.addIssue({ code: "custom", message: reason });
      return;
    }
    if (getSerializedByteLength(value) > API_UPSTREAM_MAX_SERIALIZED_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: "Serialized JSON limit exceeded",
      });
    }
  });

/** 请求脚本可返回的 Query 修改。 */
export const apiUpstreamQuerySchema = z
  .record(z.string().min(1).max(256), apiUpstreamQueryValueSchema)
  .superRefine((query, ctx) => {
    let valueCount = 0;
    const encoded = new URLSearchParams();
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === null) continue;
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      valueCount += values.length;
      for (const value of values) encoded.append(key, String(value));
    }
    if (valueCount > API_UPSTREAM_MAX_QUERY_VALUES) {
      ctx.addIssue({ code: "custom", message: "Query value limit exceeded" });
    }
    if (
      new TextEncoder().encode(encoded.toString()).byteLength >
      API_UPSTREAM_MAX_QUERY_BYTES
    ) {
      ctx.addIssue({ code: "custom", message: "Encoded Query limit exceeded" });
    }
  });

/** 经资源边界校验的请求 Query。 */
export type ApiUpstreamQuery = z.infer<typeof apiUpstreamQuerySchema>;

/** 请求脚本可返回的业务 Header 修改。 */
export const apiUpstreamBusinessHeadersSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, ctx) => {
    const entries = Object.entries(headers);
    if (entries.length > API_UPSTREAM_MAX_HEADER_COUNT) {
      ctx.addIssue({ code: "custom", message: "Header count limit exceeded" });
    }
    const normalizedNames = new Set<string>();
    for (const [name, value] of entries) {
      const normalized = name.toLowerCase();
      if (
        !HTTP_HEADER_NAME_PATTERN.test(name) ||
        isBlockedApiUpstreamHeaderName(name)
      ) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Header name is not allowed",
        });
      }
      if (normalizedNames.has(normalized)) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Header names must be unique ignoring case",
        });
      }
      normalizedNames.add(normalized);
      if (/\r|\n/.test(value)) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Header value must not contain a line break",
        });
      }
      if (
        new TextEncoder().encode(value).byteLength >
        API_UPSTREAM_MAX_HEADER_VALUE_BYTES
      ) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Header value limit exceeded",
        });
      }
    }
  });

/** 非空请求脚本必须返回的部分请求信封。 */
export const apiUpstreamRequestEnvelopeSchema = z
  .object({
    query: apiUpstreamQuerySchema.optional(),
    headers: apiUpstreamBusinessHeadersSchema.optional(),
    body: apiUpstreamJsonValueSchema.optional(),
  })
  .strict();

/** 请求脚本信封。 */
export type ApiUpstreamRequestEnvelope = z.infer<
  typeof apiUpstreamRequestEnvelopeSchema
>;

/** 请求脚本实际接收的内置 Query；输入阶段不允许使用删除标记 null。 */
const apiUpstreamRequestInputQuerySchema = apiUpstreamQuerySchema.refine(
  (query) => Object.values(query).every((value) => value !== null),
  { message: "Request input Query must not contain null" }
);

/** 管理测试器和生产运行时共享的请求脚本输入。 */
export const apiUpstreamRequestInputSchema = z
  .object({
    query: apiUpstreamRequestInputQuerySchema,
    body: apiUpstreamJsonValueSchema.optional(),
  })
  .strict();

/** 请求脚本输入。 */
export type ApiUpstreamRequestInput = z.infer<
  typeof apiUpstreamRequestInputSchema
>;

/** 判断供应商操作是否属于查询阶段。 */
export function isApiUpstreamQueryOperation(
  operation: ApiUpstreamAdapterOperationId
): boolean {
  return operation.endsWith(".query") || operation === "videos.query";
}

/** 判断供应商操作是否产生图片。 */
export function isApiUpstreamImageOperation(
  operation: ApiUpstreamAdapterOperationId
): boolean {
  return operation.startsWith("images.");
}

/**
 * 解析请求脚本输出，并阻止 GET 查询操作产生请求体。
 *
 * @param operation 固定供应商适配操作。
 * @param value QuickJS 返回的未知值。
 * @returns 经严格校验的部分请求信封。
 * @throws ZodError 当输出不是安全信封或 GET 携带正文。
 */
export function parseApiUpstreamRequestEnvelope(
  operation: ApiUpstreamAdapterOperationId,
  value: unknown
): ApiUpstreamRequestEnvelope {
  const parsedOperation = apiUpstreamAdapterOperationIdSchema.parse(operation);
  const envelope = apiUpstreamRequestEnvelopeSchema.parse(value);
  if (
    isApiUpstreamQueryOperation(parsedOperation) &&
    envelope.body !== undefined
  ) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["body"],
        message: "GET query operations must not include a body",
      },
    ]);
  }
  return envelope;
}

/** 请求或响应脚本可见的脱敏只读上下文。 */
export const apiUpstreamScriptContextSchema = z
  .object({
    operation: apiUpstreamAdapterOperationIdSchema,
    stage: z.enum(["request", "response"]),
    contentType: z.enum(["application/json", "multipart/form-data"]),
    platformModelId: z.string().trim().min(1).max(240),
    upstreamModelId: z.string().trim().min(1).max(240),
    taskId: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();

/** 脚本可见的脱敏上下文。 */
export type ApiUpstreamScriptContext = z.infer<
  typeof apiUpstreamScriptContextSchema
>;

/** 响应脚本只能读取的四个安全 Header。 */
const apiUpstreamResponseHeadersSchema = z
  .object({
    "content-type": z.string().optional(),
    "retry-after": z.string().optional(),
    "request-id": z.string().optional(),
    "x-request-id": z.string().optional(),
  })
  .strict();

/** 管理测试器和生产运行时共享的响应脚本输入。 */
export const apiUpstreamResponseInputSchema = z
  .object({
    statusCode: z.number().int().min(100).max(599),
    headers: apiUpstreamResponseHeadersSchema,
    body: apiUpstreamJsonValueSchema,
  })
  .strict();

/** 响应脚本输入。 */
export type ApiUpstreamResponseInput = z.infer<
  typeof apiUpstreamResponseInputSchema
>;

/** 标准媒体输出只允许可由宿主安全下载的绝对 HTTP(S) URL。 */
const apiUpstreamMediaUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//iu.test(value), {
    message: "Media output URL must use HTTP or HTTPS",
  });

const imageOutputSchema = z
  .object({
    kind: z.literal("image"),
    url: apiUpstreamMediaUrlSchema.optional(),
    base64: z.string().min(1).optional(),
    mediaType: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (Boolean(output.url) === Boolean(output.base64)) {
      ctx.addIssue({
        code: "custom",
        message: "Image output requires exactly one of url or base64",
      });
    }
    if (output.mediaType !== undefined && output.base64 === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["mediaType"],
        message: "mediaType is only valid for base64 image output",
      });
    }
  });

const videoOutputSchema = z
  .object({
    kind: z.literal("video"),
    url: apiUpstreamMediaUrlSchema,
  })
  .strict();

/** 上游失败的稳定分类。 */
export const API_UPSTREAM_ERROR_CATEGORIES = [
  "invalid_request",
  "authentication",
  "permission",
  "rate_limit",
  "capacity",
  "moderation",
  "not_found",
  "timeout",
  "upstream",
  "unknown",
] as const;

const standardErrorSchema = z
  .object({
    category: z.enum(API_UPSTREAM_ERROR_CATEGORIES),
    code: z.string().regex(STABLE_ERROR_CODE_PATTERN),
    adminDetails: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();

const pendingResultSchema = z
  .object({
    status: z.enum(["pending", "processing"]),
    taskId: z.string().trim().min(1).max(1_024).optional(),
    progress: z.number().min(0).max(100).optional(),
    pollAfterSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict();

const failedResultSchema = z
  .object({
    status: z.literal("failed"),
    error: standardErrorSchema,
    retryable: z.boolean().default(false),
  })
  .strict();

/**
 * 为指定操作构造严格的标准响应结果 schema。
 *
 * @param operation 固定供应商适配操作。
 * @returns 带媒体类型和生成 task ID 约束的响应 schema。
 */
export function apiUpstreamResponseResultForOperationSchema(
  operation: ApiUpstreamAdapterOperationId
) {
  const parsedOperation = apiUpstreamAdapterOperationIdSchema.parse(operation);
  const completedResultSchema = z
    .object({
      status: z.literal("completed"),
      outputs: z
        .array(
          isApiUpstreamImageOperation(parsedOperation)
            ? imageOutputSchema
            : videoOutputSchema
        )
        .min(1),
    })
    .strict();
  return z
    .discriminatedUnion("status", [
      pendingResultSchema,
      completedResultSchema,
      failedResultSchema,
    ])
    .superRefine((result, ctx) => {
      if (
        (result.status === "pending" || result.status === "processing") &&
        !isApiUpstreamQueryOperation(parsedOperation) &&
        result.taskId === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["taskId"],
          message: "Generation responses require taskId before polling",
        });
      }
      if (
        result.status === "failed" &&
        isApiUpstreamQueryOperation(parsedOperation) &&
        result.retryable
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["retryable"],
          message: "Query failures cannot resubmit generation",
        });
      }
    });
}

/** 六个操作共享的标准响应结果。 */
export type ApiUpstreamResponseResult = z.infer<
  ReturnType<typeof apiUpstreamResponseResultForOperationSchema>
>;

/** 标准图片脚本响应结果；保留媒体调用方的语义化别名。 */
export type ApiUpstreamImageResponseResult = ApiUpstreamResponseResult;
