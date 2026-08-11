"use server";

/**
 * 管理端全局数据看板刷新 Server Action。
 *
 * Action 只做管理员会话边界、输入 schema 和 UOL 薄适配；全站范围、时区、readiness
 * 与统计口径统一由 `analytics.getAdminDataDashboard` operation 处理。
 */
import {
  type DataDashboardOutput,
  dataDashboardInputSchema,
} from "@repo/shared/analytics/contracts";
import { logError } from "@repo/shared/logger";
import { adminAction } from "@repo/shared/safe-action";
import { invokeOperation, OperationError } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/** 客户端可区分且不携带数据库详情的刷新结果。 */
export type AdminDataDashboardActionResult =
  | { status: "ready"; snapshot: DataDashboardOutput }
  | {
      status:
        | "validation_error"
        | "not_ready"
        | "rate_limited"
        | "timeout"
        | "unavailable";
    };

function mapOperationError(
  error: OperationError
): AdminDataDashboardActionResult {
  switch (error.code) {
    case "validation_error":
    case "not_ready":
    case "rate_limited":
    case "timeout":
      return { status: error.code };
    default:
      return { status: "unavailable" };
  }
}

/** 刷新管理员全站数据看板。 */
export const refreshAdminDataDashboardAction = adminAction
  .metadata({ action: "analytics.getAdminDataDashboard" })
  .schema(dataDashboardInputSchema)
  .action(
    async ({ parsedInput, ctx }): Promise<AdminDataDashboardActionResult> => {
      try {
        await ensureUolInitialized();
        const snapshot = await invokeOperation<DataDashboardOutput>(
          "analytics.getAdminDataDashboard",
          parsedInput,
          { type: "user", userId: ctx.userId, role: ctx.role }
        );
        return { status: "ready", snapshot };
      } catch (error) {
        if (error instanceof OperationError) {
          const result = mapOperationError(error);
          if (result.status === "unavailable") {
            logError(error, { source: "admin-data-dashboard-action" });
          }
          return result;
        }
        logError(error, { source: "admin-data-dashboard-action" });
        return { status: "unavailable" };
      }
    }
  );
