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
import "@/server/uol-bindings/image-generation";
import "@/server/uol-bindings/payment-admin";

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
import type { MediaInputReference } from "@repo/shared/image-generation/media-contract";
import { logError } from "@repo/shared/logger";
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";
import {
  type ModerationImageInput,
  moderateContent,
} from "@repo/shared/moderation";
import { checkRateLimit } from "@repo/shared/rate-limit";
import type { SubscriptionCheckoutInput } from "@repo/shared/subscription/checkout-contract";
import { subscriptionCheckoutOutputSchema } from "@repo/shared/subscription/checkout-contract";
import { purchasablePlansOutputSchema } from "@repo/shared/subscription/purchase-contract";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindExecute,
  bindOperationExecute,
  isExternalApiKeyPrincipal,
  isMcpApiKeyPrincipal,
  OperationError,
} from "@repo/shared/uol";
import {
  videoListUncertainSubmissions,
  videoReconcileSubmission,
} from "@repo/shared/uol/operations/video-generation";
import {
  type AnalyticsReadModelState,
  loadOutputUsageSummary,
  loadOutputUsageTrends,
  readAnalyticsReadModelStates,
} from "@/features/dashboard/analytics-service";
import { validateCallbackUrl } from "@/features/external-api/async-image-tasks";
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
  buildBackendMemberModelOptions,
  findUnavailableBackendMemberModelIds,
} from "@/features/image-backend-pool/member-model-options";
import {
  BackendMemberServiceError,
  backendMemberService,
} from "@/features/image-backend-pool/member-service";
import {
  deleteBackendParameterMappingTemplate,
  listBackendParameterMappingTemplates,
  saveBackendParameterMappingTemplate,
} from "@/features/image-backend-pool/parameter-mapping-service";
import { databaseAdminHistoryRepository } from "@/features/image-generation/admin-history-repository";
import {
  AdminHistoryServiceError,
  loadAdminHistoryRecords,
} from "@/features/image-generation/admin-history-service";
import { databaseHistoryRepository } from "@/features/image-generation/history-repository";
import {
  HistoryServiceError,
  loadHistoryRecords,
} from "@/features/image-generation/history-service";
import { doesVideoCallbackDeliveryMatch } from "@/features/image-generation/video-callback-delivery";
import { cleanupUnusedStagedVideoInputs } from "@/features/image-generation/video-input-storage";
import {
  getVideoGenerationById,
  reconcileUncertainVideoSubmission,
  runAdobeVideoGenerationForUser,
  VideoSubmissionReconciliationError,
} from "@/features/image-generation/video-operations";
import { buildPublicVideoStatusUrl } from "@/features/image-generation/video-status-url";
import {
  releaseVideoTaskStagingReservation,
  VideoActiveTaskLimitError,
  VideoTaskStagingInProgressError,
} from "@/features/image-generation/video-task-admission";
import {
  createVideoPrincipalScope,
  createVideoRequestFingerprint,
  createVideoTaskId,
} from "@/features/image-generation/video-task-identity";
import { prepareVideoTaskInputReferences } from "@/features/image-generation/video-task-preparation";
import { productionModelConfigurationService } from "@/features/model-configuration/service";
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

type VideoOperationStatus =
  | "pending"
  | "submitting"
  | "processing"
  | "needs_attention"
  | "completed"
  | "failed";

/** 将持久视频状态映射为稳定 UOL 状态。 */
function toVideoOperationStatus(
  status: string,
  stage?: string
): VideoOperationStatus {
  if (stage === "submitting") return "submitting";
  if (stage === "submit_uncertain") return "needs_attention";
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "submitting":
      return "submitting";
    case "running":
    case "processing":
      return "processing";
    default:
      return "pending";
  }
}

/** 从任务 metadata 取一个非空字符串，非法历史值按缺失处理。 */
function readVideoMetadataString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 校验视频任务与当前 Principal 完全同域。
 *
 * API Key 任务不会因共享 userId 而被另一把 Key 或站内会话命中。
 */
