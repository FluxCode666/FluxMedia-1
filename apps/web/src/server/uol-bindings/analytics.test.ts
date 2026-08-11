/**
 * 用户 Analytics UOL binding 的 DB-free 测试。
 *
 * 使用方：Vitest；验证数据看板只接受真实 user Principal、按用户限流、使用账号时区，
 * 并把服务层 validation/readiness/损坏分类映射为稳定 OperationError。
 */
import "@repo/shared/uol/operations";
import { invokeOperation, isOperationBound } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
  return {
    checkRateLimit: vi.fn(),
    getAppTimeZone: vi.fn(),
    getUserTimeZone: vi.fn(),
    loadDataDashboardSnapshot: vi.fn(),
    loadOutputUsageSummary: vi.fn(),
    loadOutputUsageTrends: vi.fn(),
    readAnalyticsReadModelStates: vi.fn(),
  };
});

vi.mock("@repo/shared/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@repo/shared/time-zone/server", () => ({
  getAppTimeZone: mocks.getAppTimeZone,
  getUserTimeZone: mocks.getUserTimeZone,
}));
vi.mock("@/features/data-dashboard/data-dashboard-service", () => ({
  DataDashboardServiceError: class DataDashboardServiceError extends Error {
    readonly code: "validation_error" | "not_ready" | "invalid_data";

    constructor(
      code: "validation_error" | "not_ready" | "invalid_data",
      message: string
    ) {
      super(message);
      this.name = "DataDashboardServiceError";
      this.code = code;
    }
  },
  loadDataDashboardSnapshot: mocks.loadDataDashboardSnapshot,
}));
vi.mock("@/features/dashboard/analytics-service", () => ({
  loadOutputUsageSummary: mocks.loadOutputUsageSummary,
  loadOutputUsageTrends: mocks.loadOutputUsageTrends,
  readAnalyticsReadModelStates: mocks.readAnalyticsReadModelStates,
}));

import { DataDashboardServiceError } from "@/features/data-dashboard/data-dashboard-service";
import "./analytics";

const SNAPSHOT = {
  asOf: "2026-08-09T10:15:30.000Z",
  timeZone: "Asia/Shanghai",
  today: "2026-08-09",
  range: {
    startDate: "2026-08-09",
    endDate: "2026-08-09",
    start: "2026-08-08T16:00:00.000Z",
    end: "2026-08-09T10:15:30.000Z",
  },
  metrics: {
    imageCount: 1,
    videoSeconds: 0,
    creditsConsumed: 2,
    successRate: { succeeded: 1, failed: 0, terminal: 1, rate: 1 },
    activeDays: 1,
    mostUsedModel: { model: "image-model", taskCount: 1 },
  },
  buckets: [
    {
      date: "2026-08-09",
      start: "2026-08-08T16:00:00.000Z",
      end: "2026-08-09T10:15:30.000Z",
      imageCount: 1,
      imageTaskCount: 1,
      videoCount: 0,
      videoSeconds: 0,
      creditsConsumed: 2,
    },
  ],
  taskComposition: { imageTaskCount: 1, videoCount: 0, totalTasks: 1 },
} as const;

