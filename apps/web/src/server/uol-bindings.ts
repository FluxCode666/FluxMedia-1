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

import {
  usageSummaryOutputSchema,
  usageTrendsInputSchema,
  usageTrendsOutputSchema,
} from "@repo/shared/analytics/contracts";
import { resolveUsageTimeRange } from "@repo/shared/analytics/range";
import { getAnalyticsMetricUnit } from "@repo/shared/analytics/series";
import { normalizeSubscriptionPlan } from "@repo/shared/config/subscription-plan";
import {
  type UsageEvent,
  type UsageEventDetail,
  usageEventDetailSchema,
  usageEventListOutputSchema,
} from "@repo/shared/credits/usage-log-contract";
import type { BackendGroupInput } from "@repo/shared/image-backend/group-contract";
import type { BackendMemberInput } from "@repo/shared/image-backend/member-contract";
import type { RequestParameterMapping } from "@repo/shared/image-backend/request-parameter-mapping";
import {
  type AdminHistoryListOutput,
  adminHistoryListOutputSchema,
  type HistoryListOutput,
  historyListOutputSchema,
} from "@repo/shared/image-generation/history-contract";
import {
  type ModerationImageInput,
  moderateContent,
} from "@repo/shared/moderation";
import { checkRateLimit } from "@repo/shared/rate-limit";
import type { SubscriptionCheckoutInput } from "@repo/shared/subscription/checkout-contract";
import { subscriptionCheckoutOutputSchema } from "@repo/shared/subscription/checkout-contract";
import { purchasablePlansOutputSchema } from "@repo/shared/subscription/purchase-contract";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindExecute,
  getPrincipalUserId,
  OperationError,
} from "@repo/shared/uol";
import {
  type AnalyticsReadModelState,
  loadOutputUsageSummary,
  loadOutputUsageTrends,
  readAnalyticsReadModelStates,
} from "@/features/dashboard/analytics-service";
import {
  type CreateExternalApiKeyInput,
  ExternalApiKeyManagementError,
  externalApiKeyManagementService,
} from "@/features/external-api/key-management-service";
import { getExternalModelsForApiKey } from "@/features/external-api/models";
import {
  BackendGroupServiceError,
  backendGroupService,
} from "@/features/image-backend-pool/group-service";
import {
  BackendMemberServiceError,
  backendMemberService,
} from "@/features/image-backend-pool/member-service";
import {
  deleteImageBackendParameterMappingTemplate,
  listImageBackendParameterMappingTemplates,
  upsertImageBackendParameterMappingTemplate,
} from "@/features/image-backend-pool/service";
import { databaseAdminHistoryRepository } from "@/features/image-generation/admin-history-repository";
import {
  AdminHistoryServiceError,
  loadAdminHistoryRecords,
} from "@/features/image-generation/admin-history-service";
import {
  deleteAdobeAccount,
  importAdobeAccount,
  listAdobeAccounts,
  setAdobeAccountEnabled,
} from "@/features/image-generation/adobe-direct";
import { databaseHistoryRepository } from "@/features/image-generation/history-repository";
import {
  HistoryServiceError,
  loadHistoryRecords,
} from "@/features/image-generation/history-service";
import { runImageGenerationForUser } from "@/features/image-generation/operations";
import type { ImageQuality } from "@/features/image-generation/types";
import {
  createCreditTopUpCheckout,
  fulfillAlipayCreditTopUp,
  getCreditPaymentStatus,
  getCreditTopUpOptions,
  getCreditTopUpOrderStatus,
} from "@/features/payment/credit-top-up";
import {
  createSubscriptionCheckout,
  SubscriptionCheckoutError,
  selectTrustedSubscriptionCheckoutInput,
} from "@/features/payment/subscription-checkout";
import { loadSubscriptionPurchaseOptions } from "@/features/payment/subscription-purchase-options";
import { databaseUsageLogRepository } from "@/features/usage-log/repository";
import {
  loadUsageEventDetail,
  loadUsageEvents,
  UsageLogServiceError,
} from "@/features/usage-log/service";
import { bindPlatformModelCatalogOperation } from "@/server/platform-model-catalog-binding";

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

