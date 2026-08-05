/**
 * UOL Operations - image-generation 域
 *
 * 职责：注册图像生成领域的所有操作定义到全局注册表。
 * 包含：统一管线核心、Server Action 简化入口、删除、状态查询、
 * 历史/画廊/统计查询族、后端配置解析、Web 候选图选定。
 *
 * 使用方：operations/index.ts 副作用导入触发注册；
 * invoke.ts 通过 getOperation 获取并执行。
 *
 * 关键依赖：../registry.ts（defineOperation）、zod（schema）
 *
 * 注意：execute 函数均为 STUB，Phase 2 接线时替换为真实 service 委托。
 * 不从 apps/web 或 @repo/database 导入任何内容。
 */
import { z } from "zod";

import {
  adminHistoryListInputSchema,
  adminHistoryListOutputSchema,
  adminHistoryRequestSnapshotInputSchema,
  adminHistoryRequestSnapshotOutputSchema,
  historyListInputSchema,
  historyListOutputSchema,
} from "../../image-generation/history-contract";
import {
  mediaInputReferenceSchema,
  mediaInputReferencesSchema,
} from "../../image-generation/media-contract";
import { imageModelIdSchema } from "../../image-generation/model-contract";
import { isExternalApiKeyPrincipal, type Principal } from "../principal";
import { defineOperation } from "../registry";

const imageGenerateCommonFields = {
  prompt: z.string().trim().min(1).max(100_000),
  negativePrompt: z.string().max(100_000).optional(),
  apiPrompt: z.string().trim().min(1).max(8_000).optional(),
  promptOptimization: z.boolean().optional(),
  model: imageModelIdSchema,
  size: z.string().trim().min(1).max(40).optional(),
  quality: z.string().trim().min(1).max(40).optional(),
  style: z.string().trim().min(1).max(80).optional(),
  thinking: z
    .enum(["minimal", "none", "low", "medium", "high", "xhigh"])
    .optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  background: z.enum(["transparent", "opaque", "auto"]).optional(),
  transparentMatte: z.boolean().optional(),
  moderationPromptRepair: z.boolean().optional(),
  hdRepair: z.boolean().optional(),
  blockRepair: z.boolean().optional(),
  repairPrompt: z.string().max(8_000).optional(),
  count: z.number().int().positive().max(10_000).optional(),
  generationId: z.string().trim().min(1).max(128),
  /** 本次请求明确选中的平台媒体后端分组；服务端仍会再次授权。 */
  backendGroupId: z.string().trim().min(1).max(128).optional(),
};

const textImageGenerateInputSchema = z
  .object({
    ...imageGenerateCommonFields,
    operation: z.literal("generate"),
  })
  .strict();

const imageEditInputSchema = z
  .object({
    ...imageGenerateCommonFields,
    operation: z.literal("edit"),
    images: mediaInputReferencesSchema,
  })
  .strict();

const maskedImageEditInputSchema = z
  .object({
    ...imageGenerateCommonFields,
    operation: z.literal("mask"),
    images: mediaInputReferencesSchema,
    mask: mediaInputReferenceSchema,
  })
  .strict();

/** image.generate 的传输无关联合契约；身份和治理策略均不由客户端提供。 */
export const imageGenerateInputSchema = z.discriminatedUnion("operation", [
  textImageGenerateInputSchema,
  imageEditInputSchema,
  maskedImageEditInputSchema,
]);

/** image.generate 的严格联合输入类型。 */
export type ImageGenerateOperationInput = z.infer<
  typeof imageGenerateInputSchema
>;

/** image.generate 的稳定媒体结果契约。 */
export const imageGenerateOutputSchema = z.object({
  generationId: z.string(),
  images: z.array(
    z.object({
      url: z.string(),
      revisedPrompt: z.string().optional(),
      size: z.string().optional(),
      promptRepairNotice: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      outputRole: z.enum(["final", "choice"]).optional(),
    })
  ),
  creditsUsed: z.number().optional(),
  model: z.string().optional(),
  size: z.string().optional(),
  revisedPrompt: z.string().optional(),
  promptRepairNotice: z.string().optional(),
});