describe("analytics.getMyDataDashboard binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 30,
      reset: Date.now() + 60_000,
    });
    mocks.getUserTimeZone.mockResolvedValue("Asia/Shanghai");
    mocks.getAppTimeZone.mockReturnValue("Asia/Shanghai");
    mocks.loadDataDashboardSnapshot.mockResolvedValue(SNAPSHOT);
  });

  it("保持既有摘要与趋势 operation 继续绑定", () => {
    expect(isOperationBound("analytics.getMyUsageSummary")).toBe(true);
    expect(isOperationBound("analytics.getMyUsageTrends")).toBe(true);
  });

  it.each([
    "user",
    "admin",
    "observer_admin",
    "super_admin",
  ] as const)("%s 会话只使用自己的 Principal 用户 ID", async (role) => {
    await expect(
      invokeOperation(
        "analytics.getMyDataDashboard",
        { startDate: "2026-08-09", endDate: "2026-08-09" },
        { type: "user", userId: `${role}-1`, role }
      )
    ).resolves.toEqual(SNAPSHOT);

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      `analytics-dashboard:${role}-1`,
      "global"
    );
    expect(mocks.getUserTimeZone).toHaveBeenCalledWith(`${role}-1`);
    expect(mocks.loadDataDashboardSnapshot).toHaveBeenCalledWith({
      userId: `${role}-1`,
      timeZone: "Asia/Shanghai",
      rangeInput: {
        startDate: "2026-08-09",
        endDate: "2026-08-09",
      },
    });
  });

  it("在 strict schema 处拒绝伪造 userId 且不进入 binding", async () => {
    await expect(
      invokeOperation(
        "analytics.getMyDataDashboard",
        {
          startDate: "2026-08-09",
          endDate: "2026-08-09",
          userId: "another-user",
        },
        { type: "user", userId: "session-user", role: "user" }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.loadDataDashboardSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { type: "system" as const, reason: "test" },
    { type: "cron" as const, job: "analytics" },
    { type: "webhook" as const, provider: "creem" as const },
    { type: "proxy" as const, secretKind: "proxy" as const },
    {
      type: "apiKey" as const,
      credentialKind: "external" as const,
      userId: "user-1",
      apiKeyId: "external-1",
    },
    {
      type: "apiKey" as const,
      credentialKind: "mcp" as const,
      userId: "user-1",
      apiKeyId: "mcp-1",
    },
  ])("拒绝非 session user Principal", async (principal) => {
    await expect(
      invokeOperation("analytics.getMyDataDashboard", {}, principal)
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(mocks.loadDataDashboardSnapshot).not.toHaveBeenCalled();
  });

  it("限流失败发生在时区和聚合事务之前", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      success: false,
      limit: 30,
      reset: Date.now() + 60_000,
    });

    await expect(
      invokeOperation(
        "analytics.getMyDataDashboard",
        {},
        { type: "user", userId: "user-1", role: "user" }
      )
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(mocks.getUserTimeZone).not.toHaveBeenCalled();
    expect(mocks.loadDataDashboardSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["validation_error", "validation_error"],
    ["not_ready", "not_ready"],
    ["invalid_data", "internal_error"],
  ] as const)("将 %s 服务错误映射为 %s", async (serviceCode, uolCode) => {
    mocks.loadDataDashboardSnapshot.mockRejectedValue(
      new DataDashboardServiceError(serviceCode, "safe failure")
    );

    await expect(
      invokeOperation(
        "analytics.getMyDataDashboard",
        {},
        { type: "user", userId: "user-1", role: "user" }
      )
    ).rejects.toMatchObject({ code: uolCode });
  });
});

describe("analytics.getAdminDataDashboard binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 30,
      reset: Date.now() + 60_000,
    });
    mocks.getAppTimeZone.mockReturnValue("Asia/Shanghai");
    mocks.loadDataDashboardSnapshot.mockResolvedValue(SNAPSHOT);
  });

  it.each([
    "admin",
    "super_admin",
  ] as const)("%s 只读取应用时区并加载全站快照", async (role) => {
    await expect(
      invokeOperation(
        "analytics.getAdminDataDashboard",
        { startDate: "2026-08-03", endDate: "2026-08-09" },
        { type: "user", userId: `${role}-1`, role }
      )
    ).resolves.toEqual(SNAPSHOT);

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      `admin-analytics-dashboard:${role}-1`,
      "global"
    );
    expect(mocks.getAppTimeZone).toHaveBeenCalledOnce();
    expect(mocks.loadDataDashboardSnapshot).toHaveBeenCalledWith({
      timeZone: "Asia/Shanghai",
      rangeInput: { startDate: "2026-08-03", endDate: "2026-08-09" },
    });
  });

  it.each([
    "user",
    "observer_admin",
  ] as const)("%s 会话被拒绝且不进入全站聚合", async (role) => {
    await expect(
      invokeOperation(
        "analytics.getAdminDataDashboard",
        {},
        { type: "user", userId: `${role}-1`, role }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.loadDataDashboardSnapshot).not.toHaveBeenCalled();
  });
});
