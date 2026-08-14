/**
 * 运营总览日期范围、快捷项、粒度与 URL 保持浏览器验收。
 *
 * 使用真实 Server Action 重新读取整页，验证默认近 30 日、本周/月/年、自定义范围
 * 和日周月切换不会丢失其它筛选参数。
 */

import { expect, test } from "@playwright/test";

import {
  openOperationsDashboard,
  toUtcDay,
  waitForOperationsDashboardReady,
} from "./test-helpers";

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ page }) => openOperationsDashboard(page));

test("默认范围包含今天在内的近 30 个自然日", async ({ page }) => {
  const rangeButton = page
    .locator("header")
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2}/ })
    .first();
  const label = (await rangeButton.textContent())?.trim() ?? "";
  const dates = label.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  expect(dates).toHaveLength(2);
  expect(toUtcDay(dates[1] ?? "") - toUtcDay(dates[0] ?? "")).toBe(29);
  await expect(
    page.getByRole("button", { name: "日", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
});

test("本周、本月、本年快捷项更新完整页面", async ({ page }) => {
  for (const [label, range] of [
    ["本周", "this_week"],
    ["本月", "this_month"],
    ["本年", "this_year"],
  ] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`\\?range=${range}$`), {
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: label, exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await waitForOperationsDashboardReady(page);
  }
});

test("自定义范围在日周月切换和刷新后保持", async ({ page }) => {
  await page
    .locator("header")
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2}/ })
    .first()
    .click();
  await page.getByRole("button", { name: "2026年8月1日 星期六" }).click();
  await expect(
    page.getByRole("button", { name: "应用", exact: true })
  ).toBeDisabled();
  await page.getByRole("button", { name: "2026年8月14日 星期五" }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page).toHaveURL(
    /\?range=custom&from=2026-08-01&to=2026-08-14$/
  );
  await waitForOperationsDashboardReady(page);
  await expect(
    page.getByRole("button", { name: "2026-08-01 – 2026-08-14" })
  ).toBeVisible();

  for (const [label, granularity] of [
    ["周", "week"],
    ["月", "month"],
    ["日", "day"],
  ] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const expectedSearch =
      granularity === "day"
        ? "range=custom&from=2026-08-01&to=2026-08-14"
        : `range=custom&from=2026-08-01&to=2026-08-14&granularity=${granularity}`;
    await expect(page).toHaveURL(new RegExp(`\\?${expectedSearch}$`));
    await waitForOperationsDashboardReady(page);
  }

  const currentUrl = page.url();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page).toHaveURL(currentUrl);
  await waitForOperationsDashboardReady(page);
});

test("桌面自定义日历使用双月布局并禁用未来日期", async ({ page }) => {
  await page
    .locator("header")
    .getByRole("button", { name: /\d{4}-\d{2}-\d{2}/ })
    .first()
    .click();
  await expect(page.getByText("自定义日期范围", { exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(2);
  const rangeLabel =
    (await page
      .locator("header")
      .getByRole("button", { name: /\d{4}-\d{2}-\d{2}/ })
      .first()
      .textContent()) ?? "";
  const endDate = rangeLabel.match(/\d{4}-\d{2}-\d{2}/g)?.at(-1);
  if (!endDate) throw new Error("运营日期范围缺少结束日期");
  const futureDate = new Date((toUtcDay(endDate) + 1) * 86_400_000);
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"] as const;
  const futureDateLabel = `${futureDate.getUTCFullYear()}年${
    futureDate.getUTCMonth() + 1
  }月${futureDate.getUTCDate()}日 星期${weekdays[futureDate.getUTCDay()]}`;
  await expect(
    page.getByRole("button", { name: futureDateLabel })
  ).toBeDisabled();
});
