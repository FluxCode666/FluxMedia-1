import { processExpiredBatches } from "@repo/shared/credits/core";
import {
  destroyExpiredGenerationPhotos,
  destroyGenerationPhotosByMaxCount,
  expireStalePendingGenerations,
} from "@repo/shared/generation-maintenance";
import { getRuntimeSettingSelect } from "@repo/shared/system-settings";
import {
  buildCreditsExpireResponse,
  summarizeExpiredPendingGenerations,
} from "@/server/scheduled-jobs-response";

/**
 * 单次图像维护 cron 扫描的最大处理行数。
 * 同时作为超时 pending 过期与超期成品图销毁的批量上限，避免单次任务无界扫描。
 */
const IMAGE_MAINTENANCE_BATCH_LIMIT = 500;

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
