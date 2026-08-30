/**
 * Web 定时维护任务编排。
 *
 * 职责：执行图片清理、积分过期、媒体队列补投、图片租约恢复、运营 CSV 导出与
 * 定时任务；业务副作用通过各领域仓储、队列或 UOL operation 完成。
 */
import { processExpiredBatches } from "@repo/shared/credits/core";
import {
  destroyExpiredGenerationPhotos,
  destroyGenerationPhotosByMaxCount,
  expireStalePendingGenerations,
} from "@repo/shared/generation-maintenance";
import { logError } from "@repo/shared/logger";
import { getRuntimeSettingSelect } from "@repo/shared/system-settings";
import {
  defaultImageAsyncTaskRepository,
  type ImageAsyncTaskRepository,
} from "@/features/image-generation/image-async-task-repository";
import {
  acquireImageGenerationAdmission,
  type RedisImageGenerationAdmissionAcquisition,
  type RedisImageGenerationAdmissionLease,
  releaseImageGenerationAdmission,
  renewImageGenerationAdmission,
  restoreImageGenerationAdmissionLease,
} from "@/features/image-generation/redis-image-generation-slots";
import { runVideoCallbackDeliveryJob } from "@/features/image-generation/video-callback-delivery";
import { runVideoInputCleanupJob } from "@/features/image-generation/video-input-cleanup-queue";
import { enqueueImageTask, enqueueVideoTask } from "@/server/media-task-queues";
import {
  defaultMediaTaskRecoveryRepository,
  type MediaTaskRecoveryRepository,
} from "@/server/media-task-recovery-repository";
import {
  buildCreditsExpireResponse,
  summarizeExpiredPendingGenerations,
} from "@/server/scheduled-jobs-response";

/**
 * 运营导出任务通过 UOL 内部 cron Principal 调用，保证处理与保留任务只能使用各自
 * 声明的 job 身份进入统一权限和审计网关。
 *
 * @param operation - 处理队列或过期清理 operation。
 * @param batchSize - 本轮最大任务数，最终仍由 UOL Zod 契约校验为 1 至 100。
 * @param job - 与 operation access 声明一致的固定 cron job 名。
 * @returns operation 返回的本轮处理统计。
 * @throws UOL 未绑定、输入非法或领域 worker 失败时保持上抛，由调度器记录失败状态。
 */
async function invokeOperationsExportJob<T>(
  operation: "operations.processExports" | "operations.expireExports",
  batchSize: number,
  job: "operations-export" | "operations-export-retention"
): Promise<T> {
  const [{ invokeOperation }, { ensureUolInitialized }] = await Promise.all([
    import("@repo/shared/uol"),
    import("@/server/uol-init"),
  ]);
  await ensureUolInitialized();
  return invokeOperation<T>(
    operation,
    { limit: batchSize },
    { type: "cron", job }
  );
}

/**
 * 支付履约恢复通过 system/job UOL operation 执行，scheduler 不直接调用财务 service。
 *
 * @returns 本轮领取与收敛统计。
 */
export async function runPaymentFulfillmentRecoveryJob() {
  const [{ invokeOperation }, { ensureUolInitialized }] = await Promise.all([
    import("@repo/shared/uol"),
    import("@/server/uol-init"),
  ]);
  await ensureUolInitialized();
  return invokeOperation(
    "payment.recoverFulfillments",
    {},
    { type: "cron", job: "payment-fulfillment" }
  );
}

/**
 * 处理一批排队中或租约已陈旧的运营 CSV 导出任务。
 *
 * @param batchSize - 本轮最大认领任务数。
 * @returns worker 的有界处理统计。
 */
export async function runOperationsExportProcessingJob(batchSize: number) {
  return invokeOperationsExportJob(
    "operations.processExports",
    batchSize,
    "operations-export"
  );
}

/**
 * 过期并清理一批已超过文件保留期的运营 CSV 导出任务。
 *
 * @param batchSize - 本轮最大清理任务数。
 * @returns retention worker 的有界处理统计。
 */
export async function runOperationsExportExpirationJob(batchSize: number) {
  return invokeOperationsExportJob(
    "operations.expireExports",
    batchSize,
    "operations-export-retention"
  );
}

/**
 * 单次图像维护 cron 扫描的最大处理行数。
 * 同时作为超时 pending 过期与超期成品图销毁的批量上限，避免单次任务无界扫描。
 */
