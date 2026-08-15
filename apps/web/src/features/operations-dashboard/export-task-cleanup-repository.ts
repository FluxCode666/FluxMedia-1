/**
 * 运营 CSV 导出正式对象、孤儿对象与过期任务清理仓储。
 *
 * 使用方：数据库仓储组合入口和导出清理器。该模块只管理清理候选、引用保护、
 * 删除水位与失败轮转；实际对象删除由存储适配器负责。
 */
import { adminAuditLog, operationsExportTask } from "@repo/database/schema";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import type { OperationsExportTaskRepository } from "./export-task-contracts";
import { createOperationsExportAuditValues } from "./export-task-repository-helpers";

/** 数据库清理状态方法集合；由稳定仓储入口组合为完整端口。 */
export const operationsExportTaskCleanupRepository: Pick<
  OperationsExportTaskRepository,
  | "recordOrphan"
  | "listOrphans"
  | "markOrphanDeleted"
  | "markOrphanCleanupFailed"
  | "findReferencedObjectKeys"
  | "findActiveExportLeases"
  | "expireDue"
  | "markDeleted"
  | "markCleanupFailed"
> = {
  /**
   * 登记可能未被任务终态引用的上传对象。
   *
   * 输入任务、lease token、对象定位与错误码，仅写不含文件内容的审计候选；写入
   * 失败会上抛，后续清理由 listOrphans 按引用关系再次确认。
   */
  async recordOrphan(input) {
    const { db } = await import("@repo/database");
    await db.insert(adminAuditLog).values(
      createOperationsExportAuditValues({
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
  /**
   * 按审计创建顺序列出仍未完成清理且无任务引用的孤儿对象。
   *
   * 输入页大小，返回最小清理定位；无写副作用，原始 SQL 行整体经 Zod 校验，
   * 数据异常或数据库失败会显式上抛。
   */
  async listOrphans(input) {
    const { db } = await import("@repo/database");
    const result = await db.execute(sql`
      select
        orphan.id as audit_id,
        orphan.after->>'taskId' as task_id,
        orphan.metadata->>'objectBucket' as object_bucket,
        orphan.metadata->>'objectKey' as object_key
      from admin_audit_log as orphan
      left join lateral (
        select failed.created_at
        from admin_audit_log as failed
        where failed.action = 'operations.exportOrphanCleanupFailed'
          and failed.metadata->>'orphanAuditId' = orphan.id
        order by failed.created_at desc, failed.id desc
        limit 1
      ) as latest_failure on true
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
      order by latest_failure.created_at nulls first,
        orphan.created_at,
        orphan.id
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
  /**
   * 为成功删除的审计孤儿写入幂等完成水位。
   *
   * 输入原审计、任务、对象键与时间，追加完成审计而不修改任务；数据库失败上抛，
   * 未写成功时下一清理批仍会重试该对象。
   */
  async markOrphanDeleted(input) {
    const { db } = await import("@repo/database");
    await db.insert(adminAuditLog).values(
      createOperationsExportAuditValues({
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
  /**
   * 记录孤儿对象清理失败水位，让永久坏项在后续批次中轮转到队尾。
   *
   * @param input 原孤儿审计、对象键、稳定错误码和失败时间。
   * @returns 无。
   * @sideEffects 追加不含对象内容的管理员审计行；数据库失败会上抛。
   */
  async markOrphanCleanupFailed(input) {
    const { db } = await import("@repo/database");
    await db.insert(adminAuditLog).values(
      createOperationsExportAuditValues({
        adminUserId: null,
        action: "operations.exportOrphanCleanupFailed",
        taskId: input.taskId,
        metadata: {
          orphanAuditId: input.auditId,
          objectKey: input.objectKey,
          errorCode: input.errorCode,
        },
        now: input.now,
      })
    );
  },
  /**
   * 批量查询指定 bucket 中仍被任意导出任务引用的对象键。
   *
   * 空键集合直接返回空 Set；其余输入只读数据库并返回引用集合，故清理方必须保留
   * 所有命中项，查询失败会上抛且不得推进扫描游标。
   */
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
  /**
   * 批量查询任务在给定时间仍有效的运行租约。
   *
   * 空任务集合直接返回空数组；其余输入返回 taskId 与非空 lease token，供对象和
   * multipart 清理排除活跃上传，读取失败会上抛并停止本页清理。
   */
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
      row.leaseToken ? [{ taskId: row.taskId, leaseToken: row.leaseToken }] : []
    );
  },
  /**
   * 竞争过期到期任务并保持删除失败任务可再次认领。
   *
   * 输入数据库时间与批量上限；SKIP LOCKED 把 completed 到期项或未删除 expired
   * 项统一标记为 expired，返回对象定位。并发批次不会认领同一行，异常直接上抛。
   */
  async expireDue(input) {
    const { db } = await import("@repo/database");
    const rows = await db.execute(sql`
      with due as (
        select id from operations_export_task
        where (status = 'completed' and expires_at <= ${input.now})
          or (status = 'expired' and object_deleted_at is null)
        order by (cleanup_error_code is not null),
          case
            when cleanup_error_code is null then expires_at
            else updated_at
          end,
          id
        for update skip locked limit ${input.limit}
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
  /**
   * 条件标记 expired 任务对象已经删除。
   *
   * 输入任务、对象键与完成时间，只更新仍未删除且对象键匹配的行并清除清理错误；
   * 条件不匹配时为空操作，数据库异常会上抛。
   */
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
  /**
   * 条件记录 expired 对象本轮清理失败。
   *
   * 输入任务、对象键、稳定错误码与时间，只更新仍未删除且对象键匹配的行；不会
   * 恢复下载权限，条件不匹配为空操作，数据库异常会上抛供调度层观测。
   */
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
