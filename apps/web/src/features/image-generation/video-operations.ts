/**
 * 统一媒体账号的视频生成持久状态机。
 *
 * 职责：创建并幂等扣费、统一号池获租、单次提交，以及由内置 worker 认领后执行
 * 轮询、下载、完成或退款。使用方是 UOL binding 与定时任务。
 * 关键依赖：video_generation CAS、API/Adobe 分阶段适配器、成员租约、credits 与 storage。
 *
 * 不变量：上游接受后固定顶层成员；HTTP 与对象存储 I/O 不进入数据库事务；
 * API 创建失败自动有界重试并切号；Adobe Direct 提交不确定时保留协议兼容态；
 * 所有终态通过持久阶段和幂等财务键收敛。
 */

import { randomUUID } from "node:crypto";
import { db } from "@repo/database";
import {
  creditsTransaction,
  videoGeneration,
  videoGenerationCallbackDelivery,
} from "@repo/database/schema";
import {
  ADOBE_VIDEO_PRICING_FAMILIES,
  createDefaultVideoModelCreditsPerSecond,
  getVideoCreditCost,
  getVideoPricingResolutionKey,
  getVideoPricingResolutions,
  globalVideoModelCreditsPerSecondSchema,
  resolveEffectiveVideoCreditsPerSecond,
} from "@repo/shared/adobe";
import {
  assertAdobeVideoPollUrl,
  resolveFireflyVideoProviderModel,
} from "@repo/shared/adobe/firefly-direct";
import {
  AccountFrozenError,
  consumeCredits,
  InsufficientCreditsError,
} from "@repo/shared/credits/core";
import { refundGenerationCredits } from "@repo/shared/generation-maintenance";
import { DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT } from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS,
  type ApiUpstreamRequestSnapshot,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import {
  listVideoInputManifestReferences,
  type VideoInputManifest,
  videoInputManifestSchema,
} from "@repo/shared/image-generation/media-contract";
import { logError, logger, logWarn } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import {
  getRuntimeSettingJson,
  getRuntimeSettingNumber,
  getRuntimeStorageBucketConfig,
} from "@repo/shared/system-settings";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { completeVideoGenerationWithUsage } from "@/features/dashboard/output-usage-read-model";
import { parseMediaUpstreamUrl } from "@/features/image-backend-pool/media-upstream-url";
import { defaultBackendPoolRepository } from "@/features/image-backend-pool/repository";
import {
  ApiVideoRecoveryConfigInvalidError,
  createRuntimeBackendSession,
  loadApiVideoRecoveryConfig,
} from "@/features/image-backend-pool/runtime-service";
import { BackendSchedulerError } from "@/features/image-backend-pool/scheduler-error";
import {
  downloadAdobeDirectVideoRequest,
  pollAdobeDirectVideoRequest,
  submitAdobeDirectVideoRequest,
} from "./adobe-direct";
import {
  downloadApiVideoRequest,
  pollApiVideoRequest,
  submitApiVideoRequest,
} from "./api-video";
import { ApiAcceptedVideoError } from "./api-video-error";
import { buildBackendAccountSnapshot } from "./backend-account-snapshot";
import { createVideoCreditOperation } from "./credit-operation-context";
import { loadMediaInputs } from "./media-input-loader";
import { defaultVideoApiKeyQuotaRepository } from "./video-api-key-quota";
import { createVideoCallbackDeliveryValues } from "./video-callback-delivery";
import { reconcileVideoCreditConsumption } from "./video-credit-consumption";
import {
  resolveVideoExecutionContract,
  type VideoCapabilitySnapshot,
  type VideoExecutionContract,
} from "./video-execution-contract";
import {
  adoptVideoInputObjectsForPersistence,
  parseVideoInputCleanupObjects,
  type VideoInputCleanupObject,
} from "./video-input-cleanup-queue";
import { shouldRetainVideoInputsAfterStage } from "./video-input-lifecycle";
import {
  resolveVideoCapacityRetryAt,
  resolveVideoQueueSchedule,
  type VideoQueueSchedule,
} from "./video-queue-schedule";
import {
  createVideoStorageKey,
  isAcceptedVideoError,
  resolveApiAdapterQueryFailure,
  resolveVideoBackendExhaustionError,
  shouldRetryAcceptedVideoError,
  usesBoundedVideoRefundRetryPolicy,
} from "./video-recovery-policy";
import { defaultVideoRecoveryRepository } from "./video-recovery-repository";
import { defaultVideoSubmissionAttemptRepository } from "./video-submission-attempt-repository";
import {
  classifyLegacyUncertainVideoSnapshot,
  classifyVideoSubmissionFailure,
  isValidPersistedVideoStorageBucket,
  resolveVideoSubmissionRetrySchedule,
  sanitizeVideoSubmissionFailureReason,
  type VideoSubmissionFailureCode,
  type VideoSubmissionFailureDecision,
} from "./video-submission-failure";
import { createVideoSubmissionRecoveryEvent } from "./video-submission-recovery-events";
import { resolveVideoSubmissionRetryAccountSelection } from "./video-submission-retry-selection";
import {
  admitVideoTaskCreation,
  consumeVideoTaskStagingReservation,
} from "./video-task-admission";

const VIDEO_POLL_DELAY_MS = 15_000;
const VIDEO_RETRY_DELAY_MS = 60_000;
const VIDEO_LEASE_TTL_MS = 21 * 60_000;
const VIDEO_CLAIM_TTL_MS = VIDEO_LEASE_TTL_MS;
const VIDEO_IO_HEARTBEAT_MS = 5 * 60_000;
const VIDEO_REFUND_RETRY_DELAY_MS = 30_000;
const VIDEO_REFUND_MAX_ATTEMPTS = 3;
const LEGACY_API_INVALID_SNAPSHOT_REASON =
  "历史视频任务恢复快照不完整，生成已终止";
const LEGACY_API_INVALID_SNAPSHOT_OPERATIONS_REASON =
  "升级前 API 视频任务缺少不可变恢复快照";

type VideoStage =
  | "created"
  | "charged"
  | "submitting"
  | "submit_uncertain"
  | "retrying"
  | "polling"
  | "downloading"
  | "refunding"
  | "completed"
  | "failed";

export type VideoGenerationInput = {
  userId: string;
  apiKeyId?: string | null;
  principalScope: string;
  stagingReservationToken: string;
  prompt: string;
  videoGenerationId?: string;
  clientRequestId?: string;
  /** 创建调用的服务端权威 request ID，仅用于安全日志与任务关联。 */
  serverRequestId?: string;
  /** 客户端 X-Request-Id 的已校验关联副本，不能替代服务端 request ID。 */
  externalRequestId?: string;
  requestFingerprint?: string;
  model: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  backendGroupId?: string;
  negativePrompt?: string | null;
  effectiveAudio: boolean;
  capabilitySnapshot: VideoCapabilitySnapshot;
  inputManifest?: VideoInputManifest;
  stagedInputObjects?: VideoInputCleanupObject[];
};

/** 仅由受信 OperationContext 构造的非领域执行选项。 */
export type VideoGenerationExecutionOptions = {
  callbackUrl?: string;
};

export type VideoGenerationResult =
  | {
      videoGenerationId: string;
      status: "pending" | "processing";
      creditsConsumed: number;
    }
  | { error: string; videoGenerationId?: string };

/** 管理员对视频上游提交不确定任务的核对结论。 */
export type VideoSubmissionReconciliation =
  | {
      outcome: "accepted";
      taskId: string;
      pollUrl: string;
      upstreamJobId: string;
    }
  | {
      outcome: "not_accepted";
      taskId: string;
      reason: string;
    };

/** 视频提交核对失败的稳定领域错误。 */
export class VideoSubmissionReconciliationError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "validation_error",
    message: string
  ) {
    super(message);
    this.name = "VideoSubmissionReconciliationError";
  }
}

/** 创作页视频价格预估所需的定价输入。 */
export type VideoPricingInfo = {
  creditsPerSecond: Record<string, number>;
};

type VideoGenerationRow = NonNullable<
  Awaited<ReturnType<typeof getVideoGenerationById>>
>;

/** 读取必填全局视频模型价格；历史脏值回退开发默认值。 */
async function getRuntimeGlobalVideoPricing(): Promise<Record<string, number>> {
  const parsed = globalVideoModelCreditsPerSecondSchema.safeParse(
    await getRuntimeSettingJson("VIDEO_MODEL_CREDITS_PER_SECOND")
  );
  return parsed.success
    ? parsed.data
    : createDefaultVideoModelCreditsPerSecond();
}

/** 读取视频价格，保证展示和实扣共用同一解析口径。 */
export async function getVideoPricingForUser(input: {
  userId: string;
  apiKeyId?: string | null;
  group?: Record<string, number> | null;
}): Promise<VideoPricingInfo> {
  void input.userId;
  void input.apiKeyId;
  const global = await getRuntimeGlobalVideoPricing();
  const entries = ADOBE_VIDEO_PRICING_FAMILIES.flatMap((family) => [
    [
      family,
      resolveEffectiveVideoCreditsPerSecond({
        family,
        global,
        group: input.group,
      }),
    ] as const,
    ...getVideoPricingResolutions(family).map(
      (resolution) =>
        [
          getVideoPricingResolutionKey(family, resolution),
          resolveEffectiveVideoCreditsPerSecond({
            family,
            resolution,
            global,
            group: input.group,
          }),
        ] as const
    ),
  ]);
  return {
    creditsPerSecond: Object.fromEntries(entries),
  };
}

/** 按 ID 读取持久视频任务；调用方必须另行校验 Principal 归属。 */
export async function getVideoGenerationById(id: string) {
  const rows = await db
    .select()
    .from(videoGeneration)
    .where(eq(videoGeneration.id, id))
    .limit(1);
  return rows[0] || null;
}

/**
 * 对状态阶段执行版本比较交换。
 *
 * @returns 更新后的行；竞态失败时返回 null，由调用方停止当前 worker。
 */
async function compareAndSetVideoStage(input: {
  row: VideoGenerationRow;
  expectedStages: VideoStage[];
  values: Partial<typeof videoGeneration.$inferInsert>;
}): Promise<VideoGenerationRow | null> {
  const claimCondition = input.row.claimToken
    ? eq(videoGeneration.claimToken, input.row.claimToken)
    : isNull(videoGeneration.claimToken);
  const [updated] = await db
    .update(videoGeneration)
    .set({
      ...input.values,
      // WHY：阶段推进永不拥有输入删除权限。即使未来调用方误传空清单，CAS 仍以
      // 生命周期策略覆盖并保留当前任务清单；删除只由账号删除清理队列执行。
      inputManifest: shouldRetainVideoInputsAfterStage(
        typeof input.values.stage === "string"
          ? input.values.stage
          : input.row.stage
      )
        ? input.row.inputManifest
        : null,
      stateVersion: input.row.stateVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(videoGeneration.id, input.row.id),
        eq(videoGeneration.stateVersion, input.row.stateVersion),
        inArray(videoGeneration.stage, input.expectedStages),
        claimCondition
      )
    )
    .returning();
  return updated ?? null;
}

/** 将最新请求快照合并到 worker 内存行，防止后续成员切换覆盖数据库快照。 */
function attachVideoUpstreamRequestSnapshot(
  row: VideoGenerationRow,
  snapshot: ApiUpstreamRequestSnapshot
): VideoGenerationRow {
  return {
    ...row,
    metadata: {
      ...(row.metadata ?? {}),
      upstreamRequestSnapshot: snapshot,
    },
  };
}

/**
 * 在任意视频后端真正外呼前最佳努力保存最终请求正文。
 *
 * WHY：不推进 stateVersion，避免调试快照干扰持久状态机 CAS；失败只记录任务 ID，
 * 不把请求正文或签名 URL 写入日志，也不阻断用户生成。
 */
