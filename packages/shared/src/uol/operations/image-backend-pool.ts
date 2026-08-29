/**
 * UOL 操作注册 - 统一媒体后端号池。
 *
 * 职责：只暴露分组、统一成员和 API 媒体参数模板三类能力。
 * Web/Codex 账号、Sub2API、注册机、旧 API/Adobe 双模型和定时同步均不属于现行契约。
 * 真实实现由 apps/web 的 UOL binding 注入。
 */
import { z } from "zod";
import {
  apiModelMappingsSchema,
  apiUpstreamAuthenticationSchema,
  apiUpstreamOperationsSchema,
  apiVideoInputCapabilitiesByModelSchema,
  apiVideoInputCapabilitiesSchema,
  apiVideoProtocolModeSchema,
} from "../../image-backend/api-upstream-adaptation";
import {
  apiUpstreamAdapterOperationIdSchema,
  apiUpstreamJsonValueSchema,
} from "../../image-backend/api-upstream-script-contract";
import {
  backendGroupInputSchema,
  backendGroupOptionSchema,
  backendGroupSummarySchema,
} from "../../image-backend/group-contract";
import {
  backendMemberInputSchema,
  backendModelResolutionCapabilitiesSchema,
} from "../../image-backend/member-contract";
import { createOffsetPaginationOutputSchema } from "../../pagination/contracts";
import { isValidTimeZone } from "../../time-zone";
import { defineOperation } from "../registry";
import type { AccessRequirement } from "../types";

const poolWriteAccess: AccessRequirement = {
  kind: "roles",
  roles: ["admin", "super_admin"],
};

export { backendGroupInputSchema };

const redactedApiConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    hasApiKey: z.boolean(),
    useStream: z.boolean(),
    /** 图生图参考图是否先转存并转换为绝对公网 URL。 */
    convertReferenceImagesToPublicUrl: z.boolean().optional(),
    videoSubmissionRetryCount: z.number().int().min(0).max(10),
    videoProtocolMode: apiVideoProtocolModeSchema,
    videoInputCapabilities: apiVideoInputCapabilitiesSchema,
    videoInputCapabilitiesByModel: apiVideoInputCapabilitiesByModelSchema,
    modelMappings: apiModelMappingsSchema,
    authentication: apiUpstreamAuthenticationSchema.optional(),
    credentialScope: z.string().optional(),
    operations: apiUpstreamOperationsSchema.optional(),
    currentAdapterVersion: z
      .object({
        id: z.string(),
        revision: z.number().int().positive(),
        createdAt: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const redactedAdobeConfigSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("gateway"),
      baseUrl: z.string().url(),
      hasApiKey: z.boolean(),
      defaultRatio: z.string(),
      defaultResolution: z.string(),
      gptImageQuality: z.enum(["low", "medium", "high"]),
    })
    .strict(),
  z
    .object({
      mode: z.literal("direct"),
      hasCookie: z.boolean(),
      displayName: z.string().nullable(),
      email: z.string().nullable(),
      credentialStatus: z.enum(["active", "error", "exhausted", "invalid"]),
      lastRefreshAt: z.string().nullable(),
      consecutiveFailures: z.number().int().nonnegative(),
      fireflyCredentialStatus: z
        .enum(["active", "error", "exhausted", "invalid"])
        .nullable(),
      fireflyLastRefreshAt: z.string().nullable(),
      fireflyConsecutiveFailures: z.number().int().nonnegative(),
      creditsTotal: z.number().int().nullable(),
      creditsUsed: z.number().int().nullable(),
      creditsAvailable: z.number().int().nullable(),
      creditsUpdatedAt: z.string().nullable(),
      defaultRatio: z.string(),
      defaultResolution: z.string(),
      gptImageQuality: z.enum(["low", "medium", "high"]),
    })
    .strict(),
]);