const IMAGE_MAINTENANCE_BATCH_LIMIT = 500;
const MEDIA_TASK_RECOVERY_BATCH_LIMIT = 1_000;
const MEDIA_TASK_RECOVERY_CONCURRENCY = 25;
const IMAGE_ADMISSION_RECOVERY_BACKOFF_MS = 60_000;

/** 媒体队列与图片租约补偿任务的可替换依赖。 */
export interface MediaTaskRecoveryJobDependencies {
  repository: MediaTaskRecoveryRepository;
  imageTaskRepository: Pick<
    ImageAsyncTaskRepository,
    | "deferAdmissionRenewal"
    | "markAdmissionReleased"
    | "markMqDelivered"
    | "prepareClaimRecoveryDelivery"
    | "updateAdmissionLease"
  >;
  enqueueImage: typeof enqueueImageTask;
  enqueueVideo: typeof enqueueVideoTask;
  acquireImageAdmission(input: {
    userId: string;
    userConcurrency: number;
    token: string;
  }): Promise<RedisImageGenerationAdmissionAcquisition>;
  renewImageAdmission(
    lease: RedisImageGenerationAdmissionLease
  ): ReturnType<typeof renewImageGenerationAdmission>;
  releaseImageAdmission(
    lease: RedisImageGenerationAdmissionLease
  ): Promise<void>;
  now(): Date;
  reportFailure(
    error: unknown,
    queue: "image" | "image-admission" | "image-release" | "video",
    taskId: string
  ): void;
}

const defaultMediaTaskRecoveryDependencies: MediaTaskRecoveryJobDependencies = {
  repository: defaultMediaTaskRecoveryRepository,
  imageTaskRepository: defaultImageAsyncTaskRepository,
  enqueueImage: enqueueImageTask,
  enqueueVideo: enqueueVideoTask,
  acquireImageAdmission: acquireImageGenerationAdmission,
  renewImageAdmission: renewImageGenerationAdmission,
  releaseImageAdmission: releaseImageGenerationAdmission,
  now: () => new Date(),
  reportFailure(error, queue, taskId) {
    logError(error, {
      source: "media-task-mq-recovery",
      queue,
      taskId,
    });
  },
};

/**
 * 使用 Redis 服务端 expiry 的剩余半窗安排下一次 admission 续期。
 *
 * @param now 本轮数据库确认时间。
 * @param expiresAt Redis 返回的租约绝对过期时间戳。
 * @returns 严格位于当前时间和过期时间之间的下一次续期时间。
 * @throws 租约已经过期或只剩不足 1 毫秒时失败关闭。
 */
function getRecoveredAdmissionRenewalDueAt(now: Date, expiresAt: number): Date {
  const remainingMs = expiresAt - now.getTime();
  if (remainingMs <= 1) {
    throw new Error("恢复后的图片 admission 租约已过期");
  }
  return new Date(now.getTime() + Math.floor(remainingMs / 2));
}

/**
 * 恢复一条非终态 admission。
 *
 * @param task 数据库扫描出的持久租约与用户并发快照。
 * @param dependencies Redis 和数据库可替换端口。
 * @returns 数据库确认续期时为 true；容量满载或并发状态已变化时为 false。
 * @throws Redis 不可用、响应非法或续期时间无效时显式上抛。
 *
 * WHY：token 丢失不能直接复活，否则会绕过用户并发上限；必须使用原 token 和持久
 * 并发快照重新执行原子容量裁决，保持重入且不扩大准入配额。
 */
