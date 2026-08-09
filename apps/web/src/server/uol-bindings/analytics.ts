/**
 * 用户 Analytics UOL 真实执行绑定。
 *
 * 使用方：uol-bindings.ts 启动副作用导入。既有摘要/趋势保持兼容；新数据看板只接受
 * session user Principal，并在数据库事务前执行每用户 global 限流和账号时区解析。
 */
import {
  dataDashboardOutputSchema,
  usageSummaryOutputSchema,
  usageTrendsInputSchema,
  usageTrendsOutputSchema,
} from "@repo/shared/analytics/contracts";
import { resolveUsageTimeRange } from "@repo/shared/analytics/range";
import { getAnalyticsMetricUnit } from "@repo/shared/analytics/series";
import { checkRateLimit } from "@repo/shared/rate-limit";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";

import {
  DataDashboardServiceError,
  loadDataDashboardSnapshot,
} from "@/features/data-dashboard/data-dashboard-service";
import {
  type AnalyticsReadModelState,
  loadOutputUsageSummary,
  loadOutputUsageTrends,
  readAnalyticsReadModelStates,
} from "@/features/dashboard/analytics-service";

/** 判断单个既有统计读模型是否达到当前线上查询所需版本。 */
function isAnalyticsReadModelReady(state: AnalyticsReadModelState): boolean {
  return state?.version === 1 && state.status === "ready";
}

/** 查询既有 analytics readiness，未完成回填时返回相同暂不可用错误。 */
async function assertAnalyticsReady(): Promise<void> {
  const states = await readAnalyticsReadModelStates();
  if (
    !isAnalyticsReadModelReady(states.outputUsage) ||
    !isAnalyticsReadModelReady(states.creditUsage)
  ) {
    throw new OperationError(
      "not_ready",
      "Analytics data is still being prepared",
      undefined,
      503
    );
  }
}

/** 将数据看板服务错误映射为 UOL 稳定错误，不暴露损坏行或 SQL。 */
function throwDataDashboardOperationError(error: unknown): never {
  if (error instanceof DataDashboardServiceError) {
    if (error.code === "validation_error") {
      throw new OperationError("validation_error", error.message);
    }
    if (error.code === "not_ready") {
      throw new OperationError("not_ready", error.message, undefined, 503);
    }
    throw new OperationError(
      "internal_error",
      "Analytics data is temporarily unavailable"
    );
  }
  throw error;
}

/** 绑定本人整页数据看板；身份只取 session Principal，且事务前按用户限流。 */
bindExecute(
  "analytics.getMyDataDashboard",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "user") {
      throw new OperationError(
        "unauthenticated",
        "User session authentication required"
      );
    }
    const rateLimit = await checkRateLimit(
      `analytics-dashboard:${principal.userId}`,
      "global"
    );
    if (!rateLimit.success) {
      throw new OperationError(
        "rate_limited",
        "Data dashboard requests are too frequent"
      );
    }
    const timeZone = await getUserTimeZone(principal.userId);
    try {
      return dataDashboardOutputSchema.parse(
        await loadDataDashboardSnapshot({
          userId: principal.userId,
          timeZone,
          rangeInput: input,
        })
      );
    } catch (error) {
      throwDataDashboardOperationError(error);
    }
  }
);

/** 绑定本人近 24 小时摘要 operation，保留既有 user/API Key 兼容行为。 */
bindExecute(
  "analytics.getMyUsageSummary",
  async (_input: Record<string, never>, principal: Principal) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    await assertAnalyticsReady();
    const timeZone = await getUserTimeZone(principal.userId);
    const asOf = new Date();
    const last24HoursRange = {
      start: new Date(asOf.getTime() - 24 * 60 * 60 * 1000),
      end: asOf,
    };
    const result = await loadOutputUsageSummary({
      userId: principal.userId,
      last24HoursRange,
    });
    return usageSummaryOutputSchema.parse({
      asOf: asOf.toISOString(),
      timeZone,
      last24HoursRange: {
        start: last24HoursRange.start.toISOString(),
        end: last24HoursRange.end.toISOString(),
      },
      last24Hours: result.last24Hours,
      modelDistribution: result.modelDistribution,
      lifetime: result.lifetime,
    });
  }
);

/** 绑定本人趋势 operation，保留既有时区范围和单指标语义。 */
bindExecute(
  "analytics.getMyUsageTrends",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    await assertAnalyticsReady();
    const parsed = usageTrendsInputSchema.parse(input);
    const timeZone = await getUserTimeZone(principal.userId);
    let range: ReturnType<typeof resolveUsageTimeRange>;
    try {
      range = resolveUsageTimeRange(parsed, {
        timeZone,
        asOf: new Date(),
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new OperationError("validation_error", error.message);
      }
      throw error;
    }
    const result = await loadOutputUsageTrends({
      userId: principal.userId,
      range,
    });
    return usageTrendsOutputSchema.parse({
      asOf: range.asOf.toISOString(),
      timeZone,
      range: { start: range.start.toISOString(), end: range.end.toISOString() },
      granularity: range.granularity,
      metric: range.metric,
      unit: getAnalyticsMetricUnit(range.metric),
      buckets: result.buckets,
      distribution: result.distribution,
    });
  }
);