/** image.generate 的稳定媒体结果类型。 */
export type ImageGenerateOperationOutput = z.infer<
  typeof imageGenerateOutputSchema
>;

/** 图片异步任务 ID；由服务端生成并同时作为 PostgreSQL 主键与 MQ 幂等键。 */
export const imageAsyncTaskIdSchema = z
  .string()
  .trim()
  .regex(/^task_[a-zA-Z0-9_-]+$/)
  .max(128);

/** 图片异步任务的持久状态；Redis 不保存或推导此状态。 */
export const imageAsyncTaskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);

/** 创建图片异步任务的传输无关输入。 */
export const imageEnqueueAsyncInputSchema = z
  .object({
    taskId: imageAsyncTaskIdSchema,
    generationInput: imageGenerateInputSchema,
    responseFormat: z.enum(["url", "b64_json"]),
    callbackUrl: z.string().url().max(2_048).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const generationInput = input.generationInput;
    if (generationInput.count !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["generationInput", "count"],
        message: "Async image tasks do not accept batch count",
      });
    }
    if (generationInput.operation !== "generate") {
      const references =
        generationInput.operation === "mask"
          ? [...generationInput.images, generationInput.mask]
          : generationInput.images;
      for (const [referenceIndex, reference] of references.entries()) {
        if (reference.source === "storage") continue;
        context.addIssue({
          code: "custom",
          path: ["generationInput", "media", referenceIndex],
          message: "Async image media must be persisted as storage references",
        });
      }
    }
  });

/** 图片异步任务的稳定编排视图，不包含提示词、凭据或媒体引用。 */
export const imageAsyncTaskOutputSchema = z.object({
  taskId: imageAsyncTaskIdSchema,
  model: z.string().trim().min(1).max(256),
  operation: z.enum(["generate", "edit", "mask"]),
  status: imageAsyncTaskStatusSchema,
  generationId: z.string().trim().min(1).max(128),
  responseFormat: z.enum(["url", "b64_json"]),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  error: z.string().max(2_000).nullable(),
});

/** image.enqueueAsync 的严格输入类型。 */
export type ImageEnqueueAsyncInput = z.infer<
  typeof imageEnqueueAsyncInputSchema
>;

/** 图片异步任务的稳定输出类型。 */
export type ImageAsyncTaskOutput = z.infer<typeof imageAsyncTaskOutputSchema>;

type ImageGenerateOperation = z.infer<
  typeof imageGenerateInputSchema
>["operation"];

/** 各图片动作对应的站内、外部 API 套餐能力。 */
const IMAGE_CAPABILITIES_BY_OPERATION: Record<
  ImageGenerateOperation,
  { internal: string; external: string }
> = {
  generate: {
    internal: "imageGeneration.text",
    external: "externalApi.images.generate",
  },
  edit: {
    internal: "imageGeneration.edit",
    external: "externalApi.images.edit",
  },
  mask: {
    internal: "imageGeneration.mask",
    external: "externalApi.images.mask",
  },
};

/** 根据媒体变体和 Principal 推导站内或外部 API 套餐能力。 */
function deriveImageCapabilities(
  input: z.infer<typeof imageGenerateInputSchema>,
  principal: Principal
): string[] {
  const external = isExternalApiKeyPrincipal(principal);
  const operationCapabilities =
    IMAGE_CAPABILITIES_BY_OPERATION[input.operation];
  const capabilities = [
    external ? operationCapabilities.external : operationCapabilities.internal,
  ];
  if ((input.count ?? 1) > 1) {
    capabilities.push(
      external ? "externalApi.images.batch" : "imageGeneration.batch"
    );
  }
  return capabilities;
}

// ---------------------------------------------------------------------------
// 1. image.generate - 统一管线核心（runImageGenerationForUser）
// 5 个 v1 handler + 3 个 web 路由汇入的单一生图入口
// ---------------------------------------------------------------------------
export const imageGenerate = defineOperation<
  ImageGenerateOperationInput,
  ImageGenerateOperationOutput
