/**
 * 运营 CSV 导出任务数据库 JSON 与认领行解析器。
 *
 * 使用方：PostgreSQL 仓储、导出 worker 与冻结快照读取。所有数据库 JSON 都在进入
 * 业务层前经过严格 Zod 校验，避免类型断言掩盖脏数据。
 */
import { operationsDashboardQueryInputSchema } from "@repo/shared/operations-dashboard/contracts";
import { z } from "zod";

import type { OperationsDetailHighWatermarks } from "./detail-repository";
import type { ClaimedOperationsExportTask } from "./export-task-contracts";

export const operationsExportTypeSchema = z.enum([
  "user_growth",
  "commercialization",
  "content_production",
]);

export const operationsExportHighWatermarksSchema = z
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

const claimedOperationsExportTaskRowSchema = z
  .object({
    id: z.string(),
    created_by: z.string(),
    export_type: operationsExportTypeSchema,
    query: operationsDashboardQueryInputSchema,
    time_zone: z.string(),
    epoch_app_date: z.string(),
    epoch_starts_at: z.coerce.date(),
    schema_version: z.number().int(),
    snapshot_at: z.coerce.date(),
    high_watermarks: operationsExportHighWatermarksSchema,
    lease_owner: z.string(),
    lease_token: z.string(),
    attempt_count: z.coerce.number().int(),
  })
  .strict();

/**
 * 校验 worker 将要读取的冻结事实上界。
 *
 * @param value 数据库 JSON 或其它未知输入。
 * @returns 字段完整且保留 PostgreSQL 六位微秒字符串的高水位。
 * @throws ZodError 当字段缺失、多余、时间格式或类型非法时抛出；无副作用。
 */
export function parseOperationsExportHighWatermarks(
  value: unknown
): OperationsDetailHighWatermarks {
  return operationsExportHighWatermarksSchema.parse(value);
}

/**
 * 把未知 PostgreSQL 认领行解析为 worker 契约。
 *
 * @param value claim SQL 返回的完整单行未知值。
 * @returns 已校验 query、高水位并规范化日期的冻结任务。
 * @throws ZodError 当字段缺失、多余或非法时抛出；不会读写数据库或修改输入。
 */
export function parseClaimedOperationsExportTaskRow(
  value: unknown
): ClaimedOperationsExportTask {
  const row = claimedOperationsExportTaskRowSchema.parse(value);
  return {
    id: row.id,
    createdBy: row.created_by,
    exportType: row.export_type,
    query: row.query,
    timeZone: row.time_zone,
    epochAppDate: row.epoch_app_date,
    epochStartsAt: row.epoch_starts_at,
    schemaVersion: row.schema_version,
    snapshotAt: row.snapshot_at,
    highWatermarks: row.high_watermarks,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
  };
}
