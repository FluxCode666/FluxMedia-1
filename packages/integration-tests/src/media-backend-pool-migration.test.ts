/**
 * 统一媒体号池破坏性迁移的真实 PostgreSQL 集成测试。
 *
 * 职责：直接执行 0060-0063 SQL，验证空旧号池可原子切换、遗留数据会阻断且完整
 * 回滚，同时锁定旧设置、套餐 JSON、回调投递表和视频 Principal 作用域。
 * 使用方：显式 `test:media-backend-pool-migration` 质量门。
 * 关键依赖：专用 MEDIA_BACKEND_POOL_MIGRATION_TEST_DATABASE_URL 与生产迁移 SQL。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

interface ExistsRow {
  exists: boolean;
}

interface JsonValueRow {
  value: Record<string, unknown>;
}

let pool: Pool | null = null;

const migrationPaths = [
  "0060_unified_media_backend_pool.sql",
  "0061_video_callback_delivery.sql",
  "0062_video_principal_scope.sql",
  "0063_video_recovery_lease_identity.sql",
].map((filename) =>
  fileURLToPath(new URL(`../../database/drizzle/${filename}`, import.meta.url))
);

/** 验证随机 schema 名并返回安全的双引号标识符。 */
function quoteSchemaName(schemaName: string): string {
  if (!/^pool_migration_[a-f0-9]+$/u.test(schemaName)) {
    throw new Error("迁移测试 schema 名非法");
  }
  return `"${schemaName}"`;
}

/** 创建最小 0059 号池 schema，使生产迁移的每个 DDL 都在真实 PostgreSQL 执行。 */
async function createLegacySchema(client: PoolClient): Promise<string> {
  const schemaName = `pool_migration_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteSchemaName(schemaName);
  await client.query(`create schema ${quotedSchema}`);
  await client.query(`set search_path to ${quotedSchema}, public`);
  await client.query(`
    create table image_backend_group (id text primary key);
    create table image_backend_account (id text primary key);
    create table image_backend_api (id text primary key);
    create table image_backend_adobe (id text primary key);
    create table image_backend_account_group (id text primary key);
    create table image_backend_api_group (id text primary key);
    create table image_backend_adobe_group (id text primary key);
    create table image_backend_inflight_lease (id text primary key);
    create table image_backend_sticky_binding (id text primary key);
    create table image_backend_scheduler_metric (id text primary key);
    create table system_setting (
      key text primary key,
      value json not null,
      updated_at timestamp not null default now()
    );
    create table adobe_account (
      id text primary key,
      adobe_id text not null,
      constraint adobe_account_adobe_id_image_backend_adobe_id_fk
        foreign key (adobe_id) references image_backend_adobe(id)
    );
    create index adobe_account_adobe_idx on adobe_account(adobe_id);
    create table adobe_token (
      id text primary key,
      adobe_id text not null,
      status text not null default 'active',
      constraint adobe_token_adobe_id_image_backend_adobe_id_fk
        foreign key (adobe_id) references image_backend_adobe(id)
    );
    create index adobe_token_adobe_idx on adobe_token(adobe_id);
    create index adobe_token_adobe_status_idx on adobe_token(adobe_id, status);
    create table video_generation (
      id text primary key,
      user_id text not null,
      api_key_id text,
      status text not null default 'pending',
      adobe_id text,
      constraint video_generation_adobe_id_image_backend_adobe_id_fk
        foreign key (adobe_id) references image_backend_adobe(id)
    )
  `);
  return schemaName;
}

/** 删除当前测试创建的随机 schema。 */
async function dropLegacySchema(
  client: PoolClient,
  schemaName: string
): Promise<void> {
  await client.query("set search_path to public");
  await client.query(`drop schema ${quoteSchemaName(schemaName)} cascade`);
}

/** 按 Drizzle statement breakpoint 执行真实连续迁移，并确保失败时整体回滚。 */
async function executeMigrations(
  client: PoolClient,
  schemaName: string
): Promise<void> {
  const migrations = await Promise.all(
    migrationPaths.map((migrationPath) => readFile(migrationPath, "utf8"))
  );
  const statements = migrations.flatMap((migrationSql) =>
    migrationSql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
  );
  await client.query("begin");
  try {
    await client.query(
      `set local search_path to ${quoteSchemaName(schemaName)}, public`
    );
    for (const statement of statements) await client.query(statement);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/** 查询指定 schema 中是否存在普通表。 */
async function tableExists(
  client: PoolClient,
  schemaName: string,
  tableName: string
): Promise<boolean> {
  const result = await client.query<ExistsRow>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = $1 and table_name = $2
     ) as exists`,
    [schemaName, tableName]
  );
  return result.rows[0]?.exists ?? false;
}

