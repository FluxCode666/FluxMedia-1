/**
 * 运营总览 UOL 操作定义。
 *
 * 使用方：管理端 Server Action、后续 CSV worker 与受控下载路由。这里只声明严格
 * 输入输出、权限和幂等元数据；数据库读取与导出执行体由 apps/web late binding 注入。
 */
import {
  operationsCreateExportInputSchema,
  operationsCreateExportOutputSchema,
  operationsDetailOutputSchema,
  operationsExpireExportsInputSchema,
  operationsExpireExportsOutputSchema,
  operationsGetDetailInputSchema,
  operationsGetOverviewInputSchema,
  operationsListExportsInputSchema,
  operationsListExportsOutputSchema,
  operationsOverviewOutputSchema,
  operationsPrepareExportDownloadInputSchema,
  operationsPrepareExportDownloadOutputSchema,
  operationsProcessExportsInputSchema,
  operationsProcessExportsOutputSchema,
  operationsRetryExportInputSchema,
  operationsRetryExportOutputSchema,
} from "../../operations-dashboard/contracts";
import { defineOperation } from "../registry";
import type { AccessRequirement } from "../types";

const adminAccess: AccessRequirement = {
  kind: "roles",
  roles: ["admin", "super_admin"],
};

/** 获取单一 repeatable-read 快照中的运营总览。 */
export const getOperationsOverview = defineOperation({
  name: "operations.getOverview",
  domain: "operations",
  title: "获取运营总览",
  description: "按应用时区读取增长、商业化、内容生产和系统健康的一致运营快照。",
  input: operationsGetOverviewInputSchema,
  output: operationsOverviewOutputSchema,
  access: adminAccess,
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: operations.getOverview");
  },
});

/** 获取与总览同源的管理员明细页，并用不透明游标继续读取。 */
export const getOperationsDetail = defineOperation({
  name: "operations.getDetail",
  domain: "operations",
  title: "获取运营明细",
  description: "按模块和明细类型读取运营事实，保持日期筛选并返回 keyset 游标。",
  input: operationsGetDetailInputSchema,
  output: operationsDetailOutputSchema,
  access: adminAccess,
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: operations.getDetail");
  },
});

/** 创建异步 CSV 导出任务；clientRequestId 保证页面重试幂等。 */
export const createOperationsExport = defineOperation({
  name: "operations.createExport",
  domain: "operations",
  title: "创建运营 CSV 导出",
  description: "冻结当前筛选条件并排队生成完整运营 CSV 文件。",
  input: operationsCreateExportInputSchema,
  output: operationsCreateExportOutputSchema,
  access: adminAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-principal",
  },
  sideEffects: ["queue", "audit"],
  execute: async () => {
    throw new Error("Not yet wired: operations.createExport");
  },
});

/** 列出当前管理员的导出记录。 */
export const listOperationsExports = defineOperation({
  name: "operations.listExports",
  domain: "operations",
  title: "列出运营导出记录",
  description: "只返回当前管理员创建的导出任务摘要，不暴露对象存储凭据。",
  input: operationsListExportsInputSchema,
  output: operationsListExportsOutputSchema,
  access: adminAccess,
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: operations.listExports");
  },
});

/** 重试失败导出；新任务保留 retryOfTaskId 以便审计。 */
export const retryOperationsExport = defineOperation({
  name: "operations.retryExport",
  domain: "operations",
  title: "重试运营 CSV 导出",
  description: "仅允许重试当前管理员的失败任务，并创建新的幂等导出记录。",
  input: operationsRetryExportInputSchema,
  output: operationsRetryExportOutputSchema,
  access: adminAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-principal",
  },
  sideEffects: ["queue", "audit"],
  execute: async () => {
    throw new Error("Not yet wired: operations.retryExport");
  },
});

/** 下载前重新校验任务归属和七天保留状态，返回短期下载许可。 */
export const prepareOperationsExportDownload = defineOperation({
  name: "operations.prepareExportDownload",
  domain: "operations",
  title: "准备运营导出下载",
  description: "只为当前管理员未过期的已完成导出签发短期下载许可。",
  input: operationsPrepareExportDownloadInputSchema,
  output: operationsPrepareExportDownloadOutputSchema,
  access: adminAccess,
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  execute: async () => {
    throw new Error("Not yet wired: operations.prepareExportDownload");
  },
});

/** 内部导出 worker 批处理 operation，仅接受固定 cron job Principal。 */
export const processOperationsExports = defineOperation({
  name: "operations.processExports",
  domain: "operations",
  title: "处理运营导出任务",
  description: "由独立后台 job 认领并处理有界数量的运营 CSV 导出任务。",
  input: operationsProcessExportsInputSchema,
  output: operationsProcessExportsOutputSchema,
  access: { kind: "cronJob", job: "operations-export" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["queue", "storage", "audit"],
  hasMaintenanceWrite: true,
  execute: async () => {
    throw new Error("Not yet wired: operations.processExports");
  },
});

/** 内部导出清理 operation，先过期任务再幂等删除对象。 */
export const expireOperationsExports = defineOperation({
  name: "operations.expireExports",
  domain: "operations",
  title: "清理运营导出任务",
  description: "由独立后台 job 过期七天文件并记录清理结果。",
  input: operationsExpireExportsInputSchema,
  output: operationsExpireExportsOutputSchema,
  access: { kind: "cronJob", job: "operations-export-retention" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: { kind: "natural" },
  sideEffects: ["storage", "audit"],
  hasMaintenanceWrite: true,
  execute: async () => {
    throw new Error("Not yet wired: operations.expireExports");
  },
});

export {
  operationsDetailOutputSchema,
  operationsGetDetailInputSchema,
  operationsGetOverviewInputSchema,
  operationsOverviewOutputSchema,
};
