/**
 * UOL Bindings - 启动时延迟绑定真实 execute 实现
 *
 * 职责：在 apps/web 启动时，将 packages/shared 中定义的 operation stub
 * 替换为真实的 service-fn 实现。解决跨包依赖问题：
 * - 操作定义在 packages/shared（不可导入 apps/web）
 * - 部分 execute 实现依赖 apps/web 的 service-fn（DB、外部 API 等）
 *
 * 使用方：uol-init.ts 在应用启动时调用此模块（副作用导入）
 * 关键依赖：@repo/shared/uol（bindExecute）、各 features service-fn
 *
 * 约定：
 * - 此文件在 import 时执行所有 bindExecute 调用
 * - 每个绑定块对应一个 operation，注明源 service-fn 位置
 * - 尚未接线的 operation 用 TODO 注释标记
 */

// 副作用导入：触发所有操作注册到 registry
import "@repo/shared/uol/operations";
import "@/server/uol-bindings/admin-status";
import "@/server/uol-bindings/analytics";
import "@/server/uol-bindings/credits";
import "@/server/uol-bindings/support";
import "@/server/uol-bindings/content";
import "@/server/uol-bindings/image-backend-pool";
import "@/server/uol-bindings/image-async-task";
import "@/server/uol-bindings/image-deletion";
import "@/server/uol-bindings/image-generation";
import "@/server/uol-bindings/operations-dashboard-facts";
import "@/server/uol-bindings/operations-dashboard";
import "@/server/uol-bindings/payment-admin";
import "@/server/uol-bindings/payment-fulfillment";
import "@/server/uol-bindings/payment-webhooks";
import "@/server/uol-bindings/payment-user";
import "@/server/uol-bindings/referrals";
import "@/server/uol-bindings/video-generation";
import "@/server/uol-bindings/user-auth";
import "@/server/site-branding-binding";

import { canViewGlobalUsageRecords } from "@repo/shared/auth/roles";
import {
  usageEventDetailSchema,
  usageEventListOutputSchema,
} from "@repo/shared/credits/usage-log-contract";
import {
  type AdminHistoryListOutput,
  type AdminHistoryRequestSnapshotOutput,
  adminHistoryListOutputSchema,
  adminHistoryRequestSnapshotOutputSchema,
  type HistoryListOutput,
  historyListOutputSchema,
} from "@repo/shared/image-generation/history-contract";
import {
  type ModerationImageInput,
  moderateContent,
} from "@repo/shared/moderation";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindExecute,
  isExternalApiKeyPrincipal,
  isMcpApiKeyPrincipal,
  OperationError,
} from "@repo/shared/uol";
import { getExternalModelsForApiKey } from "@/features/external-api/models";
import { bindHomepageReliabilityOperation } from "@/server/homepage-reliability-binding";
import { bindModelMarketplaceOperations } from "@/server/model-marketplace-binding";
import { requestGoJson } from "@/server/go-backend-client";

// ---------------------------------------------------------------------------
// image-generation 域
// ---------------------------------------------------------------------------

