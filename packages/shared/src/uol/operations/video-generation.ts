/**
 * UOL Operations - 视频生成与状态查询。
 *
 * 职责：定义跨 Web、外部 API 与 MCP 的严格视频契约；真实任务、财务、调度和归属
 * 实现在 apps/web 通过 late binding 注入。本文件不依赖数据库或 Web 运行时。
 */
import { z } from "zod";

import { mediaInputReferencesSchema } from "../../image-generation/media-contract";
import type { Principal } from "../principal";
import { defineOperation } from "../registry";

/** video.generate 的传输无关输入契约。 */
export const videoGenerateInputSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
    prompt: z.string().trim().min(1).max(100_000),
    negativePrompt: z.string().max(100_000).optional(),
    model: z.string().trim().min(1).max(120),
    backendGroupId: z.string().trim().min(1).max(128).optional(),
    inputImages: mediaInputReferencesSchema.max(3).optional(),
  })
  .strict();

/** video.getStatus 的归属查询输入契约。 */
export const videoGetStatusInputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(128),
  })
  .strict();

/** 根据 Principal 推导站内或外部视频能力。 */
function deriveVideoCapability(principal: Principal): string[] {
  return [
    principal.type === "apiKey"
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
