/**
 * 运营总览 Playwright 场景共享助手。
 *
 * 使用方：权限、筛选、下钻、导出、图表、移动端与可访问性 spec。助手只封装稳定
 * 路由和可访问选择器，不隐藏断言或业务等待条件。
 */

import { expect, type Page } from "@playwright/test";

/** 打开管理员运营总览并等待首屏一致快照。 */
export async function openOperationsDashboard(page: Page): Promise<void> {
  await page.goto("/zh/dashboard/admin/operations");
  await expect(
    page.getByRole("heading", { level: 1, name: "运营总览" })
  ).toBeVisible();
  const dashboard = page.locator("main.container > div[aria-busy]");
  await expect(dashboard).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("heading", { name: "用户增长与活跃" })
  ).toBeVisible();
}

/** 返回标题命中的 shadcn Card，供卡片内动作精确定位。 */
export function getCardByTitle(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({
    has: page.locator('[data-slot="card-title"]', { hasText: title }),
  });
}

/** 将 yyyy-MM-dd 文本解析为 UTC 日序，避免本机夏令时影响天数断言。 */
export function toUtcDay(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`非法测试日期：${value}`);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}
