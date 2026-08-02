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
  type VideoGenerateInput,
  videoGetInputs,
  videoListCapabilities,
  videoListUncertainSubmissions,
  videoReconcileSubmission,
  videoRequestAccountInputCleanup,
} from "@repo/shared/uol/operations/video-generation";

import { validateCallbackUrl } from "@/features/external-api/async-image-tasks";
import { doesVideoCallbackDeliveryMatch } from "@/features/image-generation/video-callback-delivery";
import { createVideoCapabilitySnapshot } from "@/features/image-generation/video-execution-contract";
import {
  getVideoInputAssets,
  requestVideoAccountInputCleanup,
} from "@/features/image-generation/video-input-assets";
import { buildVideoInputSummary } from "@/features/image-generation/video-input-lifecycle";
import { cleanupUnusedStagedVideoInputs } from "@/features/image-generation/video-input-storage";
import {
  getVideoGenerationById,
  reconcileUncertainVideoSubmission,
  runVideoGenerationForUser,
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

import { executeVideoListCapabilitiesBinding } from "./video-generation-capabilities";

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

bindOperationExecute(videoListCapabilities, (input, principal) =>
  executeVideoListCapabilitiesBinding(input, principal, {
    async loadCapabilityOverrides() {
      return getRuntimeSettingJson("VIDEO_MODEL_CAPABILITY_OVERRIDES");
    },
    async listConfiguredModelIds(selection) {
      return (
        await import("@/features/image-backend-pool/runtime-service")
      ).listConfiguredRuntimeModelIds(selection);
    },
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
      return {
        taskId,
        status: toVideoOperationStatus(existing.status, existing.stage),
      };
    }

    // WHY：动态参考图上限只约束新任务。历史幂等重放已在上方按创建时规范
    // 身份命中，不能被管理员后续降限改写为新的 validation_error。
    let canonicalResult: ReturnType<typeof resolveCanonicalVideoGenerateInput>;
    let modelConfigurationRevision: number;
    try {
      const [capabilityOverrides, marketplaceConfigValue] = await Promise.all([
        getRuntimeSettingJson("VIDEO_MODEL_CAPABILITY_OVERRIDES"),
        getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG"),
      ]);
      canonicalResult = resolveCanonicalVideoGenerateInput(
        input,
        capabilityOverrides
      );
      const marketplaceConfig = parseModelMarketplaceConfig(
        marketplaceConfigValue
      );
      modelConfigurationRevision = resolveModelMarketplaceEntry(
        marketplaceConfig.videoByFamily[input.model],
        "video"
      ).revision;
    } catch (error) {
      logError(error, { source: "video-capability-validation" });
      throw new OperationError("not_ready", "视频模型能力配置暂时不可用");
    }
    if (!canonicalResult.ok) {
      throw new OperationError(
        "validation_error",
        canonicalResult.error.message,
        {
          field: canonicalResult.error.field,
          maximum: canonicalResult.error.maximum,
          received: canonicalResult.error.received,
        }
      );
    }
    const canonicalInput = canonicalResult.input;
    const capabilitySnapshot = createVideoCapabilitySnapshot({
      modelConfigurationRevision,
      maxReferenceImages:
        canonicalResult.capability.input.referenceImages.maxCount,
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
      preparation = await prepareVideoTaskInputReferences({
        taskId,
        userId: principal.userId,
        principalScope,
        manifest: inputManifest,
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
      const result = await runVideoGenerationForUser(
        {
          userId: principal.userId,
          ...(apiKeyId ? { apiKeyId } : {}),
          principalScope,
          stagingReservationToken: preparation.reservationToken,
          videoGenerationId: taskId,
          clientRequestId: canonicalInput.clientRequestId,
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
    const parsedManifest = videoInputManifestSchema.safeParse(
      row.inputManifest ?? {}
    );
    if (!parsedManifest.success) {
      throw new OperationError("internal_error", "视频任务输入清单暂时不可用");
    }
    return {
      taskId: row.id,
      status: toVideoOperationStatus(row.status, row.stage),
      model: row.model,
      duration: row.durationSeconds,
      aspectRatio: row.aspectRatio,
      resolution: row.resolution,
      generateAudio: readVideoMetadataBoolean(row.metadata, "generateAudio"),
      input: buildVideoInputSummary(parsedManifest.data),
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

/** video.reconcileSubmission - 管理员人工收敛视频上游提交不确定任务。 */
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
