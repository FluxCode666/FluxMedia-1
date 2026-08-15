/**
 * 运营总览 390px 窄屏浏览器验收。
 *
 * 验证单月日历、页面无横向溢出、内容图与导出入口可达；不以桌面 DOM 顺序或固定
 * 像素坐标定位交互。
 */

import { expect, test } from "@playwright/test";

import { openOperationsDashboard } from "./test-helpers";

test("390px 下保持单列布局且页面无横向溢出", async ({ page }) => {
  await openOperationsDashboard(page);
  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
  );
  expect(hasHorizontalOverflow).toBe(false);
  await expect(page.getByRole("heading", { name: "内容生产" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出内容生产", exact: true })
  ).toBeVisible();
});

test("390px 自定义日历只展示一个月份", async ({ page }) => {
  await openOperationsDashboard(page);
  await page
    .locator("header")
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2}/ })
    .first()
    .click();
  await expect(page.getByText("自定义日期范围", { exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(1);
});
