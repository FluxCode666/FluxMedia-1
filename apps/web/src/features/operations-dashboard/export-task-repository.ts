/**
 * 运营 CSV 导出任务 PostgreSQL 仓储。
 *
 * 使用方：导出 service、worker、受控下载与保留任务。所有状态迁移都通过条件更新
 * 收敛；认领使用 SKIP LOCKED，续租和终态必须匹配 lease token，审计与创建同事务。
 */
import { randomUUID } from "node:crypto";

import {
  adminAuditLog,
  type OperationsExportTask,
  operationsExportTask,
} from "@repo/database/schema";
import { logError } from "@repo/shared/logger";
import type {
  OperationsDashboardQueryInput,
  OperationsExportType,
} from "@repo/shared/operations-dashboard/contracts";
import { resolveOperationsDashboardRange } from "@repo/shared/operations-dashboard/range";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import type { OperationsDetailHighWatermarks } from "./detail-repository";

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

/** 仓储对 service/worker 暴露的封闭端口。 */
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

const exportTypeSchema = z.enum([
  "user_growth",
  "commercialization",
  "content_production",
]);
const highWatermarksSchema = z
  .object({
    users: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        id: z.string(),
      })
      .nullable(),
    webVisits: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        userId: z.string(),
        appDate: z.string(),
      })
      .nullable(),
    outputs: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        outputKind: z.string(),
        sourceTaskId: z.string(),
      })
      .nullable(),
    paymentOrders: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        id: z.string(),
      })
      .nullable(),
    paymentLifecycle: z
      .object({
        recordedAt: z.string().datetime({ offset: true }),
        id: z.string(),
      })
      .nullable(),
    creditContributions: z
      .object({
        projectedAt: z.string().datetime({ offset: true }),
        transactionId: z.string(),
      })
      .nullable(),
  })
  .strict();

/** 校验冻结 JSON，并保留数据库生成的六位微秒时间字符串。 */
export function parseOperationsExportHighWatermarks(
  value: unknown
): OperationsDetailHighWatermarks {
  const parsed = highWatermarksSchema.parse(value);
  return parsed;
}

/** 对未知 Drizzle 返回安全读取布尔条件更新结果。 */
function changed(result: unknown): boolean {
  return extractExecuteRows(result).length === 1;
}

/** 生成不含筛选敏感内容的管理员审计行。 */
function auditValues(input: {
  adminUserId: string | null;
  action: string;
  taskId: string;
  metadata: Record<string, unknown>;
  now: Date;
}) {
  return {
    id: randomUUID(),
    adminUserId: input.adminUserId,
    targetUserId: null,
    action: input.action,
    reason: "运营数据导出",
    before: null,
    after: { taskId: input.taskId },
    metadata: input.metadata,
    createdAt: input.now,
  };
}

/** 只识别需要作为运营容量指标留痕的稳定创建拒绝码。 */
function getCreateRejectionCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return [
    "operations_export_capacity_exceeded",
    "operations_export_rate_limited",
    "operations_export_not_ready",
  ].includes(error.message)
    ? error.message
    : null;
}

/** 在同一事务中捕获数据库时钟、epoch 与全部事实 append 高水位。 */
async function readSnapshot(
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>
): Promise<OperationsExportSnapshot> {
  const row = z
    .object({
      snapshot_at: z.coerce.date(),
      epoch_app_date: z.string().nullable(),
      epoch_starts_at: z.coerce.date().nullable(),
      high_watermarks: highWatermarksSchema,
    })
    .parse(
      extractExecuteRows(
        await execute(sql`
    select
      transaction_timestamp() as snapshot_at,
      (select app_date from operations_analytics_epoch where id = 1) as epoch_app_date,
      (select starts_at from operations_analytics_epoch where id = 1) as epoch_starts_at,
      json_build_object(
        'users', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', id) from "user" order by created_at desc, id desc limit 1),
        'webVisits', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'userId', user_id, 'appDate', app_date) from user_web_visit order by created_at desc, user_id desc, app_date desc limit 1),
        'outputs', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'outputKind', output_kind, 'sourceTaskId', source_task_id) from user_output_usage_event order by created_at desc, output_kind desc, source_task_id desc limit 1),
        'paymentOrders', (select json_build_object('createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', id) from payment_order order by created_at desc, id desc limit 1),
        'paymentLifecycle', (select json_build_object('recordedAt', to_char(recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', id) from payment_lifecycle_event order by recorded_at desc, id desc limit 1),
        'creditContributions', (select json_build_object('projectedAt', to_char(projected_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'transactionId', transaction_id) from credit_usage_projection_entry order by projected_at desc, transaction_id desc limit 1)
      ) as high_watermarks
  `)
      )[0]
    );
  if ((row.epoch_app_date === null) !== (row.epoch_starts_at === null))
    throw new Error("运营统计起点数据不完整");
  return {
    snapshotAt: row.snapshot_at,
    epoch:
      row.epoch_app_date && row.epoch_starts_at
        ? { appDate: row.epoch_app_date, startsAt: row.epoch_starts_at }
        : null,
    highWatermarks: row.high_watermarks,
  };
}

