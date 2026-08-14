/**
 * 运营 CSV 导出七天保留与对象清理执行器。
 *
 * 使用方：operations.expireExports 内部 UOL binding。先让数据库任务过期并拒绝下载，
 * 再幂等删除正式对象、孤儿对象和陈旧 multipart 上传；清理失败不恢复下载权限。
 */
import { logger } from "@repo/shared/logger";

import {
  getOperationsExportStorage,
  type OperationsExportStorage,
  parseOperationsExportObjectKey,
} from "./export-storage";
import {
  databaseOperationsExportTaskRepository,
  OPERATIONS_EXPORT_LEASE_MS,
  type OperationsExportTaskRepository,
} from "./export-task-repository";

const EXPORT_ORPHAN_SCAN_PREFIX = "operations-exports/";
const EXPORT_ORPHAN_SAFETY_MS = OPERATIONS_EXPORT_LEASE_MS;

/** 进程内 opaque cursor；重启后从前缀起点重扫，删除与引用检查均保持幂等。 */
let storageObjectScanCursor: string | null = null;
let multipartUploadScanCursor: string | null = null;

/** 七天清理可替换端口。 */
export type OperationsExportCleanupDependencies = {
  repository: Pick<
    OperationsExportTaskRepository,
    | "expireDue"
    | "markDeleted"
    | "markCleanupFailed"
    | "listOrphans"
    | "markOrphanDeleted"
    | "findReferencedObjectKeys"
    | "findActiveExportLeases"
  >;
  storage: Pick<
    OperationsExportStorage,
    | "bucket"
    | "deleteObject"
    | "listObjects"
    | "listMultipartUploads"
    | "abortMultipartUpload"
  >;
  now(): Date;
};

/** 为 task/lease 组合构造仅在进程内使用的集合键。 */
function exportLeaseKey(input: { taskId: string; leaseToken: string }): string {
  return `${input.taskId}:${input.leaseToken}`;
}

/** 批量查询对象键对应的仍有效租约，避免清理长时间运行的上传。 */
async function findActiveObjectLeaseKeys(
  objectKeys: string[],
  dependencies: OperationsExportCleanupDependencies
): Promise<Set<string>> {
  const parsedObjects = objectKeys.flatMap((key) => {
    const parsed = parseOperationsExportObjectKey(key);
    return parsed ? [parsed] : [];
  });
  const activeLeases = await dependencies.repository.findActiveExportLeases({
    taskIds: [...new Set(parsedObjects.map((object) => object.taskId))],
    now: dependencies.now(),
  });
  return new Set(activeLeases.map(exportLeaseKey));
}

/**
 * 清理一页硬崩溃遗留对象。
 *
 * 只处理早于一个完整租约窗口的对象，并在每页删除前一次性查询数据库引用集合；
 * completed、expired 或其它状态任务只要仍引用对象就永久保留。删除失败时不推进
 * cursor，使下一批优先重试同一页，其余已删除对象按幂等缺失处理。
 */
async function cleanupUnreferencedStoragePage(
  input: { limit: number; olderThan: Date },
  dependencies: OperationsExportCleanupDependencies
): Promise<number> {
  const currentCursor = storageObjectScanCursor;
  try {
    const page = await dependencies.storage.listObjects(
      EXPORT_ORPHAN_SCAN_PREFIX,
      dependencies.storage.bucket,
      { cursor: currentCursor, limit: input.limit }
    );
    const staleObjects = page.objects.filter(
      (object) => object.lastModified < input.olderThan
    );
    const objectKeys = staleObjects.map((object) => object.key);
    const referenced = await dependencies.repository.findReferencedObjectKeys({
      objectBucket: dependencies.storage.bucket,
      objectKeys,
    });
    const activeLeaseKeys = await findActiveObjectLeaseKeys(
      objectKeys,
      dependencies
    );
    let deleted = 0;
    let failed = false;
    for (const object of staleObjects) {
      if (referenced.has(object.key)) continue;
      const parsed = parseOperationsExportObjectKey(object.key);
      if (parsed && activeLeaseKeys.has(exportLeaseKey(parsed))) continue;
      try {
        await dependencies.storage.deleteObject(
          object.key,
          dependencies.storage.bucket
        );
        deleted += 1;
      } catch {
        failed = true;
        logger.warn(
          {
            operation: "operations.expireExports",
            cleanupKind: "unreferenced_object",
            leaseStatus: "item_cleanup_failed",
            errorCode: "orphan_object_delete_failed",
            objectKey: object.key,
          },
          "Operations export orphan object cleanup failed"
        );
      }
    }
    if (!failed) storageObjectScanCursor = page.nextCursor;
    return deleted;
  } catch {
    logger.warn(
      {
        operation: "operations.expireExports",
        leaseStatus: "orphan_scan_failed",
        errorCode: "orphan_scan_failed",
      },
      "Operations export orphan scan failed"
    );
    return 0;
  }
}

/**
 * 清理一页陈旧 S3 multipart 上传；local provider 没有该能力时为空操作。
 *
 * worker 批量排除仍有效的 task/lease，provider 负责分页和 NoSuchUpload 幂等；
 * 失败不推进 cursor，下次 cron 从相同页继续，且不回滚数据库过期边界。
 */
