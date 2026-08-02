import { describe, expect, it } from "vitest";

import {
  canAccessAdminArea,
  canActOnTargetRole,
  canManageUserPermissions,
  canViewGlobalUsageRecords,
  canViewImageBackendPool,
  isAdminRole,
  normalizeUserRole,
} from "./roles";

// 守护审计 C-H6：四个角色对三道能力门的越权边界全部用表驱动断言。
// observer_admin 必须能看后端池但绝不能进后台/管权限；admin 能进后台但
// 仅 super_admin 能管权限。任一常量数组被误改即应有用例失败。
describe("角色能力门矩阵", () => {
  const cases: Array<{
    role: string;
    backendPool: boolean;
    globalUsageRecords: boolean;
    adminArea: boolean;
    managePermissions: boolean;
  }> = [
    {
      role: "user",
      backendPool: false,
      globalUsageRecords: false,
      adminArea: false,
      managePermissions: false,
    },
    {
      role: "observer_admin",
      backendPool: true,
      globalUsageRecords: true,
      adminArea: false,
      managePermissions: false,
    },
    {
      role: "admin",
      backendPool: true,
      globalUsageRecords: true,
      adminArea: true,
      managePermissions: false,
    },
    {
      role: "super_admin",
      backendPool: true,
      globalUsageRecords: true,
      adminArea: true,
      managePermissions: true,
    },
  ];

  for (const {
    role,
    backendPool,
    globalUsageRecords,
    adminArea,
    managePermissions,
  } of cases) {
    it(`${role} 的四道能力门符合预期`, () => {
      expect(canViewImageBackendPool(role)).toBe(backendPool);
      expect(canViewGlobalUsageRecords(role)).toBe(globalUsageRecords);
      expect(canAccessAdminArea(role)).toBe(adminArea);
      expect(canManageUserPermissions(role)).toBe(managePermissions);
    });
  }

  it("isAdminRole 仅 admin 与 super_admin 为真", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("super_admin")).toBe(true);
    expect(isAdminRole("observer_admin")).toBe(false);
    expect(isAdminRole("user")).toBe(false);
  });

  it("normalizeUserRole 对未知/空值回退 user", () => {
    expect(normalizeUserRole("admin")).toBe("admin");
    expect(normalizeUserRole("observer_admin")).toBe("observer_admin");
    expect(normalizeUserRole("bogus-role")).toBe("user");
    expect(normalizeUserRole("")).toBe("user");
    expect(normalizeUserRole(null)).toBe("user");
    expect(normalizeUserRole(undefined)).toBe("user");
  });
});

// 守护审计 S-H5 的目标权限护栏：防止普通 admin 封禁/锁死 super_admin 或越级互操作。
describe("canActOnTargetRole", () => {
  it("超管可操作任意账户（含其他超管）", () => {
    expect(canActOnTargetRole("super_admin", "super_admin")).toBe(true);
    expect(canActOnTargetRole("super_admin", "admin")).toBe(true);
    expect(canActOnTargetRole("super_admin", "observer_admin")).toBe(true);
    expect(canActOnTargetRole("super_admin", "user")).toBe(true);
  });

  it("普通 admin 不能操作超管或同级 admin（核心修复）", () => {
    expect(canActOnTargetRole("admin", "super_admin")).toBe(false);
    expect(canActOnTargetRole("admin", "admin")).toBe(false);
  });

  it("普通 admin 仅能操作权限严格更低的账户", () => {
    expect(canActOnTargetRole("admin", "observer_admin")).toBe(true);
    expect(canActOnTargetRole("admin", "user")).toBe(true);
  });

  it("observer_admin 不能操作 admin/超管", () => {
    expect(canActOnTargetRole("observer_admin", "admin")).toBe(false);
    expect(canActOnTargetRole("observer_admin", "super_admin")).toBe(false);
    expect(canActOnTargetRole("observer_admin", "user")).toBe(true);
  });

  it("非法/缺省角色按 user 处理，且 user 不能操作任何人", () => {
    expect(canActOnTargetRole("user", "user")).toBe(false);
    expect(canActOnTargetRole(null, "user")).toBe(false);
    expect(canActOnTargetRole("admin", null)).toBe(true);
    expect(canActOnTargetRole("admin", "bogus-role")).toBe(true);
  });
});
