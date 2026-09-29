/**
 * UOL 操作注册 - 管理员 agent 令牌。
 *
 * 使用方：后台「Agent 令牌」页面的 server action。agent 令牌是全局管理员凭据，
 * 供外部 agent（如 Claude Code、Codex）调用 /api/admin-agent/v1/*，能力由签发时
 * 勾选的 scope 决定；scope 清单由 Go 后端注册表统一维护并随列表返回。真实执行由
 * Web binding 委托 Go，操作只对人工管理员开放，不向站内 Agent 暴露。
 */
import { z } from "zod";

import { defineOperation } from "../registry";
import type { AccessRequirement } from "../types";

/** 签发与管理令牌仅限 admin/super_admin，observer_admin 不可见。 */
const adminAgentTokenAccess: AccessRequirement = {
  kind: "roles",
  roles: ["admin", "super_admin"],
};

/** scope 标识格式：<资源>:<动作>，如 suppliers:read。 */
export const adminAgentScopeIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)
  .max(64);

/** Go 注册表中的 scope 定义，用于签发界面展示与勾选。 */
export const adminAgentScopeSchema = z
  .object({
    id: z.string(),
    group: z.string(),
    label: z.string(),
    description: z.string(),
    risky: z.boolean(),
    riskNote: z.string(),
    requires: z.array(z.string()),
  })
  .strict();

export type AdminAgentScope = z.output<typeof adminAgentScopeSchema>;

/** 管理员 agent 令牌的脱敏列表项；明文令牌只在签发时返回一次。 */
export const adminAgentTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tokenPrefix: z.string(),
    lastFour: z.string(),
    scopes: z.array(z.string()),
    createdBy: z
      .object({ id: z.string(), name: z.string(), email: z.string() })
      .strict(),
    isOwn: z.boolean(),
    status: z.enum(["active", "revoked", "expired"]),
    expiresAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export type AdminAgentTokenItem = z.output<typeof adminAgentTokenSchema>;

/** 签发令牌的输出；token 为明文，只在本次返回。 */
export const createdAdminAgentTokenSchema = z
  .object({
    id: z.string(),
    token: z.string(),
    name: z.string(),
    tokenPrefix: z.string(),
    lastFour: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type CreatedAdminAgentToken = z.output<
  typeof createdAdminAgentTokenSchema
>;

/** 列出管理员 agent 令牌与可签发 scope：super_admin 可见全部，admin 仅见自己签发的。 */
export const listAdminAgentTokens = defineOperation({
  name: "adminAgent.listTokens",
  domain: "admin-agent",
  title: "读取管理员 agent 令牌",
  description:
    "列出全局管理员 agent 令牌元数据和可签发的授权范围，不返回明文或哈希。",
  input: z.object({}).strict(),
  output: z
    .object({
      tokens: z.array(adminAgentTokenSchema),
      availableScopes: z.array(adminAgentScopeSchema),
    })
    .strict(),
  access: adminAgentTokenAccess,
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: adminAgent.listTokens");
  },
});

/** 签发管理员 agent 令牌；明文只在本次输出中返回。 */
export const createAdminAgentToken = defineOperation({
  name: "adminAgent.createToken",
  domain: "admin-agent",
  title: "签发管理员 agent 令牌",
  description:
    "签发可撤销、有到期时间的全局 agent 令牌，能力由勾选的授权范围决定；前置范围由后端自动补齐。",
  input: z
    .object({
      name: z.string().trim().min(1).max(120),
      scopes: z.array(adminAgentScopeIdSchema).min(1).max(32),
      expiresInDays: z.number().int().min(1).max(90).default(30),
    })
    .strict(),
  output: createdAdminAgentTokenSchema,
  access: adminAgentTokenAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: adminAgent.createToken");
  },
});

/** 撤销管理员 agent 令牌，撤销后立即失效。 */
export const revokeAdminAgentToken = defineOperation({
  name: "adminAgent.revokeToken",
  domain: "admin-agent",
  title: "撤销管理员 agent 令牌",
  description:
    "撤销令牌；admin 只能撤销自己签发的，super_admin 可撤销任意令牌。",
  input: z.object({ id: z.string().trim().min(1).max(128) }).strict(),
  output: z.object({ id: z.string(), revoked: z.boolean() }).strict(),
  access: adminAgentTokenAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: adminAgent.revokeToken");
  },
});
