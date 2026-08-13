/**
 * API 账号上游适配配置契约。
 *
 * 职责：约束平台模型映射、认证方式、六操作路径及不可变版本配置。
 * 使用方：统一账号保存 UOL、管理端表单、运行时 API Images/Videos 适配器。
 * 本模块只处理非密钥配置与模型 ID，不执行脚本，也不接触网络。
 */
import { z } from "zod";

import {
  API_UPSTREAM_ADAPTER_OPERATION_IDS,
  API_UPSTREAM_MAX_SCRIPT_CHARACTERS,
  type ApiUpstreamAdapterOperationId,
  apiUpstreamScriptSourceSchema,
  isApiUpstreamQueryOperation,
  isBlockedApiUpstreamHeaderName,
} from "./api-upstream-script-contract";

/** 单个 API 账号允许保存的最大模型映射数量。 */
export const MAX_API_MODEL_MAPPINGS = 1_000;

/** API 视频创建默认允许的额外重试次数。 */
export const DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT = 2;

/** API 视频创建额外重试次数；实际请求上限始终为该值加一。 */
export const videoSubmissionRetryCountSchema = z
  .number()
  .int()
  .min(0)
  .max(10)
  .default(DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT);

/** 单个账号请求处理脚本的最大 UTF-16 字符数。 */
export const MAX_API_REQUEST_TRANSFORM_SCRIPT_CHARACTERS =
  API_UPSTREAM_MAX_SCRIPT_CHARACTERS;

/** 平台真实模型 ID 到供应商上游模型 ID 的单条稀疏映射。 */
export const apiModelMappingSchema = z
  .object({
    modelId: z.string().trim().min(1).max(120),
    upstreamModelId: z.string().trim().min(1).max(240),
  })
  .strict();

/**
 * 账号级模型映射集合。
 *
 * 来源按大小写不敏感语义唯一；目标允许重复，以兼容供应商把多个公开模型聚合到同一
 * 上游模型的情况。来源是否属于账号支持模型由成员聚合契约继续校验。
 */
export const apiModelMappingsSchema = z
  .array(apiModelMappingSchema)
  .max(MAX_API_MODEL_MAPPINGS)
  .superRefine((mappings, context) => {
    const sourceIndexes = new Map<string, number>();
    for (const [index, mapping] of mappings.entries()) {
      const key = mapping.modelId.toLowerCase();
      const previousIndex = sourceIndexes.get(key);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "modelId"],
          message: `模型 ID 与第 ${previousIndex + 1} 条映射重复`,
        });
        continue;
      }
      sourceIndexes.set(key, index);
    }
  });

/** 同步 JavaScript 请求处理脚本；空白内容规范为空字符串。 */
export const apiRequestTransformScriptSchema = apiUpstreamScriptSourceSchema;

/** API 账号支持的四种宿主认证模式。 */
export const API_UPSTREAM_AUTH_MODES = [
  "bearer",
  "raw_authorization",
  "custom_header",
  "none",
] as const;

const authenticationHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
  .refine((value) => !isBlockedApiUpstreamHeaderName(value), {
    message: "Authentication Header name is reserved",
  });

/** 非密钥认证配置；凭据值始终由宿主从当前账号密钥读取。 */
export const apiUpstreamAuthenticationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("bearer") }).strict(),
  z.object({ mode: z.literal("raw_authorization") }).strict(),
  z
    .object({
      mode: z.literal("custom_header"),
      headerName: authenticationHeaderNameSchema,
    })
    .strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);

/** 六操作的内置相对路径；null 表示图片查询默认不受支持。 */
export const API_UPSTREAM_BUILT_IN_PATHS = {
  "images.generate": "/images/generations",
  "images.generate.query": null,
  "images.edit": "/images/edits",
  "images.edit.query": null,
  "videos.generate": "/videos/generations",
  "videos.query": "/videos/{task_id}",
} as const satisfies Record<ApiUpstreamAdapterOperationId, string | null>;

/** 创建六操作空脚本配置，供兼容输入、表单初值和迁移共同使用。 */
export function createDefaultApiUpstreamOperations(): ApiUpstreamOperations {
  return Object.fromEntries(
    API_UPSTREAM_ADAPTER_OPERATION_IDS.map((operation) => [
      operation,
      { path: "", requestScript: "", responseScript: "" },
    ])
  ) as ApiUpstreamOperations;
}

/**
 * 反复解码路径以识别双重编码的 dot segment；非法百分号编码直接拒绝。
 *
 * @param path 管理员配置的相对路径。
 * @returns 最多三轮解码后的路径。
 */