/** 人工列表可继续展示既有折叠诊断；通用 Agent 快照仍使用上方无诊断 schema。 */
const adminRedactedAdobeConfigSchema = z.union([
  redactedAdobeConfigSchema,
  z
    .object({
      mode: z.literal("direct"),
      hasCookie: z.boolean(),
      displayName: z.string().nullable(),
      email: z.string().nullable(),
      credentialStatus: z.enum(["active", "error", "exhausted", "invalid"]),
      lastRefreshAt: z.string().nullable(),
      lastRefreshError: z.string().nullable(),
      consecutiveFailures: z.number().int().nonnegative(),
      fireflyCredentialStatus: z
        .enum(["active", "error", "exhausted", "invalid"])
        .nullable(),
      fireflyLastRefreshAt: z.string().nullable(),
      fireflyLastRefreshError: z.string().nullable(),
      fireflyConsecutiveFailures: z.number().int().nonnegative(),
      creditsTotal: z.number().int().nullable(),
      creditsUsed: z.number().int().nullable(),
      creditsAvailable: z.number().int().nullable(),
      creditsUpdatedAt: z.string().nullable(),
      creditsError: z.string().nullable(),
      defaultRatio: z.string(),
      defaultResolution: z.string(),
      gptImageQuality: z.enum(["low", "medium", "high"]),
    })
    .strict(),
]);

const backendMemberSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["api", "adobe"]),
    groupIds: z.array(z.string()),
    supportedModelIds: z.array(z.string()).min(1),
    supportedResolutionsByModel: backendModelResolutionCapabilitiesSchema
      .optional()
      .default({}),
    contentSafetyEnabled: z.boolean(),
    isEnabled: z.boolean(),
    alwaysActive: z.boolean(),
    failureCooldownEnabled: z.boolean(),
    priority: z.number().int(),
    concurrency: z.number().int().positive(),
    status: z.string(),
    healthStatus: z.string(),
    inflightCount: z.number().int().nonnegative(),
    leaseAcquiredCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    lastAcquiredAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
    config: z.union([redactedApiConfigSchema, redactedAdobeConfigSchema]),
  })
  .strict();

/** 管理列表允许的 Adobe Direct 凭据健康筛选。 */
export const backendMemberCredentialFilterSchema = z.enum([
  "all",
  "pending",
  "healthy",
  "degraded",
  "isolated",
  "overdue",
  "unhealthy",
  "not_applicable",
]);

/** 人工管理页面的成员分页输入；日期边界按显式部署时区解释。 */
export const adminPoolMemberListInputSchema = z
  .object({
    page: z.number().int().positive().default(1),
    pageSize: z
      .union([z.literal(10), z.literal(20), z.literal(50)])
      .default(20),
    name: z.string().trim().max(120).default(""),
    credentialStatus: backendMemberCredentialFilterSchema.default("all"),
    modelId: z.string().trim().max(240).default("all"),
    resolution: z.string().trim().max(32).default("all"),
    createdFrom: z.iso.date().or(z.literal("")).default(""),
    createdTo: z.iso.date().or(z.literal("")).default(""),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimeZone, "无效的 IANA 时区"),
  })
  .strict();

/** 人工管理页面的分组分页输入。 */
export const adminPoolGroupListInputSchema = z
  .object({
    page: z.number().int().positive().default(1),
    pageSize: z
      .union([z.literal(10), z.literal(20), z.literal(50)])
      .default(20),
    name: z.string().trim().max(120).default(""),
  })
  .strict();

const credentialHealthStatusSchema = z.enum([
  "pending",
  "healthy",
  "degraded",
  "isolated",
  "overdue",
]);

/** 管理成员列表输出；凭据健康只增加可筛选状态，不返回诊断。 */
export const adminPoolMemberListOutputSchema =
  createOffsetPaginationOutputSchema(
    backendMemberSummarySchema
      .extend({
        config: z.union([
          redactedApiConfigSchema,
          adminRedactedAdobeConfigSchema,
        ]),
        credentialHealthStatus: credentialHealthStatusSchema.nullable(),
      })
      .strict()
  );

