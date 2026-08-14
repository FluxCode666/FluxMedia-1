/**
 * 运营总览 axe 与基本焦点语义门禁。
 *
 * 使用方：桌面 Chromium 项目。扫描运营 main 区域的 WCAG A/AA 规则，并验证页面
 * 主标题、图表等价表和下钻 dialog 均可从可访问树读取。
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { getCardByTitle, openOperationsDashboard } from "./test-helpers";

test.beforeEach(async ({ page }) => openOperationsDashboard(page));

test("运营主区域没有 axe WCAG A/AA 违规", async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("图表等价表与明细 dialog 具有可访问名称", async ({ page }) => {
  const imageCard = getCardByTitle(page, "生图数量");
  await imageCard.locator("summary", { hasText: "查看数据表" }).click();
  await expect(
    imageCard.getByRole("table", { name: "生图数量趋势数据表" })
  ).toBeVisible();

  await page.getByRole("button", { name: "核对生图明细" }).click();
  const dialog = page.getByRole("dialog", { name: "生图明细" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("仅列成功图片产物")).toBeVisible();
});
