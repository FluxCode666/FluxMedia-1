/**
 * 运营 CSV 导出任务 PostgreSQL 仓储组合入口。
 *
 * 使用方：稳定公共仓储入口。创建、读取、租约状态机和对象清理分别由专用模块
 * 实现，这里只组合完整端口，不新增事务、SQL、错误映射或状态语义。
 */

import { operationsExportTaskCleanupRepository } from "./export-task-cleanup-repository";
import type { OperationsExportTaskRepository } from "./export-task-contracts";
import { operationsExportTaskCreateRepository } from "./export-task-create-repository";
import { operationsExportTaskLeaseRepository } from "./export-task-lease-repository";
import { operationsExportTaskReadRepository } from "./export-task-read-repository";

/**
 * 组合完整 PostgreSQL 仓储端口。
 *
 * @returns 模块初始化时创建的无状态方法集合；方法调用时才延迟导入数据库连接。
 * @sideEffects 初始化无副作用；各方法的数据库副作用由对应专用模块契约约束。
 */
export const databaseOperationsExportTaskRepository: OperationsExportTaskRepository =
  {
    ...operationsExportTaskCreateRepository,
    ...operationsExportTaskReadRepository,
    ...operationsExportTaskLeaseRepository,
    ...operationsExportTaskCleanupRepository,
  };