/** 管理分组列表输出。 */
export const adminPoolGroupListOutputSchema =
  createOffsetPaginationOutputSchema(backendGroupSummarySchema);

export type AdminPoolMemberListInput = z.output<
  typeof adminPoolMemberListInputSchema
>;
export type AdminPoolGroupListInput = z.output<
  typeof adminPoolGroupListInputSchema
>;
export type AdminPoolMemberListOutput = z.output<
  typeof adminPoolMemberListOutputSchema
>;
export type AdminPoolGroupListOutput = z.output<
  typeof adminPoolGroupListOutputSchema
>;

/** 获取用户或表单可选择的统一后端分组。 */
export const getGroupOptions = defineOperation({
  name: "pool.getGroupOptions",
  domain: "image-backend-pool",
  title: "获取媒体后端组选项",
  description: "获取可选择的媒体后端分组，不暴露成员凭据。",
  input: z.object({}).strict(),
  output: z.object({
    options: z.array(backendGroupOptionSchema),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: pool.getGroupOptions");
  },
});

/** 获取统一号池管理快照；所有 secret 仅返回存在性标记。 */
export const getAdminPool = defineOperation({
  name: "pool.getAdminPool",
  domain: "image-backend-pool",
  title: "获取账号池",
  description: "读取分组、统一成员和调度指标的脱敏管理快照。",
  input: z.object({}).strict(),
  output: z
    .object({
      groups: z.array(backendGroupSummarySchema),
      members: z.array(backendMemberSummarySchema),
    })
    .strict(),
  access: { kind: "imageBackendPoolViewer" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: pool.getAdminPool");
  },
});

/** 分页读取人工账号池成员列表，不改变运行时全量快照。 */
export const listAdminMembers = defineOperation({
  name: "pool.listAdminMembers",
  domain: "image-backend-pool",
  title: "分页读取账号池成员",
  description: "按管理筛选条件读取脱敏成员、凭据健康状态和精确总数。",
  input: adminPoolMemberListInputSchema,
  output: adminPoolMemberListOutputSchema,
  access: { kind: "imageBackendPoolViewer" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: pool.listAdminMembers");
  },
});

/** 分页读取人工账号池分组列表，不改变表单使用的完整分组选项。 */
export const listAdminGroups = defineOperation({
  name: "pool.listAdminGroups",
  domain: "image-backend-pool",
  title: "分页读取账号池分组",
  description: "按名称筛选读取脱敏分组和精确总数。",
  input: adminPoolGroupListInputSchema,
  output: adminPoolGroupListOutputSchema,
  access: { kind: "imageBackendPoolViewer" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: pool.listAdminGroups");
  },
});

/** 新建或更新统一媒体后端分组。 */
export const saveGroup = defineOperation({
  name: "pool.saveGroup",
  domain: "image-backend-pool",
  title: "保存媒体后端分组",
  description: "保存统一分组、任务队列优先级、内容安全和媒体积分覆盖。",
  input: backendGroupInputSchema,
  output: z.object({ id: z.string() }).strict(),
  access: poolWriteAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.saveGroup");
  },
});

/** 删除空分组并解除其关系；成员本身不随分组删除。 */
export const deleteGroup = defineOperation({
  name: "pool.deleteGroup",
  domain: "image-backend-pool",
  title: "删除媒体后端分组",
  description: "删除指定分组；默认分组或仍被任务使用时由实现层拒绝。",
  input: z.object({ id: z.string().trim().min(1).max(128) }).strict(),
  output: z.object({ success: z.boolean() }).strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.deleteGroup");
  },
});

/** 以 `api | adobe` 单一入口新建或更新媒体后端成员。 */
export const saveMember = defineOperation({
  name: "pool.saveMember",
  domain: "image-backend-pool",
  title: "保存媒体后端成员",
  description:
    "按互斥成员类型保存公共调度字段、模型配置目录中的显式能力和类型专属配置。",
  input: backendMemberInputSchema,
  output: z
    .object({
      id: z.string(),
      adapterVersion: z
        .object({
          id: z.string(),
          revision: z.number().int().positive(),
        })
        .strict()
        .nullable()
        .optional(),
    })
    .strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.saveMember");
  },
});

