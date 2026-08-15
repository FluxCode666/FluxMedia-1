/**
 * 运营总览 Playwright 全局夹具生命周期。
 *
 * 使用方：playwright.config.ts。测试前重建隔离 PostgreSQL 夹具，测试后删除固定用户
 * 及其级联状态；不可变 epoch 保留，重复运行仍使用同一统计起点。
 */

import type { FullConfig } from "@playwright/test";

import { requireOperationsE2EEnvironment } from "./environment";
import {
  cleanupOperationsE2EFixture,
  seedOperationsE2EFixture,
} from "./fixture";
import { cleanupOperationsE2EStorage } from "./fixture-exports";

/** 建立隔离夹具，并返回 Playwright 调用的清理函数。 */
export default async function globalSetup(
  _config: FullConfig
): Promise<() => Promise<void>> {
  const environment = requireOperationsE2EEnvironment();
  await cleanupOperationsE2EStorage(environment);
  await seedOperationsE2EFixture(environment);
  return async () => {
    await cleanupOperationsE2EFixture(environment);
    await cleanupOperationsE2EStorage(environment);
  };
}
