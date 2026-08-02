/**
 * UOL Operations - 视频生成与状态查询。
 *
 * 职责：定义跨 Web、外部 API 与 MCP 的严格视频契约；真实任务、财务、调度和归属
 * 实现在 apps/web 通过 late binding 注入。本文件不依赖数据库或 Web 运行时。
 */
import { z } from "zod";

import {
  MAX_MEDIA_INPUT_COUNT,
  mediaInputReferenceSchema,
  mediaInputReferencesSchema,
} from "../../image-generation/media-contract";
import {
  resolveEffectiveVideoModelCapability,
  type VideoModelCapabilityDescriptor,
  validateVideoModelParameters,
  videoAspectRatioSchema,
  videoListCapabilitiesOutputSchema,
  videoModelIdSchema,
  videoResolutionSchema,
} from "../../video-generation";
import { isExternalApiKeyPrincipal, type Principal } from "../principal";
import { defineOperation } from "../registry";

export {
  videoCapabilityItemSchema,
  videoListCapabilitiesOutputSchema,
} from "../../video-generation/public-capabilities";

/** video.generate 的传输无关输入契约。 */
export const videoGenerateInputSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
    prompt: z.string().trim().min(1).max(100_000),
    negativePrompt: z.string().max(100_000).optional(),
    generateAudio: z.boolean().optional(),
    model: videoModelIdSchema,
    duration: z.number().int().positive(),
    aspectRatio: videoAspectRatioSchema,
    resolution: videoResolutionSchema,
    backendGroupId: z.string().trim().min(1).max(128).optional(),
    firstFrame: mediaInputReferenceSchema.optional(),
    lastFrame: mediaInputReferenceSchema.optional(),
    referenceImages: mediaInputReferencesSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const parameters = validateVideoModelParameters(input);
    if (!parameters.ok) {
      context.addIssue({
        code: "custom",
        message: parameters.error.message,
        path: [parameters.error.field],
      });
      return;
    }
    const capability = parameters.capability;
    if (input.generateAudio === true && !capability.audio.supported) {
      context.addIssue({
        code: "custom",
        message: "This video model does not support audio generation",
        path: ["generateAudio"],
      });
    }
    if (input.lastFrame && !input.firstFrame) {
      context.addIssue({
        code: "custom",
        message: "lastFrame requires firstFrame",
        path: ["lastFrame"],
      });
    }
    if (input.firstFrame && capability.input.frames === "none") {
      context.addIssue({
        code: "custom",
        message: "This video model does not support frame inputs",
        path: ["firstFrame"],
      });
    }
    if (
      input.lastFrame &&
      capability.input.frames !== "first-and-optional-last"
    ) {
      context.addIssue({
        code: "custom",
        message: "This video model does not support lastFrame",
        path: ["lastFrame"],
      });
    }
    const referenceCount = input.referenceImages?.length ?? 0;
    if (referenceCount > 0 && capability.input.referenceImages.maxCount === 0) {
      context.addIssue({
        code: "custom",
        message: "This video model does not support reference images",
        path: ["referenceImages"],
      });
    }
    if (
      referenceCount > capability.input.referenceImages.maxCount &&
      !capability.input.referenceImages.configurable
    ) {
      context.addIssue({
        code: "custom",
        message: `This video model supports at most ${capability.input.referenceImages.maxCount} reference images`,
        path: ["referenceImages"],
      });
    }
    if ((input.firstFrame || input.lastFrame) && referenceCount > 0) {
      context.addIssue({
        code: "custom",
        message: "Frame inputs and reference images are mutually exclusive",
        path: ["referenceImages"],
      });
    }
  });

/** video.generate 经静态 schema 收窄后的输入。 */
export type VideoGenerateInput = z.infer<typeof videoGenerateInputSchema>;

/** UOL 动态能力解析后的规范视频请求。 */
export type CanonicalVideoGenerateInput = Omit<
  VideoGenerateInput,
  "generateAudio"
> & {
  generateAudio: boolean;
};

/** Seedance 动态参考图上限失败的稳定结构。 */
export type VideoGenerateCapabilityError = {
  code: "too_many_reference_images";
  field: "referenceImages";
  message: string;
  maximum: number;
  received: number;
};

/** 动态能力解析结果；设置脏值继续由 Zod 显式抛出，不能静默回退。 */
export type CanonicalVideoGenerateInputResult =
  | {
      ok: true;
      input: CanonicalVideoGenerateInput;
      capability: VideoModelCapabilityDescriptor;
    }
  | { ok: false; error: VideoGenerateCapabilityError };

/**
 * 为历史任务重放解析不随动态上限变化的规范默认值。
 *
 * @param input - 已通过静态视频请求 schema 的输入。
 * @returns 只补齐静态声音默认值的规范身份；保留全部具名输入与顺序。
 * @sideEffects 无。
 * @throws ZodError 静态目录损坏时 fail closed；不得用于放行新任务的动态数量校验。
 */
export function normalizeVideoGenerateInputForReplay(
  input: VideoGenerateInput
): CanonicalVideoGenerateInput {
  const capability = resolveEffectiveVideoModelCapability(
    input.model,
    undefined
  );
  return {
    ...input,
    generateAudio: input.generateAudio ?? capability.audio.defaultEnabled,
  };
}

/**
 * 应用运行时能力覆盖并解析声音默认值。
 *
 * @param input - 已通过 videoGenerateInputSchema 的静态规范请求。
 * @param capabilityOverrides - 系统设置中的未知覆盖值；缺行使用默认 10，脏值抛错。
 * @returns 动态数量合法时返回规范请求和有效能力，超量时返回稳定错误。
 * @sideEffects 无。
 * @throws ZodError 覆盖设置存在但损坏时 fail closed。
 */
