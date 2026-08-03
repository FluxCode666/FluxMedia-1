/**
 * Adobe direct 凭据健康统一接口契约。
 *
 * 职责：声明后台扫描、通知补偿、历史清理、管理员检查/重新授权/诊断读取
 * 与通知设置的严格 UOL schema 和权限边界。真实数据库及 Adobe 调用由 Web
 * 侧 late binding 注入；本文件不读取 Cookie、部署密钥或运行时环境。
 * 使用方：UOL registry、内部任务调度器和管理员 Server Action。
 */
import { z } from "zod";

import { defineOperation } from "../registry";
import type { AccessRequirement } from "../types";

const administratorAccess: AccessRequirement = {
  kind: "roles",
  roles: ["admin", "super_admin"],
};

const memberIdSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.string().datetime({ offset: true });

/** 严格限制可进入持久诊断和管理员页面的 Adobe 字段。 */
export const adobeCredentialDiagnosticSchema = z
  .object({
    statusCode: z.number().int().min(100).max(599).optional(),
    adobeErrorCode: z.string().trim().min(1).max(128).optional(),
    message: z.string().trim().min(1).max(512).optional(),
    requestId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const credentialHealthStatusSchema = z.enum([
  "pending",
  "healthy",
  "degraded",
  "isolated",
  "overdue",
]);

const evaluationDispositionSchema = z.enum(["accepted", "stale", "discarded"]);

const healthSummarySchema = z
  .object({
    memberId: memberIdSchema,
    status: credentialHealthStatusSchema,
    consecutiveFailures: z.number().int().nonnegative(),
    failureProfiles: z.array(z.enum(["express", "firefly"])).max(2),
    lastCheckedAt: timestampSchema.nullable(),
    lastSuccessAt: timestampSchema.nullable(),
    nextCheckAt: timestampSchema.nullable(),
    evaluationDeadlineAt: timestampSchema.nullable(),
    isolatedAt: timestampSchema.nullable(),
    diagnostic: adobeCredentialDiagnosticSchema.nullable(),
  })
  .strict();

const evaluationResultSchema = z
  .object({
    evaluationId: z.string().trim().min(1).max(128),
    disposition: evaluationDispositionSchema,
    health: healthSummarySchema,
  })
  .strict();

const cronBatchInputSchema = z
  .object({
    batchSize: z.number().int().min(1).max(100).default(25),
  })
  .strict();

const cronBatchOutputSchema = z
  .object({
    claimed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();

/** 后台扫描到期 Adobe direct 成员并执行双 Profile 评估。 */
export const adobeCredentialHealthScan = defineOperation({
  name: "pool.scanAdobeCredentialHealth",
  domain: "image-backend-pool",
  title: "扫描 Adobe 凭据健康",
  description: "由指定内部任务认领到期成员并执行凭据健康评估。",
  input: cronBatchInputSchema,
  output: cronBatchOutputSchema,
  access: { kind: "cronJob", job: "adobe-credential-health" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["external-call", "audit", "queue"],
  hasMaintenanceWrite: true,
  execute: async () => {
    throw new Error("Not yet wired: pool.scanAdobeCredentialHealth");
  },
});

/** 补偿认领到期的 Adobe 凭据通知投递。 */
export const adobeCredentialNotificationDrain = defineOperation({
  name: "pool.drainAdobeCredentialNotifications",
  domain: "image-backend-pool",
  title: "补偿投递 Adobe 凭据通知",
  description: "由指定内部任务恢复 pending 或重试到期的邮件和 Webhook 投递。",
  input: cronBatchInputSchema,
  output: cronBatchOutputSchema,
  access: {
    kind: "cronJob",
    job: "adobe-credential-notification-delivery",
  },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["email", "external-call", "audit"],
  hasMaintenanceWrite: true,
  execute: async () => {
    throw new Error("Not yet wired: pool.drainAdobeCredentialNotifications");
  },
});

/** 清理超过保留期且已终态的 Adobe 凭据健康历史。 */
export const adobeCredentialHealthCleanup = defineOperation({
  name: "pool.cleanupAdobeCredentialHealthHistory",
  domain: "image-backend-pool",
  title: "清理 Adobe 凭据健康历史",
  description: "由指定内部任务按依赖顺序清理超过保留期的终态历史。",
  input: cronBatchInputSchema,
  output: z
    .object({
      deletedEvaluations: z.number().int().nonnegative(),
      deletedIncidents: z.number().int().nonnegative(),
      deletedDeliveries: z.number().int().nonnegative(),
    })
    .strict(),
  access: {
    kind: "cronJob",
    job: "adobe-credential-health-retention",
  },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  hasMaintenanceWrite: true,
  execute: async () => {
    throw new Error("Not yet wired: pool.cleanupAdobeCredentialHealthHistory");
  },
});

/** 管理员立即检查一个 Adobe direct 成员。 */
export const adobeCredentialHealthCheck = defineOperation({
  name: "pool.checkAdobeCredentialHealth",
  domain: "image-backend-pool",
  title: "立即检查 Adobe 凭据",
  description: "管理员为指定成员触发一次与后台扫描共享 claim 的健康评估。",
  input: z.object({ memberId: memberIdSchema }).strict(),
  output: evaluationResultSchema,
  access: administratorAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["external-call", "audit", "queue"],
  execute: async () => {
    throw new Error("Not yet wired: pool.checkAdobeCredentialHealth");
  },
});

/** 管理员读取凭据健康摘要和严格清洗后的折叠诊断。 */
export const adobeCredentialHealthDetails = defineOperation({
  name: "pool.getAdobeCredentialHealth",
  domain: "image-backend-pool",
  title: "读取 Adobe 凭据健康详情",
  description: "读取独立健康摘要和有限诊断，不返回 Cookie、Token 或上游原文。",
  input: z.object({ memberId: memberIdSchema }).strict(),
  output: healthSummarySchema,
  access: administratorAccess,
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: pool.getAdobeCredentialHealth");
  },
});

/** 管理员为同一 Adobe 账号提交新 Cookie 并执行双 Profile 身份验证。 */
export const adobeCredentialReauthorize = defineOperation({
  name: "pool.reauthorizeAdobeCredential",
  domain: "image-backend-pool",
  title: "重新授权 Adobe 凭据",
  description:
    "只允许同一稳定 Adobe 账号更新 Cookie，并在验证通过后恢复凭据状态。",
  input: z
    .object({
      memberId: memberIdSchema,
      cookie: z.string().trim().min(1).max(64_000),
      clientRequestId: z.string().trim().min(1).max(128),
    })
    .strict(),
  output: evaluationResultSchema,
  access: administratorAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-user",
  },
  sideEffects: ["external-call", "audit", "queue"],
  execute: async () => {
    throw new Error("Not yet wired: pool.reauthorizeAdobeCredential");
  },
});

/**
 * 验证通知 Webhook 的非机密 URL 结构。
 *
 * 这里只执行同步语法约束；保存与每次发送仍必须在 Web 层做 DNS pin、私网阻断
 * 和禁止重定向校验。query、fragment 与 userinfo 被拒绝，避免隐式凭据落库。
 */
const notificationWebhookUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .superRefine((value, ctx) => {
    if (value === "") return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Webhook 地址格式无效" });
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname === ""
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Webhook 必须是不含凭据、query 和 fragment 的 HTTPS 地址",
      });
    }
  });

