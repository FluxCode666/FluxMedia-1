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
  apiUpstreamAuthenticationSchema,
  apiUpstreamOperationsSchema,
  apiVideoInputCapabilitiesByModelSchema,
  apiVideoInputCapabilitiesSchema,
  apiVideoProtocolModeSchema,
  createDefaultApiUpstreamOperations,
  videoSubmissionRetryCountSchema,
} from "./api-upstream-adaptation";
import {
  isLegacyVideoModelId,
  supportedModelIdsSchema,
} from "./supported-models";

/** 供应商账号按模型声明的输出分辨率覆盖；缺失模型键表示继承全局模型能力。 */
export const backendModelResolutionCapabilitiesSchema = z
  .record(
    z.string().trim().min(1).max(240),
    z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(32)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
      )
      .min(1)
      .max(20)
  )
  .superRefine((value, context) => {
    for (const [modelId, resolutions] of Object.entries(value)) {
      const normalized = resolutions.map((resolution) =>
        resolution.toLowerCase()
      );
      if (new Set(normalized).size !== normalized.length) {
        context.addIssue({
          code: "custom",
          path: [modelId],
          message: "模型分辨率不能重复",
        });
      }
    }
  })
  .transform((value) =>
    Object.fromEntries(
      Object.entries(value).map(([modelId, resolutions]) => [
        modelId.trim().toLowerCase(),
        resolutions.map((resolution) => resolution.trim().toLowerCase()),
      ])
    )
  );

export type BackendModelResolutionCapabilities = z.infer<
  typeof backendModelResolutionCapabilitiesSchema
>;

/**
 * 规范成员提交的模型 ID，同时保留图像模型的精确身份。
 *
 * @param values - 已通过基础字符串边界的成员模型列表。
 * @returns 去空白、大小写无关去重的模型 ID；真实视频统一小写，图像不移除任何前缀。
 * @sideEffects 无。
 * @failure 不抛错；基础 schema 已保证元素均为非空字符串。
 */
function normalizeMemberSupportedModelIds(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    const normalized = normalizeVideoModelId(trimmed) ?? trimmed;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

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
    videoSubmissionRetryCount: videoSubmissionRetryCountSchema,
    /** 显式选择视频上游请求格式；旧成员缺失时安全沿用 custom。 */
    videoProtocolMode: apiVideoProtocolModeSchema,
    /** 旧适配版本的账号级能力；新保存始终保持关闭。 */
    videoInputCapabilities: apiVideoInputCapabilitiesSchema,
    /** 按平台模型 ID 声明的参考视频和参考音频输入能力。 */
    videoInputCapabilitiesByModel: apiVideoInputCapabilitiesByModelSchema,
    modelMappings: apiModelMappingsSchema,
    authentication: apiUpstreamAuthenticationSchema.default({
      mode: "bearer",
    }),
    credentialScope: z.string().trim().min(1).max(512).optional(),
    operations: apiUpstreamOperationsSchema.default(() =>
      createDefaultApiUpstreamOperations()
    ),
    expectedCurrentVersionId: z
      .string()
      .trim()
      .min(1)
      // 旧迁移版本由固定前缀和最长 128 字符成员 ID 组成。
      .max(256)
      .nullable()
      .optional(),
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
    .transform((value) => normalizeMemberSupportedModelIds(value))
    .refine((value) => value.length > 0, {
      message: "At least one supported model ID is required",
    }),
  supportedResolutionsByModel:
    backendModelResolutionCapabilitiesSchema.optional(),
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
      if (
        member.id !== undefined &&
        member.config.expectedCurrentVersionId === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["config", "expectedCurrentVersionId"],
          message: "Editing an API member requires the current adapter version",
        });
      }
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
      for (const modelId of Object.keys(
        member.config.videoInputCapabilitiesByModel
      )) {
        if (supportedModelIds.has(modelId.toLowerCase())) continue;
        context.addIssue({
          code: "custom",
          path: ["config", "videoInputCapabilitiesByModel", modelId],
          message: "Video input capability model must be supported",
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
