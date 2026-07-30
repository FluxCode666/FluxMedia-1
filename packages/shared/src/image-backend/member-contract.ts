/**
 * 统一媒体后端成员输入契约。
 *
 * 职责：为 UOL、管理后台和数据库服务提供唯一的成员保存 schema，以 `api | adobe`
 * 区分顶层成员，并用严格的类型专属配置阻止旧 Web、Responses 与 Adobe 双重身份字段
 * 重新进入系统。调度器只消费公共字段和显式模型能力，不在本模块做模型前缀分流。
 */
import { z } from "zod";

import { normalizeVideoModelId } from "../video-generation/contracts";
import {
  apiModelMappingsSchema,
  apiRequestTransformScriptSchema,
} from "./api-upstream-adaptation";
import {
  isLegacyVideoModelId,
  normalizeSupportedModelIds,
  supportedModelIdsSchema,
} from "./supported-models";

/** 管理员配置的媒体上游可使用 HTTP 或 HTTPS，不限制目标网络范围。 */
const mediaUpstreamUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Media upstream URL must use HTTP or HTTPS" }
  );

/** 顶层媒体后端成员类型；不得再增加 Web/Codex 等身份。 */
export const BACKEND_MEMBER_TYPES = ["api", "adobe"] as const;

/** 顶层媒体后端成员类型。 */
export type BackendMemberType = (typeof BACKEND_MEMBER_TYPES)[number];

/** API 成员支持 OpenAI 风格的 Images 与平台 Videos 兼容协议。 */
export const apiBackendMemberConfigSchema = z
  .object({
    baseUrl: mediaUpstreamUrlSchema,
    apiKey: z.string().trim().min(1).max(8_192).optional(),
    useStream: z.boolean().default(false),
    modelMappings: apiModelMappingsSchema,
    requestTransformScript: apiRequestTransformScriptSchema,
  })
  .strict();

/** Adobe gateway 成员配置；只承接图片协议。 */
export const adobeGatewayMemberConfigSchema = z
  .object({
    mode: z.literal("gateway"),
    baseUrl: mediaUpstreamUrlSchema,
    apiKey: z.string().trim().min(1).max(8_192).optional(),
    defaultRatio: z.string().trim().min(1).max(20),
    defaultResolution: z.string().trim().min(1).max(20),
    gptImageQuality: z.enum(["low", "medium", "high"]),
  })
  .strict();

/** Adobe direct 成员配置；一个顶层成员恰好持有一个 Adobe Cookie。 */
export const adobeDirectMemberConfigSchema = z
  .object({
    mode: z.literal("direct"),
    cookie: z.string().trim().min(1).max(64_000).optional(),
    scope: z.string().trim().min(1).max(4_096).optional(),
    defaultRatio: z.string().trim().min(1).max(20),
    defaultResolution: z.string().trim().min(1).max(20),
    gptImageQuality: z.enum(["low", "medium", "high"]),
  })
  .strict();

/** Adobe 类型专属配置。 */
export const adobeBackendMemberConfigSchema = z.discriminatedUnion("mode", [
  adobeGatewayMemberConfigSchema,
  adobeDirectMemberConfigSchema,
]);

const commonBackendMemberFields = {
  id: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(120),
  groupIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
  supportedModelIds: supportedModelIdsSchema
    .min(1)
    .transform((value) => normalizeSupportedModelIds(value))
    .refine((value) => value.length > 0, {
      message: "At least one supported model ID is required",
    }),
  contentSafetyEnabled: z.boolean(),
  isEnabled: z.boolean(),
  alwaysActive: z.boolean(),
  failureCooldownEnabled: z.boolean(),
  priority: z.number().int().min(0).max(10_000),
  concurrency: z.number().int().min(1).max(10_000),
};

const apiBackendMemberInputSchema = z
  .object({
    ...commonBackendMemberFields,
    type: z.literal("api"),
    config: apiBackendMemberConfigSchema,
  })
  .strict();

const adobeBackendMemberInputSchema = z
  .object({
    ...commonBackendMemberFields,
    type: z.literal("adobe"),
    config: adobeBackendMemberConfigSchema,
  })
  .strict();

/**
 * 统一成员保存 schema。
 *
 * API 与 Adobe direct 可声明真实视频模型；Adobe gateway 暂不具备视频执行闭环。
 * 所有可执行成员都拒绝迁移前复合视频身份，避免参数重新编码进模型 ID。
 */
export const backendMemberInputSchema = z
  .discriminatedUnion("type", [
    apiBackendMemberInputSchema,
    adobeBackendMemberInputSchema,
  ])
  .superRefine((member, context) => {
    if (member.type === "api") {
      const supportedModelIds = new Set(
        member.supportedModelIds.map((modelId) => modelId.toLowerCase())
      );
      for (const [index, mapping] of member.config.modelMappings.entries()) {
        if (supportedModelIds.has(mapping.modelId.toLowerCase())) continue;
        context.addIssue({
          code: "custom",
          path: ["config", "modelMappings", index, "modelId"],
          message: "Model mapping source must be a supported model ID",
        });
      }
    }
    if (
      member.type === "adobe" &&
      member.config.mode === "direct" &&
      member.id === undefined &&
      member.config.cookie === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["config", "cookie"],
        message: "A new Adobe direct member requires a Cookie",
      });
    }
    if (member.type === "api" || member.config.mode === "direct") {
      for (const [index, modelId] of member.supportedModelIds.entries()) {
        if (!isLegacyVideoModelId(modelId)) continue;
        context.addIssue({
          code: "custom",
          path: ["supportedModelIds", index],
          message: "Video models must use a real model ID",
        });
      }
      return;
    }
    for (const [index, modelId] of member.supportedModelIds.entries()) {
      if (!normalizeVideoModelId(modelId) && !isLegacyVideoModelId(modelId)) {
        continue;
      }
      context.addIssue({
        code: "custom",
        path: ["supportedModelIds", index],
        message: "Video models require an API or Adobe direct member",
      });
    }
  });

/** 统一成员保存输入类型。 */
export type BackendMemberInput = z.infer<typeof backendMemberInputSchema>;