async function recoverImageAdmission(
  task: Awaited<
    ReturnType<MediaTaskRecoveryRepository["scan"]>
  >["imageAdmissions"][number],
  dependencies: MediaTaskRecoveryJobDependencies
): Promise<boolean> {
  const persistedLease = restoreImageGenerationAdmissionLease({
    userId: task.userId,
    token: task.token,
    expiresAt: task.expiresAt,
  });
  const renewal = await dependencies.renewImageAdmission(persistedLease);
  let expiresAt: number;
  let recoveredLease = persistedLease;
  if (renewal.status === "renewed") {
    expiresAt = renewal.expiresAt;
    recoveredLease = { ...persistedLease, expiresAt };
  } else {
    const acquisition = await dependencies.acquireImageAdmission({
      userId: task.userId,
      userConcurrency: task.effectiveUserConcurrency,
      token: task.token,
    });
    if (acquisition.status === "blocked") {
      const now = dependencies.now();
      await dependencies.imageTaskRepository.deferAdmissionRenewal({
        taskId: task.taskId,
        admissionLeaseToken: task.token,
        expectedRenewalDueAt: task.renewalDueAt,
        nextRenewalDueAt: new Date(
          now.getTime() + IMAGE_ADMISSION_RECOVERY_BACKOFF_MS
        ),
        now,
      });
      return false;
    }
    expiresAt = acquisition.lease.expiresAt;
    recoveredLease = acquisition.lease;
  }
  const now = dependencies.now();
  const updated = await dependencies.imageTaskRepository.updateAdmissionLease({
    taskId: task.taskId,
    admissionLeaseToken: task.token,
    admissionLeaseExpiresAt: new Date(expiresAt),
    admissionRenewalDueAt: getRecoveredAdmissionRenewalDueAt(now, expiresAt),
    now,
  });
  if (!updated) {
    // WHY：扫描后任务可能已经终态并完成旧 token 的 release ack；本轮迟到的 renew/
    // acquire 必须撤销，不能把已经释放的用户槽重新留在 Redis 直到 TTL。
    await dependencies.releaseImageAdmission(recoveredLease);
    return false;
  }
  return true;
}

/**
 * 恢复一条终态 admission 释放。
 *
 * @param task 数据库扫描出的终态任务与持久 token。
 * @param dependencies Redis release 与数据库确认端口。
 * @returns release ack 由当前调用写入时为 true；已被其他恢复器收敛时为 false。
 * @throws Redis 释放失败时上抛，保留 terminal due 供下轮重试。
 *
 * WHY：Redis release 天然幂等，只有调用成功或确认 token 已不存在后，才能清除数据库
 * due；这样 DB 提交后崩溃和 release 后 ack 前崩溃都能最终收敛。
 */
async function recoverImageTerminalRelease(
  task: Awaited<
    ReturnType<MediaTaskRecoveryRepository["scan"]>
  >["imageTerminalReleases"][number],
  dependencies: MediaTaskRecoveryJobDependencies
): Promise<boolean> {
  const lease = restoreImageGenerationAdmissionLease({
    userId: task.userId,
    token: task.token,
    expiresAt: task.expiresAt,
  });
  await dependencies.releaseImageAdmission(lease);
  return Boolean(
    await dependencies.imageTaskRepository.markAdmissionReleased({
      taskId: task.taskId,
      admissionLeaseToken: task.token,
      now: dependencies.now(),
    })
  );
}

/**
 * 以固定并发分片处理恢复项，避免扩大扫描吞吐后同时压垮 Redis 和 PostgreSQL。
 *
 * @param items 本轮同一恢复类型的有界扫描结果。
 * @param work 单项隔离处理函数；错误应由调用方在函数内转换为统计。
 */
async function runBoundedMediaRecovery<T>(
  items: T[],
  work: (item: T) => Promise<void>
): Promise<void> {
  for (
    let offset = 0;
    offset < items.length;
    offset += MEDIA_TASK_RECOVERY_CONCURRENCY
  ) {
    await Promise.all(
      items.slice(offset, offset + MEDIA_TASK_RECOVERY_CONCURRENCY).map(work)
    );
  }
}

export async function runImageMaintenanceJob() {
  // 图片清理三态模式：off=不清理（永久保存，默认）；time=按时间过期；
  // count=按最大保留张数删最老图。互斥：每次维护只跑其中一种照片清理逻辑，
  // 避免两套逻辑重复处理同一行。模式取值与设置项 options 逐字一致。
  const retentionMode = await getRuntimeSettingSelect(
    "GENERATION_IMAGE_RETENTION_MODE",
    ["off", "time", "count"] as const,
    "off"
  );

  const photoRetentionTask =
    retentionMode === "time"
      ? destroyExpiredGenerationPhotos({ limit: IMAGE_MAINTENANCE_BATCH_LIMIT })
      : retentionMode === "count"
        ? destroyGenerationPhotosByMaxCount({
            limit: IMAGE_MAINTENANCE_BATCH_LIMIT,
          })
        : Promise.resolve({
            enabled: false as const,
            destroyed: 0,
            failed: 0,
            storageObjectsDeleted: 0,
            details: [] as Array<{
              generationId: string;
              userId: string;
              storageObjectsDeleted: number;
            }>,
          });

  const [pendingResults, photoRetention] = await Promise.all([
    expireStalePendingGenerations({ limit: IMAGE_MAINTENANCE_BATCH_LIMIT }),
    photoRetentionTask,
  ]);

  return {
    success: true,
    ...summarizeExpiredPendingGenerations(pendingResults),
    details: pendingResults,
    retentionMode,
    photoRetention,
    timestamp: new Date().toISOString(),
  };
}

