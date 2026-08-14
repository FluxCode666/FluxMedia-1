/**
 * 运营总览图表交互浏览器验收。
 *
 * 覆盖视频数量/秒数切换、真实 Recharts 图面 hover 浮窗，以及完整序列键盘点的 focus
 * 与方向键 roving tabindex，确保鼠标和键盘都能读取精确桶值。
 */

import { expect, test } from "@playwright/test";

import { getCardByTitle, openOperationsDashboard } from "./test-helpers";

test.beforeEach(async ({ page }) => openOperationsDashboard(page));

test("视频数量与视频秒数在同一日期快照内切换", async ({ page }) => {
  const videoCard = getCardByTitle(page, "视频");
  const countButton = videoCard.getByRole("button", {
    name: "视频数量",
    exact: true,
  });
  const secondsButton = videoCard.getByRole("button", {
    name: "视频秒数",
    exact: true,
  });
  await expect(countButton).toHaveAttribute("aria-pressed", "true");
  const currentUrl = page.url();
  await secondsButton.click();
  await expect(secondsButton).toHaveAttribute("aria-pressed", "true");
  await expect(videoCard.getByRole("img")).toHaveAttribute(
    "aria-label",
    /视频秒数/
  );
  await expect(page).toHaveURL(currentUrl);
});

test("hover 浮窗展示真实点日期和值", async ({ page }) => {
  const imageCard = getCardByTitle(page, "生图数量");
  const chart = imageCard.getByRole("img", { name: "生图数量" });
  await chart.scrollIntoViewIfNeeded();
  const bounds = await chart.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("生图图表缺少可交互边界");
  await page.mouse.move(
    bounds.x + bounds.width - 18,
    bounds.y + bounds.height / 2
  );
  const tooltip = imageCard.locator(".recharts-tooltip-wrapper");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("2026");
  await expect(tooltip).toContainText("3");
});

test("键盘焦点读数与方向键浏览完整序列", async ({ page }) => {
  const imageCard = getCardByTitle(page, "生图数量");
  const navigation = imageCard.getByRole("list", {
    name: "使用左右方向键浏览图表数据点",
  });
  const points = navigation.getByRole("button");
  expect(await points.count()).toBeGreaterThan(1);
  await points.first().focus();
  const firstLabel = await points.first().getAttribute("aria-label");
  await page.keyboard.press("ArrowRight");
  await expect(points.nth(1)).toBeFocused();
  const secondLabel = await points.nth(1).getAttribute("aria-label");
  expect(secondLabel).not.toBe(firstLabel);
  await page.keyboard.press("End");
  await expect(points.last()).toBeFocused();
});
