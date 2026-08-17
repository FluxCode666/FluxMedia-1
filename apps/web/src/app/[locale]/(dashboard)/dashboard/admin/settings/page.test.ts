/**
 * 系统设置页面的高敏角色边界测试。
 *
 * 使用方：apps/web Vitest。证明只有 super_admin 能在时区读取和页签装配前进入系统设置，
 * 避免模型配置或供应商入口拆分后重新暴露高敏配置。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const redirectError = new Error("NEXT_REDIRECT");
  return {
    canManageUserPermissions: vi.fn(),
    getLocale: vi.fn(),
    getServerSession: vi.fn(),
    getUserRoleById: vi.fn(),
    getUserTimeZone: vi.fn(),
    settingsTabs: vi.fn(() => null),
    redirect: vi.fn(() => {
      throw redirectError;
    }),
    redirectError,
  };
});

vi.mock("@repo/shared/auth/roles", () => ({
  canManageUserPermissions: mocks.canManageUserPermissions,
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));
vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: mocks.getServerSession,
}));
vi.mock("@repo/shared/time-zone/server", () => ({
  getUserTimeZone: mocks.getUserTimeZone,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({ getLocale: mocks.getLocale }));
vi.mock("./admin-settings-tabs", () => ({
  AdminSettingsTabs: mocks.settingsTabs,
}));

import DashboardAdminSettingsPage from "./page";

describe("DashboardAdminSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocale.mockResolvedValue("zh");
    mocks.getUserTimeZone.mockResolvedValue("Asia/Shanghai");
  });

  it("未登录时跳转登录且不读取角色或时区", async () => {
    mocks.getServerSession.mockResolvedValue(null);

    await expect(DashboardAdminSettingsPage()).rejects.toBe(
      mocks.redirectError
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/zh/sign-in");
    expect(mocks.getUserRoleById).not.toHaveBeenCalled();
    expect(mocks.getUserTimeZone).not.toHaveBeenCalled();
    expect(mocks.settingsTabs).not.toHaveBeenCalled();
  });

  it.each([
    "observer_admin",
    "admin",
    "user",
  ] as const)("%s 不能进入高敏系统设置", async (role) => {
    mocks.getServerSession.mockResolvedValue({ user: { id: `${role}-1` } });
    mocks.getUserRoleById.mockResolvedValue(role);
    mocks.canManageUserPermissions.mockReturnValue(false);

    await expect(DashboardAdminSettingsPage()).rejects.toBe(
      mocks.redirectError
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/zh/dashboard");
    expect(mocks.getUserTimeZone).not.toHaveBeenCalled();
    expect(mocks.settingsTabs).not.toHaveBeenCalled();
  });

  it("super_admin 只装配系统设置和推广奖励页签", async () => {
    mocks.getServerSession.mockResolvedValue({
      user: { id: "super-admin-1" },
    });
    mocks.getUserRoleById.mockResolvedValue("super_admin");
    mocks.canManageUserPermissions.mockReturnValue(true);

    const page = (await DashboardAdminSettingsPage()) as {
      props: Record<string, unknown>;
    };

    expect(mocks.getUserTimeZone).toHaveBeenCalledWith("super-admin-1");
    expect(page.props).toEqual({
      canManageSystemSettings: true,
      timeZone: "Asia/Shanghai",
    });
  });
});
