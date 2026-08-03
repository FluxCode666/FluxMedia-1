import { processExpiredBatches } from "@repo/shared/credits/core";
import {
  destroyExpiredGenerationPhotos,
  destroyGenerationPhotosByMaxCount,
  expireStalePendingGenerations,
} from "@repo/shared/generation-maintenance";
import { logError } from "@repo/shared/logger";
import { getRuntimeSettingSelect } from "@repo/shared/system-settings";
import { runVideoCallbackDeliveryJob } from "@/features/image-generation/video-callback-delivery";
import { runVideoInputCleanupJob } from "@/features/image-generation/video-input-cleanup-queue";
import {
  defaultMediaTaskRecoveryRepository,
  type MediaTaskRecoveryRepository,
} from "@/server/media-task-recovery-repository";
import {
  enqueueImageTask,
  enqueueVideoTask,
} from "@/server/media-task-queues";
import {
  buildCreditsExpireResponse,
  summarizeExpiredPendingGenerations,
} from "@/server/scheduled-jobs-response";

/**
 * 单次图像维护 cron 扫描的最大处理行数。
 * 同时作为超时 pending 过期与超期成品图销毁的批量上限，避免单次任务无界扫描。
 */
const IMAGE_MAINTENANCE_BATCH_LIMIT = 500;
const MEDIA_TASK_RECOVERY_BATCH_LIMIT = 100;

/** 媒体 MQ 补偿任务的可替换依赖。 */
export interface MediaTaskRecoveryJobDependencies {
  repository: MediaTaskRecoveryRepository;
  enqueueImage: typeof enqueueImageTask;
  enqueueVideo: typeof enqueueVideoTask;
  reportFailure(error: unknown, queue: "image" | "video", taskId: string): void;
}

const defaultMediaTaskRecoveryDependencies: MediaTaskRecoveryJobDependencies = {
  repository: defaultMediaTaskRecoveryRepository,
  enqueueImage: enqueueImageTask,
  enqueueVideo: enqueueVideoTask,
  reportFailure(error, queue, taskId) {
    logError(error, {
      source: "media-task-mq-recovery",
      queue,
      taskId,
    });
  },
};

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
 * 认领并恢复一批 Adobe 视频任务。
 *
 * @returns 本轮认领、恢复与隔离失败数量。
 */
export async function runMediaTaskQueueRecovery(
  dependencies: MediaTaskRecoveryJobDependencies =
    defaultMediaTaskRecoveryDependencies
) {
  const tasks = await dependencies.repository.scan({
    now: new Date(),
    limit: MEDIA_TASK_RECOVERY_BATCH_LIMIT,
  });
  let enqueued = 0;
  let failed = 0;
  await Promise.all([
    ...tasks.images.map(async (task) => {
      try {
        await dependencies.enqueueImage(task);
        enqueued += 1;
      } catch (error) {
        failed += 1;
        dependencies.reportFailure(error, "image", task.taskId);
      }
    }),
    ...tasks.videos.map(async (task) => {
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
    discovered: tasks.images.length + tasks.videos.length,
    enqueued,
    failed,
  };
}

/**
 * 低频补投媒体 MQ，并继续执行独立的视频回调与输入清理维护。
 *
 * @returns 本轮补投、回调投递和输入清理统计；不直接 claim 或处理媒体生成任务。
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
