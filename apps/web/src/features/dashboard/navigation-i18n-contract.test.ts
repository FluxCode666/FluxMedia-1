/**
 * 控制台生成入口多语言文案契约测试。
 *
 * 使用方：apps/web Vitest。确保生成入口的菜单和顶部标题在所有已支持语言中使用动作
 * 名称，避免不同位置或 locale 的文案不同步。
 */

import { dashboardNav } from "@repo/shared/config/nav";
import { describe, expect, it } from "vitest";

import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";
import { buildAdministrationItems } from "./sidebar-navigation";

describe("控制台生成入口多语言契约", () => {
  it("为模型配置和供应商管理提供独立的中英文导航文案", () => {
    expect(enMessages.Dashboard.nav.modelConfiguration).toBe(
      "Model Configuration"
    );
    expect(zhMessages.Dashboard.nav.modelConfiguration).toBe("模型配置");
    expect(enMessages.Dashboard.nav.supplierManagement).toBe(
      "Supplier Management"
    );
    expect(zhMessages.Dashboard.nav.supplierManagement).toBe("供应商管理");
    expect(enMessages.Dashboard.nav.groupManagement).toBe("Group Management");
    expect(zhMessages.Dashboard.nav.groupManagement).toBe("分组管理");
    expect(enMessages.Dashboard.pages.modelConfiguration).toBe(
      "Model Configuration"
    );
    expect(zhMessages.Dashboard.pages.modelConfiguration).toBe("模型配置");
    expect(enMessages.Dashboard.pages.supplierManagement).toBe(
      "Supplier Management"
    );
    expect(zhMessages.Dashboard.pages.supplierManagement).toBe("供应商管理");
    expect(enMessages.Dashboard.pages.groupManagement).toBe("Group Management");
    expect(zhMessages.Dashboard.pages.groupManagement).toBe("分组管理");
    expect("imageBackendPool" in enMessages.Dashboard.nav).toBe(false);
    expect("imageBackendPool" in zhMessages.Dashboard.nav).toBe(false);
  });

  it("角色菜单指向两个独立管理路由且仅超管看到系统设置", () => {
    const observerHrefs = buildAdministrationItems("observer_admin").map(
      (item) => item.href
    );
    const adminHrefs = buildAdministrationItems("admin").map(
      (item) => item.href
    );
    const superAdminHrefs = buildAdministrationItems("super_admin").map(
      (item) => item.href
    );

    expect(observerHrefs).toContain("/dashboard/admin/model-configuration");
    expect(observerHrefs).toContain("/dashboard/admin/suppliers");
    expect(observerHrefs).toContain("/dashboard/admin/supplier-groups");
    expect(observerHrefs).toContain("/dashboard/admin/status");
    expect(observerHrefs).toContain("/dashboard/admin/history");
    expect(observerHrefs).not.toContain("/dashboard/admin/settings");
    expect(adminHrefs).toContain("/dashboard/admin/model-configuration");
    expect(adminHrefs).toContain("/dashboard/admin/suppliers");
    expect(adminHrefs).toContain("/dashboard/admin/supplier-groups");
    expect(adminHrefs.indexOf("/dashboard/admin/suppliers")).toBeLessThan(
      adminHrefs.indexOf("/dashboard/admin/supplier-groups")
    );
    expect(superAdminHrefs).toContain("/dashboard/admin/supplier-groups");
    expect(adminHrefs).not.toContain("/dashboard/admin/settings");
    expect(superAdminHrefs).toContain("/dashboard/admin/settings");
  });

  it("在中英文菜单和顶部标题中使用对应的生成动作名称", () => {
    expect(enMessages.Dashboard.nav.generate).toBe("Generate");
    expect(zhMessages.Dashboard.nav.generate).toBe("生成");
    expect(enMessages.Dashboard.pages.generate).toBe("Generate");
    expect(zhMessages.Dashboard.pages.generate).toBe("生成");
  });

  it("在中英文菜单和页面标题中提供独立数据看板文案", () => {
    expect(enMessages.Dashboard.nav.analytics).toBe("Data dashboard");
    expect(zhMessages.Dashboard.nav.analytics).toBe("数据看板");
    expect(enMessages.Dashboard.pages.analytics).toBe("Data dashboard");
    expect(zhMessages.Dashboard.pages.analytics).toBe("数据看板");
    expect(dashboardNav[0]?.items.slice(0, 2).map((item) => item.href)).toEqual(
      ["/dashboard", "/dashboard/analytics"]
    );
  });

  it("为管理端全站数据看板提供独立导航与页面标题", () => {
    expect(enMessages.Dashboard.nav.adminAnalytics).toBe("Data Dashboard");
    expect(zhMessages.Dashboard.nav.adminAnalytics).toBe("数据看板");
    expect(enMessages.Dashboard.pages.adminAnalytics).toBe("Data Dashboard");
    expect(zhMessages.Dashboard.pages.adminAnalytics).toBe("数据看板");
    expect(zhMessages.AdminDataDashboard.charts.images).toBe("生图数量");
    expect(zhMessages.AdminDataDashboard.charts.videos).toBe("视频");
  });

  it("为管理端运营总览提供独立导航与页面标题", () => {
    expect(enMessages.Dashboard.nav.operations).toBe("Operations Dashboard");
    expect(zhMessages.Dashboard.nav.operations).toBe("运营总览");
    expect(enMessages.Dashboard.pages.operations).toBe("Operations Dashboard");
    expect(zhMessages.Dashboard.pages.operations).toBe("运营总览");
  });
});
