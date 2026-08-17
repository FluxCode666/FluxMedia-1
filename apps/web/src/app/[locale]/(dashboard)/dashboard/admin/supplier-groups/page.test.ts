/**
 * 分组管理独立页面的服务端权限边界测试。
 *
 * 使用方：apps/web Vitest。仅 mock 会话、角色、翻译、分页和面板，证明越权请求不会
 * 在页面守卫前读取分组依赖，也不连接数据库或 UOL。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const redirectError = new Error("NEXT_REDIRECT");
  return {
    canViewImageBackendPool: vi.fn(),
    getLocale: vi.fn(),
    getServerSession: vi.fn(),
    getTranslations: vi.fn(),
    getUserRoleById: vi.fn(),
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
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getLocale: mocks.getLocale,
  getTranslations: mocks.getTranslations,
}));
vi.mock("@/features/pagination/server", () => ({
  loadPaginationConfig: mocks.loadPaginationConfig,
}));
vi.mock("@/features/image-backend-pool/backend-group-admin-panel", () => ({
  BackendGroupAdminPanel: mocks.panel,
}));

import DashboardAdminSupplierGroupsPage from "./page";

describe("DashboardAdminSupplierGroupsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocale.mockResolvedValue("zh");
    mocks.getTranslations.mockResolvedValue((key: string) => key);
    mocks.loadPaginationConfig.mockResolvedValue({ pageSizeOptions: [10] });
  });

  it("未登录时在角色、翻译和分页读取前跳转登录", async () => {
    mocks.getServerSession.mockResolvedValue(null);

    await expect(DashboardAdminSupplierGroupsPage()).rejects.toBe(
      mocks.redirectError
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/zh/sign-in");
    expect(mocks.getUserRoleById).not.toHaveBeenCalled();
    expect(mocks.getTranslations).not.toHaveBeenCalled();
    expect(mocks.loadPaginationConfig).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
  });

  it("普通用户在翻译、分页和面板读取前跳转 dashboard", async () => {
    mocks.getServerSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserRoleById.mockResolvedValue("user");
    mocks.canViewImageBackendPool.mockReturnValue(false);

    await expect(DashboardAdminSupplierGroupsPage()).rejects.toBe(
      mocks.redirectError
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/zh/dashboard");
    expect(mocks.getTranslations).not.toHaveBeenCalled();
    expect(mocks.loadPaginationConfig).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
  });

  it.each([
    ["observer_admin", true],
    ["admin", false],
    ["super_admin", false],
  ] as const)("%s 传递正确的分组只读状态", async (role, readOnly) => {
    mocks.getServerSession.mockResolvedValue({ user: { id: `${role}-1` } });
    mocks.getUserRoleById.mockResolvedValue(role);
    mocks.canViewImageBackendPool.mockReturnValue(true);

    const page = (await DashboardAdminSupplierGroupsPage()) as {
      props: { children: unknown };
    };

    expect(mocks.getTranslations).toHaveBeenCalledWith("Dashboard.pages");
    expect(mocks.loadPaginationConfig).toHaveBeenCalledOnce();
    const children = page.props.children as readonly unknown[];
    const panel = children[1] as { props: Record<string, unknown> };
    expect(panel.props).toMatchObject({
      paginationConfig: { pageSizeOptions: [10] },
      readOnly,
      readOnlyNotice: "groupReadOnlyNotice",
      title: "groupManagement",
    });
  });
});
