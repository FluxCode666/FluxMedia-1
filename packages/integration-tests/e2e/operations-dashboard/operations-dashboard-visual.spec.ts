/**
 * 运营总览首屏视觉回归。
 *
 * 使用方：桌面与 390px Chromium 项目。动态快照时间、日期范围和指标值被遮罩，
 * 基线只比较增长优先的信息架构、响应式换行、卡片密度与操作区位置。
 */

import { expect, test } from "@playwright/test";

import { openOperationsDashboard } from "./test-helpers";

test("运营总览首屏布局保持稳定", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cookie-consent", "essential");
    localStorage.setItem(
      "cookie-preferences",
      JSON.stringify({ analytics: false, marketing: false })
    );
  });
  await openOperationsDashboard(page);
  await expect(page).toHaveScreenshot("operations-dashboard-first-view.png", {
    fullPage: false,
    mask: [
      page.getByText(/应用时区：/),
      page
        .locator("header")
        .getByRole("button", { name: /\d{4}-\d{2}-\d{2}/ })
        .first(),
      page.locator("[data-status]"),
    ],
  });
});
