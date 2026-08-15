/**
 * 运营 CSV 导出任务仓储的数据库结果与审计值辅助函数。
 *
 * 使用方：创建、下载、租约状态机与对象清理仓储模块。该模块不获取数据库连接，
 * 只把未知执行结果或显式输入转换为稳定值。
 */
import { randomUUID } from "node:crypto";

import { extractExecuteRows } from "@/server/database-result";

/**
 * 判断条件更新是否恰好命中一行。
 *
 * @param result Drizzle execute 或 returning 的未知结果。
 * @returns 仅当标准化结果包含一行时返回 true。
 * @throws 数据库结果形状无法标准化时沿用 extractExecuteRows 的错误；无副作用。
 */
export function changed(result: unknown): boolean {
  return extractExecuteRows(result).length === 1;
}

/**
 * 生成不含筛选敏感内容的管理员审计行。
 *
 * @param input 管理员、动作、任务、最小元数据与审计时间。
 * @returns 可直接写入 admin_audit_log 的新行值。
 * @sideEffects 生成一个随机 UUID；不读写数据库，不修改输入元数据。
 */
export function createOperationsExportAuditValues(input: {
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
