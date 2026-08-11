/**
 * 管理端数据看板首屏装配器测试。
 *
 * 使用方：Vitest；证明页面只构造真实管理员 Principal 并调用单个全站 UOL operation，
 * 不在 RSC 层读取数据库或拼装多个时间点的统计。
 */
import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { describe, expect, it, vi } from "vitest";

import { loadAdminDataDashboardPageData } from "./admin-data-dashboard-page-data";

const snapshot = { marker: "admin-snapshot" } as unknown as DataDashboardOutput;

describe("loadAdminDataDashboardPageData", () => {
  it("用管理员 Principal 调用一次全站 operation", async () => {
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockResolvedValue(snapshot),
    };

    await expect(
      loadAdminDataDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          rangeInput: { startDate: "2026-08-03", endDate: "2026-08-09" },
        },
        dependencies
      )
    ).resolves.toBe(snapshot);
    expect(dependencies.ensureInitialized).toHaveBeenCalledOnce();
    expect(dependencies.invokeDashboard).toHaveBeenCalledWith(
      { startDate: "2026-08-03", endDate: "2026-08-09" },
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expect(dependencies.invokeDashboard).toHaveBeenCalledOnce();
  });

  it("原样上抛 operation 失败，不构造空数据", async () => {
    const error = new Error("admin analytics unavailable");
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockRejectedValue(error),
    };

    await expect(
      loadAdminDataDashboardPageData(
        { userId: "admin-1", role: "super_admin", rangeInput: {} },
        dependencies
      )
    ).rejects.toBe(error);
  });
});
