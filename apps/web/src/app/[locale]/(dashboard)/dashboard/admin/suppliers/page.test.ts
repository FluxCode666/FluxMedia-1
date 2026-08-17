/**
 * 供应商管理独立页面的服务端权限边界测试。
 *
 * 使用方：apps/web Vitest。仅 mock 页面装配依赖，锁定三档查看角色、observer 只读状态
 * 和越权请求的早期重定向，不连接数据库、供应商 Worker 或 UOL。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const redirectError = new Error("NEXT_REDIRECT");
  return {
    canViewImageBackendPool: vi.fn(),
    getLocale: vi.fn(),
    getServerSession: vi.fn(),
    getUserRoleById: vi.fn(),
    getUserTimeZone: vi.fn(),
    loadPaginationConfig: vi.fn(),
    panel: vi.fn(() => null),
    redirect: vi.fn(() => {
      throw redirectError;
    }),
    redirectError,
  };
});

vi.mock("@repo/shared/auth/roles", () => ({
  canViewImageBackendPool: mocks.canViewImageBackendPool,
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
vi.mock("next-intl/server", () => ({
  getLocale: mocks.getLocale,
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/features/pagination/server", () => ({
  loadPaginationConfig: mocks.loadPaginationConfig,
}));
vi.mock("@/features/image-backend-pool", () => ({
  ImageBackendPoolAdminPanel: mocks.panel,
}));

import DashboardAdminSuppliersPage from "./page";

describe("DashboardAdminSuppliersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocale.mockResolvedValue("en");
    mocks.loadPaginationConfig.mockResolvedValue({ pageSizeOptions: [10] });
    mocks.getUserTimeZone.mockResolvedValue("Asia/Shanghai");
  });

  it("未登录时在角色、时区和分页读取前跳转登录", async () => {
    mocks.getServerSession.mockResolvedValue(null);

    await expect(DashboardAdminSuppliersPage()).rejects.toBe(
      mocks.redirectError
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/en/sign-in");
    expect(mocks.getUserRoleById).not.toHaveBeenCalled();
    expect(mocks.loadPaginationConfig).not.toHaveBeenCalled();
    expect(mocks.getUserTimeZone).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
  });

  it("普通用户在时区、分页和面板读取前跳转 dashboard", async () => {
    mocks.getServerSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserRoleById.mockResolvedValue("user");
    mocks.canViewImageBackendPool.mockReturnValue(false);

    await expect(DashboardAdminSuppliersPage()).rejects.toBe(
      mocks.redirectError
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/en/dashboard");
    expect(mocks.loadPaginationConfig).not.toHaveBeenCalled();
    expect(mocks.getUserTimeZone).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
  });

  it.each([
    ["observer_admin", true],
    ["admin", false],
    ["super_admin", false],
  ] as const)("%s 传递正确的只读状态", async (role, readOnly) => {
    mocks.getServerSession.mockResolvedValue({ user: { id: `${role}-1` } });
    mocks.getUserRoleById.mockResolvedValue(role);
    mocks.canViewImageBackendPool.mockReturnValue(true);

    const page = (await DashboardAdminSuppliersPage()) as {
      props: { children: unknown };
    };

    expect(mocks.getUserTimeZone).toHaveBeenCalledWith(`${role}-1`);
    expect(mocks.loadPaginationConfig).toHaveBeenCalledOnce();
    const children = page.props.children as readonly unknown[];
    const panel = children[1] as {
      props: Record<string, unknown>;
    };
    expect(panel.props).toMatchObject({
      paginationConfig: { pageSizeOptions: [10] },
      readOnly,
      readOnlyNotice: "readOnlyNotice",
      timeZone: "Asia/Shanghai",
      title: "supplierManagement",
    });
  });
});
