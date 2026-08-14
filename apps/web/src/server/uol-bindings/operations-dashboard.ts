/**
 * 运营总览 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶与运营管理页 Server Action。管理员身份、限流、应用时区
 * 和领域服务错误在此收敛；页面不直接读取数据库。导出 worker 通过独立 cron
 * Principal 进入同一 UOL 网关，避免调度入口绕过权限和审计。
 */

import { logger } from "@repo/shared/logger";
import {
  operationsCreateExportOutputSchema,
  operationsListExportsOutputSchema,
  operationsPrepareExportDownloadOutputSchema,
  operationsProcessExportsOutputSchema,
  operationsRetryExportOutputSchema,
} from "@repo/shared/operations-dashboard/contracts";
import {
  operationsDetailOutputSchema,
  operationsOverviewOutputSchema,
} from "@repo/shared/operations-dashboard/output-contracts";
import { checkRateLimit } from "@repo/shared/rate-limit";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import {
  bindExecute,
  type OperationContext,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
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

/**
 * 收窄已由 invokeOperation 授权的人工 Principal，并执行运营页面限流。
 *
 * WHY：角色策略只由 operation access 声明维护；若授权后仍收到非用户 Principal，
 * 这是网关或 binding 不变量损坏，而不是第二套可对外报告的权限判断。
 */
async function requireOperationsUser(
  principal: Principal
): Promise<Extract<Principal, { type: "user" }>> {
  if (principal.type !== "user") {
    throw new OperationError(
      "internal_error",
      "Authorized operations user principal required"
    );
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

/** 运营 operation 成功日志允许附加的非敏感度量。 */
type OperationsTelemetry = {
  module?: string;
  rangeDays?: number;
  granularity?: string;
  bucketCount?: number;
  rowCount?: number;
  exportTaskId?: string;
};

/** 从未知范围 DTO 中读取有限非负整数，避免把完整响应写入日志。 */
function readTelemetryNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const candidate = Reflect.get(value, key);
  return typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

/** 从未知范围 DTO 中读取粒度，拒绝把任意客户端文本带入日志。 */
function readTelemetryGranularity(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("granularity" in value)
  ) {
    return undefined;
  }
  const candidate = value.granularity;
  return candidate === "day" || candidate === "week" || candidate === "month"
    ? candidate
    : undefined;
}

/** 将错误收敛为稳定短码；绝不记录 SQL、对象键或领域错误消息。 */
function readTelemetryErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9_:-]{1,100}$/i.test(error.code)
  ) {
    return error.code;
  }
  return "unknown";
}

/**
 * 记录单次运营 operation 的成功或失败耗时。
 *
 * @param operation UOL operation 名称。
 * @param context UOL 权威 requestId。
 * @param execute 领域调用与输出校验。
 * @param summarize 成功后从结果提取非敏感计数，不得返回业务行或邮箱。
 * @returns execute 的原始结果。
 * @sideeffect 写一条 Pino info 或 warn 日志。
 */
async function runObservedOperationsCall<TResult>(
  operation: string,
  context: OperationContext,
  execute: () => Promise<TResult>,
  summarize: (result: TResult) => OperationsTelemetry = () => ({})
): Promise<TResult> {
  const startedAt = Date.now();
  try {
    const result = await execute();
    logger.info(
      {
        operation,
        requestId: context.requestId,
        durationMs: Math.max(0, Date.now() - startedAt),
        status: "succeeded",
        ...summarize(result),
      },
      "Operations dashboard operation completed"
    );
    return result;
  } catch (error) {
    logger.warn(
      {
        operation,
        requestId: context.requestId,
        durationMs: Math.max(0, Date.now() - startedAt),
        status: "failed",
        errorCode: readTelemetryErrorCode(error),
      },
      "Operations dashboard operation failed"
    );
    throw error;
  }
}