function assertVideoTaskPrincipal(
  row: NonNullable<Awaited<ReturnType<typeof getVideoGenerationById>>>,
  principal: Principal,
  ctx: OperationContext
): void {
  if (principal.type !== "user" && principal.type !== "apiKey") {
    throw new OperationError("unauthenticated", "User identity required");
  }
  const expectedApiKeyId = isExternalApiKeyPrincipal(principal)
    ? principal.apiKeyId
    : null;
  if (
    row.userId !== principal.userId ||
    row.apiKeyId !== expectedApiKeyId ||
    row.principalScope !== createVideoPrincipalScope(principal)
  ) {
    throw new OperationError("not_found", "Video task not found");
  }
  ctx.assertOwnership("video task", row.userId);
}

/** 校验幂等重放的请求内容没有发生变化。 */
function assertVideoRequestFingerprint(
  row: NonNullable<Awaited<ReturnType<typeof getVideoGenerationById>>>,
  requestFingerprint: string
): void {
  if (
    readVideoMetadataString(row.metadata, "requestFingerprint") !==
    requestFingerprint
  ) {
    throw new OperationError(
      "idempotency_conflict",
      "clientRequestId was already used with different video input"
    );
  }
}

/** 从受信执行上下文读取并再次校验视频完成回调地址。 */
async function getTrustedVideoCompletionUrl(
  ctx: OperationContext
): Promise<string | undefined> {
  const value = ctx.callbacks?.videoCompletionUrl;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new OperationError(
      "validation_error",
      "videoCompletionUrl callback must be a string"
    );
  }
  try {
    return await validateCallbackUrl(value);
  } catch (error) {
    throw new OperationError(
      "validation_error",
      error instanceof Error ? error.message : "Invalid video callback URL"
    );
  }
}

/** 校验幂等视频请求没有更换或追加回调目的地。 */
async function assertVideoCallbackFingerprint(
  taskId: string,
  callbackUrl: string | undefined
): Promise<void> {
  if (await doesVideoCallbackDeliveryMatch(taskId, callbackUrl)) return;
  throw new OperationError(
    "idempotency_conflict",
    "clientRequestId was already used with a different callback URL"
  );
}

