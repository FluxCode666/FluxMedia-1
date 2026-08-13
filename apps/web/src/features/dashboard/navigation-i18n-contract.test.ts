/**
 * 控制台生成入口多语言文案契约测试。
 *
 * 使用方：apps/web Vitest。确保生成入口的菜单和顶部标题在所有已支持语言中使用动作
 * 名称，避免不同位置或 locale 的文案不同步。
 */

import { describe, expect, it } from "vitest";
import { dashboardNav } from "@repo/shared/config/nav";

import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";

describe("控制台生成入口多语言契约", () => {
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
});
