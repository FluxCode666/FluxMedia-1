/**
 * 运营总览页面权限浏览器验收。
 *
 * 覆盖匿名、普通用户、observer_admin、admin 与 super_admin 的真实 session 路径；
 * 所有身份来自登录表单 storageState，不绕过 Better Auth。
 */

import { expect, type Page, test } from "@playwright/test";

import { getOperationsAuthStatePath } from "./environment";

/** 收集页面未捕获异常，确保权限重定向不会留下 React 运行时错误。 */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

test.describe("匿名访问", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("重定向到本地化登录页", async ({ page }) => {
    await page.goto("/zh/dashboard/admin/operations");
    await expect(page).toHaveURL(/\/zh\/sign-in(?:\?|$)/);
    await expect(page.getByRole("button", { name: "继续" })).toBeVisible();
  });
});

test.describe("普通用户访问", () => {
  test.use({ storageState: getOperationsAuthStatePath("user") });

  test("拒绝运营总览并回到用户 dashboard", async ({ page }) => {
    const pageErrors = collectPageErrors(page);
    await page.goto("/zh/dashboard/admin/operations");
    await expect(page).toHaveURL(/\/zh\/dashboard(?:\?|$)/);
    await expect(
      page.getByRole("heading", { level: 1, name: "运营总览" })
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("观察员管理员访问", () => {
  test.use({ storageState: getOperationsAuthStatePath("observer_admin") });

  test("拒绝运营总览并回到用户 dashboard", async ({ page }) => {
    const pageErrors = collectPageErrors(page);
    await page.goto("/zh/dashboard/admin/operations");
    await expect(page).toHaveURL(/\/zh\/dashboard(?:\?|$)/);
    await expect(
      page.getByRole("heading", { level: 1, name: "运营总览" })
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("管理员访问", () => {
  test.use({ storageState: getOperationsAuthStatePath("admin") });

  test("允许 admin 读取完整页面", async ({ page }) => {
    await page.goto("/zh/dashboard/admin/operations");
    await expect(
      page.getByRole("heading", { level: 1, name: "运营总览" })
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "系统健康" })).toBeVisible();
  });
});

test.describe("超级管理员访问", () => {
  test.use({ storageState: getOperationsAuthStatePath("super_admin") });

  test("允许 super_admin 读取完整页面", async ({ page }) => {
    await page.goto("/zh/dashboard/admin/operations");
    await expect(
      page.getByRole("heading", { level: 1, name: "运营总览" })
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "异步数据导出" })
    ).toBeVisible();
  });
});
