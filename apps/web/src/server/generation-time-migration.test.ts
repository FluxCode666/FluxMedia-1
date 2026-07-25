/**
 * generation 历史时间迁移的部署安全契约测试。
 *
 * 迁移必须在旧 Web 仍可能写入时阻断并发 INSERT，按服务端 UTC 锚点逐行分类，只更新
 * 明确的旧口径记录，最后把数据库默认值切到 UTC。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "../../packages/database/drizzle/0052_normalize_generation_created_at_utc.sql"
  ),
  "utf8"
);

describe("generation UTC migration contract", () => {
  it("locks legacy writers before inspecting or converting rows", () => {
    const lockPosition = migrationSql.indexOf(
      'LOCK TABLE "generation" IN ACCESS EXCLUSIVE MODE'
    );
    const inspectionPosition = migrationSql.indexOf('FROM "generation"');
    const updatePosition = migrationSql.indexOf('UPDATE "generation"');

    expect(lockPosition).toBeGreaterThanOrEqual(0);
    expect(inspectionPosition).toBeGreaterThan(lockPosition);
    expect(updatePosition).toBeGreaterThan(inspectionPosition);
  });

  it("uses server evidence instead of the migration session time zone", () => {
    expect(migrationSql).not.toContain("current_setting('TimeZone')");
    expect(migrationSql).toContain(
      '"metadata" #>> \'{upstreamStream,startedAt}\''
    );
    expect(migrationSql).toContain("pg_input_is_valid");
    expect(migrationSql).toContain("AT TIME ZONE 'Asia/Shanghai'");
  });

  it("rejects ambiguous rows and verifies the exact update count", () => {
    expect(migrationSql).toContain("无法逐行判断 generation 时间口径");
    expect(migrationSql).toContain("GET DIAGNOSTICS updated_count = ROW_COUNT");
    expect(migrationSql).toContain("updated_count <> legacy_count");
    expect(migrationSql).toContain(
      "SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')"
    );
  });
});
