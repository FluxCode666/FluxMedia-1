/**
 * 统一媒体账号的视频生成持久状态机。
 *
 * 职责：创建并幂等扣费、统一号池获租、单次提交，以及由内置 worker 认领后执行
 * 轮询、下载、完成或退款。使用方是 UOL binding 与定时任务。
 * 关键依赖：video_generation CAS、API/Adobe 分阶段适配器、成员租约、credits 与 storage。
 *
 * 不变量：上游接受后固定顶层成员；HTTP 与对象存储 I/O 不进入数据库事务；
 * submit 不确定不重投不退款；所有终态通过持久阶段和幂等财务键收敛。
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
import { API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS } from "@repo/shared/image-backend/api-upstream-script-contract";
import {
  listVideoInputManifestReferences,
  type VideoInputManifest,
  videoInputManifestSchema,
} from "@repo/shared/image-generation/media-contract";
import { logError } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import {
  getRuntimeSettingJson,
  getRuntimeStorageBucketConfig,
} from "@repo/shared/system-settings";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { completeVideoGenerationWithUsage } from "@/features/dashboard/output-usage-read-model";
import { parseMediaUpstreamUrl } from "@/features/image-backend-pool/media-upstream-url";
import { defaultBackendPoolRepository } from "@/features/image-backend-pool/repository";
import {
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
  resolveVideoQueueSchedule,
  type VideoQueueSchedule,
} from "./video-queue-schedule";
import {
  createVideoStorageKey,
  isAcceptedVideoError,
  resolveApiAdapterQueryFailure,
  resolveVideoBackendExhaustionError,
  shouldRetryAcceptedVideoError,
} from "./video-recovery-policy";
import { defaultVideoRecoveryRepository } from "./video-recovery-repository";
import {
  admitVideoTaskCreation,
  consumeVideoTaskStagingReservation,
} from "./video-task-admission";

const VIDEO_POLL_DELAY_MS = 15_000;
const VIDEO_RETRY_DELAY_MS = 60_000;
const VIDEO_LEASE_TTL_MS = 21 * 60_000;
const VIDEO_CLAIM_TTL_MS = VIDEO_LEASE_TTL_MS;
const VIDEO_SUBMISSION_TIMEOUT_MS = 20 * 60_000;
const VIDEO_IO_HEARTBEAT_MS = 5 * 60_000;

type VideoStage =
  | "created"
  | "charged"
  | "submitting"
  | "submit_uncertain"
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

/** 将未扣费或不可调度的任务直接标记失败，不创建退款。 */
async function failUnchargedVideo(
  row: VideoGenerationRow,
  message: string
): Promise<void> {
  await compareAndSetVideoStage({
    row,
    expectedStages: [row.stage as VideoStage],
    values: {
      status: "failed",
      stage: "failed",
      creditsConsumed: 0,
      error: message.slice(0, 1_000),
      claimToken: null,
      claimExpiresAt: null,
      nextPollAt: null,
    },
  });
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
  message: string
): Promise<VideoGenerationRow | null> {
  return compareAndSetVideoStage({
    row,
    expectedStages: [row.stage as VideoStage],
    values: {
      stage: "refunding",
      error: message.slice(0, 1_000),
      nextPollAt: new Date(),
    },
  });
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
  try {
    await refundClaimedVideo(row);
  } catch (error) {
    await retryClaimedVideo(row, error);
    throw error;
  }
}

/**
 * 人工收敛 submit_uncertain 视频任务。
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
    pollUrl =
      getVideoBackendProtocol(row) === "api"
        ? parseMediaUpstreamUrl(input.pollUrl).toString()
        : assertAdobeVideoPollUrl(input.pollUrl);
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
 * 分别重跑 created、幂等收敛 charged 或把 submitting 转为人工核对，绝不盲目重投。
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
    });
    await backendSession.acquireNext();
  } catch (error) {
    await failUnchargedVideo(
      row,
      error instanceof Error ? error.message : "无可用视频后端"
    );
    return {
      error: "无可用视频后端",
      videoGenerationId: row.id,
    };
  }

  const billedCost = getVideoCreditCost({
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
    expectedStages: ["created"],
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
    },
  });
  if (!charged) {
    await backendSession.close();
    throw new Error("视频任务扣费阶段发生并发冲突");
  }
  row = charged;

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

  for (;;) {
    const lease = backendSession.current;
    if (!lease) {
      const refunding = await moveVideoToRefunding(row, "视频后端租约已失效");
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return { error: "视频后端租约已失效", videoGenerationId: row.id };
    }
    const submitting = await compareAndSetVideoStage({
      row,
      expectedStages: ["charged"],
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
    const submissionSignal = AbortSignal.timeout(VIDEO_SUBMISSION_TIMEOUT_MS);
    const submitted =
      lease.memberType === "api"
        ? await submitApiVideoRequest(lease.config, {
            clientRequestId: row.id,
            prompt: row.prompt,
            model: contract.model,
            duration: contract.duration,
            aspectRatio: contract.aspectRatio,
            resolution: contract.resolution,
            effectiveAudio: contract.effectiveAudio,
            ...sourceInputs,
            ...(negativePrompt != null ? { negativePrompt } : {}),
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
            ...sourceInputs,
            ...(negativePrompt != null ? { negativePrompt } : {}),
            signal: submissionSignal,
          });
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

    if (submitted.submissionUncertain) {
      const uncertain = await compareAndSetVideoStage({
        row,
        expectedStages: ["submitting"],
        values: {
          stage: "submit_uncertain",
          error: submitted.error.slice(0, 1_000),
          nextPollAt: null,
          claimToken: null,
          claimExpiresAt: null,
        },
      });
      await backendSession.close();
      if (!uncertain) {
        throw new Error("视频提交不确定状态持久化发生并发冲突");
      }
      return {
        error: "视频提交结果不确定，任务已保留待核对",
        videoGenerationId: row.id,
      };
    }

    if ("backendHealthNeutral" in submitted && submitted.backendHealthNeutral) {
      await backendSession.close();
      const refunding = await moveVideoToRefunding(row, submitted.error);
      if (refunding) await refundClaimedVideoOrRetry(refunding);
      return { error: submitted.error, videoGenerationId: row.id };
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
 * @returns 非终态任务的下一次版本化投递；终态、人工核对态或任务不存在时为 null。
 * @throws claim 后的异常无法持久化重试状态时上抛，让 BullMQ 执行有界重试。
 */
export async function processVideoGenerationQueueTask(
  taskId: string
): Promise<VideoQueueSchedule | null> {
  const now = new Date();
  const claim = await defaultVideoRecoveryRepository.claimById({
    taskId,
    claimToken: randomUUID(),
    now,
    claimExpiresAt: new Date(now.getTime() + VIDEO_CLAIM_TTL_MS),
  });
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
