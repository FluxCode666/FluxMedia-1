/**
 * 管理端运营总览页面的 session 权限边界测试。
 *
 * 使用方：apps/web Vitest。隔离页面依赖，验证被封禁管理员在角色查询和 UOL 首屏
 * 加载前即被拒绝，避免绕过 Action 与下载路由的 banned 守卫。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const redirectError = new Error("NEXT_REDIRECT");
  return {
    getLocale: vi.fn(),
    getServerSession: vi.fn(),
    getUserRoleById: vi.fn(),
    loadPageData: vi.fn(),
    redirect: vi.fn(() => {
      throw redirectError;
    }),
    redirectError,
  };
});

vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));

vi.mock("next-intl/server", () => ({
  getLocale: mocks.getLocale,
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock(
  "@/features/operations-dashboard/operations-dashboard-page-data",
  () => ({
    loadOperationsDashboardPageData: mocks.loadPageData,
  })
);

vi.mock("@/features/operations-dashboard/operations-dashboard-panel", () => ({
  OperationsDashboardPanel: () => null,
}));

vi.mock("@/i18n/routing", () => ({ redirect: mocks.redirect }));

import OperationsDashboardPage from "./page";

describe("OperationsDashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocale.mockResolvedValue("zh");
  });

  it("被封禁管理员在角色和运营数据读取前重定向", async () => {
    mocks.getServerSession.mockResolvedValue({
      user: { banned: true, id: "banned-admin-1" },
    });

    await expect(
      OperationsDashboardPage({ searchParams: Promise.resolve({}) })
    ).rejects.toBe(mocks.redirectError);

    expect(mocks.redirect).toHaveBeenCalledWith({
      href: "/dashboard",
      locale: "zh",
    });
    expect(mocks.getUserRoleById).not.toHaveBeenCalled();
    expect(mocks.loadPageData).not.toHaveBeenCalled();
  });
});
