/**
 * UOL Operations - External API 领域
 *
 * 职责：注册媒体平台保留的外部 API 辅助操作，包括：
 * - 积分查询、图片任务查询、媒体模型列表（只读端点）
 * - API Key 管理（CRUD、配额、分组）
 * - 管理员 Key 状态设置
 * 图片与视频生成/编辑统一调用 image.generate、video.generate 与 video.getStatus，
 * 本域不再注册 Chat、Responses、Agent 或平行媒体生成操作。
 *
 * 使用方：UOL invoke 网关、MCP 适配器、内置 Agent
 * 关键依赖：../registry（defineOperation）、zod（schema 校验）
 *
 * 注意：所有 execute 函数当前为存根实现，待后续接入实际业务逻辑。
 */
import { z } from "zod";
import { defineOperation } from "../registry";

// ---------------------------------------------------------------------------
// 6. externalApi.getCredits - /v1/credits (apiKey, read)
// ---------------------------------------------------------------------------
export const getCredits = defineOperation({
  name: "externalApi.getCredits",
  domain: "external-api",
  title: "Get Credits",
  description:
    "通过 /v1/credits 端点查询当前 API Key 关联用户的积分余额。只读操作。",
  input: z.object({}),
  output: z.object({
    credits: z.number().describe("当前积分余额"),
    used: z.number().optional().describe("已使用积分"),
    total: z.number().optional().describe("总积分"),
  }),
  access: { kind: "apiKey" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  async execute() {
    throw new Error("Not yet wired: externalApi.getCredits");
  },
});

// ---------------------------------------------------------------------------
// 7. externalApi.getTask - /v1/images/{taskId} (apiKey, read)
// ---------------------------------------------------------------------------
export const getTask = defineOperation({
  name: "externalApi.getTask",
  domain: "external-api",
  title: "Get Task",
  description:
    "通过 /v1/images/{taskId} 端点查询异步图像生成任务状态。只读操作。",
  input: z.object({
    taskId: z.string().describe("任务 ID"),
  }),
  output: z.object({
    taskId: z.string(),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .describe("任务状态"),
    result: z
      .object({
        url: z.string().optional(),
        b64_json: z.string().optional(),
      })
      .optional()
      .describe("任务结果（完成时）"),
    error: z.string().optional().describe("错误信息（失败时）"),
    createdAt: z.number().optional(),
    completedAt: z.number().optional(),
  }),
  access: { kind: "apiKey" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  async execute() {
    throw new Error("Not yet wired: externalApi.getTask");
  },
});

// ---------------------------------------------------------------------------
// 8. externalApi.getModels - /v1/models (apiKey, read)
// ---------------------------------------------------------------------------
export const getModels = defineOperation({
  name: "externalApi.getModels",
  domain: "external-api",
  title: "Get Models",
  description: "通过 /v1/models 端点获取可用模型列表。只读操作。",
  input: z.object({}),
  output: z.object({
    object: z.literal("list"),
    data: z.array(
      z.object({
        id: z.string(),
        object: z.literal("model"),
        created: z.number(),
        owned_by: z.string(),
      })
    ),
  }),
  access: { kind: "apiKey" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  async execute() {
    throw new Error("Not yet wired: externalApi.getModels");
  },
});

/** API 密钥当前分组与可编辑候选分组的稳定摘要。 */
export const externalApiKeyGroupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    selectable: z.boolean(),
  })
  .strict();

/** API 密钥安全摘要；严格排除明文、密文、哈希和废弃治理字段。 */
export const externalApiKeySummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    lastFour: z.string(),
    generationGroupId: z.string().nullable(),
    creditLimit: z.number().nonnegative().nullable(),
    creditsUsed: z.number().nonnegative(),
    lastUsedAt: z.date().nullable(),
    isActive: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
    currentGroup: externalApiKeyGroupSchema.nullable(),
  })
  .strict();

export type ExternalApiKeySummary = z.infer<typeof externalApiKeySummarySchema>;

/** 新版可复制 API Key 明文格式；内容使用 base64url 安全字符。 */
const externalApiKeyPlaintextSchema = z
  .string()
  .regex(/^sk-[A-Za-z0-9_-]+$/u, "API Key 必须以 sk- 开头");

/**
 * 登录用户管理页使用的密钥列表行。
 *
 * 新记录返回从服务端密文恢复的完整 Key；历史不可逆、损坏或 Secret 已轮换的记录返回
 * null。该 DTO 只能由 human-only session operation 返回，不能暴露给 API Key、MCP
 * 或日志。
 */
export const externalApiKeyListItemSchema = externalApiKeySummarySchema
  .extend({
    apiKey: externalApiKeyPlaintextSchema.nullable(),
  })
  .strict();

export type ExternalApiKeyListItem = z.infer<
  typeof externalApiKeyListItemSchema
>;

export const externalApiKeyListInputSchema = z
  .object({
    page: z.number().int().positive().default(1),
    pageSize: z
      .union([z.literal(10), z.literal(20), z.literal(50)])
      .default(20),
  })
  .strict();