export async function runCreditsExpireJob() {
  const results = await processExpiredBatches();

  return {
    ...buildCreditsExpireResponse(results),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 恢复一批媒体队列投递与图片 admission 生命周期。
 *
 * @param dependencies 可替换扫描、队列、Redis 和数据库端口。
 * @returns 本轮发现、补投、续期、释放、延后与隔离失败数量。
 *
 * 单条失败只保留对应 due 并记录，不能阻断另一物理队列或其他恢复类型。
 */
export async function runMediaTaskQueueRecovery(
  dependencies: MediaTaskRecoveryJobDependencies = defaultMediaTaskRecoveryDependencies
) {
  const tasks = await dependencies.repository.scan({
    now: dependencies.now(),
    limit: MEDIA_TASK_RECOVERY_BATCH_LIMIT,
  });
  let enqueued = 0;
  let renewed = 0;
  let released = 0;
  let deferred = 0;
  let failed = 0;
  await Promise.all([
    runBoundedMediaRecovery(tasks.images, async (task) => {
      try {
        const delivery =
          task.recoveryKind === "claim"
            ? await dependencies.imageTaskRepository.prepareClaimRecoveryDelivery(
                {
                  taskId: task.taskId,
                  deliveryVersion: task.deliveryVersion,
                  claimRecoveryDueAt: task.dueAt,
                  now: dependencies.now(),
                }
              )
            : null;
        if (task.recoveryKind === "claim" && !delivery) {
          deferred += 1;
          return;
        }
        const deliveryVersion =
          delivery?.mqDeliveryVersion ?? task.deliveryVersion;
        const mqDeliveryDueAt = delivery?.mqDeliveryDueAt ?? task.dueAt;
        if (!mqDeliveryDueAt) {
          throw new Error("图片恢复投递缺少 MQ due 游标");
        }
        await dependencies.enqueueImage({
          taskId: task.taskId,
          deliveryVersion,
          priority: task.priority,
        });
        await dependencies.imageTaskRepository.markMqDelivered({
          taskId: task.taskId,
          deliveryVersion,
          mqDeliveryDueAt,
          now: dependencies.now(),
        });
        enqueued += 1;
      } catch (error) {
        failed += 1;
        dependencies.reportFailure(error, "image", task.taskId);
      }
    }),
    runBoundedMediaRecovery(tasks.imageAdmissions, async (task) => {
      try {
        if (await recoverImageAdmission(task, dependencies)) {
          renewed += 1;
        } else {
          deferred += 1;
        }
      } catch (error) {
        failed += 1;
        dependencies.reportFailure(error, "image-admission", task.taskId);
      }
    }),
    runBoundedMediaRecovery(tasks.imageTerminalReleases, async (task) => {
      try {
        if (await recoverImageTerminalRelease(task, dependencies)) {
          released += 1;
        } else {
          deferred += 1;
        }
      } catch (error) {
        failed += 1;
        dependencies.reportFailure(error, "image-release", task.taskId);
      }
    }),
    runBoundedMediaRecovery(tasks.videos, async (task) => {
      try {
        await dependencies.enqueueVideo(task);
        enqueued += 1;
      } catch (error) {
        failed += 1;
        dependencies.reportFailure(error, "video", task.taskId);
      }
    }),
  ]);
  return {
    discovered:
      tasks.images.length +
      tasks.imageAdmissions.length +
      tasks.imageTerminalReleases.length +
      tasks.videos.length,
    enqueued,
    renewed,
    released,
    deferred,
    failed,
  };
}

/**
 * 低频补投媒体 MQ、恢复图片租约，并继续执行独立的视频回调与输入清理维护。
 *
 * @returns 本轮补投、租约恢复、回调投递和输入清理统计；不直接处理媒体生成任务。
 */
export async function runVideoRecoveryJob() {
  const [queueRecovery, callbackDelivery, inputCleanup] = await Promise.all([
    runMediaTaskQueueRecovery(),
    runVideoCallbackDeliveryJob(),
    runVideoInputCleanupJob(),
  ]);
  return {
    success: true,
    queueRecovery,
    callbackDelivery,
    inputCleanup,
    timestamp: new Date().toISOString(),
  };
}