/** video.generate - Principal 作用域幂等地执行统一视频管线。 */
bindExecute(
  "video.generate",
  async (
    input: {
      clientRequestId: string;
      prompt: string;
      negativePrompt?: string;
      model: string;
      backendGroupId?: string;
      inputImages?: MediaInputReference[];
    },
    principal: Principal,
    ctx: OperationContext
  ) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    const apiKeyId = isExternalApiKeyPrincipal(principal)
      ? principal.apiKeyId
      : undefined;
    const callbackUrl = await getTrustedVideoCompletionUrl(ctx);
    const principalScope = createVideoPrincipalScope(principal);
    const taskId = createVideoTaskId({
      principalScope,
      clientRequestId: input.clientRequestId,
    });
    const requestFingerprint = createVideoRequestFingerprint(input);
    const existing = await getVideoGenerationById(taskId);
    if (existing) {
      assertVideoTaskPrincipal(existing, principal, ctx);
      assertVideoRequestFingerprint(existing, requestFingerprint);
      await assertVideoCallbackFingerprint(taskId, callbackUrl);
      return {
        taskId,
        status: toVideoOperationStatus(existing.status, existing.stage),
      };
    }

    let preparation: Awaited<
      ReturnType<typeof prepareVideoTaskInputReferences>
    >;
    try {
      preparation = await prepareVideoTaskInputReferences({
        taskId,
        userId: principal.userId,
        principalScope,
        references: input.inputImages ?? [],
      });
      if (preparation.admission === "existing") {
        const raced = await getVideoGenerationById(taskId);
        if (!raced) {
          throw new OperationError(
            "not_ready",
            "视频任务正在创建，请使用同一 clientRequestId 稍后重试"
          );
        }
        assertVideoTaskPrincipal(raced, principal, ctx);
        assertVideoRequestFingerprint(raced, requestFingerprint);
        await assertVideoCallbackFingerprint(taskId, callbackUrl);
        return {
          taskId,
          status: toVideoOperationStatus(raced.status, raced.stage),
        };
      }
    } catch (error) {
      if (error instanceof VideoActiveTaskLimitError) {
        throw new OperationError("rate_limited", error.message, {
          limitKind: error.limitKind,
          maxActiveTasks: error.maxActiveTasks,
        });
      }
      if (error instanceof VideoTaskStagingInProgressError) {
        throw new OperationError("not_ready", error.message);
      }
      logError(error, {
        source: "video-input-preparation",
        taskId,
        userId: principal.userId,
      });
      throw new OperationError(
        "not_ready",
        "视频任务暂时无法完成准入或输入转存，请稍后重试"
      );
    }
    const stagedInput = preparation.stagedInput;

    try {
      const result = await runAdobeVideoGenerationForUser(
        {
          userId: principal.userId,
          ...(apiKeyId ? { apiKeyId } : {}),
          principalScope,
          stagingReservationToken: preparation.reservationToken,
          videoGenerationId: taskId,
          clientRequestId: input.clientRequestId,
          requestFingerprint,
          prompt: input.prompt,
          model: input.model,
          ...(input.negativePrompt
            ? { negativePrompt: input.negativePrompt }
            : {}),
          ...(input.backendGroupId
            ? { backendGroupId: input.backendGroupId }
            : {}),
          ...(stagedInput.references.length
            ? { inputImages: stagedInput.references }
            : {}),
          ...(stagedInput.objects.length
            ? { stagedInputObjects: stagedInput.objects }
            : {}),
        },
        callbackUrl ? { callbackUrl } : undefined
      );
      const persisted = await getVideoGenerationById(taskId);
      await cleanupUnusedStagedVideoInputs({
        objects: stagedInput.objects,
        persistedReferences: persisted?.inputImageRefs,
      });
      if (persisted) {
        assertVideoTaskPrincipal(persisted, principal, ctx);
        assertVideoRequestFingerprint(persisted, requestFingerprint);
        await assertVideoCallbackFingerprint(taskId, callbackUrl);
      }
      return {
        taskId,
        status: persisted
          ? toVideoOperationStatus(persisted.status, persisted.stage)
          : "error" in result
            ? ("failed" as const)
            : ("pending" as const),
      };
    } catch (error) {
      // WHY：并发重放可能同时看到“未创建”，数据库主键会使其中一个
      // insert 失败。只有已存在且指纹一致时才把它视为幂等命中。
      await releaseVideoTaskStagingReservation({
        taskId,
        userId: principal.userId,
        reservationToken: preparation.reservationToken,
      }).catch((releaseError) =>
        logError(releaseError, {
          source: "video-staging-reservation-release",
          taskId,
          userId: principal.userId,
        })
      );
      const raced = await getVideoGenerationById(taskId);
      await cleanupUnusedStagedVideoInputs({
        objects: stagedInput.objects,
        persistedReferences: raced?.inputImageRefs,
      }).catch((cleanupError) =>
        logError(cleanupError, {
          source: "video-input-storage-cleanup",
          taskId,
          userId: principal.userId,
        })
      );
      if (!raced) {
        if (error instanceof VideoActiveTaskLimitError) {
          throw new OperationError("rate_limited", error.message, {
            limitKind: error.limitKind,
            maxActiveTasks: error.maxActiveTasks,
          });
        }
        throw error;
      }
      assertVideoTaskPrincipal(raced, principal, ctx);
      assertVideoRequestFingerprint(raced, requestFingerprint);
      await assertVideoCallbackFingerprint(taskId, callbackUrl);
      return {
        taskId,
        status: toVideoOperationStatus(raced.status, raced.stage),
      };
    }
  }
);

