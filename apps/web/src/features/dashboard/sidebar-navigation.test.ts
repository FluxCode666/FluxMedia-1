/**
 * Dashboard 侧栏角色菜单与 active 路径纯函数测试。
 *
 * 使用方：apps/web Vitest。测试不加载 React、会话或数据库，锁定角色可见性、locale
 * 规范化和最长前缀匹配，避免菜单状态回归影响真实管理路由。
 */
import { describe, expect, it } from "vitest";

import {
  buildAdministrationItems,
  findMostSpecificActiveHref,
  normalizeSidebarPath,
} from "./sidebar-navigation";

describe("sidebar navigation", () => {
  it.each([
    ["user", []],
    [
      "observer_admin",
      [
        "/dashboard/admin/status",
        "/dashboard/admin/history",
        "/dashboard/admin/model-configuration",
        "/dashboard/admin/suppliers",
        "/dashboard/admin/image-size-configs",
        "/dashboard/admin/supplier-groups",
      ],
    ],
    [
      "admin",
      [
        "/dashboard/admin/status",
        "/dashboard/admin/analytics",
        "/dashboard/admin/operations",
        "/dashboard/admin/users",
        "/dashboard/admin/history",
        "/dashboard/admin/payments",
        "/dashboard/admin/announcements",
        "/dashboard/admin/model-configuration",
        "/dashboard/admin/suppliers",
        "/dashboard/admin/image-size-configs",
        "/dashboard/admin/supplier-groups",
      ],
    ],
    [
      "super_admin",
      [
        "/dashboard/admin/status",
        "/dashboard/admin/analytics",
        "/dashboard/admin/operations",
        "/dashboard/admin/users",
        "/dashboard/admin/history",
        "/dashboard/admin/payments",
        "/dashboard/admin/announcements",
        "/dashboard/admin/model-configuration",
        "/dashboard/admin/suppliers",
        "/dashboard/admin/image-size-configs",
        "/dashboard/admin/supplier-groups",
        "/dashboard/admin/settings",
      ],
    ],
  ] as const)("builds the expected menu for %s", (role, expectedHrefs) => {
    expect(buildAdministrationItems(role).map((item) => item.href)).toEqual(
      expectedHrefs
    );
  });

  it("normalizes locale-prefixed paths", () => {
    expect(normalizeSidebarPath("/en/dashboard/admin/suppliers")).toBe(
      "/dashboard/admin/suppliers"
    );
    expect(normalizeSidebarPath("/zh")).toBe("/");
  });

  it("uses the longest matching href for nested routes", () => {
    const items = [
      { title: "Payments", href: "/dashboard/admin/payments" },
      {
        title: "Orders",
        href: "/dashboard/admin/payments/orders",
      },
    ];

    expect(
      findMostSpecificActiveHref(
        "/zh/dashboard/admin/payments/orders/42",
        items
      )
    ).toBe("/dashboard/admin/payments/orders");
    expect(
      findMostSpecificActiveHref("/en/dashboard/admin/payments", items)
    ).toBe("/dashboard/admin/payments");
  });

  it("激活本地化的分组管理深层路径", () => {
    const items = [
      { title: "Supplier Management", href: "/dashboard/admin/suppliers" },
      {
        title: "Group Management",
        href: "/dashboard/admin/supplier-groups",
      },
    ];

    expect(
      findMostSpecificActiveHref(
        "/zh/dashboard/admin/supplier-groups/group-primary/members",
        items
      )
    ).toBe("/dashboard/admin/supplier-groups");
  });
});
