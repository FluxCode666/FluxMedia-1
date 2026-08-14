/**
 * 运营总览下钻与异步导出浏览器验收。
 *
 * 覆盖增长、内容两类同源 Sheet，以及三类导出入口和 completed、failed、expired
 * 固定状态；只在隔离数据库中创建或重试任务，不启动导出 worker。
 */

import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { requireOperationsE2EEnvironment } from "./environment";
import {
  completeLatestOperationsE2EExport,
  readOperationsE2EDownloadAuditResults,
  resetOperationsE2EExports,
  seedOperationsE2EExportHistory,
} from "./fixture";
import { getCardByTitle, openOperationsDashboard } from "./test-helpers";

const environment = requireOperationsE2EEnvironment();

test.beforeEach(async ({ page }) => {
  await resetOperationsE2EExports(environment);
  await openOperationsDashboard(page);
});

test("增长与内容明细使用可关闭并恢复焦点的 Sheet", async ({ page }) => {
  const growthCard = getCardByTitle(page, "新增用户");
  const growthTrigger = growthCard.getByRole("button", { name: "核对明细" });
  await growthTrigger.click();
  const growthDialog = page.getByRole("dialog");
  await expect(
    growthDialog.getByRole("heading", { name: "新增用户明细" })
  ).toBeVisible();
  await expect(
    growthDialog.getByRole("cell", { name: "operations-e2e-user@example.test" })
  ).toBeVisible();
  await growthDialog.getByRole("button", { name: "Close" }).click();
  await expect(growthDialog).toBeHidden();
  await expect(growthTrigger).toBeFocused();

  const contentTrigger = page.getByRole("button", { name: "核对生图明细" });
  await contentTrigger.click();
  const contentDialog = page.getByRole("dialog");
  await expect(
    contentDialog.getByRole("heading", { name: "生图明细" })
  ).toBeVisible();
  await expect(
    contentDialog.getByRole("cell", { name: "operations-e2e-image-task" })
  ).toBeVisible();
  await expect(
    contentDialog.getByRole("cell", { name: "12.34" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contentDialog).toBeHidden();
  await expect(contentTrigger).toBeFocused();
});

test("三类导出入口创建任务并保留当前筛选", async ({ page }) => {
  const labels = ["导出用户增长", "导出商业化", "导出内容生产"] as const;
  for (const [index, label] of labels.entries()) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByText("导出任务已创建")).toBeVisible();
    if (index < labels.length - 1) await page.waitForTimeout(2_100);
  }
  const exportSection = page.getByRole("region", { name: "异步数据导出" });
  await expect(exportSection.getByText("排队中")).toHaveCount(3);
});

test("completed 下载真实 CSV 并记录审计，expired 拒绝直接下载", async ({
  page,
}) => {
  const exportSection = page.getByRole("region", { name: "异步数据导出" });
  const completed = exportSection
    .locator("article")
    .filter({ hasText: "已完成" });
  const failed = exportSection.locator("article").filter({ hasText: "失败" });
  const expired = exportSection
    .locator("article")
    .filter({ hasText: "已过期" });

  const downloadPromise = page.waitForEvent("download");
  await completed.getByRole("button", { name: "下载" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "operations-user_growth-operations-e2e-export-completed.csv"
  );
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const csv = await readFile(downloadPath as string, "utf8");
  expect(csv).toContain("记录类型,用户 ID,名称,邮箱,业务时间,角色,封禁,留存");
  expect(csv).toContain("operations-e2e-user@example.test");
  await expect
    .poll(() =>
      readOperationsE2EDownloadAuditResults(
        environment,
        "operations-e2e-export-completed"
      )
    )
    .toEqual(["granted", "started"]);

  await expect(failed.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(expired.getByRole("button", { name: "下载" })).toHaveCount(0);
  await expect(expired.getByRole("button", { name: "重新生成" })).toBeVisible();

  const expiredResponse = await page.request.get(
    "/api/admin/operations/exports/operations-e2e-export-expired/download"
  );
  expect(expiredResponse.status()).toBe(404);

  await failed.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("导出重试任务已创建")).toBeVisible();
  await expect(exportSection.getByText("排队中")).toHaveCount(1);
});

test("完成通知只提示一次，expired 可以重新生成", async ({ page }) => {
  const exportSection = page.getByRole("region", { name: "异步数据导出" });
  await page.getByRole("button", { name: "导出用户增长", exact: true }).click();
  await expect(page.getByText("导出任务已创建")).toBeVisible();
  await completeLatestOperationsE2EExport(environment);

  const refresh = exportSection.getByRole("button", {
    name: "刷新导出记录",
  });
  await refresh.click();
  const completedNotification = page.getByText("运营数据导出已完成");
  await expect(completedNotification).toHaveCount(1);
  await refresh.click();
  await expect(completedNotification).toHaveCount(1);

  await page.waitForTimeout(2_100);
  const expired = exportSection
    .locator("article")
    .filter({ hasText: "已过期" });
  await expired.getByRole("button", { name: "重新生成" }).click();
  await expect(page.getByText("导出任务已创建")).toBeVisible();
  await expect(exportSection.getByText("排队中")).toHaveCount(1);
});

test("导出记录使用签名 cursor 加载下一页", async ({ page }) => {
  await seedOperationsE2EExportHistory(environment, 21);
  await openOperationsDashboard(page);
  const exportSection = page.getByRole("region", { name: "异步数据导出" });
  const records = exportSection.locator("article");
  await expect(records).toHaveCount(20);
  await exportSection.getByRole("button", { name: "加载更多" }).click();
  await expect(records).toHaveCount(24);
  await expect(
    exportSection.getByRole("button", { name: "加载更多" })
  ).toHaveCount(0);
});