function decodePathForValidation(path: string): string {
  let decoded = path;
  for (let index = 0; index < 3; index += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

/** 判断路径是否包含 HTTP 路径不应出现的 ASCII 控制字符。 */
function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/**
 * 解析一个供应商操作的内置或管理员相对路径。
 *
 * @param operation 固定供应商适配操作。
 * @param rawPath 管理员输入；空白表示采用内置行为。
 * @returns 安全相对路径；空图片查询返回 null。
 * @throws Error 当路径可改变 origin、逃逸基址或违反 task ID 约束。
 */
export function resolveApiUpstreamOperationPath(
  operation: ApiUpstreamAdapterOperationId,
  rawPath: string
): string | null {
  const path = rawPath.trim();
  if (!path) return API_UPSTREAM_BUILT_IN_PATHS[operation];
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    containsAsciiControlCharacter(path)
  ) {
    throw new Error(
      "API upstream operation path must remain relative to baseUrl"
    );
  }
  let decoded: string;
  try {
    decoded = decodePathForValidation(path);
  } catch {
    throw new Error("API upstream operation path contains invalid encoding");
  }
  const decodedSegments = decoded.split("/");
  if (
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    decodedSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("API upstream operation path escapes baseUrl");
  }
  const taskPlaceholderCount = path.split("{task_id}").length - 1;
  if (isApiUpstreamQueryOperation(operation)) {
    if (taskPlaceholderCount !== 1) {
      throw new Error("API upstream query path requires one {task_id}");
    }
  } else if (taskPlaceholderCount !== 0) {
    throw new Error("API upstream generation path must not contain {task_id}");
  }
  return path;
}

/** 单个供应商操作的相对路径和双向脚本。 */
export const apiUpstreamOperationConfigSchema = z
  .object({
    path: z.string().max(2_048),
    requestScript: apiUpstreamScriptSourceSchema,
    responseScript: apiUpstreamScriptSourceSchema,
  })
  .strict();

/** 单个供应商操作配置。 */
export type ApiUpstreamOperationConfig = z.infer<
  typeof apiUpstreamOperationConfigSchema
>;

export const apiUpstreamOperationsSchema = z
  .object({
    "images.generate": apiUpstreamOperationConfigSchema,
    "images.generate.query": apiUpstreamOperationConfigSchema,
    "images.edit": apiUpstreamOperationConfigSchema,
    "images.edit.query": apiUpstreamOperationConfigSchema,
    "videos.generate": apiUpstreamOperationConfigSchema,
    "videos.query": apiUpstreamOperationConfigSchema,
  })
  .strict()
  .superRefine((operations, context) => {
    for (const operation of API_UPSTREAM_ADAPTER_OPERATION_IDS) {
      try {
        resolveApiUpstreamOperationPath(operation, operations[operation].path);
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: [operation, "path"],
          message:
            error instanceof Error ? error.message : "Invalid operation path",
        });
      }
    }
  });

/** 六个供应商操作配置。 */
export type ApiUpstreamOperations = z.infer<typeof apiUpstreamOperationsSchema>;

/** 管理表单和不可变版本共同使用的非密钥适配配置。 */
export const apiUpstreamAdapterDraftSchema = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "API upstream baseUrl must use HTTP or HTTPS",
        }
      ),
    useStream: z.boolean(),
    videoSubmissionRetryCount: videoSubmissionRetryCountSchema,
    modelMappings: apiModelMappingsSchema,
    authentication: apiUpstreamAuthenticationSchema,
    credentialScope: z.string().trim().min(1).max(512),
    operations: apiUpstreamOperationsSchema,
  })
  .strict();

/** 不含 API Key 的完整适配版本配置。 */
export type ApiUpstreamAdapterDraft = z.infer<
  typeof apiUpstreamAdapterDraftSchema
>;

/** 单条 API 账号模型映射。 */
export type ApiModelMapping = z.infer<typeof apiModelMappingSchema>;

/**
 * 清洗数据库或其他不可信来源中的模型映射。
 *
 * @param value - 未知 JSON 值。
 * @returns 完整且来源唯一的映射；非法配置返回空数组并由保存链拒绝继续写入。
 */
export function normalizeApiModelMappings(value: unknown): ApiModelMapping[] {
  const parsed = apiModelMappingsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * 解析一个 API 账号实际发送给供应商的模型 ID。
 *
 * @param platformModelId - 调度、计费和任务记录使用的平台真实模型 ID。
 * @param mappings - 当前账号的稀疏模型映射。
 * @returns 命中时返回保留供应商格式的上游 ID，否则原样返回平台 ID。
 */
export function resolveApiUpstreamModelId(
  platformModelId: string,
  mappings: unknown
): string {
  const key = platformModelId.trim().toLowerCase();
  const mapping = normalizeApiModelMappings(mappings).find(
    (candidate) => candidate.modelId.toLowerCase() === key
  );
  return mapping?.upstreamModelId ?? platformModelId;
}