/** 使用生产 Worker 和校验器进行无网络 API 上游脚本测试。 */
export const testApiUpstreamAdapter = defineOperation({
  name: "pool.testApiUpstreamAdapter",
  domain: "image-backend-pool",
  title: "测试 API 上游适配脚本",
  description: "使用脱敏样例验证请求或响应脚本，不读取密钥且不访问上游。",
  input: z
    .object({
      operation: apiUpstreamAdapterOperationIdSchema,
      stage: z.enum(["request", "response"]),
      script: z.string().max(32_768),
      sample: apiUpstreamJsonValueSchema,
    })
    .strict(),
  output: z
    .object({
      preview: apiUpstreamJsonValueSchema,
    })
    .strict(),
  access: poolWriteAccess,
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["queue"],
  processLocalState: true,
  execute: async () => {
    throw new Error("Not yet wired: pool.testApiUpstreamAdapter");
  },
});

/** 读取当前 Web 进程的脱敏 Worker Pool 运行诊断。 */
export const getApiUpstreamRuntimeDiagnostics = defineOperation({
  name: "pool.getApiUpstreamRuntimeDiagnostics",
  domain: "image-backend-pool",
  title: "获取 API 上游脚本运行诊断",
  description: "读取当前进程的 Worker、队列和响应许可快照，不返回配置正文。",
  input: z.object({}).strict(),
  output: z
    .object({
      lifecycle: z.enum([
        "starting",
        "ready",
        "unavailable",
        "draining",
        "closed",
      ]),
      workerCount: z.number().int().nonnegative(),
      liveWorkerCount: z.number().int().nonnegative(),
      requestQueueLength: z.number().int().nonnegative(),
      responseQueueLength: z.number().int().nonnegative(),
      responsePermitsInUse: z.number().int().nonnegative(),
      responsePermitCapacity: z.number().int().nonnegative(),
      saturationCount: z.number().int().nonnegative(),
      replacementCount: z.number().int().nonnegative(),
    })
    .strict(),
  access: poolWriteAccess,
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  processLocalState: true,
  execute: async () => {
    throw new Error("Not yet wired: pool.getApiUpstreamRuntimeDiagnostics");
  },
});

/** 手动清除统一成员的暂态运行失败状态，使其重新进入调度候选。 */
export const resetMemberStatus = defineOperation({
  name: "pool.resetMemberStatus",
  domain: "image-backend-pool",
  title: "重置账号运行状态",
  description:
    "清除健康降级、失败连击、冷却和最近错误；不修改凭据、启用开关、累计指标或运行中租约。",
  input: z.object({ id: z.string().trim().min(1).max(128) }).strict(),
  output: z.object({ success: z.boolean() }).strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.resetMemberStatus");
  },
});

/** 修改统一成员是否参与后续调度；不影响凭据、运行指标或当前租约。 */
export const setMemberEnabled = defineOperation({
  name: "pool.setMemberEnabled",
  domain: "image-backend-pool",
  title: "修改账号启用状态",
  description: "原子修改统一成员的启用状态，停用后不再获取新的任务租约。",
  input: z
    .object({
      id: z.string().trim().min(1).max(128),
      isEnabled: z.boolean(),
    })
    .strict(),
  output: z
    .object({
      id: z.string(),
      isEnabled: z.boolean(),
    })
    .strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.setMemberEnabled");
  },
});

/** 删除统一成员；有效租约或非终态视频任务存在时实现层必须拒绝。 */
export const deleteMember = defineOperation({
  name: "pool.deleteMember",
  domain: "image-backend-pool",
  title: "删除媒体后端成员",
  description: "只按统一成员 ID 删除；不可由客户端再传成员类型决定表。",
  input: z.object({ id: z.string().trim().min(1).max(128) }).strict(),
  output: z.object({ success: z.boolean() }).strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.deleteMember");
  },
});
