/**
 * 数据库迁移错误脱敏器的 Node 测试。
 *
 * 职责：确保包装异常与 PostgreSQL cause 都可定位，同时数据库 URL、密码和令牌
 * 不会进入 CI 或生产部署日志。
 * 使用方：`pnpm --filter @repo/database test` 与 monorepo `turbo test`。
 * 关键依赖：Node 内置 test/assert 与 migration-error.mjs。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { describeMigrationErrorChain } from "./migration-error.mjs";

/**
 * 构造带 PostgreSQL 定位字段的嵌套错误。
 *
 * @returns 包含 Drizzle 包装层和 PostgreSQL 根因的异常链。
 * @sideEffect 无副作用。
 */
function createNestedMigrationError() {
  const databaseError = Object.assign(
    new Error(
      "duplicate object from postgresql://admin:secret@db.internal/app"
    ),
    {
      code: "42P07",
      constraint: "referral_profile_code_unique",
      detail: "password=secret token=private-token",
      schema: "public",
      table: "referral_profile",
    }
  );
  const migrationError = new Error(
    "Failed query: CREATE TABLE referral_profile"
  );
  migrationError.cause = databaseError;
  return migrationError;
}

test("保留迁移错误链的安全定位字段", () => {
  const result = describeMigrationErrorChain(createNestedMigrationError());

  assert.deepEqual(result, [
    {
      message: "Failed query: CREATE TABLE referral_profile",
      name: "Error",
    },
    {
      code: "42P07",
      constraint: "referral_profile_code_unique",
      detail: "password=[REDACTED] token=[REDACTED]",
      message: "duplicate object from [REDACTED_DATABASE_URL]",
      name: "Error",
      schema: "public",
      table: "referral_profile",
    },
  ]);
});

test("未知异常只输出稳定占位信息", () => {
  assert.deepEqual(describeMigrationErrorChain({ reason: "secret" }), [
    {
      message: "Unknown database migration error",
      name: "UnknownError",
    },
  ]);
});

test("循环 cause 不会导致无限遍历", () => {
  const error = new Error("cyclic migration failure");
  error.cause = error;

  assert.deepEqual(describeMigrationErrorChain(error), [
    {
      message: "cyclic migration failure",
      name: "Error",
    },
  ]);
});