const notificationSettingsOutputSchema = z
  .object({
    emailRecipients: z.array(z.string().email()).max(50),
    emailConfigured: z.boolean(),
    webhookHost: z.string().nullable(),
    webhookConfigured: z.boolean(),
    webhookHmacConfigured: z.boolean(),
  })
  .strict();

/** 超级管理员读取 Adobe 凭据通知配置状态，永不返回 HMAC 明文。 */
export const getAdobeCredentialNotificationSettings = defineOperation({
  name: "settings.getAdobeCredentialNotifications",
  domain: "system-settings",
  title: "读取 Adobe 凭据通知设置",
  description: "读取邮件收件人、Webhook 脱敏主机和各渠道配置完整性。",
  input: z.object({}).strict(),
  output: notificationSettingsOutputSchema,
  access: { kind: "roles", roles: ["super_admin"] },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: settings.getAdobeCredentialNotifications");
  },
});

/** 超级管理员原子写入 Adobe 凭据通知收件人和 Webhook 地址。 */
export const setAdobeCredentialNotificationSettings = defineOperation({
  name: "settings.setAdobeCredentialNotifications",
  domain: "system-settings",
  title: "保存 Adobe 凭据通知设置",
  description: "原子保存非机密通知目标；部署 HMAC 密钥不由页面读取或写入。",
  input: z
    .object({
      emailRecipients: z.array(z.string().email()).max(50),
      webhookUrl: notificationWebhookUrlSchema,
    })
    .strict(),
  output: notificationSettingsOutputSchema,
  access: { kind: "roles", roles: ["super_admin"] },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["audit", "cache"],
  execute: async () => {
    throw new Error("Not yet wired: settings.setAdobeCredentialNotifications");
  },
});
