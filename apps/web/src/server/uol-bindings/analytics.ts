/**
 * 用户 Analytics UOL 真实执行绑定。
 *
 * 使用方：uol-bindings.ts 启动副作用导入。所有查询均通过 Go API 读取统一读模型；
 * Web session Principal 只用于权限和限流，账号时区与数据范围由 Go 后端统一解析。
 */
import {
  adminDataDashboardInputSchema,
  adminDataDashboardUserSearchInputSchema,
  adminDataDashboardUserSearchOutputSchema,
  dataDashboardOutputSchema,
  usageSummaryOutputSchema,
  usageTrendsInputSchema,
  usageTrendsOutputSchema,
} from "@repo/shared/analytics/contracts";
import { isAdminRole } from "@repo/shared/auth/roles";
import { checkRateLimit } from "@repo/shared/rate-limit";
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";
import { requestGoJson } from "@/server/go-backend-client";

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
    const result = await requestGoJson<{
      status: "ready";
      snapshot: unknown;
    }>("/api/analytics/data-dashboard", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return dataDashboardOutputSchema.parse(result.snapshot);
  }
);

/** 绑定全站或指定用户数据看板；范围固定为应用时区且仅人工管理员可读。 */
bindExecute(
  "analytics.getAdminDataDashboard",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "user" || !isAdminRole(principal.role)) {
      throw new OperationError("forbidden", "Administrator access required");
    }
    const rateLimit = await checkRateLimit(
      `admin-analytics-dashboard:${principal.userId}`,
      "global"
    );
    if (!rateLimit.success) {
      throw new OperationError(
        "rate_limited",
        "Admin data dashboard requests are too frequent"
      );
    }
    const parsedInput = adminDataDashboardInputSchema.parse(input);
    const result = await requestGoJson<{
      status: "ready";
      snapshot: unknown;
    }>("/api/admin/analytics/data-dashboard", {
      method: "POST",
      body: JSON.stringify(parsedInput),
    });
    return dataDashboardOutputSchema.parse(result.snapshot);
  }
);

/** 绑定管理员数据看板用户下拉搜索；仅返回名称、邮箱和稳定用户 ID。 */
bindExecute(
  "analytics.searchAdminDataDashboardUsers",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "user" || !isAdminRole(principal.role)) {
      throw new OperationError("forbidden", "Administrator access required");
    }
    const rateLimit = await checkRateLimit(
      `admin-analytics-dashboard-users:${principal.userId}`,
      "global"
    );
    if (!rateLimit.success) {
      throw new OperationError(
        "rate_limited",
        "Admin data dashboard user searches are too frequent"
      );
    }
    const parsedInput = adminDataDashboardUserSearchInputSchema.parse(input);
    const query = new URLSearchParams({
      query: parsedInput.query,
      limit: String(parsedInput.limit),
    });
    if (parsedInput.selectedUserId) {
      query.set("selectedUserId", parsedInput.selectedUserId);
    }
    return adminDataDashboardUserSearchOutputSchema.parse(
      await requestGoJson<unknown>(`/api/admin/analytics/users?${query}`)
    );
  }
);

/** 绑定本人近 24 小时摘要 operation，保留既有 user/API Key 兼容行为。 */
bindExecute(
  "analytics.getMyUsageSummary",
  async (_input: Record<string, never>, principal: Principal) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    return usageSummaryOutputSchema.parse(
      await requestGoJson<unknown>("/api/analytics/summary")
    );
  }
);

/** 绑定本人趋势 operation，保留既有时区范围和单指标语义。 */
bindExecute(
  "analytics.getMyUsageTrends",
  async (input: unknown, principal: Principal) => {
    if (principal.type !== "user" && principal.type !== "apiKey") {
      throw new OperationError("unauthenticated", "User identity required");
    }
    const parsed = usageTrendsInputSchema.parse(input);
    return usageTrendsOutputSchema.parse(
      await requestGoJson<unknown>("/api/analytics/trends", {
        method: "POST",
        body: JSON.stringify(parsed),
      })
    );
  }
);
