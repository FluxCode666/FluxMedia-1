/**
 * 管理端数据看板首屏装配器测试。
 *
 * 使用方：Vitest；证明页面只构造真实管理员 Principal 并调用管理员 UOL operation，
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
      searchUsers: vi.fn(),
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
    ).resolves.toEqual({
      snapshot,
      selectedUser: null,
      invalidSelectedUser: false,
      loadError: null,
    });
    expect(dependencies.ensureInitialized).toHaveBeenCalledOnce();
    expect(dependencies.invokeDashboard).toHaveBeenCalledWith(
      { startDate: "2026-08-03", endDate: "2026-08-09" },
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expect(dependencies.invokeDashboard).toHaveBeenCalledOnce();
    expect(dependencies.searchUsers).not.toHaveBeenCalled();
  });

  it("保留全站请求失败，供页面映射安全状态", async () => {
    const error = new Error("admin analytics unavailable");
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockRejectedValue(error),
      searchUsers: vi.fn(),
    };

    await expect(
      loadAdminDataDashboardPageData(
        { userId: "admin-1", role: "super_admin", rangeInput: {} },
        dependencies
      )
    ).resolves.toEqual({
      snapshot: null,
      selectedUser: null,
      invalidSelectedUser: false,
      loadError: error,
    });
  });

  it("深链带用户 ID 时读取首屏用户显示信息", async () => {
    const selectedUser = {
      id: "user-1",
      name: "张三",
      email: "zhang@example.com",
    };
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockResolvedValue(snapshot),
      searchUsers: vi.fn().mockResolvedValue({ users: [selectedUser] }),
    };

    await expect(
      loadAdminDataDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          rangeInput: { userId: "user-1" },
        },
        dependencies
      )
    ).resolves.toEqual({
      snapshot,
      selectedUser,
      invalidSelectedUser: false,
      loadError: null,
    });
    expect(dependencies.searchUsers).toHaveBeenCalledWith(
      { query: "", limit: 1, selectedUserId: "user-1" },
      { type: "user", userId: "admin-1", role: "admin" }
    );
  });

  it("用户 ID 不存在时保留日期并回退全站快照", async () => {
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockResolvedValue(snapshot),
      searchUsers: vi.fn().mockResolvedValue({ users: [] }),
    };

    await expect(
      loadAdminDataDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          rangeInput: {
            startDate: "2026-08-03",
            endDate: "2026-08-09",
            userId: "missing-user",
          },
        },
        dependencies
      )
    ).resolves.toEqual({
      snapshot,
      selectedUser: null,
      invalidSelectedUser: true,
      loadError: null,
    });
    expect(dependencies.invokeDashboard).toHaveBeenCalledWith(
      { startDate: "2026-08-03", endDate: "2026-08-09" },
      { type: "user", userId: "admin-1", role: "admin" }
    );
  });

  it("用户显示信息查询失败时原样上抛，避免静默切换统计范围", async () => {
    const error = new Error("user search unavailable");
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn(),
      searchUsers: vi.fn().mockRejectedValue(error),
    };

    await expect(
      loadAdminDataDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          rangeInput: { userId: "user-1" },
        },
        dependencies
      )
    ).rejects.toBe(error);
    expect(dependencies.invokeDashboard).not.toHaveBeenCalled();
  });

  it("指定用户看板失败时保留用户信息和原筛选供重试", async () => {
    const error = new Error("dashboard timeout");
    const selectedUser = {
      id: "user-1",
      name: "张三",
      email: "zhang@example.com",
    };
    const dependencies = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      invokeDashboard: vi.fn().mockRejectedValue(error),
      searchUsers: vi.fn().mockResolvedValue({ users: [selectedUser] }),
    };

    await expect(
      loadAdminDataDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          rangeInput: {
            startDate: "2026-08-03",
            endDate: "2026-08-09",
            userId: "user-1",
          },
        },
        dependencies
      )
    ).resolves.toEqual({
      snapshot: null,
      selectedUser,
      invalidSelectedUser: false,
      loadError: error,
    });
    expect(dependencies.invokeDashboard).toHaveBeenCalledWith(
      {
        startDate: "2026-08-03",
        endDate: "2026-08-09",
        userId: "user-1",
      },
      { type: "user", userId: "admin-1", role: "admin" }
    );
  });
});
