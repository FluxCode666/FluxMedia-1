/**
 * 运营总览真实登录认证状态生成器。
 *
 * 使用方：Playwright setup project。四种角色都通过公开登录表单建立 Better Auth
 * session，再保存 storageState；不写 Cookie、不调用测试后门。
 */

import { mkdir } from "node:fs/promises";

import { expect, type Page, test as setup } from "@playwright/test";

import {
  getOperationsAuthStatePath,
  OPERATIONS_AUTH_STATE_DIRECTORY,
  OPERATIONS_E2E_USERS,
  type OperationsE2EUserRole,
  requireOperationsE2EEnvironment,
} from "./environment";

const environment = requireOperationsE2EEnvironment();

/** 等待 React 为登录表单安装事件属性，防止过早点击退化成原生 GET 提交。 */
async function waitForClientHydration(page: Page): Promise<void> {
  await page.locator("form").waitFor();
  await page.waitForFunction(() => {
    const form = document.querySelector("form");
    return Boolean(
      form && Object.keys(form).some((key) => key.startsWith("__reactProps$"))
    );
  });
}

/** 通过真实邮箱密码表单登录并保存指定角色会话。 */
async function authenticateRole(
  page: Page,
  role: OperationsE2EUserRole
): Promise<void> {
  const fixture = OPERATIONS_E2E_USERS[role];
  await page.goto("/zh/sign-in?callbackUrl=%2Fzh%2Fdashboard");
  await waitForClientHydration(page);
  await page.getByLabel("邮箱").fill(fixture.email);
  await page.getByLabel("密码").fill(environment.password);
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page).toHaveURL(/\/zh\/dashboard(?:\?|$)/);
  await page.context().storageState({ path: getOperationsAuthStatePath(role) });
}

for (const role of Object.keys(
  OPERATIONS_E2E_USERS
) as OperationsE2EUserRole[]) {
  setup(`建立 ${role} 真实会话`, async ({ page }) => {
    await mkdir(OPERATIONS_AUTH_STATE_DIRECTORY, { recursive: true });
    await authenticateRole(page, role);
  });
}
