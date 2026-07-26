/**
 * UOL 操作注册 - 统一媒体后端号池。
 *
 * 职责：只暴露分组、统一成员和 API Images 参数模板三类能力。
 * Web/Codex 账号、Sub2API、注册机、旧 API/Adobe 双模型和定时同步均不属于现行契约。
 * 真实实现由 apps/web 的 UOL binding 注入。
 */
import { z } from "zod";

import {
  backendGroupInputSchema,
  backendGroupOptionSchema,
  backendGroupSummarySchema,
} from "../../image-backend/group-contract";
import { backendMemberInputSchema } from "../../image-backend/member-contract";
import { requestParameterMappingsSchema } from "../../image-backend/request-parameter-mapping";
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
    parameterMappings: requestParameterMappingsSchema,
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
      lastRefreshError: z.string().nullable(),
      consecutiveFailures: z.number().int().nonnegative(),
      creditsTotal: z.number().int().nullable(),
      creditsUsed: z.number().int().nullable(),
      creditsAvailable: z.number().int().nullable(),
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
    lastAcquiredAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    config: z.union([redactedApiConfigSchema, redactedAdobeConfigSchema]),
  })
  .strict();

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
  title: "获取统一媒体后端号池",
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

/** 新建或更新统一媒体后端分组。 */
export const saveGroup = defineOperation({
  name: "pool.saveGroup",
  domain: "image-backend-pool",
  title: "保存媒体后端分组",
  description: "保存统一分组、套餐门槛、内容安全和媒体积分覆盖。",
  input: backendGroupInputSchema,
  output: z.object({ id: z.string() }).strict(),
  access: poolWriteAccess,
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
  output: z.object({ id: z.string() }).strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.saveMember");
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

const parameterMappingTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    parameterMappings: requestParameterMappingsSchema,
  })
  .strict();

/** 列出 API Images 参数映射模板。 */
export const listParameterMappingTemplates = defineOperation({
  name: "pool.listParameterMappingTemplates",
  domain: "image-backend-pool",
  title: "列出 API 参数映射模板",
  description: "列出可供 API Images 成员复用的请求参数映射模板。",
  input: z.object({}).strict(),
  output: z
    .object({ templates: z.array(parameterMappingTemplateSchema) })
    .strict(),
  access: { kind: "imageBackendPoolViewer" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: pool.listParameterMappingTemplates");
  },
});

/** 新建或更新 API Images 参数映射模板。 */
export const saveParameterMappingTemplate = defineOperation({
  name: "pool.saveParameterMappingTemplate",
  domain: "image-backend-pool",
  title: "保存 API 参数映射模板",
  description: "保存严格、无 Responses/Chat 语义的参数映射模板。",
  input: z
    .object({
      id: z.string().trim().min(1).max(128).optional(),
      name: z.string().trim().min(1).max(80),
      parameterMappings: requestParameterMappingsSchema,
    })
    .strict(),
  output: z.object({ id: z.string() }).strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.saveParameterMappingTemplate");
  },
});

/** 删除 API Images 参数映射模板。 */
export const deleteParameterMappingTemplate = defineOperation({
  name: "pool.deleteParameterMappingTemplate",
  domain: "image-backend-pool",
  title: "删除 API 参数映射模板",
  description: "删除未被成员引用的参数映射模板。",
  input: z.object({ id: z.string().trim().min(1).max(128) }).strict(),
  output: z.object({ success: z.boolean() }).strict(),
  access: poolWriteAccess,
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.deleteParameterMappingTemplate");
  },
});