>({
  name: "image.generate",
  domain: "image-generation",
  title: "图像生成（统一管线）",
  description:
    "统一图像生成管线核心。接受 prompt/参数，执行扣费、外呼生图后端、" +
    "存储结果、审核。所有传输层（v1 API / Server Action / Web 路由）" +
    "最终汇入此操作。",
  input: imageGenerateInputSchema,
  output: imageGenerateOutputSchema,
  access: { kind: "protected" },
  capabilities: [
    {
      derive: (input, principal) =>
        deriveImageCapabilities(
          input as ImageGenerateOperationInput,
          principal
        ),
    },
  ],
  allowSystemCapabilityBypass: true,
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "generationId",
    scope: "per-user",
  },
  sideEffects: ["billing", "storage", "external-call"],
  processLocalState: true,
  execute: async () => {
    throw new Error("Not yet wired: image.generate");
  },
});

// ---------------------------------------------------------------------------
// 1a. image.enqueueAsync - PostgreSQL 持久化后最佳努力投递 Redis MQ
// ---------------------------------------------------------------------------
export const imageEnqueueAsync = defineOperation<
  ImageEnqueueAsyncInput,
  ImageAsyncTaskOutput
>({
  name: "image.enqueueAsync",
  domain: "image-generation",
  title: "创建图片异步任务",
  description:
    "幂等创建 PostgreSQL 图片异步任务，并在数据库提交后最佳努力投递 Redis MQ。" +
    "媒体必须是 JSON-safe 引用；Redis 消息只包含 taskId。",
  input: imageEnqueueAsyncInputSchema,
  output: imageAsyncTaskOutputSchema,
  access: { kind: "protected" },
  capabilities: [
    {
      derive: (input, principal) => {
        const parsed = input as ImageEnqueueAsyncInput;
        return deriveImageCapabilities(parsed.generationInput, principal);
      },
    },
  ],
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "taskId",
    scope: "global",
  },
  sideEffects: ["queue", "storage"],
  execute: async () => {
    throw new Error("Not yet wired: image.enqueueAsync");
  },
});

// ---------------------------------------------------------------------------
// 1b. image.getAsyncTask - owner 读取 PostgreSQL 持久任务状态
// ---------------------------------------------------------------------------
export const imageGetAsyncTask = defineOperation({
  name: "image.getAsyncTask",
  domain: "image-generation",
  title: "查询图片异步任务",
  description:
    "从 PostgreSQL 查询图片异步任务编排状态；执行体必须同时校验 userId 与 API Key 域。",
  input: z
    .object({
      taskId: imageAsyncTaskIdSchema,
    })
    .strict(),
  output: imageAsyncTaskOutputSchema,
  access: { kind: "owner", resource: "image async task" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getAsyncTask");
  },
});

// ---------------------------------------------------------------------------
// 1c. image.processAsyncTask - 系统 Worker 按 taskId 恢复并执行任务
// ---------------------------------------------------------------------------
export const imageProcessAsyncTask = defineOperation({
  name: "image.processAsyncTask",
  domain: "image-generation",
  title: "处理图片异步任务",
  description:
    "仅供系统 Worker 调用。按 taskId 从 PostgreSQL 恢复已校验输入和 Principal 快照，" +
    "通过 image.generate 执行统一图片管线并原子收敛终态。",
  input: z
    .object({
      taskId: imageAsyncTaskIdSchema,
    })
    .strict(),
  output: imageAsyncTaskOutputSchema,
  access: { kind: "system" },
  allowSystemCapabilityBypass: true,
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "taskId",
    scope: "global",
  },
  sideEffects: ["billing", "storage", "external-call", "queue"],
  execute: async () => {
    throw new Error("Not yet wired: image.processAsyncTask");
  },
});

// ---------------------------------------------------------------------------
// 2. image.generateAction - Server Action 简化入口（generateImageAction）
// 仅单图，精简 schema，底层委托 image.generate
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.generateAction",
  domain: "image-generation",
  title: "图像生成（Server Action 简化）",
  description:
    "面向 UI 的简化生图操作，仅支持单图，精简参数。" +
    "底层委托统一管线 runImageGenerationForUser。",
  input: z.object({
    prompt: z.string().min(1),
    model: imageModelIdSchema,
    size: z.string().optional(),
    quality: z.string().optional(),
    style: z.string().optional(),
  }),
  output: z.object({
    generationId: z.string(),
    imageUrl: z.string(),
    revisedPrompt: z.string().optional(),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["billing", "storage", "external-call"],
  processLocalState: true,
  execute: async () => {
    throw new Error("Not yet wired: image.generateAction");
  },
});

