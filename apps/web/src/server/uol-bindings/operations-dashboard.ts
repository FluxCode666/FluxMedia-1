/**
 * 运营总览 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶与运营管理页 Server Action。管理员身份、限流、应用时区
 * 和领域服务错误在此收敛；页面不直接读取数据库。导出 worker 的真实执行体在 U6
 * 接入前明确返回 not_implemented，避免把未完成能力伪装成成功。
 */

import { isAdminRole } from "@repo/shared/auth/roles";
import {
  operationsDetailOutputSchema,
  operationsOverviewOutputSchema,
} from "@repo/shared/operations-dashboard/contracts";
import { checkRateLimit } from "@repo/shared/rate-limit";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";
import { OperationsCommercialServiceError } from "@/features/operations-dashboard/commercial-service";
import { OperationsContentServiceError } from "@/features/operations-dashboard/content-service";
import {
  loadOperationsDetail,
  OperationsDetailServiceError,
} from "@/features/operations-dashboard/detail-service";
import { OperationsGrowthServiceError } from "@/features/operations-dashboard/growth-service";
import { OperationsHealthAdapterError } from "@/features/operations-dashboard/health-adapter";
import {
  databaseOperationsDashboardService,
  OperationsDashboardServiceError,
} from "@/features/operations-dashboard/operations-dashboard-service";

/** 将管理员身份与限流检查复用到全部人工运营 operation。 */
async function assertOperationsAdmin(
  principal: Principal
): Promise<Extract<Principal, { type: "user" }>> {
  if (principal.type !== "user" || !isAdminRole(principal.role)) {
    throw new OperationError("forbidden", "Administrator access required");
  }
  const rateLimit = await checkRateLimit(
    `operations-dashboard:${principal.userId}`,
    "global"
  );
  if (!rateLimit.success) {
    throw new OperationError(
      "rate_limited",
      "Operations dashboard requests are too frequent"
    );
  }
  return principal;
}

/** 只把运营领域公开的稳定错误映射成 UOL 错误，不泄露 SQL 或任务行。 */
function throwOperationsDashboardError(error: unknown): never {
  if (
    error instanceof OperationsDashboardServiceError ||
    error instanceof OperationsCommercialServiceError ||
    error instanceof OperationsContentServiceError ||
    error instanceof OperationsDetailServiceError ||
    error instanceof OperationsGrowthServiceError ||
    error instanceof OperationsHealthAdapterError
  ) {
    if ("code" in error && error.code === "not_ready") {
      throw new OperationError("not_ready", error.message, undefined, 503);
    }
    if ("code" in error && error.code === "validation_error") {
      throw new OperationError("validation_error", error.message);
    }
    if ("code" in error && error.code === "not_implemented") {
      throw new OperationError(
        "not_implemented",
        error.message,
        undefined,
        501
      );
    }
    throw new OperationError(
      "internal_error",
      "Operations dashboard is unavailable"
    );
  }
  throw error;
}

bindExecute(
  "operations.getOverview",
  async (input: unknown, principal: Principal) => {
    await assertOperationsAdmin(principal);
    try {
      const snapshot = await databaseOperationsDashboardService.getOverview(
        input,
        getAppTimeZone()
      );
      return operationsOverviewOutputSchema.parse(snapshot);
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 绑定管理员运营明细；完整邮箱仅在 human-only operation 内返回。 */
bindExecute(
  "operations.getDetail",
  async (input: unknown, principal: Principal) => {
    const adminPrincipal = await assertOperationsAdmin(principal);
    try {
      return operationsDetailOutputSchema.parse(
        await loadOperationsDetail({
          actorUserId: adminPrincipal.userId,
          timeZone: getAppTimeZone(),
          input,
        })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 导出 operation 在 worker/存储单元完成前显式拒绝，避免生成空文件。 */
for (const name of [
  "operations.createExport",
  "operations.listExports",
  "operations.retryExport",
  "operations.prepareExportDownload",
] as const) {
  bindExecute(name, async (_input: unknown, principal: Principal) => {
    await assertOperationsAdmin(principal);
    throw new OperationError(
      "not_implemented",
      "Operations export is not available yet",
      undefined,
      501
    );
  });
}

/** 后台 job operation 仅接受声明式 cron Principal，执行体在 U6 注册。 */
for (const name of [
  "operations.processExports",
  "operations.expireExports",
] as const) {
  bindExecute(name, async (_input: unknown, principal: Principal) => {
    if (principal.type !== "cron") {
      throw new OperationError("forbidden", "Operations job access required");
    }
    throw new OperationError(
      "not_implemented",
      "Operations export worker is not available yet",
      undefined,
      501
    );
  });
}
