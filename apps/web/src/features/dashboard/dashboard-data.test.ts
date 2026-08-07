/**
 * 控制台快照装配器的 DB-free 测试。
 *
 * 验证首屏与刷新共用一次 UOL 初始化和本人身份；核心摘要失败时拒绝，非关键近期创作
 * 失败时记录脱敏原因并降级为空数组。
 */
import type { UsageSummaryOutput } from "@repo/shared/analytics/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));

import { loadDashboardSnapshot } from "./dashboard-data";

const summary = {
  asOf: "2026-07-21T05:00:00.000Z",
  timeZone: "Asia/Shanghai",
  last24HoursRange: {
    start: "2026-07-20T05:00:00.000Z",
    end: "2026-07-21T05:00:00.000Z",
  },
  last24Hours: { imageCount: 2, videoSeconds: 5, creditsConsumed: 4 },
  modelDistribution: {
    models: [
      { model: "gpt-image-1", taskCount: 2 },
      { model: "video", taskCount: 1 },
    ],
    totalTasks: 3,
  },
  lifetime: { imageCount: 20, videoSeconds: 50, creditsConsumed: 40 },
} satisfies UsageSummaryOutput;

const creditBalance = {
  balance: 96,
  totalSpent: 42,
  totalRefunded: 2,
  totalNetSpent: 40,
  status: "active",
  asOf: "2026-07-21T05:00:00.000Z",
} as const;

describe("dashboard snapshot loader", () => {
  it("loads summary and recent creations for the same user", async () => {
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      loadSummary: vi.fn().mockResolvedValue(summary),
      loadBalance: vi.fn().mockResolvedValue(creditBalance),
      loadRecentCreations: vi.fn().mockResolvedValue([]),
      reportRecentCreationsError: vi.fn(),
    };

    await expect(
      loadDashboardSnapshot({ userId: "user-1", role: "user" }, dependencies)
    ).resolves.toEqual({ summary, creditBalance, recentCreations: [] });
    expect(dependencies.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(dependencies.loadSummary).toHaveBeenCalledWith({
      userId: "user-1",
      role: "user",
    });
    expect(dependencies.loadBalance).toHaveBeenCalledWith({
      userId: "user-1",
      role: "user",
    });
    expect(dependencies.loadRecentCreations).toHaveBeenCalledWith("user-1");
  });

  it("rejects the whole snapshot when the core summary fails", async () => {
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      loadSummary: vi.fn().mockRejectedValue(new Error("summary unavailable")),
      loadBalance: vi.fn().mockResolvedValue(creditBalance),
      loadRecentCreations: vi.fn().mockResolvedValue([]),
      reportRecentCreationsError: vi.fn(),
    };

    await expect(
      loadDashboardSnapshot({ userId: "user-1", role: "user" }, dependencies)
    ).rejects.toThrow("summary unavailable");
  });

  it("rejects the whole snapshot when the credit balance fails", async () => {
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      loadSummary: vi.fn().mockResolvedValue(summary),
      loadBalance: vi.fn().mockRejectedValue(new Error("balance unavailable")),
      loadRecentCreations: vi.fn().mockResolvedValue([]),
      reportRecentCreationsError: vi.fn(),
    };

    await expect(
      loadDashboardSnapshot({ userId: "user-1", role: "user" }, dependencies)
    ).rejects.toThrow("balance unavailable");
  });

  it("keeps the core snapshot when recent creations are unavailable", async () => {
    const databaseCause = Object.assign(new Error("read ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const recentCreationsError = new Error(
      'Failed query: select * from "generation" where "user_id" = $1\n' +
        "params: private-user-id",
      { cause: databaseCause }
    );
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      loadSummary: vi.fn().mockResolvedValue(summary),
      loadBalance: vi.fn().mockResolvedValue(creditBalance),
      loadRecentCreations: vi.fn().mockRejectedValue(recentCreationsError),
      reportRecentCreationsError: vi.fn(),
    };

    await expect(
      loadDashboardSnapshot({ userId: "admin-1", role: "admin" }, dependencies)
    ).resolves.toEqual({ summary, creditBalance, recentCreations: [] });
    expect(dependencies.reportRecentCreationsError).toHaveBeenCalledWith({
      name: "Error",
      message: "read ETIMEDOUT",
      code: "ETIMEDOUT",
    });
    expect(
      JSON.stringify(dependencies.reportRecentCreationsError.mock.calls)
    ).not.toContain("private-user-id");
  });
});
