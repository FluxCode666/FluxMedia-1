"use server";

/**
 * Dashboard 网页访问事实 Server Action。
 *
 * 使用方：跨应用自然日重新可见的客户端记录器。Action 只读取 protected session 用户，
 * 不接受身份、日期、访问时间或页面字段，实际写入统一委托 UOL。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import {
  operationsCreateExportInputSchema,
  operationsGetDetailInputSchema,
  operationsGetOverviewInputSchema,
  operationsListExportsInputSchema,
  operationsPrepareExportDownloadInputSchema,
  operationsRetryExportInputSchema,
} from "@repo/shared/operations-dashboard/contracts";
import type { OperationsDetailOutput } from "@repo/shared/operations-dashboard/output-contracts";
import { adminAction, protectedAction } from "@repo/shared/safe-action";

import {
  mapOperationsActionError,
  type OperationsDashboardActionFailure,
} from "./action-result";
import { tryRecordDashboardWebVisit } from "./dashboard-web-visit";
import type { OperationsDashboardOverview } from "./operations-dashboard-service";
import { requestGoJson } from "@/server/go-backend-client";

/** 客户端可安全消费的访问记录结果，不携带内部异常详情。 */
export type RecordDashboardWebVisitActionResult =
  | { status: "recorded"; appDate: string }
  | { status: "unavailable" };

/**
 * 为当前 session 用户尝试记录服务端认定的应用自然日访问。
 *
 * @returns 写入或幂等重放成功时返回服务端自然日；失败时返回 unavailable。
 * @sideEffects 可能写访问事实；统计不可用不阻断 dashboard 或暴露错误详情。
 */
export const recordDashboardWebVisitAction = protectedAction
  .metadata({ action: "operations.recordWebVisit" })
  .action(async ({ ctx }): Promise<RecordDashboardWebVisitActionResult> => {
    const role = await getUserRoleById(ctx.userId);
    const result = await tryRecordDashboardWebVisit(ctx.userId, role);
    return result
      ? { status: "recorded", appDate: result.appDate }
      : { status: "unavailable" };
  });

/** 客户端刷新只接收完整新快照或安全失败码，不接收半成品模块。 */
export type OperationsDashboardOverviewActionResult =
  | { status: "ready"; snapshot: OperationsDashboardOverview }
  | { status: OperationsDashboardActionFailure };

/** 读取管理员运营总览；输入和输出都由共享 operation schema 约束。 */
export const getOperationsOverviewAction = adminAction
  .metadata({ action: "operations.getOverview" })
  .schema(operationsGetOverviewInputSchema)
  .action(
    async ({
      parsedInput,
      
    }): Promise<OperationsDashboardOverviewActionResult> => {
      try {
        const snapshot = await requestGoJson<OperationsDashboardOverview>(
          "/api/admin/operations/overview",
          { method: "POST", body: JSON.stringify(parsedInput) }
        );
        return { status: "ready", snapshot };
      } catch (error) {
        return { status: mapOperationsActionError(error) };
      }
    }
  );

/** 读取管理员运营明细；客户端按 cursor 继续请求。 */
export const getOperationsDetailAction = adminAction
  .metadata({ action: "operations.getDetail" })
  .schema(operationsGetDetailInputSchema)
  .action(async ({ parsedInput }): Promise<OperationsDetailOutput> => {
    return requestGoJson<OperationsDetailOutput>("/api/admin/operations/detail", {
      method: "POST", body: JSON.stringify(parsedInput),
    });
  });

/** 异步创建 CSV 导出；U6 接入后 action API 无需变更。 */
export const createOperationsExportAction = adminAction
  .metadata({ action: "operations.createExport" })
  .schema(operationsCreateExportInputSchema)
  .action(async ({ parsedInput }) => {
    return requestGoJson("/api/admin/operations/exports", {
      method: "POST", body: JSON.stringify(parsedInput),
    });
  });

/** 列出当前管理员导出记录。 */
export const listOperationsExportsAction = adminAction
  .metadata({ action: "operations.listExports" })
  .schema(operationsListExportsInputSchema)
  .action(async ({ parsedInput }) => {
    const query = new URLSearchParams({ limit: String(parsedInput.limit) });
    if (parsedInput.cursor) query.set("cursor", parsedInput.cursor);
    return requestGoJson(`/api/admin/operations/exports?${query.toString()}`);
  });

/** 重试失败导出；幂等键由页面生成并由 UOL 网关强制校验。 */
export const retryOperationsExportAction = adminAction
  .metadata({ action: "operations.retryExport" })
  .schema(operationsRetryExportInputSchema)
  .action(async ({ parsedInput }) => {
    return requestGoJson("/api/admin/operations/exports/retry", {
      method: "POST", body: JSON.stringify(parsedInput),
    });
  });

/** 为已完成导出准备短期下载许可。 */
export const prepareOperationsExportDownloadAction = adminAction
  .metadata({ action: "operations.prepareExportDownload" })
  .schema(operationsPrepareExportDownloadInputSchema)
  .action(async ({ parsedInput }) => {
    return requestGoJson("/api/admin/operations/exports/prepare-download", {
      method: "POST", body: JSON.stringify(parsedInput),
    });
  });

export type { OperationsDashboardActionFailure } from "./action-result";
