"use server";

/**
 * 用户数据看板刷新 Server Action 薄适配器。
 *
 * 使用方：客户端快照状态机。Action 只读取 protected session userId、角色与 strict
 * 日期输入，再调用整页 UOL operation；失败返回无内部详情的可恢复状态。
 */
import {
  type DataDashboardOutput,
  dataDashboardInputSchema,
} from "@repo/shared/analytics/contracts";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { logError } from "@repo/shared/logger";
import { protectedAction } from "@repo/shared/safe-action";
import { OperationError } from "@repo/shared/uol";

import { loadDataDashboardPageData } from "./data-dashboard-page-data";

/** 客户端可区分且不携带服务端异常详情的刷新结果。 */
export type DataDashboardActionResult =
  | { status: "ready"; snapshot: DataDashboardOutput }
  | {
      status:
        | "validation_error"
        | "not_ready"
        | "rate_limited"
        | "timeout"
        | "unauthenticated"
        | "unavailable";
    };

/** 把 UOL 错误码收敛为页面状态，未知码统一视为不可用。 */
function mapOperationError(error: OperationError): DataDashboardActionResult {
  switch (error.code) {
    case "validation_error":
    case "not_ready":
    case "rate_limited":
    case "timeout":
    case "unauthenticated":
      return { status: error.code };
    default:
      return { status: "unavailable" };
  }
}

/**
 * 按当前 session 用户刷新完整数据看板。
 *
 * 输出只有最新成功 action 才应由客户端提交；服务端不保存草稿范围或旧快照。
 */
export const refreshDataDashboardAction = protectedAction
  .metadata({ action: "analytics.getMyDataDashboard" })
  .schema(dataDashboardInputSchema)
  .action(async ({ ctx, parsedInput }): Promise<DataDashboardActionResult> => {
    try {
      const role = await getUserRoleById(ctx.userId);
      const snapshot = await loadDataDashboardPageData({
        userId: ctx.userId,
        role,
        rangeInput: parsedInput,
      });
      return { status: "ready", snapshot };
    } catch (error) {
      if (error instanceof OperationError) {
        const result = mapOperationError(error);
        if (result.status === "unavailable") {
          logError(error, { source: "data-dashboard-action" });
        }
        return result;
      }
      logError(error, { source: "data-dashboard-action" });
      return { status: "unavailable" };
    }
  });
