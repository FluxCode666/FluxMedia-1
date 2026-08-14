/**
 * 运营总览 reduced-motion 浏览器门禁。
 *
 * 使用方：启用 prefers-reduced-motion 的专用 Chromium 项目。验证媒体查询生效，且
 * 图表键盘数据点的自定义高度/颜色过渡被 Tailwind motion-reduce 明确关闭。
 */

import { expect, test } from "@playwright/test";

import { getCardByTitle, openOperationsDashboard } from "./test-helpers";

test("图表键盘点在 reduced-motion 下没有 CSS transition", async ({ page }) => {
  await openOperationsDashboard(page);
  expect(
    await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
  ).toBe(true);
  const point = getCardByTitle(page, "生图数量")
    .getByRole("list", { name: "使用左右方向键浏览图表数据点" })
    .getByRole("button")
    .first();
  await expect(point).toBeVisible();
  expect(
    await point.evaluate(
      (element) => getComputedStyle(element).transitionProperty
    )
  ).toBe("none");
});
