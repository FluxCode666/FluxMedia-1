/**
 * 统一媒体号池破坏性迁移的真实 PostgreSQL 集成测试。
 *
 * 职责：直接执行 0060-0063 SQL，验证 API/Adobe 旧号池可原子迁移、Adobe
 * direct 子账号可提升为顶层成员、Web 或运行中状态会阻断且完整回滚，同时
 * 锁定设置清理、回调投递和视频 Principal 作用域。
 * 使用方：显式 `test:media-backend-pool-migration` 质量门。
 * 关键依赖：专用 MEDIA_BACKEND_POOL_MIGRATION_TEST_DATABASE_URL 与生产迁移 SQL。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FIREFLY_VIDEO_MODEL_CATALOG } from "@repo/shared/adobe/firefly-direct/video-catalog";
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
    create table image_backend_account_group (id text primary key);
    create table image_backend_api (
      id text primary key,
      group_id text,
      name text not null,
      base_url text not null,
      api_key text not null,
      model text,
      interface_mode text not null default 'images',
      use_stream boolean not null default false,
      content_safety_enabled boolean not null default true,
      is_enabled boolean not null default true,
      priority integer not null default 50,
      status text not null default 'active',
      last_used_at timestamp,
      metadata json,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
      success_count integer not null default 0,
      fail_count integer not null default 0,
      last_acquired_at timestamp,
      cooldown_until timestamp,
      last_error text,
      last_error_at timestamp,
      always_active boolean not null default false,
      concurrency integer not null default 10,
      failure_cooldown_enabled boolean not null default false,
      chat_completions_upstream_mode text not null default 'responses',
      image_upstream_mode text not null default 'images',
      adobe_sourced boolean not null default false,
      billing_multiplier numeric not null default 1,
      parameter_mappings json not null default '[]'::json,
      supported_model_ids json not null default '[]'::json
    );
    create table image_backend_adobe (
      id text primary key,
      group_id text,
      name text not null,
      base_url text not null,
      api_key text not null,
      enabled_models json,
      default_ratio text not null default '1x1',
      default_resolution text not null default '2k',
      supports_video boolean not null default false,
      content_safety_enabled boolean not null default true,
      is_enabled boolean not null default true,
      always_active boolean not null default false,
      priority integer not null default 50,
      concurrency integer not null default 10,
      failure_cooldown_enabled boolean not null default false,
      success_count integer not null default 0,
      fail_count integer not null default 0,
      status text not null default 'active',
      last_used_at timestamp,
      last_acquired_at timestamp,
      cooldown_until timestamp,
      last_error text,
      last_error_at timestamp,
      metadata json,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
      mode text not null default 'gateway',
      gpt_image_quality text not null default 'high',
      billing_multiplier numeric not null default 1
    );
    create table image_backend_api_group (
      id text primary key,
      api_id text not null references image_backend_api(id) on delete cascade,
      group_id text not null references image_backend_group(id) on delete cascade,
      created_at timestamp not null default now()
    );
    create table image_backend_adobe_group (
      id text primary key,
      adobe_id text not null references image_backend_adobe(id) on delete cascade,
      group_id text not null references image_backend_group(id) on delete cascade,
      created_at timestamp not null default now()
    );
    create table image_backend_inflight_lease (
      id text primary key,
      member_type text not null,
      member_id text not null,
      expires_at timestamp not null,
      created_at timestamp not null default now()
    );
    create table image_backend_sticky_binding (
      id text primary key,
      expires_at timestamp not null
    );
    create table image_backend_scheduler_metric (
      id text primary key,
      bucket_started_at timestamp not null,
      request_kind text not null,
      selected_layer text not null,
      member_type text,
      member_id text,
      group_id text,
      select_count integer not null default 0,
      sticky_previous_hit_count integer not null default 0,
      sticky_session_hit_count integer not null default 0,
      load_balance_count integer not null default 0,
      switch_count integer not null default 0,
      candidate_count_total integer not null default 0,
      latency_ms_total integer not null default 0,
      metadata json,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table system_setting (
      key text primary key,
      value json not null,
      updated_at timestamp not null default now()
    );
    create table adobe_account (
      id text primary key,
      adobe_id text not null,
      name text not null,
      cookie text not null,
      scope text,
      is_enabled boolean not null default true,
      display_name text,
      email text,
      account_user_id text,
      status text not null default 'active',
      last_refresh_at timestamp,
      last_refresh_error text,
      next_refresh_at timestamp,
      consecutive_failures integer not null default 0,
      metadata json,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
      constraint adobe_account_adobe_id_image_backend_adobe_id_fk
        foreign key (adobe_id) references image_backend_adobe(id)
    );
    create index adobe_account_adobe_idx on adobe_account(adobe_id);
    create table adobe_token (
      id text primary key,
      adobe_id text not null,
      account_id text references adobe_account(id) on delete cascade,
      value text not null,
      account_user_id text,
      status text not null default 'active',
      fails integer not null default 0,
      source text not null default 'auto_refresh',
      expires_at timestamp,
      credits_total integer,
      credits_used integer,
      credits_available integer,
      credits_updated_at timestamp,
      credits_error text,
      last_used_at timestamp,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
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
        tableExists(client, schemaName, "adobe_account")
      ).resolves.toBe(false);
      await expect(
        tableExists(client, schemaName, "adobe_token")
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

  it("保留 API/Adobe 数据并将每个 direct 账号提升为顶层成员", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(
        "insert into image_backend_group (id) values ('group-1'), ('group-2')"
      );
      await client.query(`
        insert into image_backend_api (
          id,
          group_id,
          name,
          base_url,
          api_key,
          supported_model_ids,
          parameter_mappings,
          use_stream,
          always_active,
          success_count,
          fail_count,
          metadata
        ) values (
          'legacy-api',
          'group-1',
          'API member',
          'https://api.example.test/v1',
          'api-secret',
          '["gpt-image-2"]'::json,
          '[{"source":"size","target":"image_size","mode":"move"}]'::json,
          true,
          true,
          5,
          2,
          '{"scheduler":{"errorEwma":0.4,"failStreak":1}}'::json
        )
      `);
      await client.query(`
        insert into image_backend_api_group (id, api_id, group_id)
        values ('api-relation', 'legacy-api', 'group-1')
      `);
      await client.query(`
        insert into image_backend_adobe (
          id,
          group_id,
          name,
          base_url,
          api_key,
          enabled_models,
          supports_video,
          content_safety_enabled,
          always_active,
          priority,
          success_count,
          fail_count,
          mode,
          gpt_image_quality
        ) values (
          'legacy-adobe',
          'group-1',
          'Adobe member',
          'https://unused-direct.example.test',
          'unused-direct-secret',
          '["firefly-gpt-image-2"]'::json,
          true,
          false,
          true,
          60,
          4,
          3,
          'direct',
          'medium'
        )
      `);
      await client.query(`
        insert into image_backend_adobe_group (id, adobe_id, group_id)
        values
          ('adobe-relation-1', 'legacy-adobe', 'group-1'),
          ('adobe-relation-2', 'legacy-adobe', 'group-2')
      `);
      await client.query(`
        insert into adobe_account (
          id,
          adobe_id,
          name,
          cookie,
          scope,
          display_name,
          email,
          account_user_id,
          consecutive_failures,
          created_at
        ) values (
          'adobe-account-1',
          'legacy-adobe',
          'Account 1',
          'cookie-secret',
          'scope-1',
          'Display 1',
          'account-1@example.test',
          'adobe-user-1',
          2,
          '2026-01-01 00:00:00'
        )
      `);
      await client.query(`
        insert into adobe_account (
          id,
          adobe_id,
          name,
          cookie,
          scope,
          display_name,
          email,
          account_user_id,
          consecutive_failures,
          created_at
        ) values (
          'adobe-account-2',
          'legacy-adobe',
          'Account 2',
          'cookie-secret-2',
          'scope-2',
          'Display 2',
          'account-2@example.test',
          'adobe-user-2',
          3,
          '2026-01-02 00:00:00'
        )
      `);
      await client.query(`
        insert into adobe_token (
          id,
          adobe_id,
          account_id,
          value,
          account_user_id,
          fails,
          expires_at,
          credits_total,
          credits_used,
          credits_available
        ) values (
          'adobe-token-1',
          'legacy-adobe',
          'adobe-account-1',
          'token-secret',
          'adobe-user-1',
          1,
          '2026-08-01 00:00:00',
          100,
          58,
          42
        )
      `);
      await client.query(`
        insert into adobe_token (
          id,
          adobe_id,
          account_id,
          value,
          account_user_id,
          fails,
          expires_at,
          credits_total,
          credits_used,
          credits_available
        ) values (
          'adobe-token-2',
          'legacy-adobe',
          'adobe-account-2',
          'token-secret-2',
          'adobe-user-2',
          4,
          '2026-09-01 00:00:00',
          200,
          125,
          75
        )
      `);
      await client.query(`
        insert into image_backend_inflight_lease (
          id,
          member_type,
          member_id,
          expires_at
        ) values (
          'expired-lease-1',
          'api',
          'legacy-api',
          now() - interval '1 minute'
        )
      `);
      await client.query(`
        insert into image_backend_scheduler_metric (
          id,
          bucket_started_at,
          request_kind,
          selected_layer,
          member_type,
          member_id,
          group_id,
          select_count,
          load_balance_count,
          candidate_count_total,
          latency_ms_total
        ) values (
          'metric-1',
          date_trunc('minute', now()),
          'image_generation',
          'load_balance',
          'api',
          'legacy-api',
          'group-1',
          3,
          3,
          6,
          120
        )
      `);
      await client.query(`
        insert into video_generation (id, user_id, status, adobe_id)
        values ('legacy-adobe-video', 'user-1', 'completed', 'legacy-adobe')
      `);

      await executeMigrations(client, schemaName);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );

      const members = await client.query<{
        id: string;
        name: string;
        lease_acquired_count: number;
        metadata: { legacyUnifiedPool?: Record<string, unknown> };
        supported_model_ids: string[];
        type: string;
      }>(`
        select id, type, name, supported_model_ids, lease_acquired_count, metadata
        from image_backend_member
        order by id
      `);
      expect(members.rows).toHaveLength(3);
      expect(members.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "legacy-api",
            lease_acquired_count: 7,
            metadata: expect.objectContaining({
              legacyUnifiedPool: expect.objectContaining({
                adobeSourced: false,
                imageUpstreamMode: "images",
              }),
            }),
            type: "api",
            supported_model_ids: ["gpt-image-2"],
          }),
          expect.objectContaining({
            id: "legacy-adobe",
            lease_acquired_count: 7,
            name: "Account 1",
            metadata: expect.objectContaining({
              legacyUnifiedPool: expect.objectContaining({
                supportsVideo: true,
              }),
            }),
            type: "adobe",
            supported_model_ids: expect.arrayContaining([
              "gpt-image-2",
              "firefly-sora2-4s-9x16",
            ]),
          }),
          expect.objectContaining({
            id: "adobe-direct:adobe-account-2",
            lease_acquired_count: 0,
            name: "Account 2",
            metadata: expect.objectContaining({
              legacyAdobeDirect: {
                accountId: "adobe-account-2",
                parentMemberId: "legacy-adobe",
                promoted: true,
              },
            }),
            type: "adobe",
            supported_model_ids: expect.arrayContaining([
              "gpt-image-2",
              "firefly-sora2-4s-9x16",
            ]),
          }),
        ])
      );
      const migratedAdobeMember = members.rows.find(
        (member) => member.id === "legacy-adobe"
      );
      expect(new Set(migratedAdobeMember?.supported_model_ids)).toEqual(
        new Set(["gpt-image-2", ...Object.keys(FIREFLY_VIDEO_MODEL_CATALOG)])
      );
      const apiConfig = await client.query<{
        api_key: string;
        base_url: string;
        parameter_mappings: Array<Record<string, string>>;
        use_stream: boolean;
      }>(`
        select base_url, api_key, parameter_mappings, use_stream
        from image_backend_member_api_config
        where member_id = 'legacy-api'
      `);
      expect(apiConfig.rows[0]).toEqual({
        api_key: "api-secret",
        base_url: "https://api.example.test/v1",
        parameter_mappings: [
          { mode: "move", source: "size", target: "image_size" },
        ],
        use_stream: true,
      });
      const adobeConfigs = await client.query<{
        access_token: string | null;
        account_user_id: string | null;
        api_key: string | null;
        base_url: string | null;
        consecutive_failures: number;
        cookie: string | null;
        credential_status: string | null;
        credits_available: number | null;
        credits_total: number | null;
        credits_used: number | null;
        display_name: string | null;
        email: string | null;
        gpt_image_quality: string;
        member_id: string;
        mode: string;
        scope: string | null;
        token_fails: number;
      }>(`
        select
          member_id,
          mode,
          base_url,
          api_key,
          cookie,
          scope,
          access_token,
          account_user_id,
          display_name,
          email,
          credential_status,
          token_fails,
          consecutive_failures,
          credits_total,
          credits_used,
          credits_available,
          gpt_image_quality
        from image_backend_member_adobe_config
        order by member_id
      `);
      expect(adobeConfigs.rows).toEqual([
        {
          access_token: "token-secret-2",
          account_user_id: "adobe-user-2",
          api_key: null,
          base_url: null,
          consecutive_failures: 3,
          cookie: "cookie-secret-2",
          credential_status: "active",
          credits_available: 75,
          credits_total: 200,
          credits_used: 125,
          display_name: "Display 2",
          email: "account-2@example.test",
          gpt_image_quality: "medium",
          member_id: "adobe-direct:adobe-account-2",
          mode: "direct",
          scope: "scope-2",
          token_fails: 4,
        },
        {
          access_token: "token-secret",
          account_user_id: "adobe-user-1",
          api_key: null,
          base_url: null,
          consecutive_failures: 2,
          cookie: "cookie-secret",
          credential_status: "active",
          credits_available: 42,
          credits_total: 100,
          credits_used: 58,
          display_name: "Display 1",
          email: "account-1@example.test",
          gpt_image_quality: "medium",
          member_id: "legacy-adobe",
          mode: "direct",
          scope: "scope-1",
          token_fails: 1,
        },
      ]);
      await expect(
        tableExists(client, schemaName, "adobe_account")
      ).resolves.toBe(false);
      await expect(
        tableExists(client, schemaName, "adobe_token")
      ).resolves.toBe(false);
      const relations = await client.query<{
        group_id: string;
        member_id: string;
      }>(`
        select member_id, group_id
        from image_backend_member_group
        order by member_id, group_id
      `);
      expect(relations.rows).toEqual([
        {
          group_id: "group-1",
          member_id: "adobe-direct:adobe-account-2",
        },
        {
          group_id: "group-2",
          member_id: "adobe-direct:adobe-account-2",
        },
        { group_id: "group-1", member_id: "legacy-adobe" },
        { group_id: "group-2", member_id: "legacy-adobe" },
        { group_id: "group-1", member_id: "legacy-api" },
      ]);
      const lease = await client.query<{
        id: string;
        member_id: string;
        owner_token: string;
      }>(`
        select id, member_id, owner_token
        from image_backend_member_lease
      `);
      expect(lease.rows[0]).toEqual({
        id: "expired-lease-1",
        member_id: "legacy-api",
        owner_token: "legacy-migration:expired-lease-1",
      });
      const metric = await client.query<{
        event_count: number;
        metadata: { legacyRows?: Array<{ id?: string }> };
        outcome: string;
        request_kind: string;
        strategy: string;
      }>(`
        select request_kind, strategy, outcome, event_count, metadata
        from image_backend_member_scheduler_metric
      `);
      expect(metric.rows[0]).toMatchObject({
        event_count: 3,
        outcome: "acquired",
        request_kind: "image",
        strategy: "least_load",
      });
      expect(metric.rows[0]?.metadata.legacyRows?.[0]?.id).toBe("metric-1");
      const video = await client.query<{
        backend_member_id: string;
        stage: string;
      }>(`
        select backend_member_id, stage
        from video_generation
        where id = 'legacy-adobe-video'
      `);
      expect(video.rows[0]).toEqual({
        backend_member_id: "legacy-adobe",
        stage: "completed",
      });
      await expect(
        tableExists(client, schemaName, "image_backend_api")
      ).resolves.toBe(false);
      await expect(
        tableExists(client, schemaName, "image_backend_adobe")
      ).resolves.toBe(false);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("API 与 Adobe 关系使用相同旧 ID 时仍完整迁移", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(
        "insert into image_backend_group (id) values ('shared-group')"
      );
      await client.query(`
        insert into image_backend_api (
          id,
          group_id,
          name,
          base_url,
          api_key,
          supported_model_ids
        ) values (
          'api-member',
          'shared-group',
          'API member',
          'https://api.example.test/v1',
          'api-secret',
          '["gpt-image-2"]'::json
        )
      `);
      await client.query(`
        insert into image_backend_adobe (
          id,
          group_id,
          name,
          base_url,
          api_key,
          mode
        ) values (
          'adobe-member',
          'shared-group',
          'Adobe member',
          'https://adobe.example.test/v1',
          'adobe-secret',
          'gateway'
        )
      `);
      await client.query(`
        insert into image_backend_api_group (id, api_id, group_id)
        values ('shared-relation-id', 'api-member', 'shared-group')
      `);
      await client.query(`
        insert into image_backend_adobe_group (id, adobe_id, group_id)
        values ('shared-relation-id', 'adobe-member', 'shared-group')
      `);

      await executeMigrations(client, schemaName);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const relations = await client.query<{
        id: string;
        member_id: string;
      }>(`
        select id, member_id
        from image_backend_member_group
        order by member_id
      `);
      expect(relations.rows).toEqual([
        {
          id: "legacy-adobe-relation:shared-relation-id",
          member_id: "adobe-member",
        },
        {
          id: "legacy-api-relation:shared-relation-id",
          member_id: "api-member",
        },
      ]);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("非法模型元素与 Responses API 配置阻断迁移", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(`
        insert into image_backend_api (
          id,
          name,
          base_url,
          api_key,
          interface_mode,
          image_upstream_mode,
          supported_model_ids
        ) values (
          'invalid-api',
          'Invalid API',
          'https://api.example.test/v1',
          'api-secret',
          'responses',
          'responses',
          '[1, ""]'::json
        )
      `);

      await expect(executeMigrations(client, schemaName)).rejects.toThrow(
        /invalid_api_models=1.*incompatible_api_protocol=1/u
      );
      await expect(
        tableExists(client, schemaName, "image_backend_api")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "image_backend_member")
      ).resolves.toBe(false);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("Adobe direct 账号缺少唯一自动刷新 token 时阻断迁移", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(`
        insert into image_backend_adobe (
          id,
          name,
          base_url,
          api_key,
          mode
        ) values (
          'direct-without-token',
          'Direct without token',
          '',
          '',
          'direct'
        )
      `);
      await client.query(`
        insert into adobe_account (
          id,
          adobe_id,
          name,
          cookie
        ) values (
          'account-without-token',
          'direct-without-token',
          'Account without token',
          'cookie-secret'
        )
      `);

      await expect(executeMigrations(client, schemaName)).rejects.toThrow(
        /invalid_direct_credential=1/u
      );
      await expect(
        tableExists(client, schemaName, "adobe_account")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "image_backend_member")
      ).resolves.toBe(false);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("Adobe direct 游离 token 时阻断迁移", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(`
        insert into image_backend_adobe (
          id,
          name,
          base_url,
          api_key,
          mode
        ) values (
          'direct-with-orphan',
          'Direct with orphan',
          '',
          '',
          'direct'
        )
      `);
      await client.query(`
        insert into adobe_token (
          id,
          adobe_id,
          value,
          source
        ) values (
          'orphan-token',
          'direct-with-orphan',
          'token-secret',
          'auto_refresh'
        )
      `);

      await expect(executeMigrations(client, schemaName)).rejects.toThrow(
        /invalid_direct_credential=1/u
      );
      await expect(
        tableExists(client, schemaName, "adobe_token")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "image_backend_member")
      ).resolves.toBe(false);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("旧 Web 账号阻断迁移且不留下任何新表", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(
        "insert into image_backend_account (id) values ('legacy-web-account')"
      );

      await expect(executeMigrations(client, schemaName)).rejects.toThrow(
        /0060 blocked: non-migratable media state remains/u
      );

      await expect(
        tableExists(client, schemaName, "image_backend_account")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "image_backend_member")
      ).resolves.toBe(false);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const legacyRows = await client.query<{ count: number }>(
        "select count(*)::integer as count from image_backend_account"
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

  it("未过期旧租约阻断迁移并保持旧租约记录", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(`
        insert into image_backend_inflight_lease (
          id,
          member_type,
          member_id,
          expires_at
        ) values (
          'active-lease-1',
          'api',
          'legacy-api',
          now() + interval '10 minutes'
        )
      `);

      await expect(executeMigrations(client, schemaName)).rejects.toThrow(
        /active_lease=1/u
      );
      await expect(
        tableExists(client, schemaName, "image_backend_member")
      ).resolves.toBe(false);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const legacyLease = await client.query<{ count: number }>(`
        select count(*)::integer as count
        from image_backend_inflight_lease
        where id = 'active-lease-1'
      `);
      expect(legacyLease.rows[0]?.count).toBe(1);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });
});