/** 数据库实现延迟导入连接，使 DB-free 测试可替换仓储。 */
export const databaseOperationsExportTaskRepository: OperationsExportTaskRepository =
  {
    async create(input) {
      const { db } = await import("@repo/database");
      try {
        return await db.transaction(
          async (transaction) => {
            // 与 system-settings 的存储配置更新共用同一事务锁，避免“配置检查无任务”
            // 与导出任务插入交错，导致任务引用已经切换的 provider。
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtext('operations-export:storage-config'))`
            );
            // WHY：全局锁保证不同管理员并发创建时也不会越过全局 active 上限；
            // 所有事务再按同一顺序获取管理员锁，避免锁顺序反转。
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtext('operations-export:global'))`
            );
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`operations-export:${input.createdBy}`}))`
            );
            const existing =
              await transaction.query.operationsExportTask.findFirst({
                where: and(
                  eq(operationsExportTask.createdBy, input.createdBy),
                  eq(
                    operationsExportTask.clientRequestId,
                    input.clientRequestId
                  )
                ),
              });
            if (existing) return existing;
            const [counts] = await transaction
              .select({
                mine: sql<number>`count(*) filter (where ${operationsExportTask.createdBy} = ${input.createdBy})::int`,
                global: sql<number>`count(*)::int`,
              })
              .from(operationsExportTask)
              .where(
                inArray(operationsExportTask.status, ["queued", "running"])
              );
            if (
              (counts?.mine ?? 0) >= input.perAdminLimit ||
              (counts?.global ?? 0) >= input.globalLimit
            )
              throw new Error("operations_export_capacity_exceeded");
            const [latest] = await transaction
              .select({ createdAt: operationsExportTask.createdAt })
              .from(operationsExportTask)
              .where(eq(operationsExportTask.createdBy, input.createdBy))
              .orderBy(desc(operationsExportTask.createdAt))
              .limit(1);
            if (
              latest &&
              input.now.getTime() - latest.createdAt.getTime() <
                input.minCreateIntervalMs
            )
              throw new Error("operations_export_rate_limited");
            const snapshot = await readSnapshot(
              transaction.execute.bind(transaction)
            );
            if (!snapshot.epoch) throw new Error("operations_export_not_ready");
            const range = resolveOperationsDashboardRange(input.query, {
              timeZone: input.timeZone,
              asOf: snapshot.snapshotAt,
              epochDate: snapshot.epoch.appDate,
            });
            const frozenQuery: OperationsDashboardQueryInput = {
              granularity: input.query.granularity,
              range: { kind: "custom", from: range.from, to: range.to },
            };
            const [created] = await transaction
              .insert(operationsExportTask)
              .values({
                id: input.taskId,
                createdBy: input.createdBy,
                clientRequestId: input.clientRequestId,
                exportType: input.exportType,
                status: "queued",
                query: frozenQuery,
                timeZone: input.timeZone,
                epochAppDate: snapshot.epoch.appDate,
                epochStartsAt: snapshot.epoch.startsAt,
                schemaVersion: 1,
                snapshotAt: snapshot.snapshotAt,
                highWatermarks: snapshot.highWatermarks,
                retryOfTaskId: input.retryOfTaskId,
                createdAt: input.now,
                updatedAt: input.now,
              })
              .returning();
            if (!created) throw new Error("operations_export_create_failed");
            await transaction.insert(adminAuditLog).values(
              auditValues({
                adminUserId: input.createdBy,
                action: input.retryOfTaskId
                  ? "operations.retryExport"
                  : "operations.createExport",
                taskId: created.id,
                metadata: {
                  exportType: input.exportType,
                  query: frozenQuery,
                  retryOfTaskId: input.retryOfTaskId,
                  snapshotAt: snapshot.snapshotAt.toISOString(),
                },
                now: input.now,
              })
            );
            return created;
          },
          { isolationLevel: "repeatable read" }
        );
      } catch (error) {
        const rejectionCode = getCreateRejectionCode(error);
        if (rejectionCode) {
          try {
            await db.insert(adminAuditLog).values(
              auditValues({
                adminUserId: input.createdBy,
                action: input.retryOfTaskId
                  ? "operations.rejectRetryExport"
                  : "operations.rejectCreateExport",
                taskId: input.taskId,
                metadata: {
                  exportType: input.exportType,
                  query: input.query,
                  retryOfTaskId: input.retryOfTaskId,
                  result: rejectionCode,
                },
                now: input.now,
              })
            );
          } catch (auditError) {
            logError(auditError, {
              source: "operations-export-rejection-audit",
              adminUserId: input.createdBy,
              rejectionCode,
            });
          }
        }
        throw error;
      }
    },
    async list(input) {
      const { db } = await import("@repo/database");
      return db
        .select()
        .from(operationsExportTask)
        .where(
          and(
            eq(operationsExportTask.createdBy, input.createdBy),
            input.cursor
              ? or(
                  lt(operationsExportTask.createdAt, input.cursor.createdAt),
                  and(
                    eq(operationsExportTask.createdAt, input.cursor.createdAt),
                    lt(operationsExportTask.id, input.cursor.id)
                  )
                )
              : undefined
          )
        )
        .orderBy(
          desc(operationsExportTask.createdAt),
          desc(operationsExportTask.id)
        )
        .limit(input.limit);
    },
    async findOwned(taskId, createdBy) {
      const { db } = await import("@repo/database");
      return (
        (await db.query.operationsExportTask.findFirst({
          where: and(
            eq(operationsExportTask.id, taskId),
            eq(operationsExportTask.createdBy, createdBy)
          ),
        })) ?? null
      );
    },
    async findDownloadable(taskId, createdBy, now) {
      const task = await this.findOwned(taskId, createdBy);
      if (
        task?.status !== "completed" ||
        !task.objectBucket ||
        !task.objectKey ||
        !task.expiresAt ||
        task.expiresAt <= now
      )
        return null;
      return {
        id: task.id,
        createdBy: task.createdBy,
        status: "completed",
        objectBucket: task.objectBucket,
        objectKey: task.objectKey,
        expiresAt: task.expiresAt,
        exportType: exportTypeSchema.parse(task.exportType),
      };
    },
    async recordDownload(input) {
      const { db } = await import("@repo/database");
      await db.insert(adminAuditLog).values(
        auditValues({
          adminUserId: input.createdBy,
          action: "operations.downloadExport",
          taskId: input.taskId,
          metadata: { mode: input.mode, result: input.result },
          now: input.now,
        })
      );
    },
    async claimNext(input) {
      const { db } = await import("@repo/database");
      const result = await db.execute(sql`
      with candidate as (
        select id
        from operations_export_task
        where status = 'queued'
          or (status = 'running' and lease_expires_at <= ${input.now})
        order by created_at, id
        for update skip locked
        limit 1
      )
      update operations_export_task as task
      set status = 'running', lease_owner = ${input.workerId}, lease_token = ${input.leaseToken}, lease_expires_at = ${new Date(input.now.getTime() + OPERATIONS_EXPORT_LEASE_MS)}, attempt_count = attempt_count + 1, error_code = null, updated_at = ${input.now}
      from candidate where task.id = candidate.id
      returning task.*
    `);
      const raw = extractExecuteRows(result)[0] as
        | Record<string, unknown>
        | undefined;
      if (!raw) return null;
      return {
        id: z.string().parse(raw.id),
        createdBy: z.string().parse(raw.created_by),
        exportType: exportTypeSchema.parse(raw.export_type),
        query: raw.query as OperationsDashboardQueryInput,
        timeZone: z.string().parse(raw.time_zone),
        epochAppDate: z.string().parse(raw.epoch_app_date),
        epochStartsAt: z.coerce.date().parse(raw.epoch_starts_at),
        schemaVersion: z.number().int().parse(raw.schema_version),
        snapshotAt: z.coerce.date().parse(raw.snapshot_at),
        highWatermarks: highWatermarksSchema.parse(raw.high_watermarks),
        leaseOwner: z.string().parse(raw.lease_owner),
        leaseToken: z.string().parse(raw.lease_token),
        attemptCount: z.coerce.number().int().parse(raw.attempt_count),
      };
    },
    async renewLease(input) {
      const { db } = await import("@repo/database");
      return changed(
        await db
          .update(operationsExportTask)
          .set({
            leaseExpiresAt: new Date(
              input.now.getTime() + OPERATIONS_EXPORT_LEASE_MS
            ),
            updatedAt: input.now,
          })
          .where(
            and(
              eq(operationsExportTask.id, input.taskId),
              eq(operationsExportTask.status, "running"),
              eq(operationsExportTask.leaseToken, input.leaseToken)
            )
          )
          .returning({ id: operationsExportTask.id })
      );
    },
    async complete(input) {
      const { db } = await import("@repo/database");
      return db.transaction(async (transaction) => {
        const [task] = await transaction
          .update(operationsExportTask)
          .set({
            status: "completed",
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            objectBucket: input.objectBucket,
            objectKey: input.objectKey,
            checksumSha256: input.checksumSha256,
            rowCount: input.rowCount,
            byteCount: input.byteCount,
            completedAt: input.completedAt,
            expiresAt: input.expiresAt,
            updatedAt: input.completedAt,
          })
          .where(
            and(
              eq(operationsExportTask.id, input.taskId),
              eq(operationsExportTask.status, "running"),
              eq(operationsExportTask.leaseToken, input.leaseToken)
            )
          )
          .returning();
        if (!task) return false;
        await transaction.insert(adminAuditLog).values(
          auditValues({
            adminUserId: task.createdBy,
            action: "operations.completeExport",
            taskId: task.id,
            metadata: {
              rowCount: input.rowCount,
              byteCount: input.byteCount,
              checksumSha256: input.checksumSha256,
            },
            now: input.completedAt,
          })
        );
        return true;
      });
    },
    async fail(input) {
      const { db } = await import("@repo/database");
      return db.transaction(async (transaction) => {
        const [task] = await transaction
          .update(operationsExportTask)
          .set({
            status: "failed",
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            errorCode: input.errorCode,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(operationsExportTask.id, input.taskId),
              eq(operationsExportTask.status, "running"),
              eq(operationsExportTask.leaseToken, input.leaseToken)
            )
          )
          .returning({
            id: operationsExportTask.id,
            createdBy: operationsExportTask.createdBy,
          });
        if (!task) return false;
        await transaction.insert(adminAuditLog).values(
          auditValues({
            adminUserId: task.createdBy,
            action: "operations.failExport",
            taskId: task.id,
            metadata: { errorCode: input.errorCode },
            now: input.now,
          })
        );
        return true;
      });
    },
    async recordOrphan(input) {
      const { db } = await import("@repo/database");
      await db.insert(adminAuditLog).values(
        auditValues({
          adminUserId: null,
          action: "operations.exportOrphan",
          taskId: input.taskId,
          metadata: {
            leaseToken: input.leaseToken,
            objectBucket: input.objectBucket,
            objectKey: input.objectKey,
            errorCode: input.errorCode,
          },
          now: input.now,
        })
      );
    },
    async listOrphans(input) {
      const { db } = await import("@repo/database");
      const result = await db.execute(sql`
      select
        orphan.id as audit_id,
        orphan.after->>'taskId' as task_id,
        orphan.metadata->>'objectBucket' as object_bucket,
        orphan.metadata->>'objectKey' as object_key
      from admin_audit_log as orphan
      where orphan.action = 'operations.exportOrphan'
        and not exists (
          select 1
          from operations_export_task as referenced_task
          where referenced_task.object_bucket = orphan.metadata->>'objectBucket'
            and referenced_task.object_key = orphan.metadata->>'objectKey'
            and referenced_task.object_deleted_at is null
        )
        and not exists (
          select 1
          from admin_audit_log as cleaned
          where cleaned.action = 'operations.exportOrphanDeleted'
            and cleaned.metadata->>'orphanAuditId' = orphan.id
        )
      order by orphan.created_at, orphan.id
      limit ${input.limit}
    `);
      return z
        .array(
          z.object({
            audit_id: z.string(),
            task_id: z.string(),
            object_bucket: z.string(),
            object_key: z.string(),
          })
        )
        .parse(extractExecuteRows(result))
        .map((row) => ({
          auditId: row.audit_id,
          taskId: row.task_id,
          objectBucket: row.object_bucket,
          objectKey: row.object_key,
        }));
    },
    async markOrphanDeleted(input) {
      const { db } = await import("@repo/database");
      await db.insert(adminAuditLog).values(
        auditValues({
          adminUserId: null,
          action: "operations.exportOrphanDeleted",
          taskId: input.taskId,
          metadata: {
            orphanAuditId: input.auditId,
            objectKey: input.objectKey,
          },
          now: input.now,
        })
      );
    },
    async findReferencedObjectKeys(input) {
      if (input.objectKeys.length === 0) return new Set();
      const { db } = await import("@repo/database");
      const rows = await db
        .select({ objectKey: operationsExportTask.objectKey })
        .from(operationsExportTask)
        .where(
          and(
            eq(operationsExportTask.objectBucket, input.objectBucket),
            inArray(operationsExportTask.objectKey, input.objectKeys)
          )
        );
      return new Set(
        rows.flatMap((row) => (row.objectKey ? [row.objectKey] : []))
      );
    },
    async findActiveExportLeases(input) {
      if (input.taskIds.length === 0) return [];
      const { db } = await import("@repo/database");
      const rows = await db
        .select({
          taskId: operationsExportTask.id,
          leaseToken: operationsExportTask.leaseToken,
        })
        .from(operationsExportTask)
        .where(
          and(
            inArray(operationsExportTask.id, input.taskIds),
            eq(operationsExportTask.status, "running"),
            gt(operationsExportTask.leaseExpiresAt, input.now),
            isNotNull(operationsExportTask.leaseToken)
          )
        );
      return rows.flatMap((row) =>
        row.leaseToken
          ? [{ taskId: row.taskId, leaseToken: row.leaseToken }]
          : []
      );
    },
    async expireDue(input) {
      const { db } = await import("@repo/database");
      const rows = await db.execute(sql`
      with due as (
        select id from operations_export_task
        where (status = 'completed' and expires_at <= ${input.now})
          or (status = 'expired' and object_deleted_at is null)
        order by expires_at, id for update skip locked limit ${input.limit}
      )
      update operations_export_task as task set status = 'expired', updated_at = ${input.now}
      from due where task.id = due.id
      returning task.id, task.object_bucket, task.object_key
    `);
      return z
        .array(
          z.object({
            id: z.string(),
            object_bucket: z.string(),
            object_key: z.string(),
          })
        )
        .parse(extractExecuteRows(rows))
        .map((row) => ({
          id: row.id,
          objectBucket: row.object_bucket,
          objectKey: row.object_key,
        }));
    },
    async markDeleted(input) {
      const { db } = await import("@repo/database");
      await db
        .update(operationsExportTask)
        .set({
          objectDeletedAt: input.now,
          cleanupErrorCode: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(operationsExportTask.id, input.taskId),
            eq(operationsExportTask.status, "expired"),
            eq(operationsExportTask.objectKey, input.objectKey),
            isNull(operationsExportTask.objectDeletedAt)
          )
        );
    },
    async markCleanupFailed(input) {
      const { db } = await import("@repo/database");
      await db
        .update(operationsExportTask)
        .set({ cleanupErrorCode: input.errorCode, updatedAt: input.now })
        .where(
          and(
            eq(operationsExportTask.id, input.taskId),
            eq(operationsExportTask.status, "expired"),
            eq(operationsExportTask.objectKey, input.objectKey),
            isNull(operationsExportTask.objectDeletedAt)
          )
        );
    },
  };
