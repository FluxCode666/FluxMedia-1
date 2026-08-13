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
import "@/server/uol-bindings/adobe-credential-health";
import "@/server/uol-bindings/admin-status";
import "@/server/uol-bindings/analytics";
import "@/server/uol-bindings/content";
import "@/server/uol-bindings/image-backend-pool";
import "@/server/uol-bindings/image-async-task";
import "@/server/uol-bindings/image-deletion";
import "@/server/uol-bindings/image-generation";
import "@/server/uol-bindings/payment-admin";
import "@/server/uol-bindings/payment-user";
import "@/server/uol-bindings/referrals";
import "@/server/uol-bindings/video-generation";
import "@/server/notification-settings-binding";
import "@/server/site-branding-binding";

import { canViewGlobalUsageRecords } from "@repo/shared/auth/roles";
import {
  type UsageEvent,
  type UsageEventDetail,
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
import { checkRateLimit } from "@repo/shared/rate-limit";
import { getAppTimeZone, getUserTimeZone } from "@repo/shared/time-zone/server";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindExecute,
  isExternalApiKeyPrincipal,
  isMcpApiKeyPrincipal,
  OperationError,
} from "@repo/shared/uol";
import {
  type CreateExternalApiKeyInput,
  ExternalApiKeyManagementError,
  externalApiKeyManagementService,
} from "@/features/external-api/key-management-service";
import { getExternalModelsForApiKey } from "@/features/external-api/models";
import { databaseAdminHistoryRepository } from "@/features/image-generation/admin-history-repository";
import {
  AdminHistoryServiceError,
  loadAdminHistoryRecords,
  loadAdminHistoryRequestSnapshot,
} from "@/features/image-generation/admin-history-service";
import { databaseHistoryRepository } from "@/features/image-generation/history-repository";
import {
  HistoryServiceError,
  loadHistoryRecords,
} from "@/features/image-generation/history-service";
import {
  createCreditTopUpCheckout,
  fulfillAlipayCreditTopUp,
  getCreditPaymentStatus,
  getCreditTopUpOptions,
  getCreditTopUpOrderStatus,
} from "@/features/payment/credit-top-up";
import { databaseUsageLogRepository } from "@/features/usage-log/repository";
import {
  loadUsageEventDetail,
  loadUsageEvents,
  UsageLogServiceError,
} from "@/features/usage-log/service";
import { bindHomepageReliabilityOperation } from "@/server/homepage-reliability-binding";
import { bindModelMarketplaceOperations } from "@/server/model-marketplace-binding";

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
    try {
      const timeZone = await getUserTimeZone(principal.userId);
      return historyListOutputSchema.parse(
        await loadHistoryRecords(
          { userId: principal.userId, timeZone, input },
          { repository: databaseHistoryRepository }
        )
      );
    } catch (error) {
      if (error instanceof HistoryServiceError) {
        throw new OperationError(error.code, error.message);
      }
      throw error;
    }
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
    try {
      return adminHistoryListOutputSchema.parse(
        await loadAdminHistoryRecords(
          {
            actorUserId: principal.userId,
            timeZone: getAppTimeZone(),
            input,
          },
          { repository: databaseAdminHistoryRepository }
        )
      );
    } catch (error) {
      if (error instanceof AdminHistoryServiceError) {
        throw new OperationError(error.code, error.message);
      }
      throw error;
    }
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
    try {
      return adminHistoryRequestSnapshotOutputSchema.parse(
        await loadAdminHistoryRequestSnapshot(
          { input },
          { repository: databaseAdminHistoryRepository }
        )
      );
    } catch (error) {
      if (error instanceof AdminHistoryServiceError) {
        throw new OperationError(error.code, error.message);
      }
      throw error;
    }
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

/** 将 usage-log 服务稳定错误映射为 UOL 错误，不附带 token 或业务 ID。 */
function throwUsageLogOperationError(error: unknown): never {
  if (error instanceof UsageLogServiceError) {
    throw new OperationError(error.code, error.message);
  }
  throw error;
}

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
    try {
      const timeZone = await getUserTimeZone(principal.userId);
      const output = await loadUsageEvents(
        { userId: principal.userId, timeZone, input },
        { repository: databaseUsageLogRepository }
      );
      return usageEventListOutputSchema.parse(output) as {
        asOf: string;
        events: UsageEvent[];
        nextCursor: string | null;
      };
    } catch (error) {
      throwUsageLogOperationError(error);
    }
  }
);