/** 查询指定表是否包含列。 */
async function columnExists(
  client: PoolClient,
  schemaName: string,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const result = await client.query<ExistsRow>(
    `select exists (
       select 1 from information_schema.columns
       where table_schema = $1 and table_name = $2 and column_name = $3
     ) as exists`,
    [schemaName, tableName, columnName]
  );
  return result.rows[0]?.exists ?? false;
}

beforeAll(() => {
  pool = new Pool({
    application_name: "fluxmedia-pool-migration-integration",
    connectionString: requireDedicatedTestDatabaseUrl(
      "MEDIA_BACKEND_POOL_MIGRATION_TEST_DATABASE_URL"
    ),
    max: 2,
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("0060-0063 unified media backend pool migrations", () => {
  it("空旧号池原子切换到统一成员模型并清理设置", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(
        "insert into system_setting (key, value) values ('PLATFORM_CHAT_MODEL', '\"retired\"'::json)"
      );
      await client.query(
        `insert into system_setting (key, value) values (
          'PLAN_CAPABILITY_MATRIX',
          '{"billing":{"free":{"chatRoundCredits":1}},"features":{"imageGeneration.chat":"free","imageGeneration.video":"pro"},"limits":{"free":{"maxChatImages":9,"maxFileMb":20}}}'::json
        )`
      );
      await client.query(
        `insert into video_generation (id, user_id, status)
         values ('legacy-video', 'user-1', 'pending')`
      );

      await executeMigrations(client, schemaName);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );

      await expect(
        tableExists(client, schemaName, "image_backend_member")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "image_backend_member_lease")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "image_backend_api")
      ).resolves.toBe(false);
      await expect(
        columnExists(client, schemaName, "adobe_account", "member_id")
      ).resolves.toBe(true);
      await expect(
        columnExists(client, schemaName, "adobe_account", "adobe_id")
      ).resolves.toBe(false);
      await expect(
        columnExists(client, schemaName, "video_generation", "stage")
      ).resolves.toBe(true);
      await expect(
        columnExists(client, schemaName, "video_generation", "adobe_id")
      ).resolves.toBe(false);
      await expect(
        columnExists(client, schemaName, "video_generation", "principal_scope")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "video_generation_callback_delivery")
      ).resolves.toBe(true);
      const principalScope = await client.query<{ principal_scope: string }>(
        `select principal_scope
         from video_generation
         where id = 'legacy-video'`
      );
      expect(principalScope.rows[0]?.principal_scope).toBe("user:user-1");
      const leaseForeignKey = await client.query<{ count: number }>(
        `select count(*)::integer as count
         from pg_constraint
         where connamespace = $1::regnamespace
           and conname =
             'video_generation_member_lease_id_image_backend_member_lease_id_fk'`,
        [schemaName]
      );
      expect(leaseForeignKey.rows[0]?.count).toBe(0);

      const removedSetting = await client.query<{ count: number }>(
        "select count(*)::integer as count from system_setting where key = 'PLATFORM_CHAT_MODEL'"
      );
      expect(removedSetting.rows[0]?.count).toBe(0);
      const matrix = await client.query<JsonValueRow>(
        "select value from system_setting where key = 'PLAN_CAPABILITY_MATRIX'"
      );
      expect(matrix.rows[0]?.value).toEqual({
        features: { "imageGeneration.video": "pro" },
        limits: { free: { maxFileMb: 20 } },
      });
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("遗留成员数据阻断迁移且不留下任何新表", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(
        "insert into image_backend_api (id) values ('legacy-api')"
      );

      await expect(executeMigrations(client, schemaName)).rejects.toThrow(
        /0060 blocked: legacy media data remains/u
      );

      await expect(
        tableExists(client, schemaName, "image_backend_api")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "image_backend_member")
      ).resolves.toBe(false);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const legacyRows = await client.query<{ count: number }>(
        "select count(*)::integer as count from image_backend_api"
      );
      expect(legacyRows.rows[0]?.count).toBe(1);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });
});
