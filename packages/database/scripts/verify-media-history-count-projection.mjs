/**
 * 媒体历史精确计数投影的隔离 PostgreSQL 验收。
 *
 * 使用方：发布前人工/CI 数据库门。脚本在现有数据库事务内创建随机隔离 schema，
 * 运行真实迁移、触发器、状态迁移、删除、漂移和重建场景，最后无条件回滚；不会
 * 读取或修改业务 schema 数据。输出只包含计数与 EXPLAIN 节点，不打印连接信息。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import pg from "pg";

const databaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(databaseRoot, "../..");
const migrationPath = resolve(
  databaseRoot,
  "drizzle/0090_media_history_count_projection.sql"
);

/** 加载项目根环境；已注入的变量优先且不会被覆盖。 */
function loadProjectEnvironment() {
  dotenv.config({ path: resolve(projectRoot, ".env.local") });
  dotenv.config({ path: resolve(projectRoot, ".env") });
}

/** 读取必需数据库 URL；缺失时明确失败，不尝试默认连接。 */
function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置，无法执行投影验收");
  return databaseUrl;
}

/** 从单行单列 PostgreSQL 结果收窄为安全整数。 */
function parseSafeCount(result, field) {
  const value = Number(result.rows[0]?.[field]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`投影验收返回非法计数：${field}`);
  }
  return value;
}