bindExecute(
  "operations.getOverview",
  async (input: unknown, principal: Principal, context: OperationContext) => {
    await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.getOverview",
        context,
        async () => {
          const snapshot = await databaseOperationsDashboardService.getOverview(
            input,
            getAppTimeZone()
          );
          return operationsOverviewOutputSchema.parse(snapshot);
        },
        (snapshot) => ({
          module: "all",
          rangeDays: readTelemetryNumber(snapshot.range, "dayCount"),
          granularity: readTelemetryGranularity(snapshot.range),
          bucketCount:
            typeof snapshot.range === "object" &&
            snapshot.range !== null &&
            "buckets" in snapshot.range &&
            Array.isArray(snapshot.range.buckets)
              ? snapshot.range.buckets.length
              : undefined,
        })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 绑定管理员运营明细；完整邮箱仅在 human-only operation 内返回。 */
bindExecute(
  "operations.getDetail",
  async (input: unknown, principal: Principal, context: OperationContext) => {
    const adminPrincipal = await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.getDetail",
        context,
        async () =>
          operationsDetailOutputSchema.parse(
            await loadOperationsDetail({
              actorUserId: adminPrincipal.userId,
              timeZone: getAppTimeZone(),
              input,
            })
          ),
        (result) => ({
          module: result.selection.module,
          rangeDays: readTelemetryNumber(result.range, "dayCount"),
          granularity: readTelemetryGranularity(result.range),
          rowCount: result.rows.length,
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
  async (input: unknown, principal: Principal, context: OperationContext) => {
    const admin = await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.createExport",
        context,
        async () =>
          operationsCreateExportOutputSchema.parse(
            await createOperationsExport({
              createdBy: admin.userId,
              timeZone: getAppTimeZone(),
              input,
            })
          ),
        (result) => ({
          module: result.task.exportType,
          granularity: result.task.query.granularity,
          exportTaskId: result.task.id,
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
  async (input: unknown, principal: Principal, context: OperationContext) => {
    const admin = await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.listExports",
        context,
        async () =>
          operationsListExportsOutputSchema.parse(
            await listOperationsExports({ createdBy: admin.userId, input })
          ),
        (result) => ({ rowCount: result.tasks.length })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 重试失败任务并保留父记录。 */
bindExecute(
  "operations.retryExport",
  async (input: unknown, principal: Principal, context: OperationContext) => {
    const admin = await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.retryExport",
        context,
        async () =>
          operationsRetryExportOutputSchema.parse(
            await retryOperationsExport({ createdBy: admin.userId, input })
          ),
        (result) => ({
          module: result.task.exportType,
          granularity: result.task.query.granularity,
          exportTaskId: result.task.id,
        })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 为远端签名或本地受控路由准备短期下载许可。 */
bindExecute(
  "operations.prepareExportDownload",
  async (input: unknown, principal: Principal, context: OperationContext) => {
    const admin = await requireOperationsUser(principal);
    try {
      const origin =
        process.env.NEXT_PUBLIC_APP_URL ??
        process.env.BETTER_AUTH_URL ??
        "http://localhost:3000";
      return await runObservedOperationsCall(
        "operations.prepareExportDownload",
        context,
        async () =>
          operationsPrepareExportDownloadOutputSchema.parse(
            await prepareOperationsExportDownload({
              createdBy: admin.userId,
              input,
              localDownloadUrl: (taskId) =>
                new URL(
                  `/api/admin/operations/exports/${encodeURIComponent(taskId)}/download`,
                  origin
                ).toString(),
            })
          ),
        (result) => ({ exportTaskId: result.taskId })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 处理任务只接受 UOL 已鉴权的精确 operations-export cron Principal。 */
bindExecute(
  "operations.processExports",
  async (input: unknown, _principal: Principal, context: OperationContext) => {
    const limit =
      typeof input === "object" && input !== null && "limit" in input
        ? Number(input.limit)
        : 10;
    return runObservedOperationsCall(
      "operations.processExports",
      context,
      async () =>
        operationsProcessExportsOutputSchema.parse(
          await processDatabaseOperationsExports(limit)
        ),
      (result) => ({ rowCount: result.processed })
    );
  }
);

/** 保留任务使用独立 cron Principal，避免处理开关隐式开启清理。 */
bindExecute(
  "operations.expireExports",
  async (input: unknown, _principal: Principal, context: OperationContext) => {
    const limit =
      typeof input === "object" && input !== null && "limit" in input
        ? Number(input.limit)
        : 10;
    return runObservedOperationsCall(
      "operations.expireExports",
      context,
      async () =>
        operationsProcessExportsOutputSchema.parse(
          await expireDatabaseOperationsExports(limit)
        ),
      (result) => ({ rowCount: result.processed })
    );
  }
);
