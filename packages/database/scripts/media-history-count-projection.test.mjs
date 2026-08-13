/**
 * 媒体历史精确计数投影迁移静态契约测试。
 *
 * 使用方：database test。无需 PostgreSQL 即可阻止触发器、重建、漂移校验或读取函数
 * 被意外删除；真实事务行为与查询计划由发布 PostgreSQL 验收脚本覆盖。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const databaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = resolve(
  databaseRoot,
  "drizzle/0090_media_history_count_projection.sql"
);

/** 读取并返回手写迁移 SQL；读取失败直接让测试失败。 */
async function readMigration() {
  return readFile(migrationPath, "utf8");
}

test("媒体历史投影由数据库触发器覆盖图片和视频写入", async () => {
  const migration = await readMigration();

  assert.match(migration, /CREATE TRIGGER generation_history_count_projection_write/);
  assert.match(
    migration,
    /CREATE TRIGGER video_generation_history_count_projection_write/
  );
  assert.match(migration, /AFTER INSERT OR DELETE OR UPDATE OF/);
  assert.match(migration, /OLD\.usage_log_visible IS NOT DISTINCT FROM NEW\.usage_log_visible/);
});

test("媒体历史投影提供可重入重建、漂移检查与精确读取", async () => {
  const migration = await readMigration();

  assert.match(migration, /FUNCTION rebuild_media_history_count_projection/);
  assert.match(
    migration,
    /FUNCTION media_history_count_projection_drift_count/
  );
  assert.match(migration, /FUNCTION media_history_exact_count/);
  assert.match(migration, /SELECT rebuild_media_history_count_projection\(\)/);
  assert.match(
    migration,
    /media_history_count_projection_drift_count\(\) <> 0/
  );
});