async function cleanupStaleMultipartUploadPage(
  input: { limit: number; olderThan: Date },
  dependencies: OperationsExportCleanupDependencies
): Promise<number> {
  if (
    !dependencies.storage.listMultipartUploads ||
    !dependencies.storage.abortMultipartUpload
  ) {
    return 0;
  }
  try {
    const page = await dependencies.storage.listMultipartUploads(
      EXPORT_ORPHAN_SCAN_PREFIX,
      dependencies.storage.bucket,
      {
        cursor: multipartUploadScanCursor,
        limit: input.limit,
      }
    );
    const staleUploads = page.uploads.filter(
      (upload) => upload.initiatedAt < input.olderThan
    );
    const activeLeaseKeys = await findActiveObjectLeaseKeys(
      staleUploads.map((upload) => upload.key),
      dependencies
    );
    let aborted = 0;
    let failed = false;
    for (const upload of staleUploads) {
      const parsed = parseOperationsExportObjectKey(upload.key);
      if (parsed && activeLeaseKeys.has(exportLeaseKey(parsed))) {
        continue;
      }
      try {
        await dependencies.storage.abortMultipartUpload(
          upload.key,
          dependencies.storage.bucket,
          upload.cleanupToken
        );
        aborted += 1;
      } catch {
        failed = true;
        logger.warn(
          {
            operation: "operations.expireExports",
            cleanupKind: "multipart_upload",
            leaseStatus: "item_cleanup_failed",
            errorCode: "multipart_abort_failed",
            objectKey: upload.key,
          },
          "Operations export multipart item cleanup failed"
        );
      }
    }
    if (!failed) multipartUploadScanCursor = page.nextCursor;
    return aborted;
  } catch {
    logger.warn(
      {
        operation: "operations.expireExports",
        leaseStatus: "multipart_cleanup_failed",
        errorCode: "multipart_cleanup_failed",
      },
      "Operations export multipart cleanup failed"
    );
    return 0;
  }
}

/** 先批量转 expired，再逐对象幂等删除；删除失败不恢复下载权限。 */
export async function expireOperationsExportBatch(
  input: { limit: number },
  dependencies: OperationsExportCleanupDependencies
): Promise<{ processed: number }> {
  const now = dependencies.now();
  const tasks = await dependencies.repository.expireDue({
    now,
    limit: input.limit,
  });
  for (const task of tasks) {
    const startedAt = Date.now();
    try {
      await dependencies.storage.deleteObject(
        task.objectKey,
        task.objectBucket
      );
      await dependencies.repository.markDeleted({
        taskId: task.id,
        objectKey: task.objectKey,
        now: dependencies.now(),
      });
      logger.info(
        {
          operation: "operations.expireExports",
          exportTaskId: task.id,
          leaseStatus: "object_deleted",
          durationMs: Math.max(0, Date.now() - startedAt),
        },
        "Operations export object deleted"
      );
    } catch {
      await dependencies.repository.markCleanupFailed({
        taskId: task.id,
        objectKey: task.objectKey,
        errorCode: "object_delete_failed",
        now: dependencies.now(),
      });
      logger.warn(
        {
          operation: "operations.expireExports",
          exportTaskId: task.id,
          leaseStatus: "cleanup_failed",
          errorCode: "object_delete_failed",
          durationMs: Math.max(0, Date.now() - startedAt),
        },
        "Operations export object cleanup failed"
      );
    }
  }
  const remaining = Math.max(0, input.limit - tasks.length);
  const orphans =
    remaining > 0
      ? await dependencies.repository.listOrphans({ limit: remaining })
      : [];
  for (const orphan of orphans) {
    try {
      await dependencies.storage.deleteObject(
        orphan.objectKey,
        orphan.objectBucket
      );
      await dependencies.repository.markOrphanDeleted({
        auditId: orphan.auditId,
        taskId: orphan.taskId,
        objectKey: orphan.objectKey,
        now: dependencies.now(),
      });
    } catch {
      logger.warn(
        {
          operation: "operations.expireExports",
          cleanupKind: "recorded_orphan",
          leaseStatus: "item_cleanup_failed",
          errorCode: "recorded_orphan_cleanup_failed",
          objectKey: orphan.objectKey,
        },
        "Operations export recorded orphan cleanup failed"
      );
    }
  }
  const olderThan = new Date(now.getTime() - EXPORT_ORPHAN_SAFETY_MS);
  const deletedOrphans = await cleanupUnreferencedStoragePage(
    { limit: input.limit, olderThan },
    dependencies
  );
  const abortedUploads = await cleanupStaleMultipartUploadPage(
    { limit: input.limit, olderThan },
    dependencies
  );
  return {
    processed: tasks.length + orphans.length + deletedOrphans + abortedUploads,
  };
}

/** 生产清理任务读取单一存储快照并执行数据库过期边界。 */
export async function expireDatabaseOperationsExports(
  limit: number
): Promise<{ processed: number }> {
  const storage = await getOperationsExportStorage();
  return expireOperationsExportBatch(
    { limit },
    {
      repository: databaseOperationsExportTaskRepository,
      storage,
      now: () => new Date(),
    }
  );
}
