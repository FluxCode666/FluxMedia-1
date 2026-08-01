/**
 * 视频输入清理原因列修复迁移的静态契约测试。
 *
 * 保证已运行 0065 的数据库先回填既有孤儿记录，再收紧默认值、非空与枚举约束，
 * 避免视频提交和恢复 worker 因 Drizzle schema 漂移而访问不存在的 reason 列。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "../../packages/database/drizzle/0076_video_input_cleanup_reason.sql"
  ),
  "utf8"
);

describe("video input cleanup reason migration contract", () => {
  it("adds and backfills the reason column before making it required", () => {
    const addColumnPosition = migrationSql.indexOf(
      'ADD COLUMN IF NOT EXISTS "reason" text'
    );
    const backfillPosition = migrationSql.indexOf("SET \"reason\" = 'orphan'");
    const notNullPosition = migrationSql.indexOf(
      'ALTER COLUMN "reason" SET NOT NULL'
    );

    expect(addColumnPosition).toBeGreaterThanOrEqual(0);
    expect(backfillPosition).toBeGreaterThan(addColumnPosition);
    expect(migrationSql).toContain('WHERE "reason" IS NULL');
    expect(notNullPosition).toBeGreaterThan(backfillPosition);
  });

  it("sets the runtime default and restricts cleanup reasons", () => {
    expect(migrationSql).toContain(
      "ALTER COLUMN \"reason\" SET DEFAULT 'orphan'"
    );
    expect(migrationSql).toContain(
      'DROP CONSTRAINT IF EXISTS "video_input_cleanup_reason_check"'
    );
    expect(migrationSql).toContain(
      "CHECK (\"reason\" IN ('orphan', 'lifecycle_delete'))"
    );
  });
});
