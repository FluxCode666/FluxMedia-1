/**
 * 运营 CSV 导出任务幂等创建、冻结快照、容量限制与创建审计仓储。
 *
 * 使用方：数据库仓储组合入口。创建在单个 repeatable-read 事务内按固定锁顺序检查
 * 存储配置、全局和管理员容量，并冻结规范化范围与事实高水位。
 */
import { adminAuditLog, operationsExportTask } from "@repo/database/schema";
import { logError } from "@repo/shared/logger";
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";
import { resolveOperationsDashboardRange } from "@repo/shared/operations-dashboard/range";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { OperationsExportTaskRepository } from "./export-task-contracts";
import { createOperationsExportAuditValues } from "./export-task-repository-helpers";
import { readOperationsExportSnapshot } from "./export-task-snapshot";

/**
 * 识别需要作为运营容量指标留痕的稳定创建拒绝码。
 *
 * @param error 创建事务抛出的未知错误。
 * @returns 已知容量、频率或未就绪错误码；其它错误返回 null。
 * @sideEffects 无；不吞掉原错误，调用方仍须原样上抛。
 */
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

/** 数据库创建方法集合；由稳定仓储入口组合为完整端口。 */
export const operationsExportTaskCreateRepository: Pick<
  OperationsExportTaskRepository,
  "create"
> = {
  /**
   * 按管理员幂等请求创建冻结导出任务并返回持久化记录。
   *
   * 输入包含容量、频率与当前时间边界；事务会串行检查配额、冻结快照并写审计。
   * 重复 clientRequestId 返回原任务，统计起点未就绪或容量超限时抛稳定错误码。
   */
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
                eq(operationsExportTask.clientRequestId, input.clientRequestId)
              ),
            });
          if (existing) return existing;
          const [counts] = await transaction
            .select({
              mine: sql<number>`count(*) filter (where ${operationsExportTask.createdBy} = ${input.createdBy})::int`,
              global: sql<number>`count(*)::int`,
            })
            .from(operationsExportTask)
            .where(inArray(operationsExportTask.status, ["queued", "running"]));
          if (
            (counts?.mine ?? 0) >= input.perAdminLimit ||
            (counts?.global ?? 0) >= input.globalLimit
          ) {
            throw new Error("operations_export_capacity_exceeded");
          }
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
          ) {
            throw new Error("operations_export_rate_limited");
          }
          const snapshot = await readOperationsExportSnapshot(
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
            createOperationsExportAuditValues({
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
            createOperationsExportAuditValues({
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
};
