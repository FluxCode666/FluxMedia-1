/**
 * 视频生成 UOL 的强类型 late binding。
 *
 * 职责：绑定真实模型能力发现、幂等任务创建、状态查询与提交不确定人工收敛；
 * 身份、可信分组和回调只从 Principal 与 OperationContext 获取。
 * 使用方：根 uol-bindings 聚合器；能力发现依赖可注入以保持权限测试 DB-free。
 */

import { videoInputManifestSchema } from "@repo/shared/image-generation/media-contract";
import { logError } from "@repo/shared/logger";
import {
  type ModelMarketplaceCustomModel,
  parseModelMarketplaceConfig,
  resolveModelMarketplaceEntry,
} from "@repo/shared/model-marketplace";
import {
  getRuntimeSettingJson,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import type { OperationContext, Principal } from "@repo/shared/uol";
import {
  bindExecute,
  bindOperationExecute,
  isExternalApiKeyPrincipal,
  OperationError,
} from "@repo/shared/uol";
import {
  normalizeVideoGenerateInputForReplay,
  resolveCanonicalVideoGenerateInput,
  resolveCustomVideoGenerateInput,
  type VideoGenerateInput,
  videoGetInputs,
  videoListCapabilities,
  videoListUncertainSubmissions,
  videoReconcileSubmission,
  videoRequestAccountInputCleanup,
} from "@repo/shared/uol/operations/video-generation";
import { normalizeVideoModelId } from "@repo/shared/video-generation";
import { resolveVideoTaskBilling } from "@repo/shared/video-generation/video-billing-snapshot";

import { validateCallbackUrl } from "@/features/external-api/async-image-tasks";
import { projectVideoTaskPublicBilling } from "@/features/image-generation/video-billing-lifecycle";
import { doesVideoCallbackDeliveryMatch } from "@/features/image-generation/video-callback-delivery";
import { createVideoCapabilitySnapshot } from "@/features/image-generation/video-execution-contract";
import {
  getVideoInputAssets,
  requestVideoAccountInputCleanup,
} from "@/features/image-generation/video-input-assets";
import { buildVideoInputSummary } from "@/features/image-generation/video-input-lifecycle";
import { cleanupUnusedStagedVideoInputs } from "@/features/image-generation/video-input-storage";
import {
  applyInitialVideoBackendAvailability,
  getVideoGenerationById,
  reconcileUncertainVideoSubmission,
  runVideoGenerationForUser,
  VideoQuoteConflictError,
  VideoSubmissionReconciliationError,
} from "@/features/image-generation/video-operations";
import { toLegacyVideoPublicStatus } from "@/features/image-generation/video-public-status";
import { resolveVideoQueueSchedule } from "@/features/image-generation/video-queue-schedule";
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
import { enqueueVideoTask } from "@/server/media-task-queues";
import { getMediaInputPolicyOperationError } from "./media-input-policy-error";
import { loadVideoCurrentQuotes } from "./video-current-quotes";
import { executeVideoListCapabilitiesBinding } from "./video-generation-capabilities";
import { assertVideoModelEnabled } from "./video-model-availability";

/**
 * 数据库提交后最佳努力投递视频任务。
 *
 * Redis 只负责唤醒，失败不能回滚已经提交的任务；内置恢复扫描会再次补投。这样把
 * Redis 调用放在事务外，避免数据库事务持锁等待外部服务。
 */
async function enqueueVideoTaskBestEffort(
  row: NonNullable<Awaited<ReturnType<typeof getVideoGenerationById>>>
): Promise<void> {
  const schedule = resolveVideoQueueSchedule(row);
  if (!schedule) return;
  try {
    await enqueueVideoTask(schedule);
  } catch (error) {
    logError(error, {
      source: "video-task-mq-enqueue",
      taskId: row.id,
    });
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
 * @param row - 持久视频任务。
 * @param principal - 网关已验证调用者。
 * @param ctx - 提供统一归属断言的操作上下文。
 * @returns 无返回；归属一致时继续执行。
 * @sideEffects 调用 ctx.assertOwnership，不写数据库。
 * @throws OperationError 非用户身份或 Principal 域不一致时拒绝。
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

/** 从受信 OperationContext 读取并再次校验视频完成回调地址。 */
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

/** 从任务 metadata 读取布尔请求快照，非法历史值按 false 处理。 */
function readVideoMetadataBoolean(
  metadata: Record<string, unknown> | null,
  key: string
): boolean {
  return metadata?.[key] === true;
}

/** 仅向创建响应投影 failed 任务已持久化的安全失败原因。 */
function createVideoGenerateResult(
  row: NonNullable<Awaited<ReturnType<typeof getVideoGenerationById>>>
): {
  taskId: string;
  status: ReturnType<typeof toLegacyVideoPublicStatus>;
  billing: ReturnType<typeof projectVideoTaskPublicBilling>;
  error?: string;
} {
  const status = toLegacyVideoPublicStatus(
    row.status,
    row.stage,
    row.capacityWaitDeadlineAt
  );
  return {
    taskId: row.id,
    status,
    billing: projectVideoTaskPublicBilling(row.metadata, row.creditsConsumed),
    ...(status === "failed" && row.error ? { error: row.error } : {}),
  };
}

bindOperationExecute(videoListCapabilities, (input, principal) =>
  executeVideoListCapabilitiesBinding(input, principal, {
    async loadCapabilityOverrides() {
      return getRuntimeSettingJson("VIDEO_MODEL_CAPABILITY_OVERRIDES");
    },
    async loadMarketplaceConfig() {
      return getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG");
    },
    async listConfiguredModelIds(selection) {
      return (
        await import("@/features/image-backend-pool/runtime-service")
      ).listConfiguredRuntimeModelIds(selection);
    },
    loadCurrentQuotes: loadVideoCurrentQuotes,
    reportFailure(error) {
      logError(error, { source: "video-capability-discovery" });
    },
  })
);

/** video.getInputs - 只从任务白名单为 owner 或历史管理员签发短期 URL。 */
bindOperationExecute(videoGetInputs, (input, principal, context) =>
  getVideoInputAssets({ taskId: input.taskId, principal, context })
);

/** video.requestAccountInputCleanup - 账号失效前登记幂等生命周期意图。 */
bindOperationExecute(
  videoRequestAccountInputCleanup,
  async (input, principal) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    return requestVideoAccountInputCleanup({
      userId: principal.userId,
      clientRequestId: input.clientRequestId,
    });
  }
);

/** video.generate - Principal 作用域幂等地执行统一视频管线。 */
bindExecute(
  "video.generate",
  async (
    input: VideoGenerateInput,
    principal: Principal,
    ctx: OperationContext
  ) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    const apiKeyId = isExternalApiKeyPrincipal(principal)
      ? principal.apiKeyId
      : undefined;
    if (apiKeyId && input.backendGroupId) {
      throw new OperationError(
        "validation_error",
        "API Key 调用不能覆盖服务端绑定的媒体后端分组"
      );
    }
    const callbackUrl = await getTrustedVideoCompletionUrl(ctx);
    const principalScope = createVideoPrincipalScope(principal);
    const taskId = createVideoTaskId({
      principalScope,
      clientRequestId: input.clientRequestId,
    });
    const requestFingerprint = createVideoRequestFingerprint(
      normalizeVideoGenerateInputForReplay(input)
    );
    const existing = await getVideoGenerationById(taskId);
    if (existing) {
      assertVideoTaskPrincipal(existing, principal, ctx);
      assertVideoRequestFingerprint(existing, requestFingerprint);
      await assertVideoCallbackFingerprint(taskId, callbackUrl);
      return createVideoGenerateResult(existing);
    }

    // WHY：动态参考图上限只约束新任务。历史幂等重放已在上方按创建时规范
    // 身份命中，不能被管理员后续降限改写为新的 validation_error。
    let canonicalResult: ReturnType<typeof resolveCanonicalVideoGenerateInput>;
    let modelConfigurationRevision: number;
    let customModelDefinition: ModelMarketplaceCustomModel | undefined;
    try {
      const [capabilityOverrides, marketplaceConfigValue] = await Promise.all([
        getRuntimeSettingJson("VIDEO_MODEL_CAPABILITY_OVERRIDES"),
        getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG"),
      ]);
      const marketplaceConfig = parseModelMarketplaceConfig(
        marketplaceConfigValue
      );
      const customModel = marketplaceConfig.customModels.find(
        (model) =>
          model.category === "video" &&
          model.modelId.toLowerCase() === input.model.toLowerCase()
      );
      customModelDefinition = customModel;
      if (!customModel && !normalizeVideoModelId(input.model)) {
        throw new OperationError(
          "validation_error",
          "视频模型不在当前模型配置中",
          { field: "model" }
        );
      }
      const modelId = customModel?.modelId ?? input.model;
      assertVideoModelEnabled(marketplaceConfig, modelId);
      canonicalResult = customModel
        ? resolveCustomVideoGenerateInput(
            { ...input, model: customModel.modelId },
            customModel.supportedResolutions
          )
        : resolveCanonicalVideoGenerateInput(input, capabilityOverrides);
      modelConfigurationRevision = resolveModelMarketplaceEntry(
        marketplaceConfig.videoByFamily[modelId],
        "video"
      ).revision;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      logError(error, { source: "video-capability-validation" });
      throw new OperationError("not_ready", "视频模型能力配置暂时不可用");
    }
    if (!canonicalResult.ok) {
      throw new OperationError(
        "validation_error",
        canonicalResult.error.message,
        canonicalResult.error.code === "too_many_reference_images"
          ? {
              field: canonicalResult.error.field,
              maximum: canonicalResult.error.maximum,
              received: canonicalResult.error.received,
            }
          : { field: canonicalResult.error.field }
      );
    }
    const canonicalInput = canonicalResult.input;
    const capabilitySnapshot = createVideoCapabilitySnapshot({
      modelConfigurationRevision,
      maxReferenceImages:
        canonicalResult.capability.input.referenceImages.maxCount,
      ...(customModelDefinition
        ? {
            customModel: {
              modelId: customModelDefinition.modelId,
              supportedResolutions: customModelDefinition.supportedResolutions,
            },
          }
        : {}),
    });
    const inputManifest = {
      ...(canonicalInput.firstFrame
        ? { firstFrame: canonicalInput.firstFrame }
        : {}),
      ...(canonicalInput.lastFrame
        ? { lastFrame: canonicalInput.lastFrame }
        : {}),
      ...(canonicalInput.referenceImages?.length
        ? { referenceImages: canonicalInput.referenceImages }
        : {}),
    };

    let preparation: Awaited<
      ReturnType<typeof prepareVideoTaskInputReferences>
    >;
    try {
      const { mediaLimitService } = await import(
        "@repo/shared/image-generation/media-limit-service"
      );
      const mediaLimits = await mediaLimitService.getForUser(principal.userId);
      preparation = await prepareVideoTaskInputReferences({
        taskId,
        userId: principal.userId,
        principalScope,
        manifest: inputManifest,
        mediaLimits,
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
        await enqueueVideoTaskBestEffort(raced);
        return createVideoGenerateResult(raced);
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
      const mediaPolicyError = getMediaInputPolicyOperationError(error);
      if (mediaPolicyError) throw mediaPolicyError;
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
      await runVideoGenerationForUser(
        {
          userId: principal.userId,
          ...(apiKeyId ? { apiKeyId } : {}),
          principalScope,
          stagingReservationToken: preparation.reservationToken,
          videoGenerationId: taskId,
          clientRequestId: canonicalInput.clientRequestId,
          serverRequestId: ctx.requestId,
          ...(ctx.externalRequestId
            ? { externalRequestId: ctx.externalRequestId }
            : {}),
          requestFingerprint,
          prompt: canonicalInput.prompt,
          model: canonicalInput.model,
          duration: canonicalInput.duration,
          aspectRatio: canonicalInput.aspectRatio,
          resolution: canonicalInput.resolution,
          ...(canonicalInput.negativePrompt
            ? { negativePrompt: canonicalInput.negativePrompt }
            : {}),
          effectiveAudio: canonicalInput.generateAudio,
          capabilitySnapshot,
          ...(input.quoteToken ? { quoteToken: input.quoteToken } : {}),
          ...(canonicalInput.backendGroupId
            ? { backendGroupId: canonicalInput.backendGroupId }
            : {}),
          ...(Object.keys(stagedInput.manifest).length
            ? { inputManifest: stagedInput.manifest }
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
        persistedManifest: persisted?.inputManifest,
      });
      let responseRow = persisted;
      if (responseRow?.stage === "created") {
        try {
          const persistedBilling = resolveVideoTaskBilling(
            responseRow.metadata
          );
          const availability = await import(
            "@/features/image-backend-pool/runtime-service"
          ).then((runtime) =>
            runtime.inspectRuntimeVideoBackendAvailability({
              userId: principal.userId,
              ...(apiKeyId ? { apiKeyId } : {}),
              ...(persistedBilling.kind === "snapshot"
                ? {
                    pinnedGroupId: persistedBilling.snapshot.billingGroupId,
                  }
                : canonicalInput.backendGroupId
                  ? { requestedGroupId: canonicalInput.backendGroupId }
                  : {}),
              modelId: canonicalInput.model,
              requiresContentSafety: true,
              // 自定义模型只能由 API 成员执行；内置模型必须同时统计 API 与
              // Adobe Direct，保持创建预检与权威获租的协议边界一致。
              ...(customModelDefinition
                ? { requiredMemberType: "api" as const }
                : {}),
            })
          );
          responseRow =
            (await applyInitialVideoBackendAvailability(
              responseRow.id,
              availability
            )) ?? responseRow;
        } catch (availabilityError) {
          // 只读资格预检故障不能撤销已持久化任务；独立 worker 会重新执行权威调度。
          logError(availabilityError, {
            source: "video-initial-backend-availability",
            taskId,
          });
        }
      }
      if (responseRow) {
        assertVideoTaskPrincipal(responseRow, principal, ctx);
        assertVideoRequestFingerprint(responseRow, requestFingerprint);
        await assertVideoCallbackFingerprint(taskId, callbackUrl);
        await enqueueVideoTaskBestEffort(responseRow);
      }
      if (!responseRow) {
        throw new OperationError(
          "not_ready",
          "视频任务未能持久化，请使用同一 clientRequestId 重试"
        );
      }
      return createVideoGenerateResult(responseRow);
    } catch (error) {
      // WHY：并发重放可能同时看到“未创建”，数据库主键会使其中一个 insert
      // 失败。只有已存在且指纹一致时才把它视为幂等命中。
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
        persistedManifest: raced?.inputManifest,
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
        if (error instanceof VideoQuoteConflictError) {
          throw new OperationError("conflict", error.message, {
            reason: "stale_video_quote",
            currentQuote: error.currentQuote,
          });
        }
        throw error;
      }
      assertVideoTaskPrincipal(raced, principal, ctx);
      assertVideoRequestFingerprint(raced, requestFingerprint);
      await assertVideoCallbackFingerprint(taskId, callbackUrl);
      return createVideoGenerateResult(raced);
    }
  }
);

/**
 * @deprecated 仅供 Adobe Direct 遗留 submit_uncertain 任务恢复。
 * API 供应商任务由状态机自动重试、切号和退款，不会出现在本列表。
 */
bindOperationExecute(videoListUncertainSubmissions, async (input) => {
  const [{ db }, { videoGeneration }, { and, desc, eq, sql }] =
    await Promise.all([
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
    .where(
      and(
        eq(videoGeneration.stage, "submit_uncertain"),
        sql`COALESCE(${videoGeneration.metadata}->>'videoBackendProtocol', 'adobe_direct') = 'adobe_direct'`
      )
    )
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

/** @deprecated 仅允许管理员收敛 Adobe Direct 遗留人工态。 */
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
    const videoUrl =
      row.storageKey && row.storageBucket
        ? buildPublicVideoStatusUrl({
            storageKey: row.storageKey,
            bucket: row.storageBucket,
            publicBaseUrl:
              (await getRuntimeSettingString("NEXT_PUBLIC_APP_URL")) ||
              (await getRuntimeSettingString("BETTER_AUTH_URL")),
          })
        : null;
    const parsedManifest = videoInputManifestSchema.safeParse(
      row.inputManifest ?? {}
    );
    if (!parsedManifest.success) {
      throw new OperationError("internal_error", "视频任务输入清单暂时不可用");
    }
    return {
      taskId: row.id,
      status: toLegacyVideoPublicStatus(
        row.status,
        row.stage,
        row.capacityWaitDeadlineAt
      ),
      model: row.model,
      duration: row.durationSeconds,
      aspectRatio: row.aspectRatio,
      resolution: row.resolution,
      generateAudio: readVideoMetadataBoolean(row.metadata, "generateAudio"),
      input: buildVideoInputSummary(parsedManifest.data),
      billing: projectVideoTaskPublicBilling(row.metadata, row.creditsConsumed),
      ...(videoUrl ? { videoUrl } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.createdAt.toISOString(),
      ...(row.completedAt
        ? { completedAt: row.completedAt.toISOString() }
        : {}),
    };
  }
);