// ---------------------------------------------------------------------------
// 3. image.delete - 删除生成记录及孤立图（deleteGenerationAction）
// 近似幂等：已删除的记录再次删除不报错
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.delete",
  domain: "image-generation",
  title: "删除生成记录",
  description:
    "删除用户的生成记录及其关联的存储对象（best-effort 清理）。" +
    "需校验资源归属，不涉及扣费。近似幂等。",
  input: z.object({
    generationId: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "owner", resource: "generation" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["storage"],
  execute: async () => {
    throw new Error("Not yet wired: image.delete");
  },
});

// ---------------------------------------------------------------------------
// 4. image.getStatus - 生成状态查询（getGenerationStatus）
// 纯读，幂等只读
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.getStatus",
  domain: "image-generation",
  title: "查询生成状态",
  description:
    "查询指定 generationId 的生成状态（pending/processing/completed/failed）。" +
    "纯只读操作，需校验资源归属。",
  input: z.object({
    generationId: z.string(),
  }),
  output: z.object({
    generationId: z.string(),
    status: z.enum(["pending", "processing", "completed", "failed"]),
    progress: z.number().optional(),
    error: z.string().optional(),
    completedAt: z.string().optional(),
  }),
  access: { kind: "owner", resource: "generation" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getStatus");
  },
});

// ---------------------------------------------------------------------------
// 5. image.listMyHistoryRecords - 当前会话用户的图片/视频统一历史
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.listMyHistoryRecords",
  domain: "image-generation",
  title: "获取本人统一生成历史",
  description:
    "按创建日期、模型、状态与产物类型读取当前会话用户的图片/视频历史。" +
    "身份只来自 Principal，返回安全详情、真实模型选项与双向 keyset cursor。",
  input: historyListInputSchema,
  output: historyListOutputSchema,
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.listMyHistoryRecords");
  },
});

// ---------------------------------------------------------------------------
// 6. image.listAdminHistoryRecords - 管理员全局图片/视频统一历史
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.listAdminHistoryRecords",
  domain: "image-generation",
  title: "获取全局统一生成历史",
  description:
    "按创建日期、用户邮箱、模型、状态与产物类型读取全站图片/视频历史。" +
    "仅三档人工管理员可调用，返回受控的所属用户与供应商账号身份、模型选项和双向 keyset cursor。",
  input: adminHistoryListInputSchema,
  output: adminHistoryListOutputSchema,
  access: {
    kind: "roles",
    roles: ["observer_admin", "admin", "super_admin"],
  },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.listAdminHistoryRecords");
  },
});

// ---------------------------------------------------------------------------
// 6a. image.getAdminHistoryRequestSnapshot - 管理员按需读取真实请求 JSON
// ---------------------------------------------------------------------------
export const imageGetAdminHistoryRequestSnapshot = defineOperation({
  name: "image.getAdminHistoryRequestSnapshot",
  domain: "image-generation",
  title: "获取全局生成记录请求快照",
  description:
    "按图片或视频记录 ID 读取请求脚本处理后的脱敏上游请求正文。" +
    "仅三档人工管理员可调用，旧记录或非 API 类型供应商返回空快照。",
  input: adminHistoryRequestSnapshotInputSchema,
  output: adminHistoryRequestSnapshotOutputSchema,
  access: {
    kind: "roles",
    roles: ["observer_admin", "admin", "super_admin"],
  },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getAdminHistoryRequestSnapshot");
  },
});

// ---------------------------------------------------------------------------
// 7. image.getUserGenerations - 用户生成历史（分页）
// 语义只读，可能触发过期 pending 清理（维护性写入）
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.getUserGenerations",
  domain: "image-generation",
  title: "获取用户生成历史",
  description:
    "分页获取用户的图像生成历史记录。" +
    "可能触发 expireStalePendingGenerations（维护性写入）。",
  input: z.object({
    userId: z.string(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().optional(),
    status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
  }),
  output: z.object({
    generations: z.array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        status: z.string(),
        model: z.string().optional(),
        imageUrl: z.string().optional(),
        createdAt: z.string(),
      })
    ),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  hasMaintenanceWrite: true,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getUserGenerations");
  },
});