async function persistVideoUpstreamRequestSnapshot(
  row: VideoGenerationRow,
  snapshot: ApiUpstreamRequestSnapshot
): Promise<void> {
  try {
    const claimCondition = row.claimToken
      ? eq(videoGeneration.claimToken, row.claimToken)
      : isNull(videoGeneration.claimToken);
    await db
      .update(videoGeneration)
      .set({
        metadata: sql`COALESCE(${videoGeneration.metadata}, '{}'::json)::jsonb || ${JSON.stringify(
          { upstreamRequestSnapshot: snapshot }
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(videoGeneration.id, row.id),
          eq(videoGeneration.stateVersion, row.stateVersion),
          eq(videoGeneration.stage, "submitting"),
          claimCondition
        )
      );
  } catch (error) {
    logError(error, {
      event: "video_upstream_request_snapshot_persist_failed",
      videoId: row.id,
    });
  }
}

/** 将未扣费或不可调度的任务直接标记失败，不创建退款。 */
async function failUnchargedVideo(
  row: VideoGenerationRow,
  message: string,
  failureCode?: VideoSubmissionFailureCode
): Promise<VideoGenerationRow | null> {
  const failureReason = sanitizeVideoSubmissionFailureReason(message);
  const failed = await compareAndSetVideoStage({
    row,
    expectedStages: [row.stage as VideoStage],
    values: {
      status: "failed",
      stage: "failed",
      creditsConsumed: 0,
      error: failureReason,
      ...(failureCode ? { failureCode } : {}),
      claimToken: null,
      claimExpiresAt: null,
      nextPollAt: null,
    },
  });
  if (failed && failureCode) {
    logger.error(
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_recovery_exhausted",
        videoTaskId: failed.id,
        supplierName: getVideoSupplierName(failed),
        model: failed.model,
        protocol: "api",
        requestId: getVideoRequestId(failed) ?? randomUUID(),
        failureCode,
        failureReason,
        ...(getVideoExternalRequestId(failed)
          ? { externalRequestId: getVideoExternalRequestId(failed) }
          : {}),
      }),
      "视频 API 创建在外呼前终止"
    );
  }
  return failed;
}

/** 创建响应前只读资格裁决的结果。 */
export type InitialVideoBackendAvailability =
  | "available"
  | "capacity_rejected"
  | "no_candidate";

/**
 * 把创建响应前的只读资格裁决持久化，不获取账号租约或发起上游请求。
 *
 * @param taskId 已持久化的视频任务 ID。
 * @param availability 当前可信分组的资格与容量快照。
 * @returns 更新后的任务；任务已被并发推进时返回数据库当前事实。
 * @sideEffects 无合格账号或零等待时标记失败；容量满时固定等待截止并打印一次日志。
 * @failure 任务不存在时返回 null；配置读取失败上抛，避免错误终结合法任务。
 */
export async function applyInitialVideoBackendAvailability(
  taskId: string,
  availability: InitialVideoBackendAvailability
): Promise<VideoGenerationRow | null> {
  const row = await getVideoGenerationById(taskId);
  if (row?.stage !== "created") return row;
  if (availability === "available") return row;
  if (availability === "no_candidate") {
    return (
      (await failUnchargedVideo(
        row,
        "当前没有可用生成服务",
        "no_eligible_api_account"
      )) ?? (await getVideoGenerationById(taskId))
    );
  }

  const configuredSeconds = await getRuntimeSettingNumber(
    "VIDEO_SUBMISSION_CAPACITY_WAIT_TIMEOUT_SECONDS",
    120,
    { nonNegative: true }
  );
  const waitSeconds = Math.min(
    1_800,
    Math.max(0, Math.round(configuredSeconds))
  );
  if (waitSeconds === 0) {
    return (
      (await failUnchargedVideo(
        row,
        "当前生成服务繁忙，请稍后重试",
        "capacity_wait_timeout"
      )) ?? (await getVideoGenerationById(taskId))
    );
  }
  const now = new Date();
  const deadline = new Date(now.getTime() + waitSeconds * 1_000);
  const waiting = await compareAndSetVideoStage({
    row,
    expectedStages: ["created"],
    values: {
      capacityWaitDeadlineAt: deadline,
      nextPollAt: resolveVideoCapacityRetryAt(now, deadline),
      claimToken: null,
      claimExpiresAt: null,
    },
  });
  if (waiting) logVideoCapacityWaitStarted({ row: waiting, deadline });
  return waiting ?? getVideoGenerationById(taskId);
}

/** 释放任务持有的成员租约；owner 已被接管时旧 worker 无法误释放。 */
async function releaseVideoLease(row: VideoGenerationRow): Promise<void> {
  if (!row.memberLeaseId || !row.memberLeaseOwnerToken) return;
  await defaultBackendPoolRepository
    .releaseLease({
      leaseId: row.memberLeaseId,
      ownerToken: row.memberLeaseOwnerToken,
    })
    .catch((error) =>
      logError(error, { source: "video-release-lease", videoId: row.id })
    );
}

/** 将已扣费任务推进到 refunding，随后由幂等退款阶段收敛。 */
async function moveVideoToRefunding(
  row: VideoGenerationRow,
  message: string,
  failureCode?: VideoSubmissionFailureCode
): Promise<VideoGenerationRow | null> {
  const refunding = await compareAndSetVideoStage({
    row,
    expectedStages: [row.stage as VideoStage],
    values: {
      stage: "refunding",
      status: "failed",
      error: message.slice(0, 1_000),
      ...(failureCode ? { failureCode } : {}),
      nextPollAt: new Date(),
    },
  });
  if (refunding && getVideoBackendProtocol(row) === "api") {
    logger.error(
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_recovery_exhausted",
        videoTaskId: row.id,
        supplierName: getVideoSupplierName(row),
        model: row.model,
        protocol: "api",
        requestId: getVideoRequestId(row) ?? randomUUID(),
        failureCode: failureCode ?? "unknown_submission_failure",
        ...(getVideoExternalRequestId(row)
          ? { externalRequestId: getVideoExternalRequestId(row) }
          : {}),
      }),
      "视频 API 自动恢复已耗尽"
    );
  }
  return refunding;
}

/** 从安全任务快照读取日志所需的供应商名称。 */
function getVideoSupplierName(row: VideoGenerationRow): string {
  const backend = row.metadata?.backend;
  if (
    backend &&
    typeof backend === "object" &&
    "name" in backend &&
    typeof backend.name === "string" &&
    backend.name.trim()
  ) {
    return backend.name.trim().slice(0, 120);
  }
  return "unknown supplier";
}

/** 从安全任务快照读取服务端执行 request ID。 */
function getVideoRequestId(row: VideoGenerationRow): string | undefined {
  const value = row.metadata?.serverRequestId;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 256)
    : undefined;
}

/** 从安全任务快照读取客户端可选关联标识，绝不替代服务端 request ID。 */
function getVideoExternalRequestId(
  row: VideoGenerationRow
): string | undefined {
  const value = row.metadata?.externalRequestId;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 256)
    : undefined;
}

/** 从 API 账号配置读取不含地址或凭据的稳定供应商 ID。 */
function getApiVideoSupplierId(
  config: Awaited<ReturnType<typeof createRuntimeBackendSession>>["current"]
): string | undefined {
  if (config?.memberType !== "api") return undefined;
  const value = config.config.backend?.apiUpstreamAdapter?.credentialScope;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 512)
    : undefined;
}

/** 记录容量等待开始；只在首次固定截止时间时调用，避免扫描重复打印。 */
function logVideoCapacityWaitStarted(input: {
  row: VideoGenerationRow;
  deadline: Date;
}): void {
  logger.info(
    createVideoSubmissionRecoveryEvent({
      event: "video_submission_capacity_wait_started",
      videoTaskId: input.row.id,
      supplierName: getVideoSupplierName(input.row),
      model: input.row.model,
      protocol: "api",
      requestId: getVideoRequestId(input.row) ?? randomUUID(),
      capacityWaitDeadlineAt: input.deadline.toISOString(),
      ...(getVideoExternalRequestId(input.row)
        ? { externalRequestId: getVideoExternalRequestId(input.row) }
        : {}),
    }),
    "视频 API 已进入容量等待"
  );
}

/** 把一次 API 外呼失败写入尝试账本，并输出不含敏感载荷的稳定日志。 */
async function recordVideoSubmissionFailure(input: {
  row: VideoGenerationRow;
  attemptId: string;
  requestId: string;
  supplierId?: string;
  supplierName: string;
  attemptNumber: number;
  memberAttemptNumber: number;
  configuredRetryCount: number;
  maxAttemptsSnapshot: number;
  httpTimeoutSeconds: number;
  memberId: string;
  decision: VideoSubmissionFailureDecision;
  now: Date;
}): Promise<void> {
  if (!input.decision.failureCode || !input.decision.userReason) return;
  const failureReason = sanitizeVideoSubmissionFailureReason(
    input.decision.userReason
  );
  const operationsReason = sanitizeVideoSubmissionFailureReason(
    input.decision.operationsReason
  );
  await defaultVideoSubmissionAttemptRepository.markFailed({
    attemptId: input.attemptId,
    failureCode: input.decision.failureCode,
    failureReason,
    operationsReason,
    failedAt: input.now,
  });
  logWarn(
    "视频 API 创建尝试失败",
    createVideoSubmissionRecoveryEvent({
      event: "video_submission_attempt_failed",
      videoTaskId: input.row.id,
      requestId: input.requestId,
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      supplierName: input.supplierName,
      model: input.row.model,
      protocol: "api",
      attemptNumber: input.attemptNumber,
      memberAttemptNumber: input.memberAttemptNumber,
      configuredRetryCount: input.configuredRetryCount,
      maxAttemptsSnapshot: input.maxAttemptsSnapshot,
      httpTimeoutSeconds: input.httpTimeoutSeconds,
      memberId: input.memberId,
      failureCode: input.decision.failureCode,
      failureReason,
      operationsReason,
      ...(getVideoExternalRequestId(input.row)
        ? { externalRequestId: getVideoExternalRequestId(input.row) }
        : {}),
    })
  );
}

/** 记录一次自动恢复排程；只输出低基数、无敏感载荷的告警字段。 */
function logVideoSubmissionRetryScheduled(input: {
  row: VideoGenerationRow;
  supplierId?: string;
  supplierName: string;
  requestId: string;
  decision: VideoSubmissionFailureDecision;
  attemptNumber: number;
  memberAttemptNumber?: number;
  configuredRetryCount?: number;
  maxAttemptsSnapshot?: number;
  memberId: string;
  httpTimeoutSeconds?: number;
  baseRetryDelaySeconds: number;
  upstreamRetryAfterSeconds?: number;
  finalRetryDelaySeconds: number;
  nextAttemptAt: Date;
}): void {
  if (!input.decision.failureCode) return;
  logger.info(
    createVideoSubmissionRecoveryEvent({
      event: "video_submission_retry_scheduled",
      videoTaskId: input.row.id,
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      supplierName: input.supplierName,
      model: input.row.model,
      protocol: "api",
      requestId: input.requestId,
      attemptNumber: input.attemptNumber,
      ...(input.memberAttemptNumber
        ? { memberAttemptNumber: input.memberAttemptNumber }
        : {}),
      ...(input.configuredRetryCount !== undefined
        ? { configuredRetryCount: input.configuredRetryCount }
        : {}),
      ...(input.maxAttemptsSnapshot !== undefined
        ? { maxAttemptsSnapshot: input.maxAttemptsSnapshot }
        : {}),
      memberId: input.memberId,
      ...(input.httpTimeoutSeconds
        ? { httpTimeoutSeconds: input.httpTimeoutSeconds }
        : {}),
      baseRetryDelaySeconds: input.baseRetryDelaySeconds,
      ...(input.upstreamRetryAfterSeconds !== undefined
        ? { upstreamRetryAfterSeconds: input.upstreamRetryAfterSeconds }
        : {}),
      finalRetryDelaySeconds: input.finalRetryDelaySeconds,
      nextAttemptAt: input.nextAttemptAt.toISOString(),
      failureCode: input.decision.failureCode,
      failureReason: sanitizeVideoSubmissionFailureReason(
        input.decision.userReason
      ),
      operationsReason: sanitizeVideoSubmissionFailureReason(
        input.decision.operationsReason
      ),
      ...(getVideoExternalRequestId(input.row)
        ? { externalRequestId: getVideoExternalRequestId(input.row) }
        : {}),
    }),
    "视频 API 创建已安排自动重试"
  );
}

/** 记录切换供应商账号的稳定事件。 */
function logVideoSupplierSwitched(input: {
  row: VideoGenerationRow;
  supplierId?: string;
  supplierName: string;
  requestId: string;
  attemptNumber?: number;
  memberId: string;
  failureCode?: VideoSubmissionFailureCode;
}): void {
  logger.info(
    createVideoSubmissionRecoveryEvent({
      event: "video_submission_supplier_switched",
      videoTaskId: input.row.id,
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      supplierName: input.supplierName,
      model: input.row.model,
      protocol: "api",
      requestId: input.requestId,
      memberId: input.memberId,
      ...(input.attemptNumber ? { attemptNumber: input.attemptNumber } : {}),
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      ...(getVideoExternalRequestId(input.row)
        ? { externalRequestId: getVideoExternalRequestId(input.row) }
        : {}),
    }),
    "视频 API 已切换供应商账号"
  );
}

/** 读取配置的创建 HTTP 超时；每次实际请求前固定本次值并供日志复用。 */
async function getVideoSubmissionHttpTimeout(): Promise<{
  seconds: number;
  signal: AbortSignal;
}> {
  const seconds = await getRuntimeSettingNumber(
    "VIDEO_SUBMISSION_HTTP_TIMEOUT_SECONDS",
    30,
    { positive: true }
  );
  const normalizedSeconds = Math.min(300, Math.max(1, Math.round(seconds)));
  return {
    seconds: normalizedSeconds,
    signal: AbortSignal.timeout(normalizedSeconds * 1_000),
  };
}

/** 读取 API 同账号重试基础等待。 */
async function getVideoSubmissionRetryDelaySeconds(): Promise<number> {
  const seconds = await getRuntimeSettingNumber(
    "VIDEO_SUBMISSION_RETRY_DELAY_SECONDS",
    2,
    { nonNegative: true }
  );
  return Math.min(300, Math.max(0, Math.round(seconds)));
}

/** 将 API 创建暂时失败持久化为 retrying，释放 claim 但保留原账号恢复身份。 */
async function scheduleVideoSubmissionRetry(input: {
  row: VideoGenerationRow;
  decision: VideoSubmissionFailureDecision;
  requestId: string;
  supplierId?: string;
  supplierName: string;
  attemptNumber?: number;
  memberAttemptNumber?: number;
  configuredRetryCount?: number;
  maxAttemptsSnapshot?: number;
  memberId: string;
  httpTimeoutSeconds?: number;
  retryAfterSeconds?: number;
}): Promise<VideoGenerationRow | null> {
  const now = new Date();
  const baseRetryDelaySeconds = await getVideoSubmissionRetryDelaySeconds();
  const schedule = resolveVideoSubmissionRetrySchedule({
    baseDelaySeconds: baseRetryDelaySeconds,
    retryAfterSeconds: input.retryAfterSeconds,
    now,
  });
  const retrying = await compareAndSetVideoStage({
    row: input.row,
    expectedStages: ["submitting", "retrying"],
    values: {
      stage: "retrying",
      status: "running",
      error: input.decision.userReason ?? "视频生成暂时失败，请稍后重试",
      failureCode: input.decision.failureCode ?? "unknown_submission_failure",
      nextPollAt: schedule.nextAttemptAt,
      claimToken: null,
      claimExpiresAt: null,
      submitStartedAt: null,
    },
  });
  if (retrying && input.decision.failureCode) {
    logVideoSubmissionRetryScheduled({
      row: retrying,
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      supplierName: input.supplierName,
      requestId: input.requestId,
      decision: input.decision,
      attemptNumber: input.attemptNumber ?? Math.max(1, retrying.attemptCount),
      ...(input.memberAttemptNumber
        ? { memberAttemptNumber: input.memberAttemptNumber }
        : {}),
      ...(input.configuredRetryCount !== undefined
        ? { configuredRetryCount: input.configuredRetryCount }
        : {}),
      ...(input.maxAttemptsSnapshot !== undefined
        ? { maxAttemptsSnapshot: input.maxAttemptsSnapshot }
        : {}),
      memberId: input.memberId,
      ...(input.httpTimeoutSeconds
        ? { httpTimeoutSeconds: input.httpTimeoutSeconds }
        : {}),
      baseRetryDelaySeconds,
      ...(schedule.retryAfterSeconds !== undefined
        ? { upstreamRetryAfterSeconds: schedule.retryAfterSeconds }
        : {}),
      finalRetryDelaySeconds: schedule.finalDelaySeconds,
      nextAttemptAt: schedule.nextAttemptAt,
    });
  }
  return retrying;
}

/**
 * 查询视频消费账本是否已经以稳定幂等键提交。
 *
 * `adobe-video` 是已上线账本、退款和历史回填共同依赖的稳定命名空间；API 视频
 * 接入后仍须沿用，避免同一任务以新前缀产生第二笔消费或无法命中原退款记录。
 */
async function hasVideoCreditConsumption(
  row: VideoGenerationRow
): Promise<boolean> {
  const [transaction] = await db
    .select({ id: creditsTransaction.id })
    .from(creditsTransaction)
    .where(
      and(
        eq(creditsTransaction.userId, row.userId),
        eq(creditsTransaction.type, "consumption"),
        eq(creditsTransaction.sourceRef, `adobe-video:${row.id}`)
      )
    )
    .limit(1);
  return Boolean(transaction);
}

/** 判断对象存储错误是否明确证明历史输入对象已经不存在。 */
function isPersistedVideoInputNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
  const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata?.httpStatusCode;
  return statusCode === 404 || error.message.startsWith("File not found");
}

/**
 * 校验升级前 API 人工态是否仍具备可重放的不可变执行快照。
 *
 * @deprecated 仅用于 0087 前显式 API `submit_uncertain`。下个版本在遗留查询
 * 为零后移除；不得用当前账号或系统配置猜测缺失事实。
 * @param row 已由专用 API-only claim 持有的遗留任务。
 * @returns 分类器需要的六类恢复事实和固定账号名称。
 * @sideEffects 读取固定适配版本、对象存储配置与消费账本；不发起上游请求。
 * @failure 明确的快照损坏按事实缺失处理；数据库、凭据存储或对象存储临时异常上抛，
 * 由队列重试，禁止把基础设施故障误判成永久缺失并退款。
 */
async function inspectLegacyApiUncertainSnapshot(row: VideoGenerationRow) {
  const supplierName = getVideoSupplierName(row);
  const backendSnapshot = row.metadata?.backend;
  const hasSupplierSnapshot = Boolean(
    row.backendMemberId &&
      backendSnapshot &&
      typeof backendSnapshot === "object" &&
      "id" in backendSnapshot &&
      backendSnapshot.id === row.backendMemberId &&
      "name" in backendSnapshot &&
      typeof backendSnapshot.name === "string" &&
      backendSnapshot.name.trim()
  );
  let hasAdapterIdentity = false;
  if (
    row.backendMemberId &&
    row.apiAdapterMemberId &&
    row.apiAdapterVersionId
  ) {
    try {
      const config = await loadApiVideoRecoveryConfig(
        row.backendMemberId,
        row.apiAdapterMemberId,
        row.apiAdapterVersionId,
        row.model
      );
      hasAdapterIdentity = Boolean(config);
    } catch (error) {
      if (error instanceof ApiVideoRecoveryConfigInvalidError) {
        hasAdapterIdentity = false;
      } else {
        throw error;
      }
    }
  }

  let hasModelCapabilitySnapshot = false;
  try {
    resolveVideoExecutionContract({
      model: row.model,
      durationSeconds: row.durationSeconds,
      aspectRatio: row.aspectRatio,
      resolution: row.resolution,
      metadata: row.metadata,
    });
    hasModelCapabilitySnapshot = true;
  } catch {
    hasModelCapabilitySnapshot = false;
  }

  let hasValidInputManifest = false;
  const manifest = (() => {
    try {
      return parsePersistedVideoInputManifest(row);
    } catch {
      return null;
    }
  })();
  if (manifest !== null) {
    try {
      if (manifest) {
        await loadPersistedVideoSourceInputs(row.userId, manifest);
      }
      hasValidInputManifest = true;
    } catch (error) {
      if (!isPersistedVideoInputNotFoundError(error)) throw error;
    }
  }

  // 历史输出桶是任务自己的不可变事实。不能拿当前配置做相等判断，否则正常的
  // 存储配置迁移会把可恢复任务误判为损坏并退款。
  const hasStorageBucket = isValidPersistedVideoStorageBucket(
    row.storageBucket
  );

  const hasLedgerConsumption =
    row.creditsConsumed > 0 && (await hasVideoCreditConsumption(row));

  return {
    supplierName,
    classification: classifyLegacyUncertainVideoSnapshot({
      protocol:
        getVideoMetadataString(row.metadata, "videoBackendProtocol", 32) ===
        "api"
          ? "api"
          : "adobe_direct",
      hasSupplierSnapshot,
      hasBackendMember: Boolean(row.backendMemberId),
      hasAdapterIdentity,
      hasModelCapabilitySnapshot,
      hasValidInputManifest,
      hasStorageBucket,
      hasLedgerConsumption,
    }),
  };
}

/**
 * 自动迁移一条已认领的历史 API `submit_uncertain` 任务。
 *
 * @deprecated 仅处理升级前遗留数据。完整快照补记历史首次失败尝试后进入 retrying；
 * 不完整快照只 CAS 到 refunding、打印一次专用错误事件并执行幂等退款。下个版本只有
 * 在遗留查询为零后才能删除，Adobe 永远不得调用。
 */
async function migrateClaimedLegacyApiUncertainVideo(
  row: VideoGenerationRow
): Promise<void> {
  const snapshot = await inspectLegacyApiUncertainSnapshot(row);
  if (snapshot.classification === "not_applicable") return;
  if (
    snapshot.classification === "retrying" &&
    row.backendMemberId &&
    row.apiAdapterMemberId &&
    row.apiAdapterVersionId
  ) {
    const requestId = getVideoRequestId(row) ?? `legacy-migration:${row.id}`;
    const initialAttemptRecorded =
      await defaultVideoSubmissionAttemptRepository.recordLegacyInitialFailure({
        videoGenerationId: row.id,
        backendMemberId: row.backendMemberId,
        requestId,
        supplierNameSnapshot: snapshot.supplierName,
        apiAdapterMemberId: row.apiAdapterMemberId,
        apiAdapterVersionId: row.apiAdapterVersionId,
        now: new Date(),
      });
    if (!initialAttemptRecorded) {
      // WHY：无法证明历史首次请求已占用预算时禁止进入 retrying，避免升级竞态
      // 让同一账号实际外呼超过“首次请求加两次重试”的上限。
      throw new Error("历史视频首次创建尝试账本补记失败");
    }
    const retrying = await compareAndSetVideoStage({
      row,
      expectedStages: ["submit_uncertain"],
      values: {
        status: "running",
        stage: "retrying",
        failureCode: "unknown_submission_failure",
        error: "历史首次创建请求未取得有效响应，已安排自动重试",
        nextPollAt: new Date(),
        submitStartedAt: null,
        claimToken: null,
        claimExpiresAt: null,
      },
    });
    if (!retrying) return;
    logger.info(
      createVideoSubmissionRecoveryEvent({
        event: "video_submission_retry_scheduled",
        videoTaskId: retrying.id,
        supplierName: snapshot.supplierName,
        model: retrying.model,
        protocol: "api",
        requestId,
        attemptNumber: 1,
        memberAttemptNumber: 1,
        configuredRetryCount: DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT,
        maxAttemptsSnapshot: DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT + 1,
        memberId: row.backendMemberId,
        baseRetryDelaySeconds: 0,
        finalRetryDelaySeconds: 0,
        nextAttemptAt:
          retrying.nextPollAt?.toISOString() ?? new Date().toISOString(),
        failureCode: "unknown_submission_failure",
        failureReason: "历史首次创建请求未取得有效响应",
        operationsReason: "升级前 API 人工态已迁移到自动重试",
      }),
      "历史视频 API 人工态已迁移到自动重试"
    );
    return;
  }

  const refunding = await compareAndSetVideoStage({
    row,
    expectedStages: ["submit_uncertain"],
    values: {
      status: "failed",
      stage: "refunding",
      failureCode: "unknown_submission_failure",
      error: LEGACY_API_INVALID_SNAPSHOT_REASON,
      nextPollAt: new Date(),
    },
  });
  if (!refunding) return;
  logger.error(
    createVideoSubmissionRecoveryEvent({
      event: "video_legacy_submission_snapshot_invalid",
      videoTaskId: refunding.id,
      supplierName: snapshot.supplierName,
      model: refunding.model,
      protocol: "api",
      requestId:
        getVideoRequestId(refunding) ?? `legacy-migration:${refunding.id}`,
      failureCode: "unknown_submission_failure",
      failureReason: LEGACY_API_INVALID_SNAPSHOT_REASON,
      operationsReason: LEGACY_API_INVALID_SNAPSHOT_OPERATIONS_REASON,
      ...(getVideoExternalRequestId(refunding)
        ? { externalRequestId: getVideoExternalRequestId(refunding) }
        : {}),
    }),
    "历史视频 API 人工态恢复快照无效"
  );
  await refundClaimedVideoOrRetry(refunding);
}

/**
 * 执行视频扣费并用账本事实消除“事务已提交、调用却抛错”的不确定窗口。
 *
 * @returns consumed=false 仅表示已确认账本不存在；查询失败会原样上抛并保留 charged。
 */
async function consumeVideoCredits(input: {
  row: VideoGenerationRow;
  amount: number;
  metadata: Record<string, unknown>;
}) {
  // 与历史消费查询和退款共用同一幂等命名空间，不能按当前上游协议改名。
  const sourceRef = `adobe-video:${input.row.id}`;
  return reconcileVideoCreditConsumption({
    consume: () =>
      consumeCredits({
        userId: input.row.userId,
        amount: input.amount,
        serviceName: "adobe-video",
        description: `视频生成 ${input.row.model}`,
        sourceRef,
        operation: createVideoCreditOperation(
          input.row.id,
          input.row.createdAt
        ),
        metadata: input.metadata,
      }),
    hasLedgerConsumption: () => hasVideoCreditConsumption(input.row),
    isDefinitiveRejection: (error) =>
      error instanceof InsufficientCreditsError ||
      error instanceof AccountFrozenError,
  });
}

/** 幂等退款并标记终态；进程在两步之间退出时 worker 可安全重放。 */
async function refundClaimedVideo(row: VideoGenerationRow): Promise<void> {
  // 必须命中原消费的历史命名空间，确保 API 与 Adobe 任务都只退款一次。
  const sourceRef = `adobe-video:${row.id}`;
  await refundGenerationCredits({
    generationId: row.id,
    userId: row.userId,
    amount: row.creditsConsumed,
    sourceRef,
    description: `视频生成失败退款 ${row.model}`,
    operation: createVideoCreditOperation(row.id, row.createdAt),
  });
  await defaultVideoApiKeyQuotaRepository.refund({ videoId: row.id });
  const failed = await compareAndSetVideoStage({
    row,
    expectedStages: ["refunding"],
    values: {
      status: "failed",
      stage: "failed",
      creditsConsumed: 0,
      refundAttemptCount: Math.min(
        VIDEO_REFUND_MAX_ATTEMPTS,
        row.refundAttemptCount + 1
      ),
      claimToken: null,
      claimExpiresAt: null,
      nextPollAt: null,
    },
  });
  await releaseVideoLease(failed ?? row);
}

/** 退款临时失败时释放当前 claim 并保留 refunding，避免等待整段租约过期。 */
async function refundClaimedVideoOrRetry(
  row: VideoGenerationRow
): Promise<void> {
  // Adobe Direct 的退款恢复沿用升级前的普通恢复间隔；API 供应商才使用
  // 有界三次退款策略。两种协议的财务语义不能互相覆盖。
  if (!usesBoundedVideoRefundRetryPolicy(getVideoBackendProtocol(row))) {
    try {
      await refundClaimedVideo(row);
    } catch (error) {
      await retryClaimedVideo(row, error);
      throw error;
    }
    return;
  }
  try {
    await refundClaimedVideo(row);
  } catch {
    const attemptCount = row.refundAttemptCount + 1;
    if (attemptCount >= VIDEO_REFUND_MAX_ATTEMPTS) {
      const exhaustedAt = new Date();
      const exhausted = await compareAndSetVideoStage({
        row,
        expectedStages: ["refunding"],
        values: {
          refundAttemptCount: VIDEO_REFUND_MAX_ATTEMPTS,
          refundExhaustedAt: exhaustedAt,
          nextPollAt: null,
          claimToken: null,
          claimExpiresAt: null,
        },
      });
      if (exhausted) {
        logger.error(
          createVideoSubmissionRecoveryEvent({
            event: "video_refund_retry_exhausted",
            videoTaskId: row.id,
            supplierName: getVideoSupplierName(row),
            model: row.model,
            protocol: "api",
            requestId: getVideoRequestId(row) ?? randomUUID(),
            failureCode:
              (row.failureCode as VideoSubmissionFailureCode | null) ??
              "unknown_submission_failure",
            refundAttemptCount: VIDEO_REFUND_MAX_ATTEMPTS,
            ...(getVideoExternalRequestId(row)
              ? { externalRequestId: getVideoExternalRequestId(row) }
              : {}),
          }),
          "视频退款自动重试已耗尽"
        );
        await releaseVideoLease(exhausted);
      }
      return;
    }
    await compareAndSetVideoStage({
      row,
      expectedStages: ["refunding"],
      values: {
        refundAttemptCount: attemptCount,
        nextPollAt: new Date(Date.now() + VIDEO_REFUND_RETRY_DELAY_MS),
        claimToken: null,
        claimExpiresAt: null,
      },
    });
    logger.warn(
      createVideoSubmissionRecoveryEvent({
        event: "video_refund_attempt_failed",
        videoTaskId: row.id,
        supplierName: getVideoSupplierName(row),
        model: row.model,
        protocol: "api",
        requestId: getVideoRequestId(row) ?? randomUUID(),
        failureCode:
          (row.failureCode as VideoSubmissionFailureCode | null) ??
          "unknown_submission_failure",
        refundAttemptCount: attemptCount,
        ...(getVideoExternalRequestId(row)
          ? { externalRequestId: getVideoExternalRequestId(row) }
          : {}),
      }),
      "视频退款尝试失败，已安排重试"
    );
  }
}

/**
 * 人工收敛 submit_uncertain 视频任务。
 *
 * @deprecated 仅供 0087 前遗留 `submit_uncertain` 数据迁移验证使用。公开 HTTP 与
 * UOL 人工入口已删除；下个版本在遗留行数为零后删除本函数及其输入/错误类型。
 *
 * 接受结论必须绑定原成员与受信 poll URL；未接受结论才会
 * 进入幂等退款。重复提交相同接受身份或已完成退款时返回当前结果，不产生新副作用。
 */
export async function reconcileUncertainVideoSubmission(
  input: VideoSubmissionReconciliation
): Promise<{
  taskId: string;
  status: "processing" | "completed" | "failed";
}> {
  const row = await getVideoGenerationById(input.taskId);
  if (!row) {
    throw new VideoSubmissionReconciliationError("not_found", "视频任务不存在");
  }

  // API 供应商不再接受人工核对；此入口仅为 Adobe Direct 遗留
  // submit_uncertain 任务保留，待遗留行清零后随兼容代码一并移除。
  if (getVideoBackendProtocol(row) !== "adobe_direct") {
    throw new VideoSubmissionReconciliationError(
      "conflict",
      "API 视频任务不支持人工核对，请等待自动恢复"
    );
  }

  if (input.outcome === "not_accepted") {
    if (row.stage === "failed") {
      return { taskId: row.id, status: "failed" };
    }
    if (row.stage === "refunding") {
      await refundClaimedVideo(row);
      return { taskId: row.id, status: "failed" };
    }
    if (row.stage !== "submit_uncertain") {
      throw new VideoSubmissionReconciliationError(
        "conflict",
        "只有提交结果不确定的任务可以确认未接受"
      );
    }
    const refunding = await moveVideoToRefunding(
      row,
      `人工核对确认视频上游未接受提交：${input.reason}`
    );
    if (!refunding) {
      throw new VideoSubmissionReconciliationError(
        "conflict",
        "视频任务状态已被其他操作修改"
      );
    }
    await refundClaimedVideo(refunding);
    return { taskId: row.id, status: "failed" };
  }

  let pollUrl: string;
  try {
    pollUrl = assertAdobeVideoPollUrl(input.pollUrl);
  } catch (error) {
    throw new VideoSubmissionReconciliationError(
      "validation_error",
      error instanceof Error ? error.message : "视频轮询地址不受信任"
    );
  }

  if (["polling", "downloading", "completed"].includes(row.stage)) {
    if (row.pollUrl !== pollUrl || row.upstreamJobId !== input.upstreamJobId) {
      throw new VideoSubmissionReconciliationError(
        "conflict",
        "任务已用不同的上游恢复身份完成核对"
      );
    }
    return {
      taskId: row.id,
      status: row.stage === "completed" ? "completed" : "processing",
    };
  }
  if (row.stage !== "submit_uncertain" || !row.backendMemberId) {
    throw new VideoSubmissionReconciliationError(
      "conflict",
      "当前视频任务不能恢复上游轮询"
    );
  }
  const polling = await compareAndSetVideoStage({
    row,
    expectedStages: ["submit_uncertain"],
    values: {
      stage: "polling",
      pollUrl,
      upstreamJobId: input.upstreamJobId,
      upstreamAcceptedAt: new Date(),
      nextPollAt: new Date(),
      claimToken: null,
      claimExpiresAt: null,
      error: null,
    },
  });
  if (!polling) {
    throw new VideoSubmissionReconciliationError(
      "conflict",
      "视频任务状态已被其他操作修改"
    );
  }
  return { taskId: row.id, status: "processing" };
}

/** 从任务 metadata 读取受限可选字符串；非法持久值按缺失处理。 */
function getVideoMetadataString(
  metadata: Record<string, unknown> | null,
  key: string,
  maxLength: number
): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

type VideoBackendProtocol = "api" | "adobe_direct";

/** 从任务快照恢复已接受任务的协议；迁移前任务一律属于 Adobe Direct。 */
function getVideoBackendProtocol(
  row: VideoGenerationRow
): VideoBackendProtocol {
  return getVideoMetadataString(row.metadata, "videoBackendProtocol", 32) ===
    "api"
    ? "api"
    : "adobe_direct";
}

/** 根据当前租约形成可持久化的协议身份。 */
function getLeaseVideoBackendProtocol(
  lease: Awaited<ReturnType<typeof createRuntimeBackendSession>>["current"]
): VideoBackendProtocol {
  return lease?.memberType === "api" ? "api" : "adobe_direct";
}

/** 将获租时固定的 API 适配版本复制到视频任务；Adobe 任务必须保持成对为空。 */
function createLeaseApiAdapterSnapshot(
  lease: NonNullable<
    Awaited<ReturnType<typeof createRuntimeBackendSession>>["current"]
  >
): {
  apiAdapterMemberId: string | null;
  apiAdapterVersionId: string | null;
} {
  if (lease.memberType !== "api") {
    return { apiAdapterMemberId: null, apiAdapterVersionId: null };
  }
  const { apiAdapterMemberId, apiAdapterVersionId } = lease.acquisition.lease;
  if (!apiAdapterMemberId || !apiAdapterVersionId) {
    throw new Error("API 视频成员租约缺少固定适配版本");
  }
  if (apiAdapterMemberId !== lease.memberId) {
    throw new Error("API 视频成员租约适配版本归属不一致");
  }
  return { apiAdapterMemberId, apiAdapterVersionId };
}

/** 将供应商账号、获租协议与 API 提交时可信源合并进任务 metadata。 */
function createLeaseVideoBackendMetadata(
  metadata: Record<string, unknown> | null,
  lease: NonNullable<
    Awaited<ReturnType<typeof createRuntimeBackendSession>>["current"]
  >
): Record<string, unknown> {
  const backendAccount = buildBackendAccountSnapshot({
    id: lease.memberId,
    name: lease.acquisition.member.name,
  });
  if (!backendAccount) {
    throw new Error("视频后端租约缺少可追溯的供应商账号身份");
  }
  return {
    ...(metadata ?? {}),
    backend: backendAccount,
    videoBackendProtocol: getLeaseVideoBackendProtocol(lease),
    apiVideoTrustedOrigin:
      lease.memberType === "api"
        ? parseMediaUpstreamUrl(lease.config.baseUrl).origin
        : null,
  };
}

/** 读取 API 提交时固定的可信源；缺失或损坏时保留任务等待人工处理。 */
function getApiVideoTrustedOrigin(row: VideoGenerationRow): string {
  const trustedOrigin = getVideoMetadataString(
    row.metadata,
    "apiVideoTrustedOrigin",
    2_048
  );
  if (!trustedOrigin) {
    throw new ApiAcceptedVideoError(
      "API 视频恢复缺少提交时可信源，任务将保留重试",
      true
    );
  }
  try {
    return parseMediaUpstreamUrl(trustedOrigin).origin;
  } catch {
    throw new ApiAcceptedVideoError(
      "API 视频恢复的提交时可信源无效，任务将保留重试",
      true
    );
  }
}

/** 加载已固定 API 账号的当前配置；读取失败只允许原任务稍后重试。 */
async function loadAcceptedApiVideoConfig(
  memberId: string,
  apiAdapterMemberId: string,
  apiAdapterVersionId: string,
  modelId: string
): Promise<
  NonNullable<Awaited<ReturnType<typeof loadApiVideoRecoveryConfig>>>
> {
  let config: Awaited<ReturnType<typeof loadApiVideoRecoveryConfig>>;
  try {
    config = await loadApiVideoRecoveryConfig(
      memberId,
      apiAdapterMemberId,
      apiAdapterVersionId,
      modelId
    );
  } catch {
    throw new ApiAcceptedVideoError(
      "API 视频恢复原账号配置读取失败，任务将保留重试",
      true
    );
  }
  if (!config) {
    throw new ApiAcceptedVideoError(
      "API 视频恢复原账号配置不可用，任务将保留重试",
      true
    );
  }
  return config;
}

/** 通过任务已固定的协议和账号轮询一次；绝不重新调度其他账号。 */
async function pollAcceptedVideoTask(row: VideoGenerationRow) {
  if (!row.backendMemberId) {
    throw new Error("已接受视频任务缺少恢复身份");
  }
  if (getVideoBackendProtocol(row) === "api") {
    if (
      !row.apiAdapterMemberId ||
      !row.apiAdapterVersionId ||
      !row.upstreamJobId
    ) {
      throw new ApiAcceptedVideoError(
        "API 视频恢复缺少固定适配版本，任务将保留重试",
        true
      );
    }
    const config = await loadAcceptedApiVideoConfig(
      row.backendMemberId,
      row.apiAdapterMemberId,
      row.apiAdapterVersionId,
      row.model
    );
    return pollApiVideoRequest(config, row.upstreamJobId, {
      trustedOrigin: getApiVideoTrustedOrigin(row),
    });
  }
  if (!row.pollUrl) throw new Error("Adobe 视频任务缺少恢复地址");
  return pollAdobeDirectVideoRequest({
    memberId: row.backendMemberId,
    pollUrl: row.pollUrl,
    model: row.model,
    requestProfile: row.adobeRequestProfile,
    authProfile: row.adobeAuthProfile,
  });
}

/** 重新校验任务中 storage-only 具名清单，防止脏数据进入 worker。 */
function parsePersistedVideoInputManifest(
  row: VideoGenerationRow
): VideoInputManifest | undefined {
  if (!row.inputManifest) return undefined;
  const parsed = videoInputManifestSchema.safeParse(row.inputManifest);
  if (!parsed.success) throw new Error("视频任务的具名输入清单无效");
  const prefix = `${row.userId}/video-inputs/${row.id}/`;
  if (
    listVideoInputManifestReferences(parsed.data).some(
      (reference) => !reference.storageKey.startsWith(prefix)
    )
  ) {
    throw new Error("视频任务的具名输入清单归属无效");
  }
  return parsed.data;
}

/** worker 已读取到内存的具名视频输入。 */
type LoadedVideoSourceInputs = {
  firstFrame?: Awaited<ReturnType<typeof loadMediaInputs>>[number];
  lastFrame?: Awaited<ReturnType<typeof loadMediaInputs>>[number];
  referenceImages?: Awaited<ReturnType<typeof loadMediaInputs>>;
};

/**
 * 按任务执行契约校验具名清单，不读取当前动态能力。
 *
 * @param manifest - 已通过 storage-only schema 和归属校验的任务清单。
 * @param contract - 由任务列与创建快照恢复的执行事实。
 * @returns 无返回；合法清单可继续读取媒体。
 * @sideEffects 无。
 * @throws Error - 帧模式、参考图模式或创建时数量上限不匹配时 fail closed。
 */
function assertVideoInputManifestMatchesContract(
  manifest: VideoInputManifest | undefined,
  contract: VideoExecutionContract
): void {
  if (manifest?.firstFrame && contract.frameCapability === "none") {
    throw new Error("该视频模型不支持首尾帧输入");
  }
  if (
    manifest?.lastFrame &&
    contract.frameCapability !== "first-and-optional-last"
  ) {
    throw new Error("该视频模型不支持尾帧输入");
  }
  const referenceCount = manifest?.referenceImages?.length ?? 0;
  if (referenceCount > 0 && contract.maxReferenceImages === 0) {
    throw new Error("该视频模型不支持参考图输入");
  }
  if (referenceCount > contract.maxReferenceImages) {
    throw new Error(
      `该视频模型最多支持 ${contract.maxReferenceImages} 张参考图`
    );
  }
}

/**
 * 按具名语义读取任务输入，保持参考图的持久顺序。
 *
 * @param userId - 任务所有者。
 * @param manifest - 已验证的 storage-only 具名清单。
 * @returns 与 API/Adobe adapter 输入同形的内存素材；无输入返回空对象。
 * @sideEffects 从对象存储读取媒体字节。
 * @throws Error - 任一媒体读取或实际字节校验失败时上抛。
 */
async function loadPersistedVideoSourceInputs(
  userId: string,
  manifest: VideoInputManifest | undefined
): Promise<LoadedVideoSourceInputs> {
  if (manifest?.referenceImages?.length) {
    return {
      referenceImages: await loadMediaInputs({
        userId,
        references: manifest.referenceImages,
      }),
    };
  }
  const references = [manifest?.firstFrame, manifest?.lastFrame].filter(
    (reference): reference is NonNullable<VideoInputManifest["firstFrame"]> =>
      Boolean(reference)
  );
  if (!references.length) return {};
  const loaded = await loadMediaInputs({ userId, references });
  return {
    ...(loaded[0] ? { firstFrame: loaded[0] } : {}),
    ...(loaded[1] ? { lastFrame: loaded[1] } : {}),
  };
}

/** 确保任务清单与本次待采用 orphan 对象一一对应。 */
function assertVideoInputManifestMatchesObjects(input: {
  manifest: VideoInputManifest | undefined;
  objects: VideoInputCleanupObject[];
}): void {
  const references = input.manifest
    ? listVideoInputManifestReferences(input.manifest)
    : [];
  const objectIdentities = new Set(
    input.objects.map(
      (object) => `${object.storageBucket}\0${object.storageKey}`
    )
  );
  if (
    references.length !== input.objects.length ||
    references.some(
      (reference) =>
        !objectIdentities.has(
          `${reference.storageBucket}\0${reference.storageKey}`
        )
    )
  ) {
    throw new Error("视频具名输入清单与待采用对象不一致");
  }
}

/**
 * 原子创建待执行视频任务。
 *
 * 本函数不读取媒体、不获租、不扣费，也不调用上游；调用方可在事务提交后立即返回
 * taskId，持久 worker 再从 created 阶段恢复全部长 I/O。
 */
export async function runVideoGenerationForUser(
  input: VideoGenerationInput,
  executionOptions?: VideoGenerationExecutionOptions
): Promise<VideoGenerationResult> {
  let contract: VideoExecutionContract;
  try {
    contract = resolveVideoExecutionContract({
      model: input.model,
      durationSeconds: input.duration,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      metadata: {
        generateAudio: input.effectiveAudio,
        videoCapabilitySnapshot: input.capabilitySnapshot,
      },
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "视频任务参数无效",
    };
  }
  const provider = resolveFireflyVideoProviderModel(contract.model);
  // WHY：自定义视频只允许 API 成员执行，但历史表仍要求非空 Adobe profile；使用不会
  // 触发 Adobe 请求的固定占位值，真正的成员类型在获租后再次裁决。
  const persistedProvider = provider ?? {
    webApp: "express" as const,
    authProfile: "express" as const,
  };
  const persistedInputManifest = input.inputManifest
    ? videoInputManifestSchema.parse(input.inputManifest)
    : undefined;
  try {
    assertVideoInputManifestMatchesContract(persistedInputManifest, contract);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "视频输入清单无效",
    };
  }
  const hasInputManifest = Boolean(
    persistedInputManifest &&
      listVideoInputManifestReferences(persistedInputManifest).length
  );

  const videoId = input.videoGenerationId || nanoid();
  const { generations: storageBucket } = await getRuntimeStorageBucketConfig();
  const stagedInputObjects = parseVideoInputCleanupObjects(
    input.stagedInputObjects ?? []
  );
  if (
    stagedInputObjects.some(
      (object) =>
        object.reason !== "orphan" ||
        object.userId !== input.userId ||
        object.videoId !== videoId
    )
  ) {
    throw new Error("视频输入清理对象与待创建任务归属不一致");
  }
  assertVideoInputManifestMatchesObjects({
    manifest: persistedInputManifest,
    objects: stagedInputObjects,
  });
  const createdAt = new Date();
  await db.transaction(async (transaction) => {
    const admission = await admitVideoTaskCreation(
      { execute: (query) => transaction.execute(query) },
      {
        taskId: videoId,
        userId: input.userId,
        principalScope: input.principalScope,
      }
    );
    if (admission === "existing") {
      await consumeVideoTaskStagingReservation(transaction, {
        taskId: videoId,
        userId: input.userId,
        reservationToken: input.stagingReservationToken,
        required: false,
      });
      return;
    }
    await consumeVideoTaskStagingReservation(transaction, {
      taskId: videoId,
      userId: input.userId,
      reservationToken: input.stagingReservationToken,
      required: true,
    });
    await adoptVideoInputObjectsForPersistence(
      { execute: (query) => transaction.execute(query) },
      stagedInputObjects
    );
    await transaction.insert(videoGeneration).values({
      id: videoId,
      userId: input.userId,
      apiKeyId: input.apiKeyId ?? null,
      principalScope: input.principalScope,
      usageLogVisible: true,
      model: contract.model,
      adobeRequestProfile: persistedProvider.webApp,
      adobeAuthProfile: persistedProvider.authProfile,
      prompt: input.prompt,
      durationSeconds: contract.duration,
      aspectRatio: contract.aspectRatio,
      resolution: contract.resolution,
      status: "pending",
      stage: "created",
      storageBucket,
      creditsConsumed: 0,
      nextPollAt: createdAt,
      metadata: {
        ...(input.clientRequestId
          ? { clientRequestId: input.clientRequestId }
          : {}),
        ...(input.serverRequestId
          ? { serverRequestId: input.serverRequestId }
          : {}),
        ...(input.externalRequestId
          ? { externalRequestId: input.externalRequestId }
          : {}),
        ...(input.requestFingerprint
          ? { requestFingerprint: input.requestFingerprint }
          : {}),
        ...(input.backendGroupId
          ? { backendGroupId: input.backendGroupId }
          : {}),
        ...(input.negativePrompt
          ? { negativePrompt: input.negativePrompt }
          : {}),
        generateAudio: contract.effectiveAudio,
        videoCapabilitySnapshot: input.capabilitySnapshot,
      },
      ...(hasInputManifest ? { inputManifest: persistedInputManifest } : {}),
      createdAt,
      updatedAt: createdAt,
    });
    if (executionOptions?.callbackUrl) {
      await transaction.insert(videoGenerationCallbackDelivery).values(
        createVideoCallbackDeliveryValues({
          videoGenerationId: videoId,
          callbackUrl: executionOptions.callbackUrl,
          now: createdAt,
        })
      );
    }
  });
  return {
    videoGenerationId: videoId,
    status: "pending",
    creditsConsumed: 0,
  };
}

/**
 * 执行一条已由 worker 认领的 created 任务。
 *
 * 媒体读取发生在获租前；扣费后才进入 submitting。进程在各阶段退出时，持久状态机
 * 分别重跑 created、幂等收敛 charged；API submitting 自动恢复，Adobe Direct 保留
 * 协议专属的不确定提交兼容态。
 */
async function submitClaimedCreatedVideo(
  initialRow: VideoGenerationRow
): Promise<VideoGenerationResult> {
  let contract: VideoExecutionContract;
  try {
    contract = resolveVideoExecutionContract({
      model: initialRow.model,
      durationSeconds: initialRow.durationSeconds,
      aspectRatio: initialRow.aspectRatio,
      resolution: initialRow.resolution,
      metadata: initialRow.metadata,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "视频任务执行快照无效";
    await failUnchargedVideo(initialRow, message);
    return {
      error: message,
      videoGenerationId: initialRow.id,
    };
  }

  let sourceInputs: LoadedVideoSourceInputs;
  try {
    const inputManifest = parsePersistedVideoInputManifest(initialRow);
    assertVideoInputManifestMatchesContract(inputManifest, contract);
    sourceInputs = await loadPersistedVideoSourceInputs(
      initialRow.userId,
      inputManifest
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "视频输入图片读取失败";
    await failUnchargedVideo(initialRow, message);
    return { error: message, videoGenerationId: initialRow.id };
  }

  const backendGroupId = getVideoMetadataString(
    initialRow.metadata,
    "backendGroupId",
    128
  );
  const negativePrompt = getVideoMetadataString(
    initialRow.metadata,
    "negativePrompt",
    100_000
  );
  let row = initialRow;
  const isSubmissionRetry = initialRow.stage === "retrying";
  // 切号后容量满会清空绑定账号。恢复时必须以外呼前账本为准排除已尝试账号，
  // 否则调度器可能再次选择已耗尽的账号并造成无效循环。
  const attemptedMemberIdsForRecovery =
    isSubmissionRetry && !row.backendMemberId
      ? await defaultVideoSubmissionAttemptRepository.listAttemptedMemberIds(
          row.id
        )
      : [];
  const retryAccountSelection = resolveVideoSubmissionRetryAccountSelection({
    isSubmissionRetry,
    backendMemberId: row.backendMemberId,
    apiAdapterMemberId: row.apiAdapterMemberId,
    apiAdapterVersionId: row.apiAdapterVersionId,
    attemptedMemberIds: attemptedMemberIdsForRecovery,
  });

  const globalPricing = await getRuntimeGlobalVideoPricing();
  let backendSession: Awaited<ReturnType<typeof createRuntimeBackendSession>>;
  try {
    backendSession = await createRuntimeBackendSession({
      userId: row.userId,
      ...(row.apiKeyId ? { apiKeyId: row.apiKeyId } : {}),
      ...(backendGroupId ? { requestedGroupId: backendGroupId } : {}),
      modelId: contract.model,
      requestKind: "video",
      requiresContentSafety: true,
      ...(contract.requiredMemberType
        ? { requiredMemberType: contract.requiredMemberType }
        : {}),
      ...retryAccountSelection,
    });
    await backendSession.acquireNext();
  } catch (error) {
    if (
      !(error instanceof BackendSchedulerError) ||
      (error.code !== "capacity_rejected" &&
        error.code !== "no_eligible_member")
    ) {
      throw error;
    }
    const isCapacity = error.code === "capacity_rejected";
    if (isCapacity) {
      const capacityWaitSeconds = await getRuntimeSettingNumber(
        "VIDEO_SUBMISSION_CAPACITY_WAIT_TIMEOUT_SECONDS",
        120,
        { nonNegative: true }
      );
      const deadline =
        row.capacityWaitDeadlineAt ??
        new Date(
          Date.now() +
            Math.min(1_800, Math.max(0, Math.round(capacityWaitSeconds))) *
              1_000
        );
      if (!row.capacityWaitDeadlineAt && deadline.getTime() > Date.now()) {
        logVideoCapacityWaitStarted({ row, deadline });
      }
      if (deadline.getTime() > Date.now()) {
        await compareAndSetVideoStage({
          row,
          // 首次获租前容量满时任务仍未扣费，必须保留 created；否则后续
          // 恢复会被误判为已扣费重试并跳过积分/配额扣除。
          expectedStages: ["created", "retrying"],
          values: {
            capacityWaitDeadlineAt: deadline,
            nextPollAt: resolveVideoCapacityRetryAt(new Date(), deadline),
            claimToken: null,
            claimExpiresAt: null,
          },
        });
        return {
          videoGenerationId: row.id,
          status: "processing",
          creditsConsumed: row.creditsConsumed,
        };
      }
      const failureCode = "capacity_wait_timeout";
      const reason = "当前生成服务繁忙，请稍后重试";
      if (row.creditsConsumed > 0) {
        const refunding = await moveVideoToRefunding(row, reason, failureCode);
        if (refunding) await refundClaimedVideoOrRetry(refunding);
      } else {
        await failUnchargedVideo(row, reason, failureCode);
      }
      return { error: reason, videoGenerationId: row.id };
    }
    if (isSubmissionRetry) {
      const reason = "当前没有可用生成服务";
      if (row.creditsConsumed > 0) {
        const refunding = await moveVideoToRefunding(
          row,
          reason,
          "no_eligible_api_account"
        );
        if (refunding) await refundClaimedVideoOrRetry(refunding);
      } else {
        await failUnchargedVideo(row, reason, "no_eligible_api_account");
      }
      return { error: reason, videoGenerationId: row.id };
    }
    await failUnchargedVideo(
      row,
      "当前没有可用生成服务",
      "no_eligible_api_account"
    );
    return {
      error: "当前没有可用生成服务",
      videoGenerationId: row.id,
    };
  }

  const billedCost = isSubmissionRetry
    ? row.creditsConsumed
    : getVideoCreditCost({
        durationSeconds: contract.duration,
        creditsPerSecond: resolveEffectiveVideoCreditsPerSecond({
          family: contract.billingFamily,
          resolution: contract.resolution,
          global: globalPricing,
          group: backendSession.group.videoCreditOverrides,
        }),
      });
  const initialLease = backendSession.current;
  if (!initialLease) throw new Error("视频后端租约在扣费前丢失");
  const liveClaimToken = row.claimToken ?? randomUUID();
  const chargedAt = new Date();
  const charged = await compareAndSetVideoStage({
    row,
    expectedStages: isSubmissionRetry ? ["retrying"] : ["created"],
    values: {
      status: "running",
      stage: "charged",
      creditsConsumed: billedCost,
      backendMemberId: initialLease.memberId,
      memberLeaseId: initialLease.acquisition.lease.id,
      memberLeaseOwnerToken: initialLease.acquisition.lease.ownerToken,
      ...createLeaseApiAdapterSnapshot(initialLease),
      metadata: createLeaseVideoBackendMetadata(row.metadata, initialLease),
      claimToken: liveClaimToken,
      claimExpiresAt: new Date(chargedAt.getTime() + VIDEO_CLAIM_TTL_MS),
      capacityWaitDeadlineAt: null,
    },
  });
  if (!charged) {
    await backendSession.close();
    throw new Error("视频任务扣费阶段发生并发冲突");
  }
  row = charged;

  if (!isSubmissionRetry) {
    try {
      await defaultVideoApiKeyQuotaRepository.reserve({
        videoId: row.id,
        amount: billedCost,
      });
    } catch (error) {
      await backendSession.close();
      await defaultVideoApiKeyQuotaRepository.refund({ videoId: row.id });
      await failUnchargedVideo(
        row,
        error instanceof Error ? error.message : "视频配额预留未完成"
      );
      return {
        error: error instanceof Error ? error.message : "视频配额预留未完成",
        videoGenerationId: row.id,
      };
    }

    let consumption: Awaited<ReturnType<typeof consumeVideoCredits>>;
    try {
      consumption = await consumeVideoCredits({
        row,
        amount: billedCost,
        metadata: {
          videoGenerationId: row.id,
          model: row.model,
          durationSeconds: contract.duration,
          ...(row.apiKeyId ? { externalApiKeyId: row.apiKeyId } : {}),
        },
      });
    } catch (error) {
      await backendSession.close();
      throw error;
    }
    if (!consumption.consumed) {
      const error = consumption.error;
      await backendSession.close();
      await defaultVideoApiKeyQuotaRepository.refund({ videoId: row.id });
      await failUnchargedVideo(
        row,
        error instanceof Error ? error.message : "积分不足"
      );
      return {
        error: error instanceof Error ? error.message : "积分不足",
        videoGenerationId: row.id,
      };
    }
  }

  for (;;) {
    const lease = backendSession.current;
    if (!lease) {
      const refunding = await moveVideoToRefunding(row, "视频后端租约已失效");
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return { error: "视频后端租约已失效", videoGenerationId: row.id };
    }
    const submitting = await compareAndSetVideoStage({
      row,
      expectedStages: ["charged", "retrying"],
      values: {
        stage: "submitting",
        submitStartedAt: new Date(),
        attemptCount: row.attemptCount + 1,
        backendMemberId: lease.memberId,
        memberLeaseId: lease.acquisition.lease.id,
        memberLeaseOwnerToken: lease.acquisition.lease.ownerToken,
        ...createLeaseApiAdapterSnapshot(lease),
        metadata: createLeaseVideoBackendMetadata(row.metadata, lease),
      },
    });
    if (!submitting) throw new Error("视频提交阶段发生并发冲突");
    row = submitting;

    const startedAt = Date.now();
    const submissionTimeout =
      lease.memberType === "api"
        ? await getVideoSubmissionHttpTimeout()
        : { seconds: 20 * 60, signal: AbortSignal.timeout(20 * 60_000) };
    const submissionSignal = submissionTimeout.signal;
    let submittedRequestSnapshot: ApiUpstreamRequestSnapshot | null = null;
    /**
     * 保存本次成员实际发送的请求；切号重试时后一次正文覆盖前一次。
     *
     * @param snapshot 已完成脱敏和大小限制的最终提交正文。
     * @returns 快照最佳努力写入完成后返回。
     * @sideEffects 更新当前视频任务 metadata，但不推进 stateVersion。
     */
    const onRequestSnapshot = async (
      snapshot: ApiUpstreamRequestSnapshot
    ): Promise<void> => {
      submittedRequestSnapshot = snapshot;
      await persistVideoUpstreamRequestSnapshot(row, snapshot);
    };
    const submissionRequestId = randomUUID();
    let attemptReservationRejected = false;
    let reservedAttemptPromise: Promise<
      Awaited<
        ReturnType<typeof defaultVideoSubmissionAttemptRepository.reserveNext>
      >
    > = Promise.resolve(null);
    const reserveAttemptBeforeSend = async (): Promise<void> => {
      reservedAttemptPromise =
        defaultVideoSubmissionAttemptRepository.reserveNext({
          attemptId: nanoid(),
          videoGenerationId: row.id,
          backendMemberId: lease.memberId,
          requestId: submissionRequestId,
          videoSubmissionRetryCount:
            lease.config.backend?.apiUpstreamAdapter
              ?.videoSubmissionRetryCount ??
            DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT,
          supplierNameSnapshot: lease.acquisition.member.name,
          apiAdapterMemberId:
            lease.acquisition.lease.apiAdapterMemberId ?? lease.memberId,
          apiAdapterVersionId:
            lease.acquisition.lease.apiAdapterVersionId ?? "missing",
          now: new Date(),
        });
      const reservedAttempt = await reservedAttemptPromise;
      if (!reservedAttempt) {
        attemptReservationRejected = true;
        throw new Error("当前 API 视频账号的创建尝试次数已耗尽");
      }
    };
    const submitted =
      lease.memberType === "api"
        ? await submitApiVideoRequest(lease.config, {
            clientRequestId: row.id,
            requestId: submissionRequestId,
            prompt: row.prompt,
            model: contract.model,
            duration: contract.duration,
            aspectRatio: contract.aspectRatio,
            resolution: contract.resolution,
            effectiveAudio: contract.effectiveAudio,
            ...sourceInputs,
            ...(negativePrompt != null ? { negativePrompt } : {}),
            onRequestSnapshot,
            onBeforeSend: reserveAttemptBeforeSend,
            signal: submissionSignal,
          })
        : await submitAdobeDirectVideoRequest(lease.config, {
            prompt: row.prompt,
            model: contract.model,
            duration: contract.duration,
            aspectRatio: contract.aspectRatio,
            resolution: contract.resolution,
            effectiveAudio: contract.effectiveAudio,
            maxReferenceImages: contract.maxReferenceImages,
            requestProfile: row.adobeRequestProfile,
            authProfile: row.adobeAuthProfile,
            onRequestSnapshot,
            ...sourceInputs,
            ...(negativePrompt != null ? { negativePrompt } : {}),
            signal: submissionSignal,
          });
    if (submittedRequestSnapshot) {
      row = attachVideoUpstreamRequestSnapshot(row, submittedRequestSnapshot);
    }
    const reservedAttempt = await reservedAttemptPromise;
    if (
      lease.memberType === "api" &&
      !("error" in submitted) &&
      !reservedAttempt
    ) {
      throw new Error("API 视频创建请求缺少发送前尝试账本");
    }
    if (!("error" in submitted)) {
      if ("status" in submitted && submitted.status === "completed") {
        const downloading = await compareAndSetVideoStage({
          row,
          expectedStages: ["submitting"],
          values: {
            stage: "downloading",
            pollUrl: null,
            upstreamJobId: null,
            videoUrl: submitted.videoUrl,
            storageKey: createVideoStorageKey(row.userId, row.id),
            upstreamAcceptedAt: new Date(),
            nextPollAt: new Date(),
            apiAdapterQueryFailureCount: 0,
            error: null,
          },
        });
        if (!downloading) {
          throw new Error("视频同步完成结果持久化发生并发冲突");
        }
        return {
          videoGenerationId: row.id,
          status: "processing",
          creditsConsumed: billedCost,
        };
      }
      const pollAfterSeconds =
        "pollAfterSeconds" in submitted
          ? (submitted.pollAfterSeconds ??
            API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS)
          : 0;
      const polling = await compareAndSetVideoStage({
        row,
        expectedStages: ["submitting"],
        values: {
          stage: "polling",
          // API 查询地址始终从固定版本重建，不把完整 URL 写入任务；Adobe
          // 仍沿用其既有动态 pollUrl 契约。
          pollUrl: "pollUrl" in submitted ? submitted.pollUrl : null,
          upstreamJobId: submitted.upstreamJobId,
          upstreamAcceptedAt: new Date(),
          nextPollAt: new Date(Date.now() + pollAfterSeconds * 1_000),
          apiAdapterQueryFailureCount: 0,
          claimToken: null,
          claimExpiresAt: null,
          error: null,
        },
      });
      if (!polling) throw new Error("视频接受结果持久化发生并发冲突");
      return {
        videoGenerationId: row.id,
        status: "processing",
        creditsConsumed: billedCost,
      };
    }

    if (lease.memberType === "api" && "failure" in submitted) {
      const decision = attemptReservationRejected
        ? {
            action: "switch_member" as const,
            failureCode: "unknown_submission_failure" as const,
            userReason: "当前生成服务暂时不可用，请稍后重试",
            operationsReason: "当前 API 视频账号的创建尝试次数已耗尽",
          }
        : classifyVideoSubmissionFailure(submitted.failure);
      if (!reservedAttempt && submitted.backendHealthNeutral) {
        // 平台脚本容量或输入签名发生在真实外呼前，不写尝试账本，也不消耗
        // 账号次数；保留原账号并用持久排程恢复。
        const retrying = await scheduleVideoSubmissionRetry({
          row,
          decision,
          requestId: getVideoRequestId(row) ?? "server-recovery",
          ...(getApiVideoSupplierId(lease)
            ? { supplierId: getApiVideoSupplierId(lease) }
            : {}),
          supplierName: getVideoSupplierName(row),
          memberId: lease.memberId,
          httpTimeoutSeconds: submissionTimeout.seconds,
          retryAfterSeconds: submitted.retryAfterSeconds,
        });
        await backendSession.close();
        if (!retrying) throw new Error("视频平台容量重试排程发生并发冲突");
        return {
          videoGenerationId: row.id,
          status: "processing",
          creditsConsumed: billedCost,
        };
      }
      if (reservedAttempt) {
        await recordVideoSubmissionFailure({
          row,
          attemptId: reservedAttempt.id,
          requestId: reservedAttempt.requestId,
          ...(getApiVideoSupplierId(lease)
            ? { supplierId: getApiVideoSupplierId(lease) }
            : {}),
          supplierName: reservedAttempt.supplierNameSnapshot,
          attemptNumber: reservedAttempt.globalAttemptNumber,
          memberAttemptNumber: reservedAttempt.memberAttemptNumber,
          configuredRetryCount: reservedAttempt.retryCountSnapshot,
          maxAttemptsSnapshot: reservedAttempt.maxAttemptsSnapshot,
          httpTimeoutSeconds: submissionTimeout.seconds,
          memberId: reservedAttempt.backendMemberId,
          decision,
          now: new Date(),
        });
      }
      const sameMemberRemaining =
        reservedAttempt !== null &&
        reservedAttempt.memberAttemptNumber <
          reservedAttempt.maxAttemptsSnapshot;
      if (decision.action === "retry_same_member" && sameMemberRemaining) {
        const retrying = await scheduleVideoSubmissionRetry({
          row,
          decision,
          requestId: reservedAttempt?.requestId ?? submissionRequestId,
          ...(getApiVideoSupplierId(lease)
            ? { supplierId: getApiVideoSupplierId(lease) }
            : {}),
          supplierName:
            reservedAttempt?.supplierNameSnapshot ??
            lease.acquisition.member.name,
          memberId: reservedAttempt?.backendMemberId ?? lease.memberId,
          ...(reservedAttempt
            ? {
                attemptNumber: reservedAttempt.globalAttemptNumber,
                memberAttemptNumber: reservedAttempt.memberAttemptNumber,
                configuredRetryCount: reservedAttempt.retryCountSnapshot,
                maxAttemptsSnapshot: reservedAttempt.maxAttemptsSnapshot,
              }
            : {}),
          httpTimeoutSeconds: submissionTimeout.seconds,
          retryAfterSeconds: submitted.retryAfterSeconds,
        });
        await backendSession.close();
        if (!retrying) throw new Error("视频同账号重试排程发生并发冲突");
        return {
          videoGenerationId: row.id,
          status: "processing",
          creditsConsumed: billedCost,
        };
      }
      if (
        decision.action === "switch_member" ||
        (decision.action === "retry_same_member" && !sameMemberRemaining)
      ) {
        try {
          await backendSession.close();
          const attemptedMemberIds =
            await defaultVideoSubmissionAttemptRepository.listAttemptedMemberIds(
              row.id
            );
          if (attemptReservationRejected) {
            attemptedMemberIds.push(lease.memberId);
          }
          const switchedSession = await createRuntimeBackendSession({
            userId: row.userId,
            ...(row.apiKeyId ? { apiKeyId: row.apiKeyId } : {}),
            ...(backendGroupId ? { requestedGroupId: backendGroupId } : {}),
            modelId: contract.model,
            requestKind: "video",
            requiresContentSafety: true,
            requiredMemberType: "api",
            excludedMemberIds: attemptedMemberIds,
          });
          let nextLease: Awaited<
            ReturnType<typeof switchedSession.acquireNext>
          >;
          let retryable: VideoGenerationRow | null;
          try {
            nextLease = await switchedSession.acquireNext();
            retryable = await compareAndSetVideoStage({
              row,
              expectedStages: ["submitting"],
              values: {
                stage: "retrying",
                backendMemberId: nextLease.memberId,
                memberLeaseId: nextLease.acquisition.lease.id,
                memberLeaseOwnerToken: nextLease.acquisition.lease.ownerToken,
                ...createLeaseApiAdapterSnapshot(nextLease),
                metadata: createLeaseVideoBackendMetadata(
                  row.metadata,
                  nextLease
                ),
                error: decision.userReason,
                failureCode: decision.failureCode,
                nextPollAt: new Date(),
                submitStartedAt: null,
                claimToken: null,
                claimExpiresAt: null,
              },
            });
          } finally {
            // CAS、数据库或日志前置失败都不能把预先获取的新账号租约遗留到 TTL。
            await switchedSession.close();
          }
          if (!retryable) throw new Error("视频成员切换发生并发冲突");
          logVideoSupplierSwitched({
            row: retryable,
            ...(getApiVideoSupplierId(nextLease)
              ? { supplierId: getApiVideoSupplierId(nextLease) }
              : {}),
            supplierName: nextLease.acquisition.member.name,
            requestId: reservedAttempt?.requestId ?? submissionRequestId,
            memberId: nextLease.memberId,
            ...(reservedAttempt
              ? { attemptNumber: reservedAttempt.globalAttemptNumber }
              : {}),
            failureCode: decision.failureCode,
          });
          return {
            videoGenerationId: row.id,
            status: "processing",
            creditsConsumed: billedCost,
          };
        } catch (error) {
          if (
            !(error instanceof BackendSchedulerError) ||
            (error.code !== "capacity_rejected" &&
              error.code !== "no_eligible_member")
          ) {
            throw error;
          }
          if (error.code === "capacity_rejected") {
            const capacityWaitSeconds = await getRuntimeSettingNumber(
              "VIDEO_SUBMISSION_CAPACITY_WAIT_TIMEOUT_SECONDS",
              120,
              { nonNegative: true }
            );
            const waitMs =
              Math.min(1_800, Math.max(0, Math.round(capacityWaitSeconds))) *
              1_000;
            const deadline =
              row.capacityWaitDeadlineAt ?? new Date(Date.now() + waitMs);
            if (waitMs > 0 && deadline.getTime() > Date.now()) {
              if (!row.capacityWaitDeadlineAt) {
                logVideoCapacityWaitStarted({ row, deadline });
              }
              const waiting = await compareAndSetVideoStage({
                row,
                expectedStages: ["submitting"],
                values: {
                  stage: "retrying",
                  capacityWaitDeadlineAt: deadline,
                  backendMemberId: null,
                  memberLeaseId: null,
                  memberLeaseOwnerToken: null,
                  apiAdapterMemberId: null,
                  apiAdapterVersionId: null,
                  nextPollAt: resolveVideoCapacityRetryAt(new Date(), deadline),
                  claimToken: null,
                  claimExpiresAt: null,
                  submitStartedAt: null,
                },
              });
              if (!waiting) throw new Error("视频容量等待排程发生并发冲突");
              return {
                videoGenerationId: row.id,
                status: "processing",
                creditsConsumed: billedCost,
              };
            }
          }
          const finalCode =
            error.code === "capacity_rejected"
              ? "capacity_wait_timeout"
              : "no_eligible_api_account";
          const finalReason =
            finalCode === "capacity_wait_timeout"
              ? "当前生成服务繁忙，请稍后重试"
              : "当前没有可用生成服务";
          const refunding = await moveVideoToRefunding(
            row,
            finalReason,
            finalCode
          );
          if (refunding) await refundClaimedVideoOrRetry(refunding);
          return { error: finalReason, videoGenerationId: row.id };
        }
      }
      await backendSession.close();
      const finalReason = decision.userReason ?? "视频生成失败，请稍后重试";
      const refunding = await moveVideoToRefunding(
        row,
        finalReason,
        decision.failureCode
      );
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return { error: finalReason, videoGenerationId: row.id };
    }

    if ("backendHealthNeutral" in submitted && submitted.backendHealthNeutral) {
      await backendSession.close();
      const refunding = await moveVideoToRefunding(row, submitted.error);
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return { error: submitted.error, videoGenerationId: row.id };
    }

    if (!("switchable" in submitted)) {
      throw new Error("API 视频提交失败未被自动恢复状态机收敛");
    }

    if (!submitted.switchable) {
      await backendSession.completeCurrent({
        success: false,
        error: submitted.error,
        durationMs: Date.now() - startedAt,
        terminal: submitted.terminal,
      });
      const refunding = await moveVideoToRefunding(row, submitted.error);
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return { error: submitted.error, videoGenerationId: row.id };
    }
    try {
      const nextLease = await backendSession.switchAfterFailure(
        submitted.error,
        Date.now() - startedAt
      );
      const retryable = await compareAndSetVideoStage({
        row,
        expectedStages: ["submitting"],
        values: {
          stage: "charged",
          backendMemberId: nextLease.memberId,
          memberLeaseId: nextLease.acquisition.lease.id,
          memberLeaseOwnerToken: nextLease.acquisition.lease.ownerToken,
          ...createLeaseApiAdapterSnapshot(nextLease),
          metadata: createLeaseVideoBackendMetadata(row.metadata, nextLease),
          error: submitted.error.slice(0, 1_000),
        },
      });
      if (!retryable) throw new Error("视频成员切换发生并发冲突");
      row = retryable;
    } catch (error) {
      await backendSession.close();
      const message =
        error instanceof BackendSchedulerError &&
        error.code === "no_eligible_member"
          ? resolveVideoBackendExhaustionError(submitted.error)
          : error instanceof Error
            ? error.message
            : "无可用视频后端";
      const refunding = await moveVideoToRefunding(row, message);
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return { error: message, videoGenerationId: row.id };
    }
  }
}

/** 接管并续期原成员租约；失败时不轮询，避免绕开统一并发容量。 */
async function takeoverVideoLease(
  row: VideoGenerationRow
): Promise<VideoGenerationRow | null> {
  if (
    !row.backendMemberId ||
    !row.memberLeaseId ||
    !row.memberLeaseOwnerToken ||
    (getVideoBackendProtocol(row) === "api" &&
      (!row.apiAdapterMemberId || !row.apiAdapterVersionId))
  ) {
    return null;
  }
  const nextOwnerToken = randomUUID();
  const now = new Date();
  const lease = await defaultBackendPoolRepository.takeoverLease({
    leaseId: row.memberLeaseId,
    memberId: row.backendMemberId,
    currentOwnerToken: row.memberLeaseOwnerToken,
    nextOwnerToken,
    now,
    expiresAt: new Date(now.getTime() + VIDEO_LEASE_TTL_MS),
    ...(row.apiAdapterMemberId && row.apiAdapterVersionId
      ? {
          apiAdapterMemberId: row.apiAdapterMemberId,
          apiAdapterVersionId: row.apiAdapterVersionId,
        }
      : {}),
  });
  if (!lease || lease.memberId !== row.backendMemberId) return null;
  const updated = await compareAndSetVideoStage({
    row,
    expectedStages: [row.stage as VideoStage],
    values: { memberLeaseOwnerToken: nextOwnerToken },
  });
  if (!updated) {
    await defaultBackendPoolRepository.releaseLease({
      leaseId: lease.id,
      ownerToken: nextOwnerToken,
    });
  }
  return updated;
}

/** 同时续期当前 worker 的任务 claim 与成员容量租约。 */
async function renewClaimedVideoExecution(
  row: VideoGenerationRow
): Promise<VideoGenerationRow | null> {
  if (!row.claimToken || !row.memberLeaseId || !row.memberLeaseOwnerToken) {
    return null;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + VIDEO_LEASE_TTL_MS);
  const lease = await defaultBackendPoolRepository.renewLease({
    leaseId: row.memberLeaseId,
    ownerToken: row.memberLeaseOwnerToken,
    now,
    expiresAt,
  });
  if (!lease) return null;
  return compareAndSetVideoStage({
    row,
    expectedStages: [row.stage as VideoStage],
    values: { claimExpiresAt: expiresAt },
  });
}

/**
 * 在下载与对象存储长 I/O 期间周期续租。
 *
 * state.row 会同步为最新 CAS 版本；即使 I/O 抛错，调用方也能用最新版本安全释放
 * claim，而不会因心跳递增 stateVersion 后拿旧快照重试失败。
 */
async function runWithVideoExecutionHeartbeat<T>(
  state: { row: VideoGenerationRow },
  work: () => Promise<T>
): Promise<T> {
  const firstRenewal = await renewClaimedVideoExecution(state.row);
  if (!firstRenewal) throw new Error("视频长任务租约无法续期");
  state.row = firstRenewal;
  let renewalError: unknown;
  let pendingRenewal = Promise.resolve();
  const timer = setInterval(() => {
    pendingRenewal = pendingRenewal
      .then(async () => {
        if (renewalError) return;
        const renewed = await renewClaimedVideoExecution(state.row);
        if (!renewed) throw new Error("视频长任务租约心跳丢失");
        state.row = renewed;
      })
      .catch((error: unknown) => {
        renewalError = error;
      });
  }, VIDEO_IO_HEARTBEAT_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  try {
    const result = await work();
    await pendingRenewal;
    if (renewalError) throw renewalError;
    return result;
  } finally {
    clearInterval(timer);
  }
}

/** 暂时失败后释放 claim 并安排重试，不改变已接受任务的 member/token。 */
async function retryClaimedVideo(
  row: VideoGenerationRow,
  error: unknown
): Promise<void> {
  await compareAndSetVideoStage({
    row,
    expectedStages: [row.stage as VideoStage],
    values: {
      error: (error instanceof Error
        ? error.message
        : "视频恢复暂时失败"
      ).slice(0, 1_000),
      nextPollAt: new Date(Date.now() + VIDEO_RETRY_DELAY_MS),
      claimToken: null,
      claimExpiresAt: null,
      attemptCount: row.attemptCount + 1,
    },
  });
}

/** 处理一条已认领任务；每个 I/O 前后均以持久 CAS 收敛。 */
async function recoverClaimedVideo(row: VideoGenerationRow): Promise<void> {
  if (row.stage === "submit_uncertain") {
    await migrateClaimedLegacyApiUncertainVideo(row);
    return;
  }
  if (row.stage === "created") {
    await submitClaimedCreatedVideo(row);
    return;
  }
  if (row.stage === "charged") {
    try {
      await defaultVideoApiKeyQuotaRepository.reserve({
        videoId: row.id,
        amount: row.creditsConsumed,
      });
    } catch (error) {
      await defaultVideoApiKeyQuotaRepository.refund({ videoId: row.id });
      await failUnchargedVideo(
        row,
        error instanceof Error ? error.message : "视频配额预留未完成"
      );
      await releaseVideoLease(row);
      return;
    }
    let consumption: Awaited<ReturnType<typeof consumeVideoCredits>>;
    // 账本本身不可查询时异常上抛；外层保留 charged 并释放 claim 后重试。
    consumption = await consumeVideoCredits({
      row,
      amount: row.creditsConsumed,
      metadata: { videoGenerationId: row.id, model: row.model },
    });
    if (!consumption.consumed) {
      const error = consumption.error;
      await defaultVideoApiKeyQuotaRepository.refund({ videoId: row.id });
      await failUnchargedVideo(
        row,
        error instanceof Error ? error.message : "视频扣费未完成"
      );
      await releaseVideoLease(row);
      return;
    }
    const refunding = await moveVideoToRefunding(
      row,
      "任务在提交前中断，已安全退款"
    );
    if (refunding) await refundClaimedVideoOrRetry(refunding);
    return;
  }
  if (row.stage === "submitting") {
    const protocol = getVideoBackendProtocol(row);
    if (protocol === "api") {
      await compareAndSetVideoStage({
        row,
        expectedStages: ["submitting"],
        values: {
          stage: "retrying",
          error: "视频创建进程中断，已安排自动恢复",
          nextPollAt: new Date(),
          claimToken: null,
          claimExpiresAt: null,
          submitStartedAt: null,
        },
      });
      return;
    }
    // Adobe Direct 保持既有人工兼容语义，不进入 API 自动创建重试。
    await compareAndSetVideoStage({
      row,
      expectedStages: ["submitting"],
      values: {
        stage: "submit_uncertain",
        error: "进程在视频提交期间中断，未自动重投或退款",
        nextPollAt: null,
        claimToken: null,
        claimExpiresAt: null,
      },
    });
    return;
  }
  if (row.stage === "retrying") {
    const now = new Date();
    if (
      row.capacityWaitDeadlineAt &&
      row.capacityWaitDeadlineAt.getTime() <= now.getTime()
    ) {
      const refunding = await moveVideoToRefunding(
        row,
        "当前生成服务繁忙，请稍后重试",
        "capacity_wait_timeout"
      );
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return;
    }
    await submitClaimedCreatedVideo(row);
    return;
  }
  if (row.stage === "refunding") {
    await refundClaimedVideoOrRetry(row);
    return;
  }

  const leased = await takeoverVideoLease(row);
  if (!leased) {
    await retryClaimedVideo(row, new Error("原视频账号租约暂时无法接管"));
    return;
  }
  row = leased;

  if (row.stage === "polling") {
    if (
      !row.backendMemberId ||
      (getVideoBackendProtocol(row) === "api"
        ? !row.upstreamJobId
        : !row.pollUrl)
    ) {
      const refunding = await moveVideoToRefunding(
        row,
        "已接受视频任务缺少恢复身份"
      );
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return;
    }
    try {
      const polled = await pollAcceptedVideoTask(row);
      if (polled.status === "pending") {
        const pollDelayMs =
          getVideoBackendProtocol(row) === "api"
            ? (("pollAfterSeconds" in polled
                ? typeof polled.pollAfterSeconds === "number"
                  ? polled.pollAfterSeconds
                  : undefined
                : undefined) ?? API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS) * 1_000
            : VIDEO_POLL_DELAY_MS;
        await compareAndSetVideoStage({
          row,
          expectedStages: ["polling"],
          values: {
            nextPollAt: new Date(Date.now() + pollDelayMs),
            claimToken: null,
            claimExpiresAt: null,
            apiAdapterQueryFailureCount: 0,
            error: null,
          },
        });
        return;
      }
      const downloading = await compareAndSetVideoStage({
        row,
        expectedStages: ["polling"],
        values: {
          stage: "downloading",
          videoUrl: polled.videoUrl,
          storageKey: createVideoStorageKey(row.userId, row.id),
          nextPollAt: new Date(),
          apiAdapterQueryFailureCount: 0,
          error: null,
        },
      });
      if (!downloading) return;
      row = downloading;
    } catch (error) {
      if (
        error instanceof ApiAcceptedVideoError &&
        error.countsTowardAdapterFailure
      ) {
        const failure = resolveApiAdapterQueryFailure(
          row.apiAdapterQueryFailureCount
        );
        if (failure.shouldRetry) {
          await compareAndSetVideoStage({
            row,
            expectedStages: ["polling"],
            values: {
              apiAdapterQueryFailureCount: failure.nextFailureCount,
              error: error.message.slice(0, 1_000),
              nextPollAt: new Date(Date.now() + VIDEO_RETRY_DELAY_MS),
              claimToken: null,
              claimExpiresAt: null,
              attemptCount: row.attemptCount + 1,
            },
          });
          return;
        }
        const refunding = await moveVideoToRefunding(
          row,
          "供应商请求处理连续失败，请联系管理员"
        );
        if (refunding) await refundClaimedVideoOrRetry(refunding);
        return;
      }
      if (shouldRetryAcceptedVideoError(error)) {
        await retryClaimedVideo(row, error);
        return;
      }
      const refunding = await moveVideoToRefunding(
        row,
        error instanceof Error ? error.message : "视频上游任务失败"
      );
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return;
    }
  }

  if (row.stage !== "downloading") return;
  if (
    !row.backendMemberId ||
    !row.videoUrl ||
    !row.storageKey ||
    !row.storageBucket
  ) {
    const refunding = await moveVideoToRefunding(row, "视频下载恢复信息不完整");
    if (refunding) await refundClaimedVideoOrRetry(refunding);
    return;
  }
  const backendMemberId = row.backendMemberId;
  const videoUrl = row.videoUrl;
  const storageKey = row.storageKey;
  const storageBucket = row.storageBucket;
  const leaseState = { row };
  try {
    await runWithVideoExecutionHeartbeat(leaseState, async () => {
      const bytes =
        getVideoBackendProtocol(leaseState.row) === "api"
          ? await downloadApiVideoRequest(videoUrl, {
              trustedOrigin: getApiVideoTrustedOrigin(leaseState.row),
            })
          : await downloadAdobeDirectVideoRequest({
              memberId: backendMemberId,
              videoUrl,
            });
      const storage = await getStorageProvider();
      await storage.putObject(storageKey, storageBucket, bytes, "video/mp4");
    });
    row = leaseState.row;
    await completeVideoGenerationWithUsage({
      videoGenerationId: row.id,
      storageKey,
      completedAt: new Date(),
    });
    const completed = await compareAndSetVideoStage({
      row,
      expectedStages: ["downloading"],
      values: {
        status: "completed",
        stage: "completed",
        apiKeyCreditsReserved: 0,
        nextPollAt: null,
        claimToken: null,
        claimExpiresAt: null,
        error: null,
      },
    });
    await releaseVideoLease(completed ?? row);
  } catch (error) {
    row = leaseState.row;
    logError(error, {
      source: "video-recovery-download",
      videoId: row.id,
    });
    if (isAcceptedVideoError(error) && !shouldRetryAcceptedVideoError(error)) {
      const refunding = await moveVideoToRefunding(
        row,
        error instanceof Error ? error.message : "视频下载失败"
      );
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return;
    }
    await retryClaimedVideo(row, error);
  }
}

/**
 * 处理 Redis MQ 指定的一条视频任务并返回下一次投递时间。
 *
 * @param taskId MQ 中仅用于定位 PostgreSQL 行的任务 ID。
 * @returns 非终态任务的下一次版本化投递；终态、协议兼容态或任务不存在时为 null。
 * @throws claim 后的异常无法持久化重试状态时上抛，让 BullMQ 执行有界重试。
 */
export async function processVideoGenerationQueueTask(
  taskId: string
): Promise<VideoQueueSchedule | null> {
  const now = new Date();
  let claim = await defaultVideoRecoveryRepository.claimById({
    taskId,
    claimToken: randomUUID(),
    now,
    claimExpiresAt: new Date(now.getTime() + VIDEO_CLAIM_TTL_MS),
  });
  if (!claim) {
    const legacy = await getVideoGenerationById(taskId);
    if (
      legacy?.stage === "submit_uncertain" &&
      getVideoMetadataString(legacy.metadata, "videoBackendProtocol", 32) ===
        "api"
    ) {
      // @deprecated：普通 claim 永远排除人工态；这里只为升级前显式 API 遗留行
      // 使用专用入口。下个版本仅在遗留查询为零后移除。
      claim = await defaultVideoRecoveryRepository.claimLegacyApiUncertainById({
        taskId,
        claimToken: randomUUID(),
        now,
        claimExpiresAt: new Date(now.getTime() + VIDEO_CLAIM_TTL_MS),
      });
    }
  }
  if (!claim) {
    const current = await getVideoGenerationById(taskId);
    return current ? resolveVideoQueueSchedule(current, now) : null;
  }

  const row = await getVideoGenerationById(claim.id);
  if (
    row?.claimToken !== claim.claimToken ||
    row.apiAdapterMemberId !== claim.apiAdapterMemberId ||
    row.apiAdapterVersionId !== claim.apiAdapterVersionId
  ) {
    return row ? resolveVideoQueueSchedule(row, now) : null;
  }

  try {
    await recoverClaimedVideo(row);
  } catch (error) {
    logError(error, {
      source: "video-mq-processing",
      videoId: row.id,
    });
    try {
      await retryClaimedVideo(row, error);
    } catch (retryError) {
      logError(retryError, {
        source: "video-mq-release-claim",
        videoId: row.id,
      });
      throw retryError;
    }
  }

  const current = await getVideoGenerationById(taskId);
  return current ? resolveVideoQueueSchedule(current) : null;
}