/** moderation.proxyModerate - 将代理请求的 base64 图片转换为领域输入并阻止回环代理。 */
bindExecute(
  "moderation.proxyModerate",
  async (
    input: {
      prompt: string;
      images?: Array<{
        data?: string;
        type?: string;
        name?: string;
        url?: string;
      }>;
      mode?: "text" | "image";
      userId?: string;
      effectiveBlockRiskLevel: "low" | "medium" | "high";
      generationId?: string;
    },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    const images = input.images
      ?.map(
        (image): ModerationImageInput => ({
          data: image.data
            ? Buffer.from(image.data, "base64")
            : Buffer.alloc(0),
          type: image.type || "image/png",
          ...(image.name ? { name: image.name } : {}),
          ...(image.url ? { url: image.url } : {}),
        })
      )
      .filter((image) => image.data.length > 0 || Boolean(image.url));
    return moderateContent({
      prompt: input.prompt,
      ...(images ? { images } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      effectiveBlockRiskLevel: input.effectiveBlockRiskLevel,
      ...(input.generationId ? { generationId: input.generationId } : {}),
      skipProxy: true,
    });
  }
);

/** 绑定本人统一生成历史；站内会话和 User MCP 可读，外部 API Key 继续隔离。 */
bindExecute(
  "image.listMyHistoryRecords",
  async (input: unknown, principal: Principal): Promise<HistoryListOutput> => {
    if (principal.type !== "user" && !isMcpApiKeyPrincipal(principal)) {
      throw new OperationError(
        "unauthenticated",
        "User session or MCP authentication required"
      );
    }
    void principal.userId;
    return historyListOutputSchema.parse(
      await requestGoJson("/api/image-generation/history", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }
);

/** 绑定管理员全局统一生成历史；仅现有三档管理员可读取受控用户身份字段。 */
bindExecute(
  "image.listAdminHistoryRecords",
  async (
    input: unknown,
    principal: Principal
  ): Promise<AdminHistoryListOutput> => {
    if (
      principal.type !== "user" ||
      !canViewGlobalUsageRecords(principal.role)
    ) {
      throw new OperationError("forbidden", "Admin access required");
    }
    return adminHistoryListOutputSchema.parse(
      await requestGoJson("/api/admin/image-generation/history", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }
);

/** 绑定管理员详情请求快照；列表接口继续保持窄响应和最小敏感面。 */
bindExecute(
  "image.getAdminHistoryRequestSnapshot",
  async (
    input: unknown,
    principal: Principal
  ): Promise<AdminHistoryRequestSnapshotOutput> => {
    if (
      principal.type !== "user" ||
      !canViewGlobalUsageRecords(principal.role)
    ) {
      throw new OperationError("forbidden", "Admin access required");
    }
    return adminHistoryRequestSnapshotOutputSchema.parse(
      await requestGoJson("/api/admin/image-generation/request-snapshot", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }
);

/**
 * externalApi.getModels - 外接 API 模型列表。
 *
 * 源：apps/web/src/features/external-api/models.ts。
 * WHY：供应商模型列表必须经过同一 UOL 网关，避免 HTTP 路由和未来 MCP 传输
 * 在可见模型集合上产生漂移。
 */
bindExecute(
  "externalApi.getModels",
  async (
    _input: Record<string, never>,
    principal: Principal,
    _ctx: OperationContext
  ) => {
    if (!isExternalApiKeyPrincipal(principal)) {
      throw new OperationError(
        "unauthenticated",
        "API key authentication required"
      );
    }
    return getExternalModelsForApiKey(principal.userId, principal.apiKeyId);
  }
);

// 首页生成 SLA 使用独立 binding，固定统计窗口并保持 strict DTO 边界。
bindHomepageReliabilityOperation();
// 管理模型配置与公开模型广场共用专用 binding，保持错误和 DTO 边界单点收敛。
bindModelMarketplaceOperations();

// ---------------------------------------------------------------------------
// credits 使用日志域
// ---------------------------------------------------------------------------

/** 绑定本人使用日志列表；userId 只取 Principal，输出再次通过共享 schema。 */
bindExecute(
  "credits.listMyUsageEvents",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "user") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    void principal.userId;
    return usageEventListOutputSchema.parse(
      await requestGoJson("/api/credits/usage-log", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }
);

/** 绑定本人单条使用详情；跨用户、签名错误和不存在统一 not_found。 */
bindExecute(
  "credits.getMyUsageEventDetail",
  async (input: { eventRef: string }, principal: Principal) => {
    if (principal.type !== "user") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    void principal.userId;
    return usageEventDetailSchema.parse(
      await requestGoJson("/api/credits/usage-log/detail", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }
);

// ---------------------------------------------------------------------------
// credits（按金额充值）域
// ---------------------------------------------------------------------------

/** credits.getTopUpOptions - 返回已完成支付配置的充值选项。 */
bindExecute(
  "credits.getTopUpOptions",
  async (
    _input: Record<string, never>,
    _principal: Principal,
    _ctx: OperationContext
  ) =>
    requestGoJson("/api/credits/top-up/options")
);

/** credits.createTopUpCheckout - 创建带 per-user clientRequestId 幂等键的充值订单。 */
bindExecute(
  "credits.createTopUpCheckout",
  async (
    input: {
      clientRequestId: string;
      currency: string;
      amountMinor: number;
      provider: "alipay_f2f";
    },
    principal: Principal,
    _ctx: OperationContext
  ) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    void principal.userId;
    return requestGoJson("/api/credits/top-up/checkout", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
);

/** credits.getTopUpOrderStatus - 订单查询按当前用户 ID 过滤，避免 IDOR。 */
bindExecute(
  "credits.getTopUpOrderStatus",
  async (
    input: { orderId: string },
    principal: Principal,
    _ctx: OperationContext
  ) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    void principal.userId;
    return requestGoJson("/api/credits/top-up/order-status", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
);

/** credits.getPaymentStatus - 统一结果页按当前用户过滤支付订单，避免 IDOR。 */
bindExecute(
  "credits.getPaymentStatus",
  async (
    input: { orderId: string },
    principal: Principal,
    _ctx: OperationContext
  ) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    void principal.userId;
    return requestGoJson("/api/credits/payment/status", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
);

/** credits.fulfillAlipayTopUp - 支付宝路由完成 RSA2 验签后经 UOL 履约。 */
bindExecute(
  "credits.fulfillAlipayTopUp",
  async (
    input: {
      outTradeNo: string;
      tradeNo: string;
      tradeStatus: string;
      totalAmount: string;
      appId: string;
      sellerId: string;
      gmtPayment?: string;
    },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    // Provider signature verification remains at the webhook boundary.  This
    // operation only forwards the verified notification to Go's durable
    // fulfillment state machine using the scheduler credential.
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) throw new OperationError("internal_error", "支付服务未配置");
    return requestGoJson("/api/internal/payment-fulfillment/alipay", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify(input),
    });
  }
);

// TODO: image.generateAction - 委托 image.generate
// TODO: image.getStatus - getGenerationStatus 逻辑
// TODO: image.getUserGenerations - 分页查询逻辑
// TODO: image.getUserGenerationCount - 计数查询逻辑
// TODO: image.getUserRecentGenerations - 最近生成查询
// TODO: image.getGenerationById - 单条查询
// TODO: image.getGenerationStats - 管理员统计
// TODO: image.getEffectiveConfig - getEffectiveConfig 逻辑

// ---------------------------------------------------------------------------
// user-auth 域
// ---------------------------------------------------------------------------

// TODO: user.getDetail - getUserDetailAction 逻辑
// TODO: user.updateRole - updateUserRoleAction 逻辑
// TODO: user.ban - banUserAction 逻辑
// TODO: user.grantCredits - adminGrantCreditsAction 逻辑
// TODO: user.adjustCredits - adminAdjustCreditsAction 逻辑
// TODO: user.setCreditsStatus - setUserCreditsStatusAction 逻辑
// TODO: user.setExternalApiKeyStatus - setExternalApiKeyStatusAction 逻辑
// TODO: user.create - createUserAction 逻辑
// TODO: user.updateProfile - updateUserProfileAction 逻辑
// TODO: user.setPassword - setUserPasswordAction 逻辑

// ---------------------------------------------------------------------------
// external-api 域
// ---------------------------------------------------------------------------

/** API 密钥管理只接受 session user Principal，身份不得从输入读取。 */
function getApiKeyManagementUserId(principal: Principal): string {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  return principal.userId;
}

type GoExternalApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  generationGroupId: string | null;
  creditLimit: number | null;
  creditsUsed: number;
  lastUsedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  currentGroup: { id: string; name: string; enabled: boolean; selectable: boolean } | null;
};

function parseGoExternalApiKeySummary(raw: GoExternalApiKeySummary) {
  return {
    ...raw,
    lastUsedAt: raw.lastUsedAt ? new Date(raw.lastUsedAt) : null,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
  };
}

async function requestExternalApiKeys<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await requestGoJson<T>(path, init);
  } catch (error) {
    // requestGoJson preserves the Go status in its error message; map the
    // stable conflict/not-found messages to the UOL error vocabulary.
    if (error instanceof Error) {
      if (/不存在/.test(error.message) || /NOT_FOUND/.test(error.message)) {
        throw new OperationError("not_found", error.message);
      }
      if (/冲突|已撤销|不能修改/.test(error.message) || /STATE_CONFLICT/.test(error.message)) {
        throw new OperationError("validation_error", error.message, { reason: "state_conflict" }, 409);
      }
    }
    throw error;
  }
}

/** externalApi.listKeys - 返回本人全部可恢复 Key 与当前可编辑分组。 */
bindExecute(
  "externalApi.listKeys",
  async (_input: Record<string, never>, principal: Principal) => {
    getApiKeyManagementUserId(principal);
    const raw = await requestExternalApiKeys<{
      keys: Array<GoExternalApiKeySummary & { apiKey: string | null }>;
      editableGroups: Array<{ id: string; name: string; enabled: boolean; selectable: boolean }>;
    }>("/api/external-api/keys");
    return {
      keys: raw.keys.map((key) => ({ ...parseGoExternalApiKeySummary(key), apiKey: key.apiKey })),
      editableGroups: raw.editableGroups,
    };
  }
);

/** externalApi.createKey - 明文只在本次 operation 输出返回。 */
bindExecute(
  "externalApi.createKey",
  async (
    input: { name?: string; generationGroupId?: string | null; creditLimit?: number | null },
    principal: Principal
  ) => {
    getApiKeyManagementUserId(principal);
    const raw = await requestExternalApiKeys<{ apiKey: string; key: GoExternalApiKeySummary }>(
      "/api/external-api/keys",
      { method: "POST", body: JSON.stringify(input) }
    );
    return { apiKey: raw.apiKey, key: parseGoExternalApiKeySummary(raw.key) };
  }
);

/** externalApi.revokeKey - 原子撤销本人启用 Key。 */
bindExecute(
  "externalApi.revokeKey",
  async (input: { keyId: string }, principal: Principal) => {
    getApiKeyManagementUserId(principal);
    const raw = await requestExternalApiKeys<GoExternalApiKeySummary>(
      `/api/external-api/keys/${encodeURIComponent(input.keyId)}`,
      { method: "DELETE" }
    );
    return parseGoExternalApiKeySummary(raw);
  }
);

/** externalApi.deleteKey - 仅删除本人已撤销 Key。 */
bindExecute(
  "externalApi.deleteKey",
  async (input: { keyId: string }, principal: Principal) => {
    getApiKeyManagementUserId(principal);
    return requestExternalApiKeys<{ id: string }>(
      `/api/external-api/keys/${encodeURIComponent(input.keyId)}?hard=1`,
      { method: "DELETE" }
    );
  }
);

/** externalApi.updateKeyGroup - 仅更新本人启用 Key 的可选分组。 */
bindExecute(
  "externalApi.updateKeyGroup",
  async (
    input: { keyId: string; generationGroupId: string | null },
    principal: Principal
  ) => {
    getApiKeyManagementUserId(principal);
    return requestExternalApiKeys<GoExternalApiKeySummary>(
      `/api/external-api/keys/${encodeURIComponent(input.keyId)}`,
      { method: "PATCH", body: JSON.stringify({ generationGroupId: input.generationGroupId }) }
    ).then(parseGoExternalApiKeySummary);
  }
);

/** externalApi.updateKeyQuota - 仅更新本人启用 Key 的积分额度。 */
bindExecute(
  "externalApi.updateKeyQuota",
  async (
    input: { keyId: string; creditLimit: number | null },
    principal: Principal
  ) => {
    getApiKeyManagementUserId(principal);
    return requestExternalApiKeys<GoExternalApiKeySummary>(
      `/api/external-api/keys/${encodeURIComponent(input.keyId)}`,
      { method: "PATCH", body: JSON.stringify({ creditLimit: input.creditLimit }) }
    ).then(parseGoExternalApiKeySummary);
  }
);

// TODO: externalApi.handleImageGenerations - image-generations handler 逻辑
// TODO: externalApi.handleImageEdits - image-edits handler 逻辑

// ---------------------------------------------------------------------------
// support 域
// ---------------------------------------------------------------------------

// TODO: support.createTicket - createTicketAction 逻辑
// TODO: support.listTickets - getTicketsAction 逻辑
// TODO: support.getTicketDetail - getTicketDetailAction 逻辑
// TODO: support.replyTicket - replyTicketAction 逻辑
// TODO: support.closeTicket - closeTicketAction 逻辑
// TODO: support.adminListTickets - adminGetTicketsAction 逻辑
// TODO: support.adminReplyTicket - adminReplyTicketAction 逻辑
// TODO: support.adminUpdateTicketStatus - adminUpdateTicketStatusAction 逻辑
