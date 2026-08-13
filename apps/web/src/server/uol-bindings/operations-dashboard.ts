/**
 * 运营总览 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶与运营管理页 Server Action。管理员身份、限流、应用时区
 * 和领域服务错误在此收敛；页面不直接读取数据库。导出 worker 通过独立 cron
 * Principal 进入同一 UOL 网关，避免调度入口绕过权限和审计。
 */

import { isAdminRole } from "@repo/shared/auth/roles";
import {
  operationsCreateExportOutputSchema,
  operationsDetailOutputSchema,
  operationsListExportsOutputSchema,
  operationsOverviewOutputSchema,
  operationsPrepareExportDownloadOutputSchema,
  operationsProcessExportsOutputSchema,
  operationsRetryExportOutputSchema,
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
import {
  createOperationsExport,
  listOperationsExports,
  OperationsExportServiceError,
  prepareOperationsExportDownload,
  retryOperationsExport,
} from "@/features/operations-dashboard/export-service";
import {
  expireDatabaseOperationsExports,
  processDatabaseOperationsExports,
} from "@/features/operations-dashboard/export-worker";
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
    error instanceof OperationsExportServiceError ||
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
    if ("code" in error && error.code === "not_found") {
      throw new OperationError("not_found", error.message);
    }
    if ("code" in error && error.code === "conflict") {
      throw new OperationError("conflict", error.message);
    }
    if ("code" in error && error.code === "rate_limited") {
      throw new OperationError("rate_limited", error.message);
    }
    if ("code" in error && error.code === "storage_unavailable") {
      throw new OperationError("not_ready", error.message, undefined, 503);
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

/** 创建冻结任务；创建者、筛选和快照审计由同一数据库事务写入。 */
bindExecute(
  "operations.createExport",
  async (input: unknown, principal: Principal) => {
    const admin = await assertOperationsAdmin(principal);
    try {
      return operationsCreateExportOutputSchema.parse(
        await createOperationsExport({
          createdBy: admin.userId,
          timeZone: getAppTimeZone(),
          input,
        })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 列出当前管理员自己的导出记录。 */
bindExecute(
  "operations.listExports",
  async (input: unknown, principal: Principal) => {
    const admin = await assertOperationsAdmin(principal);
    try {
      return operationsListExportsOutputSchema.parse(
        await listOperationsExports({ createdBy: admin.userId, input })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 重试失败任务并保留父记录。 */
bindExecute(
  "operations.retryExport",
  async (input: unknown, principal: Principal) => {
    const admin = await assertOperationsAdmin(principal);
    try {
      return operationsRetryExportOutputSchema.parse(
        await retryOperationsExport({ createdBy: admin.userId, input })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 为远端签名或本地受控路由准备短期下载许可。 */
bindExecute(
  "operations.prepareExportDownload",
  async (input: unknown, principal: Principal) => {
    const admin = await assertOperationsAdmin(principal);
    try {
      const origin =
        process.env.NEXT_PUBLIC_APP_URL ??
        process.env.BETTER_AUTH_URL ??
        "http://localhost:3000";
      return operationsPrepareExportDownloadOutputSchema.parse(
        await prepareOperationsExportDownload({
          createdBy: admin.userId,
          input,
          localDownloadUrl: (taskId) =>
            new URL(
              `/api/admin/operations/exports/${encodeURIComponent(taskId)}/download`,
              origin
            ).toString(),
        })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 处理任务只接受 UOL 已鉴权的精确 operations-export cron Principal。 */
bindExecute(
  "operations.processExports",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "cron" || principal.job !== "operations-export")
      throw new OperationError(
        "forbidden",
        "Operations export job access required"
      );
    const limit =
      typeof input === "object" && input !== null && "limit" in input
        ? Number(input.limit)
        : 10;
    return operationsProcessExportsOutputSchema.parse(
      await processDatabaseOperationsExports(limit)
    );
  }
);

/** 保留任务使用独立 cron Principal，避免处理开关隐式开启清理。 */
bindExecute(
  "operations.expireExports",
  async (input: unknown, principal: Principal) => {
    if (
      principal.type !== "cron" ||
      principal.job !== "operations-export-retention"
    )
      throw new OperationError(
        "forbidden",
        "Operations export retention job access required"
      );
    const limit =
      typeof input === "object" && input !== null && "limit" in input
        ? Number(input.limit)
        : 10;
    return operationsProcessExportsOutputSchema.parse(
      await expireDatabaseOperationsExports(limit)
    );
  }
);
