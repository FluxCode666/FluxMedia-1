/**
 * 运营 CSV 导出任务列表、所有权、下载定位与下载审计仓储。
 *
 * 使用方：数据库仓储组合入口。所有读取都绑定管理员所有权，下载审计只保存稳定
 * 结果，不暴露对象内容或查询筛选细节。
 */
import { adminAuditLog, operationsExportTask } from "@repo/database/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";

import type { OperationsExportTaskRepository } from "./export-task-contracts";
import { operationsExportTypeSchema } from "./export-task-parsers";
import { createOperationsExportAuditValues } from "./export-task-repository-helpers";

/** 数据库读取与下载审计方法集合；由稳定仓储入口组合为完整端口。 */
export const operationsExportTaskReadRepository: Pick<
  OperationsExportTaskRepository,
  "list" | "findOwned" | "findDownloadable" | "recordDownload"
> = {
  /**
   * 按管理员和 keyset 游标倒序列出任务。
   *
   * 输入限制所有权、游标与页大小，返回当前页且不写数据库；数据库读取失败会原样
   * 上抛，调用方不能用 offset 绕过稳定分页边界。
   */
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
  /**
   * 查询指定管理员拥有的单个任务。
   *
   * taskId 与 createdBy 共同限定所有权，返回任务或 null；无副作用，数据库异常上抛。
   */
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
  /**
   * 读取仍在保留期内且属于管理员的已完成下载对象。
   *
   * 输入任务、所有者和服务器时间，返回最小对象定位或 null；不改变下载状态，非法
   * 导出类型会因运行时 schema 校验失败而抛错。
   */
  async findDownloadable(taskId, createdBy, now) {
    const task = await this.findOwned(taskId, createdBy);
    if (
      task?.status !== "completed" ||
      !task.objectBucket ||
      !task.objectKey ||
      !task.expiresAt ||
      task.expiresAt <= now
    ) {
      return null;
    }
    return {
      id: task.id,
      createdBy: task.createdBy,
      status: "completed",
      objectBucket: task.objectBucket,
      objectKey: task.objectKey,
      expiresAt: task.expiresAt,
      exportType: operationsExportTypeSchema.parse(task.exportType),
    };
  },
  /**
   * 记录一次受控下载许可或传输结果审计。
   *
   * 输入不包含文件内容，仅写任务、管理员、模式和稳定结果；插入失败会上抛，避免
   * 调用方把未审计下载误判为成功。
   */
  async recordDownload(input) {
    const { db } = await import("@repo/database");
    await db.insert(adminAuditLog).values(
      createOperationsExportAuditValues({
        adminUserId: input.createdBy,
        action: "operations.downloadExport",
        taskId: input.taskId,
        metadata: { mode: input.mode, result: input.result },
        now: input.now,
      })
    );
  },
};