/** 绑定本人单条使用详情；跨用户、签名错误和不存在统一 not_found。 */
bindExecute(
  "credits.getMyUsageEventDetail",
  async (input: { eventRef: string }, principal: Principal) => {
    if (principal.type !== "user") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    try {
      const output = await loadUsageEventDetail(
        { userId: principal.userId, eventRef: input.eventRef },
        { repository: databaseUsageLogRepository }
      );
      return usageEventDetailSchema.parse(output) as UsageEventDetail;
    } catch (error) {
      throwUsageLogOperationError(error);
    }
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
  ) => getCreditTopUpOptions()
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
    // 充值下单会触发第三方预下单，按用户而非 IP 限流，避免 Server Action
    // 绕过 API middleware 后被反复调用消耗支付宝网关配额。
    const rateLimit = await checkRateLimit(
      `credit-top-up:${principal.userId}`,
      "payment"
    );
    if (!rateLimit.success) {
      throw new OperationError(
        "rate_limited",
        "Credit top-up requests are too frequent"
      );
    }
    return createCreditTopUpCheckout({ ...input, userId: principal.userId });
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
    return getCreditTopUpOrderStatus({
      userId: principal.userId,
      orderId: input.orderId,
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
    return getCreditPaymentStatus({
      userId: principal.userId,
      orderId: input.orderId,
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
    },
    _principal: Principal,
    _ctx: OperationContext
  ) => fulfillAlipayCreditTopUp(input)
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

/** 将应用服务预期领域错误稳定映射为 UOL 错误。 */
async function invokeApiKeyManagement<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ExternalApiKeyManagementError)) throw error;
    switch (error.code) {
      case "not_found":
        throw new OperationError("not_found", error.message);
      case "validation_error":
        throw new OperationError("validation_error", error.message);
      case "state_conflict":
        throw new OperationError(
          "validation_error",
          error.message,
          { reason: "state_conflict" },
          409
        );
    }
  }
}

/** externalApi.listKeys - 分页返回本人可恢复 Key 与当前可编辑分组。 */
bindExecute(
  "externalApi.listKeys",
  async (input: { page: number; pageSize: number }, principal: Principal) =>
    invokeApiKeyManagement(() =>
      externalApiKeyManagementService.listKeys(
        getApiKeyManagementUserId(principal),
        input
      )
    )
);

/** externalApi.createKey - 明文只在本次 operation 输出返回。 */
bindExecute(
  "externalApi.createKey",
  async (input: CreateExternalApiKeyInput, principal: Principal) =>
    invokeApiKeyManagement(() =>
      externalApiKeyManagementService.createKey(
        getApiKeyManagementUserId(principal),
        input
      )
    )
);

/** externalApi.revokeKey - 原子撤销本人启用 Key。 */
bindExecute(
  "externalApi.revokeKey",
  async (input: { keyId: string }, principal: Principal) =>
    invokeApiKeyManagement(() =>
      externalApiKeyManagementService.revokeKey(
        getApiKeyManagementUserId(principal),
        input.keyId
      )
    )
);

/** externalApi.deleteKey - 仅删除本人已撤销 Key。 */
bindExecute(
  "externalApi.deleteKey",
  async (input: { keyId: string }, principal: Principal) =>
    invokeApiKeyManagement(() =>
      externalApiKeyManagementService.deleteKey(
        getApiKeyManagementUserId(principal),
        input.keyId
      )
    )
);

/** externalApi.updateKeyGroup - 仅更新本人启用 Key 的可选分组。 */
bindExecute(
  "externalApi.updateKeyGroup",
  async (
    input: { keyId: string; generationGroupId: string | null },
    principal: Principal
  ) =>
    invokeApiKeyManagement(() =>
      externalApiKeyManagementService.updateKeyGroup(
        getApiKeyManagementUserId(principal),
        input.keyId,
        input.generationGroupId
      )
    )
);

/** externalApi.updateKeyQuota - 仅更新本人启用 Key 的积分额度。 */
bindExecute(
  "externalApi.updateKeyQuota",
  async (
    input: { keyId: string; creditLimit: number | null },
    principal: Principal
  ) =>
    invokeApiKeyManagement(() =>
      externalApiKeyManagementService.updateKeyQuota(
        getApiKeyManagementUserId(principal),
        input.keyId,
        input.creditLimit
      )
    )
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
