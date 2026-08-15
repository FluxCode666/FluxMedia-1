/**
 * 运营 CSV 导出任务认领、续租与 fencing 终态仓储。
 *
 * 使用方：数据库仓储组合入口和导出 worker。认领使用 SKIP LOCKED；续租、完成和
 * 失败都要求 running 状态与 lease token 同时匹配，防止陈旧 worker 发布终态。
 */
import { adminAuditLog, operationsExportTask } from "@repo/database/schema";
import { and, eq, sql } from "drizzle-orm";

import { extractExecuteRows } from "@/server/database-result";
import {
  OPERATIONS_EXPORT_LEASE_MS,
  type OperationsExportTaskRepository,
} from "./export-task-contracts";
import { parseClaimedOperationsExportTaskRow } from "./export-task-parsers";
import {
  changed,
  createOperationsExportAuditValues,
} from "./export-task-repository-helpers";

/** 数据库租约状态机方法集合；由稳定仓储入口组合为完整端口。 */
export const operationsExportTaskLeaseRepository: Pick<
  OperationsExportTaskRepository,
  "claimNext" | "renewLease" | "complete" | "fail"
> = {
  /**
   * 竞争认领最早 queued 或租约已过期的任务。
   *
   * 输入 worker、fencing token 与数据库边界时间；SKIP LOCKED 保证并发 worker 不
   * 重复认领，返回经 Zod 完整校验的冻结任务或 null，脏数据库行会显式抛错。
   */
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
      returning
        task.id,
        task.created_by,
        task.export_type,
        task.query,
        task.time_zone,
        task.epoch_app_date,
        task.epoch_starts_at,
        task.schema_version,
        task.snapshot_at,
        task.high_watermarks,
        task.lease_owner,
        task.lease_token,
        task.attempt_count
    `);
    const raw = extractExecuteRows(result)[0];
    if (!raw) return null;
    return parseClaimedOperationsExportTaskRow(raw);
  },
  /**
   * 仅为仍持有相同 fencing token 的 running 任务续租。
   *
   * 输入任务、lease token 和当前时间，条件更新成功返回 true，否则返回 false；
   * 不会复活终态或已被其它 worker 接管的任务，数据库异常会上抛。
   */
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
  /**
   * 以 fencing CAS 发布对象元数据并完成任务。
   *
   * 输入对象定位、校验和、行字节统计与保留边界；同事务写完成审计，失租返回
   * false 且无副作用，数据库结果不确定时抛错供 worker 按孤儿对象流程处理。
   */
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
        createOperationsExportAuditValues({
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
  /**
   * 以 fencing CAS 把当前 running 任务标记为失败。
   *
   * 输入任务、lease token、稳定错误码与时间；成功时同事务写失败审计并返回 true，
   * 失租或已终态返回 false，数据库异常会上抛。
   */
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
        createOperationsExportAuditValues({
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
};
