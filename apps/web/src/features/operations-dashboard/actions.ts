"use server";

/**
 * Dashboard 网页访问事实 Server Action。
 *
 * 使用方：跨应用自然日重新可见的客户端记录器。Action 只读取 protected session 用户，
 * 不接受身份、日期、访问时间或页面字段，实际写入统一委托 UOL。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { protectedAction } from "@repo/shared/safe-action";

import { tryRecordDashboardWebVisit } from "./dashboard-web-visit";

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
