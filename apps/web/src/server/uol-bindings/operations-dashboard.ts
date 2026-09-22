/**
 * 运营总览 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶与运营管理页 Server Action。转发管理员请求到 Go，
 * 由 Go 处理限流、应用时区、业务数据与导出。导出 worker 通过独立 cron
 * Principal 进入同一 UOL 网关，避免调度入口绕过权限和审计。
 */

import { logger } from "@repo/shared/logger";
import {
  operationsCreateExportOutputSchema,
  operationsListExportsOutputSchema,
  operationsOpenLocalExportDownloadInputSchema,
  operationsPrepareExportDownloadOutputSchema,
  operationsProcessExportsOutputSchema,
  operationsRetryExportOutputSchema,
} from "@repo/shared/operations-dashboard/contracts";
import {
  operationsDetailOutputSchema,
  operationsOpenLocalExportDownloadOutputSchema,
  operationsOverviewOutputSchema,
} from "@repo/shared/operations-dashboard/output-contracts";
import {
  bindExecute,
  type OperationContext,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import {
  GoBackendRequestError,
  requestGoJson,
  requestGoResponse,
} from "@/server/go-backend-client";

/**
 * 收窄已由 invokeOperation 授权的人工 Principal。
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

  return principal;
}

/** 只把运营领域公开的稳定错误映射成 UOL 错误，不泄露 SQL 或任务行。 */
function throwOperationsDashboardError(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof GoBackendRequestError) {
    if (error.status === 400)
      throw new OperationError("validation_error", error.message);
    if (error.status === 401)
      throw new OperationError("unauthenticated", error.message);
    if (error.status === 403)
      throw new OperationError("forbidden", error.message);
    if (error.status === 404)
      throw new OperationError("not_found", error.message);
    if (error.status === 409)
      throw new OperationError("conflict", error.message);
    if (error.status === 429)
      throw new OperationError("rate_limited", error.message);
    if (error.status === 503)
      throw new OperationError("not_ready", error.message);
    throw new OperationError("internal_error", "运营数据暂不可用");
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
          const snapshot = await requestGoJson(
            "/api/admin/operations/overview",
            { method: "POST", body: JSON.stringify(input) }
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
    await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.getDetail",
        context,
        async () =>
          operationsDetailOutputSchema.parse(
            await requestGoJson("/api/admin/operations/detail", {
              method: "POST",
              body: JSON.stringify(input),
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
    await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.createExport",
        context,
        async () =>
          operationsCreateExportOutputSchema.parse(
            await requestGoJson("/api/admin/operations/exports", {
              method: "POST",
              body: JSON.stringify(input),
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
    await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.listExports",
        context,
        async () =>
          operationsListExportsOutputSchema.parse(
            await requestGoJson(
              `/api/admin/operations/exports?limit=${encodeURIComponent(String((input as { limit?: number })?.limit ?? 20))}${(input as { cursor?: string })?.cursor ? `&cursor=${encodeURIComponent((input as { cursor: string }).cursor)}` : ""}`
            )
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
    await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.retryExport",
        context,
        async () =>
          operationsRetryExportOutputSchema.parse(
            await requestGoJson("/api/admin/operations/exports/retry", {
              method: "POST",
              body: JSON.stringify(input),
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

/** 为远端签名或本地受控路由准备短期下载许可。 */
bindExecute(
  "operations.prepareExportDownload",
  async (input: unknown, principal: Principal, context: OperationContext) => {
    await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.prepareExportDownload",
        context,
        async () =>
          operationsPrepareExportDownloadOutputSchema.parse(
            await requestGoJson(
              "/api/admin/operations/exports/prepare-download",
              { method: "POST", body: JSON.stringify(input) }
            )
          ),
        (result) => ({ exportTaskId: result.taskId })
      );
    } catch (error) {
      throwOperationsDashboardError(error);
    }
  }
);

/** 打开本地 provider 字节流；授权、归属和下载审计均由 UOL 执行链统一处理。 */
bindExecute(
  "operations.openLocalExportDownload",
  async (input: unknown, principal: Principal, context: OperationContext) => {
    await requireOperationsUser(principal);
    try {
      return await runObservedOperationsCall(
        "operations.openLocalExportDownload",
        context,
        async () => {
          const { taskId } =
            operationsOpenLocalExportDownloadInputSchema.parse(input);
          const response = await requestGoResponse(
            `/api/admin/operations/exports/${encodeURIComponent(taskId)}/download`,
            { method: "GET" }
          );
          const filename = response.headers
            .get("content-disposition")
            ?.match(
              /filename="(operations-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.csv)"/
            )?.[1];
          const body = response.body;
          if (
            !filename ||
            response.headers.get("content-type") !==
              "text/csv; charset=utf-8" ||
            !body
          ) {
            await body?.cancel();
            throw new OperationError("internal_error", "运营导出下载响应无效");
          }
          const stream = (async function* () {
            const reader = body.getReader();
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) return;
                yield chunk.value;
              }
            } finally {
              await reader.cancel();
              reader.releaseLock();
            }
          })();
          return operationsOpenLocalExportDownloadOutputSchema.parse({
            taskId,
            filename,
            contentType: "text/csv; charset=utf-8",
            stream,
          });
        },
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
          await requestGoJson("/api/jobs/operations/exports/process", {
            method: "POST",
            body: JSON.stringify({ limit }),
            headers: process.env.CRON_SECRET
              ? { authorization: `Bearer ${process.env.CRON_SECRET}` }
              : undefined,
          })
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
          await requestGoJson("/api/jobs/operations/exports/expire", {
            method: "POST",
            body: JSON.stringify({ limit }),
            headers: process.env.CRON_SECRET
              ? { authorization: `Bearer ${process.env.CRON_SECRET}` }
              : undefined,
          })
        ),
      (result) => ({ rowCount: result.processed })
    );
  }
);