export function resolveCanonicalVideoGenerateInput(
  input: VideoGenerateInput,
  capabilityOverrides: unknown
): CanonicalVideoGenerateInputResult {
  const capability = resolveEffectiveVideoModelCapability(
    input.model,
    capabilityOverrides
  );
  const referenceCount = input.referenceImages?.length ?? 0;
  if (referenceCount > capability.input.referenceImages.maxCount) {
    return {
      ok: false,
      error: {
        code: "too_many_reference_images",
        field: "referenceImages",
        message: `This video model supports at most ${capability.input.referenceImages.maxCount} reference images`,
        maximum: capability.input.referenceImages.maxCount,
        received: referenceCount,
      },
    };
  }
  return {
    ok: true,
    capability,
    input: {
      ...input,
      generateAudio: input.generateAudio ?? capability.audio.defaultEnabled,
    },
  };
}

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

/** 能力查询允许站内用户显式选择可信分组；API Key 绑定由 execute 强制收口。 */
export const videoListCapabilitiesInputSchema = z
  .object({
    backendGroupId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** 视频任务输入摘要；回调与列表只消费模式和数量，不含 URL 或存储身份。 */
export const videoInputSummarySchema = z
  .object({
    mode: z.enum(["none", "first-frame", "first-last-frames", "references"]),
    count: z.number().int().min(0).max(MAX_MEDIA_INPUT_COUNT),
  })
  .strict();

/** human-only 视频输入详情查询。 */
export const videoGetInputsInputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(128),
  })
  .strict();

const videoInputAssetSchema = z
  .object({
    url: z.string().url(),
    mimeType: z.string().trim().min(1).max(128),
  })
  .strict();

/** human-only 视频输入详情输出；签名 URL 是短期读取能力，不返回 bucket/key。 */
export const videoGetInputsOutputSchema = z
  .object({
    taskId: z.string(),
    summary: videoInputSummarySchema,
    firstFrame: videoInputAssetSchema.optional(),
    lastFrame: videoInputAssetSchema.optional(),
    referenceImages: z.array(videoInputAssetSchema).optional(),
  })
  .strict();

/** 账号删除链路登记输入资产清理意图的幂等输入。 */
export const videoRequestAccountInputCleanupInputSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
  })
  .strict();

/** 根据已校验输入与 Principal 推导视频和显式分组选择能力。 */
function deriveVideoCapabilities(
  input: unknown,
  principal: Principal
): string[] {
  const capabilities = [
    isExternalApiKeyPrincipal(principal)
      ? "externalApi.videos.generate"
      : "imageGeneration.video",
  ];
  if (
    !isExternalApiKeyPrincipal(principal) &&
    typeof input === "object" &&
    input !== null &&
    "backendGroupId" in input &&
    typeof input.backendGroupId === "string"
  ) {
    capabilities.push("backendGroups.select");
  }
  return capabilities;
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
    { derive: (input, principal) => deriveVideoCapabilities(input, principal) },
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

/** 查询全局视频能力与当前 Principal 的配置可达性。 */
export const videoListCapabilities = defineOperation({
  name: "video.listCapabilities",
  domain: "image-generation",
  title: "查询视频模型能力",
  description:
    "返回真实视频模型、独立参数、输入与声音能力，以及当前可信分组是否已配置可达；不返回成员、凭据、健康、并发或实时容量。",
  input: videoListCapabilitiesInputSchema,
  output: videoListCapabilitiesOutputSchema,
  access: { kind: "protected" },
  capabilities: [
    { derive: (input, principal) => deriveVideoCapabilities(input, principal) },
  ],
  allowSystemCapabilityBypass: true,
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: video.listCapabilities");
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
    model: videoModelIdSchema,
    duration: z.number().int().positive(),
    aspectRatio: videoAspectRatioSchema,
    resolution: videoResolutionSchema,
    generateAudio: z.boolean(),
    input: videoInputSummarySchema,
    progress: z.number().min(0).max(100).optional(),
    videoUrl: z.string().url().optional(),
    error: z.string().optional(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
  }),
  access: { kind: "owner", resource: "video task" },
  capabilities: [
    { derive: (input, principal) => deriveVideoCapabilities(input, principal) },
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

/** 读取任务自有的实际输入图；owner 与管理员授权在 binding 中统一校验。 */
export const videoGetInputs = defineOperation({
  name: "video.getInputs",
  domain: "image-generation",
  title: "查看视频任务输入",
  description:
    "为任务所有者或具备管理历史权限的管理员返回任务清单白名单对象的短期读取 URL。",
  input: videoGetInputsInputSchema,
  output: videoGetInputsOutputSchema,
  access: { kind: "owner", resource: "video task inputs" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: video.getInputs");
  },
});

/** 账号删除链路登记持久输入清理意图，不提供独立的用户删除任务功能。 */
export const videoRequestAccountInputCleanup = defineOperation({
  name: "video.requestAccountInputCleanup",
  domain: "storage",
  title: "登记账号视频输入清理",
  description:
    "在账号删除事务前幂等登记该账号视频输入的生命周期清理意图；活动任务等待终态后处理。",
  input: videoRequestAccountInputCleanupInputSchema,
  output: z
    .object({
      cleanupRequestId: z.string(),
      status: z.enum(["queued", "existing"]),
    })
    .strict(),
  access: { kind: "protected" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-user",
  },
  sideEffects: ["storage", "queue", "audit"],
  execute: async () => {
    throw new Error("Not yet wired: video.requestAccountInputCleanup");
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
