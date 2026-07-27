/**
 * PostgreSQL 集成测试配置。
 *
 * 职责：只承载显式 integration test 目标，禁止被普通 turbo test 自动发现。
 * 使用方：发布前专用数据库门禁。
 * 关键依赖：Vitest；测试文件自行验证专用数据库 URL 与迁移状态。
 */
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "../../apps/web/src"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["src/*.test.ts"],
    hookTimeout: 20_000,
    testTimeout: 20_000,
  },
});
