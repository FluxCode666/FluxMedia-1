/**
 * UOL Operations - 视频生成与状态查询。
 *
 * 职责：定义跨 Web、外部 API 与 MCP 的严格视频契约；真实任务、财务、调度和归属
 * 实现在 apps/web 通过 late binding 注入。本文件不依赖数据库或 Web 运行时。
 */
import { z } from "zod";

import {
  isFireflyVideoModelId,
  resolveFireflyVideoModel,
} from "../../adobe/firefly-direct/video-catalog";
import { mediaInputReferencesSchema } from "../../image-generation/media-contract";
import { isExternalApiKeyPrincipal, type Principal } from "../principal";
import { defineOperation } from "../registry";

/** video.generate 的传输无关输入契约。 */
export const videoGenerateInputSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
    prompt: z.string().trim().min(1).max(100_000),
    negativePrompt: z.string().max(100_000).optional(),
    generateAudio: z.boolean().optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((modelId) => isFireflyVideoModelId(modelId), {
        message: "Unsupported video model",
      }),
    backendGroupId: z.string().trim().min(1).max(128).optional(),
    inputImages: mediaInputReferencesSchema.max(3).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const model = resolveFireflyVideoModel(input.model);
    if (input.generateAudio === true && model && !model.supportsAudio) {
      context.addIssue({
        code: "custom",
        message: "This video model does not support audio generation",
        path: ["generateAudio"],
      });
    }
  });

/** video.getStatus 的归属查询输入契约。 */
export const videoGetStatusInputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(128),
  })
  .strict();

/** video.reconcileSubmission 的人工核对输入契约。 */
export const videoReconcileSubmissionInputSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("accepted"),
        taskId: z.string().trim().min(1).max(128),
        pollUrl: z.string().url().max(2_048),
        upstreamJobId: z.string().trim().min(1).max(512),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("not_accepted"),
        taskId: z.string().trim().min(1).max(128),
        reason: z.string().trim().min(1).max(1_000),
      })
      .strict(),
  ]
);

/** 待人工核对视频任务列表的受限输入。 */
export const videoListUncertainSubmissionsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

/** 根据 Principal 推导站内或外部视频能力。 */
function deriveVideoCapability(principal: Principal): string[] {
  return [
    isExternalApiKeyPrincipal(principal)
      ? "externalApi.videos.generate"
      : "imageGeneration.video",
  ];
}

/** 创建幂等视频任务；clientRequestId 的真实唯一域由 Principal 所有者决定。 */
export const videoGenerate = defineOperation({
  name: "video.generate",
  domain: "image-generation",
  title: "生成视频",
  description:
    "以 Principal 所有者作用域内的 clientRequestId 幂等创建视频任务，并进入统一媒体后端调度。",
  input: videoGenerateInputSchema,
  output: z.object({
    taskId: z.string(),
    status: z.enum([
      "pending",
      "submitting",
      "processing",
      "needs_attention",
      "completed",
      "failed",
    ]),
  }),
  access: { kind: "protected" },
  capabilities: [
    { derive: (_input, principal) => deriveVideoCapability(principal) },
  ],
  allowSystemCapabilityBypass: true,
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-principal",
  },
  sideEffects: ["billing", "storage", "external-call", "queue"],
  execute: async () => {
    throw new Error("Not yet wired: video.generate");
  },
});

/** 查询调用者拥有的视频任务；binding 必须调用 ctx.assertOwnership。 */
export const videoGetStatus = defineOperation({
  name: "video.getStatus",
  domain: "image-generation",
  title: "查询视频任务",
  description:
    "按任务 ID 查询视频生成状态与结果，并在执行层校验 Principal 归属。",
  input: videoGetStatusInputSchema,
  output: z.object({
    taskId: z.string(),
    status: z.enum([
      "pending",
      "submitting",
      "processing",
      "needs_attention",
      "completed",
      "failed",
    ]),
    progress: z.number().min(0).max(100).optional(),
    videoUrl: z.string().url().optional(),
    error: z.string().optional(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
  }),
  access: { kind: "owner", resource: "video task" },
  capabilities: [
    { derive: (_input, principal) => deriveVideoCapability(principal) },
  ],
  allowSystemCapabilityBypass: true,
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: video.getStatus");
  },
});

/**
 * 人工核对 Adobe 提交不确定任务。
 *
 * 只有确认上游接受后才能恢复原任务轮询；确认未接受后才触发幂等退款。
 */
export const videoReconcileSubmission = defineOperation({
  name: "video.reconcileSubmission",
  domain: "image-generation",
  title: "核对视频提交结果",
  description:
    "管理员人工核对 submit_uncertain 任务；确认接受时恢复原上游任务，确认未接受时幂等退款。",
  input: videoReconcileSubmissionInputSchema,
  output: z.object({
    taskId: z.string(),
    status: z.enum(["processing", "completed", "failed"]),
  }),
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["billing", "queue", "audit"],
  hasMaintenanceWrite: true,
  execute: async () => {
    throw new Error("Not yet wired: video.reconcileSubmission");
  },
});

/** 管理员读取待人工核对任务；不返回 prompt、token 值、Cookie 或回调地址。 */
export const videoListUncertainSubmissions = defineOperation({
  name: "video.listUncertainSubmissions",
  domain: "image-generation",
  title: "列出待核对视频提交",
  description:
    "列出 submit_uncertain 视频任务的安全诊断字段，供管理员调查后提交核对结论。",
  input: videoListUncertainSubmissionsInputSchema,
  output: z.object({
    items: z.array(
      z.object({
        taskId: z.string(),
        model: z.string(),
        backendMemberId: z.string().nullable(),
        error: z.string().nullable(),
        submitStartedAt: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
    ),
  }),
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: video.listUncertainSubmissions");
  },
});