/**
 * image.generate - 统一管线核心
 * 源: apps/web/src/features/image-generation/operations.ts
 */
bindExecute(
  "image.generate",
  async (
    input: {
      prompt: string;
      negativePrompt?: string;
      model?: string;
      size?: string;
      quality?: string;
      style?: string;
      count?: number;
      generationId?: string;
      backendGroupId?: string;
    },
    principal: Principal,
    _ctx: OperationContext
  ) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) {
      throw new OperationError("forbidden", "User identity required");
    }

    const result = await runImageGenerationForUser({
      mode: "generate",
      userId,
      prompt: input.prompt,
      model: input.model,
      size: input.size,
      quality: input.quality as ImageQuality | undefined,
      n: input.count,
      generationId: input.generationId,
      backendGroupId: input.backendGroupId,
    });

    if (result.error) {
      throw new Error(result.error);
    }

    // 将 ImageGenerationOperationResult 映射到 UOL output schema
    const images: { url: string; revisedPrompt?: string }[] = [];
    if (result.imageUrl) {
      images.push({
        url: result.imageUrl,
        revisedPrompt: result.revisedPrompt,
      });
    }
    if (result.imageOutputs) {
      for (const output of result.imageOutputs) {
        if (output.imageUrl) {
          images.push({
            url: output.imageUrl,
            revisedPrompt: output.revisedPrompt,
          });
        }
      }
    }

    return {
      generationId: result.generationId ?? input.generationId ?? "",
      images,
      creditsUsed: result.creditsConsumed,
      model: result.model,
    };
  }
);

