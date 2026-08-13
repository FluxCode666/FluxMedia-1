/**
 * API 视频提交恢复迁移顺序回归测试。
 *
 * 职责：防止功能分支复用已被主线占用的迁移编号或修改已可能执行的历史迁移，
 * 确保 Drizzle 会在主线 0090 之后执行完整、幂等的视频提交恢复迁移。
 * 使用方：数据库包 Node 测试。
 * 关键依赖：drizzle journal 与 0091_video_submission_retry.sql。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const databasePackageRoot = resolve(scriptsDirectory, "..");
const drizzleDirectory = resolve(databasePackageRoot, "drizzle");
const journalPath = resolve(drizzleDirectory, "meta/_journal.json");
const migrationPath = resolve(
  drizzleDirectory,
  "0091_video_submission_retry.sql"
);
const conflictingMigrationPath = resolve(
  drizzleDirectory,
  "0087_video_submission_retry.sql"
);
const MAIN_0090_MIGRATION_TIMESTAMP = 1786600800000;

/** 读取并验证 journal 中的视频提交恢复迁移登记。 */
test("视频提交恢复迁移排在主线 0090 之后", () => {
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const entryIndex = journal.entries.findIndex(
    (candidate) => candidate.tag === "0091_video_submission_retry"
  );
  const entry = journal.entries[entryIndex];
  const previousEntry = journal.entries[entryIndex - 1];

  assert.deepEqual(entry, {
    idx: 91,
    version: "7",
    when: 1786636800000,
    tag: "0091_video_submission_retry",
    breakpoints: true,
  });
  assert.deepEqual(previousEntry, {
    idx: 90,
    version: "7",
    when: MAIN_0090_MIGRATION_TIMESTAMP,
    tag: "0090_media_history_count_projection",
    breakpoints: true,
  });
  assert.ok(entry.when > MAIN_0090_MIGRATION_TIMESTAMP);
  assert.equal(existsSync(migrationPath), true);
  assert.equal(existsSync(conflictingMigrationPath), false);
});

/** 确保补偿迁移包含恢复 Worker 运行所需的完整数据库形态。 */
test("0091 是可补齐已执行旧迁移环境的完整幂等迁移", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");

  assert.match(
    migrationSql,
    /ADD COLUMN IF NOT EXISTS "refund_exhausted_at" timestamp/u
  );
  assert.match(
    migrationSql,
    /CREATE TABLE IF NOT EXISTS "video_generation_submission_attempt"/u
  );
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS\s+"video_generation_submission_attempt_task_created_idx"/u
  );
  assert.doesNotMatch(migrationSql, /\n  \)\n\);\n\nCREATE INDEX/u);
});