/** 断言精确计数，失败时只报告场景和数值，不泄露业务数据。 */
function assertCount(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} 计数错误：expected=${expected} actual=${actual}`);
  }
}

/** 在当前隔离 schema 读取投影精确总数。 */
async function readExactCount(client, input) {
  const result = await client.query(
    `select media_history_exact_count(
      $1, $2, $3, $4, $5, $6, $7, $8
    ) as total_count`,
    [
      input.scopeKind,
      input.ownerUserId,
      input.mediaType,
      input.status,
      input.model,
      input.start,
      input.end,
      input.asOf,
    ]
  );
  return parseSafeCount(result, "total_count");
}

/** 执行隔离迁移和触发器验收；任何成功/失败路径最终都回滚。 */
async function verifyProjection() {
  loadProjectEnvironment();
  const schemaName = `projection_verify_${randomBytes(8).toString("hex")}`;
  const client = new pg.Client({
    application_name: "fluxmedia-media-history-projection-verify",
    connectionString: requireDatabaseUrl(),
    connectionTimeoutMillis: 10_000,
    options: "-c timezone=UTC",
    query_timeout: 30_000,
  });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET LOCAL search_path TO "${schemaName}"`);
    await client.query(`
      CREATE TABLE "generation" (
        "id" text PRIMARY KEY,
        "user_id" text NOT NULL,
        "usage_log_visible" boolean,
        "status" text NOT NULL,
        "model" text NOT NULL,
        "created_at" timestamp without time zone NOT NULL
      );
      CREATE TABLE "video_generation" (
        "id" text PRIMARY KEY,
        "user_id" text NOT NULL,
        "usage_log_visible" boolean,
        "status" text NOT NULL,
        "model" text NOT NULL,
        "created_at" timestamp without time zone NOT NULL
      );
      CREATE INDEX generation_verify_count_idx
        ON generation (user_id, created_at DESC, id DESC, status, model);
      CREATE INDEX generation_verify_global_idx
        ON generation (created_at DESC, id DESC, status, model, user_id);
      CREATE INDEX video_generation_verify_count_idx
        ON video_generation (user_id, created_at DESC, id DESC, status, model);
      CREATE INDEX video_generation_verify_global_idx
        ON video_generation (created_at DESC, id DESC, status, model, user_id);
    `);

    await client.query(`
      INSERT INTO generation (
        id, user_id, usage_log_visible, status, model, created_at
      )
      SELECT
        'bench-image-' || series::text,
        'bench-user-' || (series % 10)::text,
        (series % 3 = 0),
        CASE
          WHEN series % 5 = 0 THEN 'failed'
          WHEN series % 2 = 0 THEN 'completed'
          ELSE 'pending'
        END,
        'bench-image-model-' || (series % 5)::text,
        timestamp '2025-01-01 00:00:00' + series * interval '1 minute'
      FROM generate_series(1, 50000) AS series;
      INSERT INTO video_generation (
        id, user_id, usage_log_visible, status, model, created_at
      )
      SELECT
        'bench-video-' || series::text,
        'bench-user-' || (series % 10)::text,
        (series % 3 = 0),
        CASE
          WHEN series % 7 = 0 THEN 'failed'
          WHEN series % 2 = 0 THEN 'completed'
          ELSE 'running'
        END,
        'bench-video-model-' || (series % 5)::text,
        timestamp '2025-01-01 00:00:00' + series * interval '1 minute'
      FROM generate_series(1, 50000) AS series;
    `);

    await client.query(await readFile(migrationPath, "utf8"));
    await client.query(`
      INSERT INTO generation VALUES
        ('image-1', 'user-1', true, 'pending', 'image-model', '2026-08-10 01:00:00'),
        ('image-2', 'user-1', null, 'completed', 'image-model', '2026-08-11 03:00:00'),
        ('image-3', 'user-2', false, 'failed', 'other-model', '2026-08-12 04:00:00');
      INSERT INTO video_generation VALUES
        ('video-1', 'user-1', true, 'running', 'video-model', '2026-08-11 10:00:00'),
        ('video-2', 'user-1', true, 'completed', 'video-model', '2026-08-12 11:00:00');
    `);

    assertCount(
      "global all-time",
      await readExactCount(client, {
        scopeKind: "global",
        ownerUserId: "",
        mediaType: null,
        status: null,
        model: null,
        start: null,
        end: null,
        asOf: "2026-08-13 00:00:00",
      }),
      100005
    );
    assertCount(
      "owner filtered",
      await readExactCount(client, {
        scopeKind: "owner",
        ownerUserId: "user-1",
        mediaType: null,
        status: "completed",
        model: null,
        start: null,
        end: null,
        asOf: "2026-08-13 00:00:00",
      }),
      2
    );
    assertCount(
      "UTC boundary days",
      await readExactCount(client, {
        scopeKind: "global",
        ownerUserId: "",
        mediaType: null,
        status: null,
        model: null,
        start: "2026-08-10 12:00:00",
        end: "2026-08-12 12:00:00",
        asOf: "2026-08-13 00:00:00",
      }),
      4
    );
    assertCount(
      "asOf upper bound",
      await readExactCount(client, {
        scopeKind: "global",
        ownerUserId: "",
        mediaType: null,
        status: null,
        model: null,
        start: null,
        end: null,
        asOf: "2026-08-11 05:00:00",
      }),
      100002
    );

    await client.query(`
      UPDATE generation SET status = 'failed' WHERE id = 'image-1';
      UPDATE video_generation SET status = 'completed' WHERE id = 'video-1';
      UPDATE generation SET model = model WHERE id = 'image-2';
      DELETE FROM generation WHERE id = 'image-3';
    `);
    assertCount(
      "status transition",
      await readExactCount(client, {
        scopeKind: "owner",
        ownerUserId: "user-1",
        mediaType: "image",
        status: "failed",
        model: null,
        start: null,
        end: null,
        asOf: "2026-08-13 00:00:00",
      }),
      1
    );

    assertCount(
      "trigger drift",
      parseSafeCount(
        await client.query(
          "select media_history_count_projection_drift_count() as drift_count"
        ),
        "drift_count"
      ),
      0
    );
    await client.query(`
      UPDATE media_history_count_projection
      SET record_count = record_count + 1
      WHERE ctid IN (
        SELECT ctid FROM media_history_count_projection
        WHERE scope_kind = 'global'
          AND bucket_kind = 'all_time'
          AND media_type = 'image'
        LIMIT 1
      )
    `);
    const drifted = parseSafeCount(
      await client.query(
        "select media_history_count_projection_drift_count() as drift_count"
      ),
      "drift_count"
    );
    if (drifted === 0) throw new Error("人工漂移未被检测");
    await client.query("select rebuild_media_history_count_projection()");
    assertCount(
      "rebuild drift",
      parseSafeCount(
        await client.query(
          "select media_history_count_projection_drift_count() as drift_count"
        ),
        "drift_count"
      ),
      0
    );

    const explain = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT media_history_exact_count(
        'owner', 'user-1', null, 'completed', null,
        '2026-08-10 12:00:00', '2026-08-12 12:00:00',
        '2026-08-13 00:00:00'
      )
    `);
    const plan = explain.rows[0]?.["QUERY PLAN"]?.[0];
    if (!plan || typeof plan !== "object") {
      throw new Error("EXPLAIN 未返回结构化查询计划");
    }
    const deepCursorExplain = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id
      FROM generation
      WHERE user_id = 'bench-user-0'
        AND (created_at, id) < ('2025-02-01 00:00:00', 'bench-image-44640')
      ORDER BY created_at DESC, id DESC
      LIMIT 21
    `);
    const deepCursorPlan = deepCursorExplain.rows[0]?.["QUERY PLAN"]?.[0];
    if (!deepCursorPlan || typeof deepCursorPlan !== "object") {
      throw new Error("深游标 EXPLAIN 未返回结构化查询计划");
    }
    console.log(
      JSON.stringify({
        benchmarkFactRows: 100_000,
        deepCursorExecutionTimeMs: deepCursorPlan["Execution Time"],
        driftCount: 0,
        exactCountExecutionTimeMs: plan["Execution Time"],
        exactCountPlanningTimeMs: plan["Planning Time"],
        triggerAndRebuildVerified: true,
      })
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

await verifyProjection();
