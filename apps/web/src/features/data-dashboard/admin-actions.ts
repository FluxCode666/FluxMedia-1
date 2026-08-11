"use server";

/**
 * 管理端数据看板刷新与用户搜索 Server Action。
 *
 * Action 只做管理员会话边界、输入 schema 和 UOL 薄适配；用户范围、时区、
 * readiness 与统计口径统一由 analytics operation 处理。
 */
import {
  type AdminDataDashboardUserSearchOutput,
  type DataDashboardOutput,
  adminDataDashboardInputSchema,
  adminDataDashboardUserSearchInputSchema,
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

/** 刷新管理员全站或指定用户的数据看板。 */
export const refreshAdminDataDashboardAction = adminAction
  .metadata({ action: "analytics.getAdminDataDashboard" })
  .schema(adminDataDashboardInputSchema)
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

/** 搜索管理员数据看板用户下拉选项；查询同时匹配名称和邮箱。 */
export const searchAdminDataDashboardUsersAction = adminAction
  .metadata({ action: "analytics.searchAdminDataDashboardUsers" })
  .schema(adminDataDashboardUserSearchInputSchema)
  .action(
    async ({
      parsedInput,
      ctx,
    }): Promise<AdminDataDashboardUserSearchOutput> => {
      await ensureUolInitialized();
      return invokeOperation<AdminDataDashboardUserSearchOutput>(
        "analytics.searchAdminDataDashboardUsers",
        parsedInput,
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
    }
  );