export const externalApiKeyListOutputSchema = z
  .object({
    keys: z.array(externalApiKeyListItemSchema),
    editableGroups: z.array(externalApiKeyGroupSchema),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 9. externalApi.listKeys - getExternalApiKeys (session user, read)
// ---------------------------------------------------------------------------
export const listKeys = defineOperation({
  name: "externalApi.listKeys",
  domain: "external-api",
  title: "List API Keys",
  description: "获取当前用户的外部 API Key 列表。需要登录认证。只读操作。",
  input: externalApiKeyListInputSchema,
  output: externalApiKeyListOutputSchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  async execute() {
    throw new Error("Not yet wired: externalApi.listKeys");
  },
});

// ---------------------------------------------------------------------------
// 10. externalApi.createKey - createExternalApiKey (session user)
// ---------------------------------------------------------------------------
export const createKey = defineOperation({
  name: "externalApi.createKey",
  domain: "external-api",
  title: "Create API Key",
  description: "创建新的外部 API Key。需要登录认证。",
  input: z
    .object({
      name: z.string().trim().min(1).max(80).optional().describe("Key 名称"),
      generationGroupId: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .optional()
        .describe("生图分组 ID；null 表示使用系统默认分组"),
      creditLimit: z
        .number()
        .nonnegative()
        .nullable()
        .optional()
        .describe("积分额度上限；null 表示不限额"),
    })
    .strict(),
  output: z
    .object({
      apiKey: externalApiKeyPlaintextSchema.describe(
        "完整 Key；创建响应及后续本人列表读取均可恢复"
      ),
      key: externalApiKeySummarySchema,
    })
    .strict(),
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  async execute() {
    throw new Error("Not yet wired: externalApi.createKey");
  },
});

// ---------------------------------------------------------------------------
// 11. externalApi.revokeKey - revokeExternalApiKey (session user)
// ---------------------------------------------------------------------------
export const revokeKey = defineOperation({
  name: "externalApi.revokeKey",
  domain: "external-api",
  title: "Revoke API Key",
  description: "撤销外部 API Key（不可逆）。需要登录认证且为 Key 所有者。",
  input: z
    .object({
      keyId: z.string().min(1).describe("要撤销的 Key ID"),
    })
    .strict(),
  output: externalApiKeySummarySchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  async execute() {
    throw new Error("Not yet wired: externalApi.revokeKey");
  },
});

// ---------------------------------------------------------------------------
// 12. externalApi.deleteKey - deleteExternalApiKey (session user)
// ---------------------------------------------------------------------------
export const deleteKey = defineOperation({
  name: "externalApi.deleteKey",
  domain: "external-api",
  title: "Delete API Key",
  description: "删除外部 API Key。需要登录认证且为 Key 所有者。",
  input: z
    .object({
      keyId: z.string().min(1).describe("要删除的 Key ID"),
    })
    .strict(),
  output: z.object({ id: z.string() }).strict(),
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  async execute() {
    throw new Error("Not yet wired: externalApi.deleteKey");
  },
});

// ---------------------------------------------------------------------------
// 13. externalApi.updateKeyGroup - updateExternalApiKeyGroup (session user)
// ---------------------------------------------------------------------------
export const updateKeyGroup = defineOperation({
  name: "externalApi.updateKeyGroup",
  domain: "external-api",
  title: "Update Key Group",
  description: "更新外部 API Key 的分组归属。需要登录认证且为 Key 所有者。",
  input: z
    .object({
      keyId: z.string().min(1).describe("Key ID"),
      generationGroupId: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .describe("分组 ID；null 表示使用系统默认分组"),
    })
    .strict(),
  output: externalApiKeySummarySchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  async execute() {
    throw new Error("Not yet wired: externalApi.updateKeyGroup");
  },
});

// ---------------------------------------------------------------------------
// 14. externalApi.updateKeyQuota - updateExternalApiKeyQuota (session user)
// ---------------------------------------------------------------------------
export const updateKeyQuota = defineOperation({
  name: "externalApi.updateKeyQuota",
  domain: "external-api",
  title: "Update Key Quota",
  description: "更新外部 API Key 的配额限制。需要登录认证且为 Key 所有者。",
  input: z
    .object({
      keyId: z.string().min(1).describe("Key ID"),
      creditLimit: z
        .number()
        .nonnegative()
        .nullable()
        .describe("积分额度上限；null 表示不限额"),
    })
    .strict(),
  output: externalApiKeySummarySchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  async execute() {
    throw new Error("Not yet wired: externalApi.updateKeyQuota");
  },
});

// ---------------------------------------------------------------------------
// 15. externalApi.adminSetKeyStatus - setExternalApiKeyStatus (admin)
// ---------------------------------------------------------------------------
export const adminSetKeyStatus = defineOperation({
  name: "externalApi.adminSetKeyStatus",
  domain: "external-api",
  title: "Admin Set Key Status",
  description:
    "管理员设置外部 API Key 状态（启用/禁用/撤销）。需要管理员权限。",
  input: z.object({
    keyId: z.string().describe("Key ID"),
    status: z.enum(["active", "disabled", "revoked"]).describe("目标状态"),
    reason: z.string().optional().describe("状态变更原因"),
  }),
  output: z.object({
    success: z.boolean(),
    previousStatus: z.string(),
    newStatus: z.string(),
    updatedAt: z.string(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  async execute() {
    throw new Error("Not yet wired: externalApi.adminSetKeyStatus");
  },
});
