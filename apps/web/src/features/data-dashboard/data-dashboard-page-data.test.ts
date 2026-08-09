/**
 * 数据看板首屏装配器测试。
 *
 * 使用方：Vitest；证明 RSC 首屏只初始化一次 UOL，并以当前用户 Principal 调用单个
 * 聚合 operation，不读取数据库或拼装多份不同 asOf 的结果。
 */
import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { describe, expect, it, vi } from "vitest";

import { loadDataDashboardPageData } from "./data-dashboard-page-data";

const snapshot = { marker: "snapshot" } as unknown as DataDashboardOutput;

describe("loadDataDashboardPageData", () => {
  it("用当前用户 Principal 调用一次整页 operation", async () => {
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockResolvedValue(snapshot),
    };

    await expect(
      loadDataDashboardPageData(
        {
          userId: "session-user",
          role: "admin",
          rangeInput: { startDate: "2026-08-01", endDate: "2026-08-09" },
        },
        dependencies
      )
    ).resolves.toBe(snapshot);
    expect(dependencies.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(dependencies.invokeDashboard).toHaveBeenCalledWith(
      { startDate: "2026-08-01", endDate: "2026-08-09" },
      {
        type: "user",
        userId: "session-user",
        role: "admin",
      }
    );
    expect(dependencies.invokeDashboard).toHaveBeenCalledTimes(1);
  });

  it("原样上抛 operation 失败而不构造零快照", async () => {
    const error = new Error("analytics unavailable");
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockRejectedValue(error),
    };

    await expect(
      loadDataDashboardPageData(
        { userId: "session-user", role: "user", rangeInput: {} },
        dependencies
      )
    ).rejects.toBe(error);
  });
});
