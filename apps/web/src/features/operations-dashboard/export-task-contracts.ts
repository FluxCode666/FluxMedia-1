/**
 * 运营 CSV 导出任务仓储契约与稳定时间常量。
 *
 * 使用方：导出 service、worker、清理器与 PostgreSQL 仓储实现。这里只描述端口、
 * 冻结任务和对象定位，不包含数据库连接、SQL 或状态迁移副作用。
 */
import type { OperationsExportTask } from "@repo/database/schema";
import type {
  OperationsDashboardQueryInput,
  OperationsExportType,
} from "@repo/shared/operations-dashboard/contracts";

export const OPERATIONS_EXPORT_LEASE_MS = 2 * 60 * 1000;
export const OPERATIONS_EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 创建任务时冻结并存入 JSON 的稳定事实上界。 */
export type StoredOperationsExportHighWatermarks = {
  users: { createdAt: string; id: string } | null;
  webVisits: { createdAt: string; userId: string; appDate: string } | null;
  outputs: {
    createdAt: string;
    outputKind: string;
    sourceTaskId: string;
  } | null;
  paymentOrders: { createdAt: string; id: string } | null;
  paymentLifecycle: { recordedAt: string; id: string } | null;
  creditContributions: { projectedAt: string; transactionId: string } | null;
};

/** worker 认领后可消费的冻结任务。 */
export type ClaimedOperationsExportTask = {
  id: string;
  createdBy: string;
  exportType: OperationsExportType;
  query: OperationsDashboardQueryInput;
  timeZone: string;
  epochAppDate: string;
  epochStartsAt: Date;
  schemaVersion: number;
  snapshotAt: Date;
  highWatermarks: StoredOperationsExportHighWatermarks;
  leaseOwner: string;
  leaseToken: string;
  attemptCount: number;
};

/** 下载路由需要、但绝不穿过 UOL 输出的对象定位。 */
export type DownloadableOperationsExportTask = {
  id: string;
  createdBy: string;
  status: "completed";
  objectBucket: string;
  objectKey: string;
  expiresAt: Date;
  exportType: OperationsExportType;
};

/** 创建事务读取的冻结头。 */
export type OperationsExportSnapshot = {
  snapshotAt: Date;
  epoch: { appDate: string; startsAt: Date } | null;
  highWatermarks: StoredOperationsExportHighWatermarks;
};

/** 仓储对 service、worker 和清理器暴露的封闭端口。 */
export interface OperationsExportTaskRepository {
  create(input: {
    taskId: string;
    createdBy: string;
    clientRequestId: string;
    exportType: OperationsExportType;
    query: OperationsDashboardQueryInput;
    timeZone: string;
    retryOfTaskId: string | null;
    now: Date;
    perAdminLimit: number;
    globalLimit: number;
    minCreateIntervalMs: number;
  }): Promise<OperationsExportTask>;
  list(input: {
    createdBy: string;
    cursor: { createdAt: Date; id: string } | null;
    limit: number;
  }): Promise<OperationsExportTask[]>;
  findOwned(
    taskId: string,
    createdBy: string
  ): Promise<OperationsExportTask | null>;
  findDownloadable(
    taskId: string,
    createdBy: string,
    now: Date
  ): Promise<DownloadableOperationsExportTask | null>;
  recordDownload(input: {
    taskId: string;
    createdBy: string;
    mode: "redirect" | "stream";
    result: string;
    now: Date;
  }): Promise<void>;
  claimNext(input: {
    workerId: string;
    leaseToken: string;
    now: Date;
  }): Promise<ClaimedOperationsExportTask | null>;
  renewLease(input: {
    taskId: string;
    leaseToken: string;
    now: Date;
  }): Promise<boolean>;
  complete(input: {
    taskId: string;
    leaseToken: string;
    objectBucket: string;
    objectKey: string;
    checksumSha256: string;
    rowCount: number;
    byteCount: number;
    completedAt: Date;
    expiresAt: Date;
  }): Promise<boolean>;
  fail(input: {
    taskId: string;
    leaseToken: string;
    errorCode: string;
    now: Date;
  }): Promise<boolean>;
  recordOrphan(input: {
    taskId: string;
    leaseToken: string;
    objectBucket: string;
    objectKey: string;
    errorCode: string;
    now: Date;
  }): Promise<void>;
  listOrphans(input: { limit: number }): Promise<
    Array<{
      auditId: string;
      taskId: string;
      objectBucket: string;
      objectKey: string;
    }>
  >;
  markOrphanDeleted(input: {
    auditId: string;
    taskId: string;
    objectKey: string;
    now: Date;
  }): Promise<void>;
  markOrphanCleanupFailed(input: {
    auditId: string;
    taskId: string;
    objectKey: string;
    errorCode: string;
    now: Date;
  }): Promise<void>;
  findReferencedObjectKeys(input: {
    objectBucket: string;
    objectKeys: string[];
  }): Promise<Set<string>>;
  findActiveExportLeases(input: {
    taskIds: string[];
    now: Date;
  }): Promise<Array<{ taskId: string; leaseToken: string }>>;
  expireDue(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ id: string; objectBucket: string; objectKey: string }>>;
  markDeleted(input: {
    taskId: string;
    objectKey: string;
    now: Date;
  }): Promise<void>;
  markCleanupFailed(input: {
    taskId: string;
    objectKey: string;
    errorCode: string;
    now: Date;
  }): Promise<void>;
}
