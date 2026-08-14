/**
 * 运营总览专用 Playwright 配置。
 *
 * 职责：强制隔离 PostgreSQL/Redis、启动本机 Next.js、建立真实角色会话，并把桌面、
 * 390px、axe 与 reduced-motion 场景留在显式命令中，不加入普通 turbo test。
 */

import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  buildOperationsWebEnvironment,
  getOperationsAuthStatePath,
  requireOperationsE2EEnvironment,
} from "./e2e/operations-dashboard/environment";

const environment = requireOperationsE2EEnvironment();
const repositoryRoot = resolve(import.meta.dirname, "../..");
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
);
const commonTestIgnore = [
  "**/auth.setup.ts",
  "**/operations-dashboard-mobile.spec.ts",
  "**/operations-dashboard-reduced-motion.spec.ts",
];

export default defineConfig({
  testDir: "./e2e/operations-dashboard",
  outputDir: "./test-results/operations-dashboard",
  snapshotPathTemplate:
    "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
  globalSetup: "./e2e/operations-dashboard/global-setup.ts",
  use: {
    baseURL: environment.baseUrl,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: "disabled", caret: "hide" },
  },
  webServer: {
    command: `node node_modules/next/dist/bin/next dev --turbopack --port ${environment.port}`,
    cwd: resolve(repositoryRoot, "apps/web"),
    env: {
      ...inheritedEnvironment,
      ...buildOperationsWebEnvironment(environment),
    },
    url: `${environment.baseUrl}/zh/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium-desktop",
      dependencies: ["setup"],
      testIgnore: commonTestIgnore,
      use: {
        ...devices["Desktop Chrome"],
        storageState: getOperationsAuthStatePath("admin"),
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "chromium-mobile-390",
      dependencies: ["setup"],
      testMatch: [
        "**/operations-dashboard-mobile.spec.ts",
        "**/operations-dashboard-visual.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
        storageState: getOperationsAuthStatePath("admin"),
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "chromium-reduced-motion",
      dependencies: ["setup"],
      testMatch: "**/operations-dashboard-reduced-motion.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        contextOptions: { reducedMotion: "reduce" },
        storageState: getOperationsAuthStatePath("admin"),
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
