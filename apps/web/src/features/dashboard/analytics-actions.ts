"use server";

/**
 * 用户控制台统计的 Server Action 传输适配器。
 *
 * 职责仅限读取当前会话、构造本人 Principal 并调用 Analytics UOL；统计查询的
 * readiness、范围校验、余额维护、用户归属和数据库访问统一由 UOL operation 负责。
 */
import { usageSummaryInputSchema } from "@repo/shared/analytics/contracts";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { protectedAction } from "@repo/shared/safe-action";

import {
  type DashboardSnapshot,
  loadDashboardSnapshot,
} from "./dashboard-data";

/**
 * 刷新近 24 小时摘要、积分余额、模型分布与近期创作。
 * 核心统计失败时 action 整体失败，客户端不会混用不同时间点的数据。
 */
export const refreshDashboardSnapshotAction = protectedAction
  .metadata({ action: "analytics.refreshDashboardSnapshot" })
  .schema(usageSummaryInputSchema)
  .action(async ({ ctx }): Promise<DashboardSnapshot> => {
    const role = await getUserRoleById(ctx.userId);
    return loadDashboardSnapshot({
      userId: ctx.userId,
      role,
    });
  });