/** video.getStatus - 只返回当前 Principal 同域的持久视频任务。 */
bindExecute(
  "video.getStatus",
  async (
    input: { taskId: string },
    principal: Principal,
    ctx: OperationContext
  ) => {
    const row = await getVideoGenerationById(input.taskId);
    if (!row) {
      throw new OperationError("not_found", "Video task not found");
    }
    assertVideoTaskPrincipal(row, principal, ctx);
    const videoUrl = row.storageKey
      ? buildPublicVideoStatusUrl({
          storageKey: row.storageKey,
          bucket:
            (await getRuntimeSettingString(
              "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"
            )) || "generations",
          publicBaseUrl:
            (await getRuntimeSettingString("NEXT_PUBLIC_APP_URL")) ||
            (await getRuntimeSettingString("BETTER_AUTH_URL")),
        })
      : null;
    return {
      taskId: row.id,
      status: toVideoOperationStatus(row.status, row.stage),
      ...(videoUrl ? { videoUrl } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.createdAt.toISOString(),
      ...(row.completedAt
        ? { completedAt: row.completedAt.toISOString() }
        : {}),
    };
  }
);

/** video.listUncertainSubmissions - 管理员读取安全的待核对任务列表。 */
bindOperationExecute(videoListUncertainSubmissions, async (input) => {
  const [{ db }, { videoGeneration }, { desc, eq }] = await Promise.all([
    import("@repo/database"),
    import("@repo/database/schema"),
    import("drizzle-orm"),
  ]);
  const rows = await db
    .select({
      taskId: videoGeneration.id,
      model: videoGeneration.model,
      backendMemberId: videoGeneration.backendMemberId,
      error: videoGeneration.error,
      submitStartedAt: videoGeneration.submitStartedAt,
      createdAt: videoGeneration.createdAt,
      updatedAt: videoGeneration.updatedAt,
    })
    .from(videoGeneration)
    .where(eq(videoGeneration.stage, "submit_uncertain"))
    .orderBy(desc(videoGeneration.updatedAt), desc(videoGeneration.id))
    .limit(input.limit);
  return {
    items: rows.map((row) => ({
      ...row,
      submitStartedAt: row.submitStartedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
});

/** video.reconcileSubmission - 管理员人工收敛 Adobe 提交不确定任务。 */
bindOperationExecute(videoReconcileSubmission, async (input) => {
  try {
    return await reconcileUncertainVideoSubmission(input);
  } catch (error) {
    if (error instanceof VideoSubmissionReconciliationError) {
      throw new OperationError(error.code, error.message);
    }
    throw error;
  }
});

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
    if (!isExternalApiKeyPrincipal(principal)) {
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

// 首页生成 SLA 使用独立 binding，固定统计窗口并保持 strict DTO 边界。
bindHomepageReliabilityOperation();
// 管理模型配置与公开模型广场共用专用 binding，保持错误和 DTO 边界单点收敛。
bindModelMarketplaceOperations();

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
    templates: await listBackendParameterMappingTemplates(),
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
    id: await saveBackendParameterMappingTemplate(input),
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
    await deleteBackendParameterMappingTemplate(input.id);
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

/**
 * 校验成员能力只引用模型配置目录中的模型 ID。
 *
 * @param input 已通过统一成员输入 schema 的新增或编辑请求。
 * @param principal UOL 网关验证后的真实管理员身份，用于读取同权限模型配置快照。
 * @returns 校验成功时无返回值。
 * @sideEffects 读取最新模型配置；编辑时额外读取当前成员以允许原样保留迁移历史 ID。
 * @failure 模型配置不可读时返回 not_ready；新增的未知 ID 或不支持视频的成员选择视频
 * 时返回 validation_error，不进入成员保存事务。
 */
async function assertBackendMemberModelsComeFromConfiguration(
  input: BackendMemberInput,
  principal: Principal
): Promise<void> {
  let modelConfiguration: ModelConfigurationSnapshot;
  try {
    modelConfiguration =
      await productionModelConfigurationService.read(principal);
  } catch (error) {
    logError(error, {
      source: "image-backend-pool",
      operation: "validate-member-model-options",
    });
    throw new OperationError(
      "not_ready",
      "模型配置暂不可用，无法校验成员支持的模型"
    );
  }

  const existingModelIds = input.id
    ? ((await backendMemberService.listMembers()).find(
        (member) => member.id === input.id
      )?.supportedModelIds ?? [])
    : [];
  const unavailableModelIds = findUnavailableBackendMemberModelIds(
    input,
    buildBackendMemberModelOptions(modelConfiguration),
    existingModelIds
  );
  if (unavailableModelIds.length === 0) return;

  const displayedIds = unavailableModelIds.slice(0, 3).join("、");
  const remainingCount = unavailableModelIds.length - 3;
  throw new OperationError(
    "validation_error",
    `以下模型不在当前模型配置可选范围：${displayedIds}${
      remainingCount > 0 ? ` 等 ${unavailableModelIds.length} 个` : ""
    }`
  );
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
    principal: Principal,
    _ctx: OperationContext
  ) => {
    try {
      await assertBackendMemberModelsComeFromConfiguration(input, principal);
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