/** 绑定本人统一生成历史；Principal 是唯一身份来源，API key 不得读取站内完整历史。 */
bindExecute(
  "image.listMyHistoryRecords",
  async (input: unknown, principal: Principal): Promise<HistoryListOutput> => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
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

/** 绑定管理员全局统一生成历史；仅真实 admin/super_admin 可读取受控用户身份字段。 */
bindExecute(
  "image.listAdminHistoryRecords",
  async (
    input: unknown,
    principal: Principal
  ): Promise<AdminHistoryListOutput> => {
    if (
      principal.type !== "user" ||
      (principal.role !== "admin" && principal.role !== "super_admin")
    ) {
      throw new OperationError("forbidden", "Admin access required");
    }
    try {
      const timeZone = await getUserTimeZone(principal.userId);
      return adminHistoryListOutputSchema.parse(
        await loadAdminHistoryRecords(
          {
            actorUserId: principal.userId,
            timeZone,
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

/**
 * externalApi.getModels - 外接 API 模型列表。
 *
 * 源：apps/web/src/features/external-api/models.ts。
 * WHY：套餐能力与供应商模型列表必须经过同一 UOL 网关，避免 HTTP 路由和未来 MCP
 * 传输在可见模型集合上产生漂移。
 */
bindExecute(
  "externalApi.getModels",
  async (
    _input: Record<string, never>,
    principal: Principal,
    _ctx: OperationContext
  ) => {
    if (principal.type !== "apiKey") {
      throw new OperationError(
        "unauthenticated",
        "API key authentication required"
      );
    }
    const plan = normalizeSubscriptionPlan(principal.plan);
    if (!(await canUsePlanCapability(plan, "externalApi.models.list"))) {
      throw new OperationError(
        "capability_required",
        "External API model listing is not enabled for this plan."
      );
    }
    return getExternalModelsForApiKey(
      principal.userId,
      principal.apiKeyId,
      plan
    );
  }
);

// 首页平台目录使用独立 binding 保持 strict DTO 映射可被聚焦集成测试复用。
bindPlatformModelCatalogOperation();

// ---------------------------------------------------------------------------
// analytics 域
// ---------------------------------------------------------------------------

/** 判断单个统计读模型是否达到当前线上查询所需版本。 */
function isAnalyticsReadModelReady(state: AnalyticsReadModelState): boolean {
  return state?.version === 1 && state.status === "ready";
}

/** 将 usage-log 服务稳定错误映射为 UOL 错误，不附带 token 或业务 ID。 */
function throwUsageLogOperationError(error: unknown): never {
  if (error instanceof UsageLogServiceError) {
    throw new OperationError(error.code, error.message);
  }
  throw error;
}

/** 查询统一 analytics readiness，未完成回填时返回相同的暂不可用错误。 */
async function assertAnalyticsReady(): Promise<void> {
  const states = await readAnalyticsReadModelStates();
  if (
    !isAnalyticsReadModelReady(states.outputUsage) ||
    !isAnalyticsReadModelReady(states.creditUsage)
  ) {
    throw new OperationError(
      "not_ready",
      "Analytics data is still being prepared",
      undefined,
      503
    );
  }
}

/** 绑定本人近 24 小时摘要 operation，用户 ID 只来自 Principal。 */
bindExecute(
  "analytics.getMyUsageSummary",
  async (_input: Record<string, never>, principal: Principal) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    await assertAnalyticsReady();
    const timeZone = await getUserTimeZone(principal.userId);
    const asOf = new Date();
    const last24HoursRange = {
      start: new Date(asOf.getTime() - 24 * 60 * 60 * 1000),
      end: asOf,
    };
    const result = await loadOutputUsageSummary({
      userId: principal.userId,
      last24HoursRange,
    });
    return usageSummaryOutputSchema.parse({
      asOf: asOf.toISOString(),
      timeZone,
      last24HoursRange: {
        start: last24HoursRange.start.toISOString(),
        end: last24HoursRange.end.toISOString(),
      },
      last24Hours: result.last24Hours,
      modelDistribution: result.modelDistribution,
      lifetime: result.lifetime,
    });
  }
);

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

/** 绑定本人趋势 operation，统一解析时区范围并只执行一次输出事件查询。 */
bindExecute(
  "analytics.getMyUsageTrends",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    await assertAnalyticsReady();
    const parsed = usageTrendsInputSchema.parse(input);
    const timeZone = await getUserTimeZone(principal.userId);
    let range: ReturnType<typeof resolveUsageTimeRange>;
    try {
      range = resolveUsageTimeRange(parsed, {
        timeZone,
        asOf: new Date(),
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new OperationError("validation_error", error.message);
      }
      throw error;
    }
    const result = await loadOutputUsageTrends({
      userId: principal.userId,
      range,
    });
    return usageTrendsOutputSchema.parse({
      asOf: range.asOf.toISOString(),
      timeZone,
      range: { start: range.start.toISOString(), end: range.end.toISOString() },
      granularity: range.granularity,
      metric: range.metric,
      unit: getAnalyticsMetricUnit(range.metric),
      buckets: result.buckets,
      distribution: result.distribution,
    });
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

// ---------------------------------------------------------------------------
// subscription 钱包购买能力域
// ---------------------------------------------------------------------------

/**
 * subscription.listMyPurchasablePlans - 只从 user Principal 读取本人资格。
 * 输出再次执行共享 schema，防止运行时套餐配置夹带敏感字段。
 */
bindExecute(
  "subscription.listMyPurchasablePlans",
  async (
    _input: Record<string, never>,
    principal: Principal,
    _ctx: OperationContext
  ) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    return purchasablePlansOutputSchema.parse(
      await loadSubscriptionPurchaseOptions(principal.userId)
    );
  }
);

/**
 * subscription.createCheckout - 渠道与回跳只取服务端真相。
 *
 * 兼容输入中的 provider/successUrl/cancelUrl 不会下传，防止客户端改写资金路径；
 * userId 只从已鉴权 user Principal 取得，输出再次经过共享窄 schema。
 */
bindExecute(
  "subscription.createCheckout",
  async (
    input: SubscriptionCheckoutInput,
    principal: Principal,
    _ctx: OperationContext
  ) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    const trusted = selectTrustedSubscriptionCheckoutInput(
      principal.userId,
      input
    );
    try {
      return subscriptionCheckoutOutputSchema.parse(
        await createSubscriptionCheckout(trusted.userId, trusted.priceId)
      );
    } catch (error) {
      if (error instanceof SubscriptionCheckoutError) {
        throw new OperationError("validation_error", error.message);
      }
      throw error;
    }
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

/** pool.listParameterMappingTemplates - 读取可复用的参数映射模板。 */
bindExecute(
  "pool.listParameterMappingTemplates",
  async (
    _input: Record<string, never>,
    _principal: Principal,
    _ctx: OperationContext
  ) => ({
    templates: await listImageBackendParameterMappingTemplates(),
  })
);

/** pool.saveParameterMappingTemplate - 保存独立的参数映射模板快照。 */
bindExecute(
  "pool.saveParameterMappingTemplate",
  async (
    input: {
      id?: string;
      name: string;
      parameterMappings: RequestParameterMapping[];
    },
    _principal: Principal,
    _ctx: OperationContext
  ) => ({
    id: await upsertImageBackendParameterMappingTemplate(input),
  })
);

/** pool.deleteParameterMappingTemplate - 删除模板，不影响已保存的 API 配置。 */
bindExecute(
  "pool.deleteParameterMappingTemplate",
  async (
    input: { id: string },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    await deleteImageBackendParameterMappingTemplate(input.id);
    return { success: true };
  }
);

// TODO: image.generateAction - 委托 image.generate
// TODO: image.delete - deleteGenerationAction 逻辑
// TODO: image.getStatus - getGenerationStatus 逻辑
// TODO: image.getUserGenerations - 分页查询逻辑
// TODO: image.getUserGenerationCount - 计数查询逻辑
// TODO: image.getUserRecentGenerations - 最近生成查询
// TODO: image.getGenerationById - 单条查询
// TODO: image.getGenerationStats - 管理员统计
// TODO: image.getEffectiveConfig - getEffectiveConfig 逻辑
// TODO: image.selectWebCandidate - selectChatGptWebImageCandidate 逻辑

// ---------------------------------------------------------------------------
// image-backend-pool 域
// ---------------------------------------------------------------------------

/**
 * 将统一号池领域错误映射为 UOL 错误。
 *
 * @param error 分组或成员服务抛出的未知错误。
 * @throws 始终抛出可由传输层稳定编码的错误；未知错误保持原样上抛。
 */
function throwBackendPoolOperationError(error: unknown): never {
  if (
    error instanceof BackendGroupServiceError ||
    error instanceof BackendMemberServiceError
  ) {
    throw new OperationError(error.code, error.message);
  }
  throw error;
}

/** pool.getGroupOptions - 获取用户可选择的启用分组。 */
bindExecute(
  "pool.getGroupOptions",
  async (
    _input: Record<string, never>,
    _principal: Principal,
    _ctx: OperationContext
  ) => ({ options: await backendGroupService.listGroupOptions() })
);

/** pool.getAdminPool - 读取统一分组和统一成员的脱敏管理快照。 */
bindExecute(
  "pool.getAdminPool",
  async (
    _input: Record<string, never>,
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    const [groups, members] = await Promise.all([
      backendGroupService.listGroups(),
      backendMemberService.listMembers(),
    ]);
    return { groups, members };
  }
);

/** pool.saveGroup - 保存统一分组及其计费、套餐和层级配置。 */
bindExecute(
  "pool.saveGroup",
  async (
    input: BackendGroupInput,
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    try {
      return await backendGroupService.saveGroup(input);
    } catch (error) {
      throwBackendPoolOperationError(error);
    }
  }
);

/** pool.deleteGroup - 删除不再被成员或层级关系使用的非默认分组。 */
bindExecute(
  "pool.deleteGroup",
  async (
    input: { id: string },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    try {
      return await backendGroupService.deleteGroup(input.id);
    } catch (error) {
      throwBackendPoolOperationError(error);
    }
  }
);

/** pool.saveMember - 保存 `api | adobe` 统一成员及类型专属配置。 */
bindExecute(
  "pool.saveMember",
  async (
    input: BackendMemberInput,
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    try {
      return await backendMemberService.saveMember(input);
    } catch (error) {
      throwBackendPoolOperationError(error);
    }
  }
);

/** pool.deleteMember - 按统一成员 ID 执行运行中任务保护删除。 */
bindExecute(
  "pool.deleteMember",
  async (
    input: { id: string },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    try {
      return await backendMemberService.deleteMember(input.id);
    } catch (error) {
      throwBackendPoolOperationError(error);
    }
  }
);

/** pool.listAdobeAccounts - 读取 Adobe direct 成员内部的脱敏账号。 */
bindExecute(
  "pool.listAdobeAccounts",
  async (
    input: { memberId: string },
    _principal: Principal,
    _ctx: OperationContext
  ) => ({
    accounts: (await listAdobeAccounts(input.memberId)).map((account) => ({
      id: account.id,
      name: account.name,
      displayName: account.displayName,
      email: account.email,
      isEnabled: account.isEnabled,
      status: account.status,
      lastRefreshAt: account.lastRefreshAt?.toISOString() ?? null,
      lastRefreshError: account.lastRefreshError,
      consecutiveFailures: account.consecutiveFailures,
      creditsTotal: account.creditsTotal,
      creditsUsed: account.creditsUsed,
      creditsAvailable: account.creditsAvailable,
    })),
  })
);

/** pool.importAdobeAccount - 导入并验证一个 Adobe direct Cookie。 */
bindExecute(
  "pool.importAdobeAccount",
  async (
    input: { memberId: string; cookie: string; name?: string },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    const account = await importAdobeAccount(input);
    return { id: account.id };
  }
);

/** pool.deleteAdobeAccount - 删除 Adobe direct 子账号及其级联 token。 */
bindExecute(
  "pool.deleteAdobeAccount",
  async (
    input: { id: string },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    await deleteAdobeAccount(input.id);
    return { success: true };
  }
);

/** pool.setAdobeAccountEnabled - 更新 Adobe direct 子账号启用状态。 */
bindExecute(
  "pool.setAdobeAccountEnabled",
  async (
    input: { id: string; isEnabled: boolean },
    _principal: Principal,
    _ctx: OperationContext
  ) => {
    await setAdobeAccountEnabled(input.id, input.isEnabled);
    return { success: true };
  }
);

// ---------------------------------------------------------------------------
// user-auth 域
// ---------------------------------------------------------------------------

// TODO: user.list - getAllUsersAction 逻辑（DB 查询在 packages/shared 但需运行时 DB 连接）
// TODO: user.getDetail - getUserDetailAction 逻辑
// TODO: user.updateRole - updateUserRoleAction 逻辑
// TODO: user.ban - banUserAction 逻辑
// TODO: user.grantCredits - adminGrantCreditsAction 逻辑
// TODO: user.adjustCredits - adminAdjustCreditsAction 逻辑
// TODO: user.setSubscription - setUserPlanAction 逻辑
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
      case "capability_required":
        throw new OperationError("capability_required", error.message);
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

/** externalApi.listKeys - 返回本人 Key 摘要与当前可编辑分组。 */
bindExecute(
  "externalApi.listKeys",
  async (_input: Record<string, never>, principal: Principal) =>
    invokeApiKeyManagement(() =>
      externalApiKeyManagementService.listKeys(
        getApiKeyManagementUserId(principal)
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