// ---------------------------------------------------------------------------
// 6. image.getUserGenerationCount - 用户生成总数
// 语义只读，可能触发过期清理
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.getUserGenerationCount",
  domain: "image-generation",
  title: "获取用户生成总数",
  description:
    "获取用户的图像生成总数。" +
    "可能触发 expireStalePendingGenerations（维护性写入）。",
  input: z.object({
    userId: z.string(),
  }),
  output: z.object({
    count: z.number(),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  hasMaintenanceWrite: true,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getUserGenerationCount");
  },
});

// ---------------------------------------------------------------------------
// 7. image.getUserRecentGenerations - 用户最近生成
// 语义只读，可能触发过期清理
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.getUserRecentGenerations",
  domain: "image-generation",
  title: "获取用户最近生成",
  description:
    "获取用户最近的图像生成记录（通常用于首页/仪表板展示）。" +
    "可能触发 expireStalePendingGenerations（维护性写入）。",
  input: z.object({
    userId: z.string(),
    limit: z.number().int().positive().optional(),
  }),
  output: z.object({
    generations: z.array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        status: z.string(),
        model: z.string().optional(),
        imageUrl: z.string().optional(),
        createdAt: z.string(),
      })
    ),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  hasMaintenanceWrite: true,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getUserRecentGenerations");
  },
});

// ---------------------------------------------------------------------------
// 8. image.getGenerationById - 按 ID 获取单条生成记录
// 语义只读
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.getGenerationById",
  domain: "image-generation",
  title: "按 ID 获取生成记录",
  description:
    "按 generationId 获取单条生成记录详情，含图片 URL、参数快照等。" +
    "需校验资源归属。",
  input: z.object({
    generationId: z.string(),
  }),
  output: z.object({
    id: z.string(),
    userId: z.string(),
    prompt: z.string(),
    negativePrompt: z.string().optional(),
    status: z.string(),
    model: z.string().optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    style: z.string().optional(),
    imageUrl: z.string().optional(),
    revisedPrompt: z.string().optional(),
    creditsUsed: z.number().optional(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  access: { kind: "owner", resource: "generation" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getGenerationById");
  },
});

// ---------------------------------------------------------------------------
// 9. image.getGenerationStats - 全局生成统计（管理员）
// 管理员专用统计视图
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.getGenerationStats",
  domain: "image-generation",
  title: "获取全局生成统计",
  description:
    "获取全局图像生成统计数据（总量、按模型/日期分布等）。" +
    "仅管理员可访问。",
  input: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    groupBy: z.enum(["day", "week", "month"]).optional(),
  }),
  output: z.object({
    totalGenerations: z.number(),
    totalCreditsUsed: z.number(),
    byModel: z.record(z.string(), z.number()).optional(),
    byDate: z
      .array(
        z.object({
          date: z.string(),
          count: z.number(),
          creditsUsed: z.number(),
        })
      )
      .optional(),
  }),
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getGenerationStats");
  },
});

// ---------------------------------------------------------------------------
// 10. image.getEffectiveConfig - 有效配置解析（getEffectiveConfig）
// 合并平台默认与请求参数后的最终配置
// ---------------------------------------------------------------------------
defineOperation({
  name: "image.getEffectiveConfig",
  domain: "image-generation",
  title: "获取有效生成配置",
  description:
    "合并平台默认配置、请求参数后的最终生效配置。" +
    "用于前端展示当前生效参数。解析幂等（池选号非确定）。",
  input: z.object({
    userId: z.string(),
    model: z.string().optional(),
    backendGroupId: z.string().optional(),
  }),
  output: z.object({
    model: z.string(),
    size: z.string(),
    quality: z.string(),
    style: z.string().optional(),
    backendGroupId: z.string().optional(),
    backendGroupName: z.string().optional(),
    maxCount: z.number(),
    availableModels: z.array(z.string()).optional(),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.getEffectiveConfig");
  },
});
