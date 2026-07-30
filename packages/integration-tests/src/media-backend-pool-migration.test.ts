/**
 * 统一媒体号池破坏性迁移的真实 PostgreSQL 集成测试。
 *
 * 职责：直接执行 0060-0063、0066、0068-0074 SQL，验证 API/Adobe 旧号池可原子迁移、
 * Adobe direct 子账号可提升为顶层成员、已应用旧版 0060 的数据库可继续升级，
 * Web 或运行中状态会阻断且完整回滚，并锁定设置清理、回调投递和视频 Principal
 * 作用域；0074 另以 0073 后隔离 schema 验证冻结映射、具名输入、约束和幂等切换。
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

interface FrozenVideoMapping {
  legacyModel: string;
  realModel: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
}

interface FrozenVideoFamily {
  realModel: string;
  durations: readonly number[];
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  resolutionInId: boolean;
}

const ALL_FROZEN_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9",
] as const;
const THREE_TO_FIFTEEN_SECONDS = Array.from(
  { length: 13 },
  (_, index) => index + 3
);
const FOUR_TO_FIFTEEN_SECONDS = Array.from(
  { length: 12 },
  (_, index) => index + 4
);

/** 0074 SQL 独立冻结的 13 个模型组合形状；测试不读取当前运行时目录。 */
const FROZEN_VIDEO_FAMILIES = [
  {
    realModel: "sora2",
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
  },
  {
    realModel: "sora2-pro",
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
  },
  {
    realModel: "veo31",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    realModel: "veo31-fast",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    realModel: "veo31-ref",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    realModel: "kling-o3",
    durations: [5, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p"],
    resolutionInId: false,
  },
  {
    realModel: "kling3",
    durations: THREE_TO_FIFTEEN_SECONDS,
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    realModel: "kling3-omni",
    durations: THREE_TO_FIFTEEN_SECONDS,
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    realModel: "runway-gen45",
    durations: [5, 8, 10],
    aspectRatios: ["16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
  },
  {
    realModel: "ray314",
    durations: [5, 10],
    aspectRatios: ALL_FROZEN_ASPECT_RATIOS,
    resolutions: ["4k", "1080p", "720p"],
    resolutionInId: true,
  },
  {
    realModel: "ray314-hdr",
    durations: [5],
    aspectRatios: ALL_FROZEN_ASPECT_RATIOS,
    resolutions: ["4k", "1080p", "720p"],
    resolutionInId: true,
  },
  {
    realModel: "seedance2",
    durations: FOUR_TO_FIFTEEN_SECONDS,
    aspectRatios: ALL_FROZEN_ASPECT_RATIOS,
    resolutions: ["1080p", "720p", "480p"],
    resolutionInId: true,
  },
  {
    realModel: "seedance2-fast",
    durations: FOUR_TO_FIFTEEN_SECONDS,
    aspectRatios: ALL_FROZEN_ASPECT_RATIOS,
    resolutions: ["720p", "480p"],
    resolutionInId: true,
  },
] as const satisfies readonly FrozenVideoFamily[];

/**
 * 从测试内冻结矩阵生成 0073 后规范复合 ID。
 *
 * @returns 573 个互不重复的复合 ID 及其独立参数，不读取产品运行时目录。
 * @sideEffects 无。
 * @failure 冻结常量错误会在测试长度与唯一性断言中失败。
 */
function buildFrozenVideoMappings(): FrozenVideoMapping[] {
  return FROZEN_VIDEO_FAMILIES.flatMap((family) =>
    family.durations.flatMap((durationSeconds) =>
      family.aspectRatios.flatMap((aspectRatio) =>
        family.resolutions.map((resolution) => ({
          legacyModel: `${family.realModel}-${durationSeconds}s-${aspectRatio.replace(":", "x")}${family.resolutionInId ? `-${resolution}` : ""}`,
          realModel: family.realModel,
          durationSeconds,
          aspectRatio,
          resolution,
        }))
      )
    )
  );
}

const FROZEN_VIDEO_MAPPINGS = buildFrozenVideoMappings();
const FROZEN_KLING3_ALIASES = [5, 10, 15].flatMap((durationSeconds) =>
  ["16:9", "9:16"].map((aspectRatio) => ({
    legacyModel: `kling3-${durationSeconds}s-${aspectRatio.replace(":", "x")}`,
    realModel: "kling3",
    durationSeconds,
    aspectRatio,
    resolution: "720p",
  }))
);

/**
 * 0060 发布时硬编码的 Adobe direct 视频模型快照。
 *
 * 历史迁移不能随运行时 catalog 扩张而变化；测试固定该快照，避免新增模型让已发布
 * 迁移产生伪失败，同时继续验证 PostgreSQL 实际迁移结果没有遗漏或额外模型。
 */
const LEGACY_DIRECT_VIDEO_MODEL_IDS = [
  ...[4, 8, 12].flatMap((duration) =>
    ["9x16", "16x9"].flatMap((aspectRatio) => [
      `firefly-sora2-${duration}s-${aspectRatio}`,
      `firefly-sora2-pro-${duration}s-${aspectRatio}`,
    ])
  ),
  ...["", "-ref", "-fast"].flatMap((variant) =>
    [4, 6, 8].flatMap((duration) =>
      ["16x9", "9x16"].flatMap((aspectRatio) =>
        ["1080p", "720p"].map(
          (resolution) =>
            `firefly-veo31${variant}-${duration}s-${aspectRatio}-${resolution}`
        )
      )
    )
  ),
  ...[5, 15].flatMap((duration) =>
    ["16x9", "9x16"].map(
      (aspectRatio) => `firefly-kling-o3-${duration}s-${aspectRatio}`
    )
  ),
  ...[5, 10, 15].flatMap((duration) =>
    ["16x9", "9x16"].map(
      (aspectRatio) => `firefly-kling3-${duration}s-${aspectRatio}`
    )
  ),
];

/** 0072 追加给既有 Kling 3.0 direct 成员的官网规范组合快照。 */
const KLING3_CANONICAL_VIDEO_MODEL_IDS = [
  ...Array.from({ length: 13 }, (_, index) => index + 3).flatMap((duration) =>
    ["16x9", "9x16"].flatMap((aspectRatio) =>
      ["1080p", "720p"].map(
        (resolution) =>
          `firefly-kling3-${duration}s-${aspectRatio}-${resolution}`
      )
    )
  ),
];

/** 0073 完成后统一成员应保存的平台规范裸视频能力键。 */
const PLATFORM_DIRECT_VIDEO_MODEL_IDS = [
  ...LEGACY_DIRECT_VIDEO_MODEL_IDS,
  ...KLING3_CANONICAL_VIDEO_MODEL_IDS,
].map((modelId) => modelId.slice("firefly-".length));

let pool: Pool | null = null;

const migrationPaths = [
  "0060_unified_media_backend_pool.sql",
  "0061_video_callback_delivery.sql",
  "0062_video_principal_scope.sql",
  "0063_video_recovery_lease_identity.sql",
  "0066_flatten_legacy_adobe_subpool.sql",
  "0068_adobe_direct_auth_profiles.sql",
  "0069_video_adobe_profiles.sql",
  "0070_video_express_auth_profile.sql",
  "0071_video_matching_auth_profile.sql",
  "0072_kling3_video_protocol.sql",
  "0073_remove_firefly_model_prefix.sql",
].map((filename) =>
  fileURLToPath(new URL(`../../database/drizzle/${filename}`, import.meta.url))
);
const compatibilityMigrationPath = migrationPaths.at(4);
const profileMigrationPaths = migrationPaths.slice(5);
const compatibilityUpgradePaths = migrationPaths.slice(4);
const videoAuthRepairMigrationPath = migrationPaths.at(7);
const matchingVideoAuthMigrationPath = migrationPaths.at(8);
const kling3VideoProtocolMigrationPath = migrationPaths.at(9);
const removeFireflyModelPrefixMigrationPath = migrationPaths.at(10);
const realVideoRequestMigrationPath = fileURLToPath(
  new URL(
    "../../database/drizzle/0074_real_video_request_contract.sql",
    import.meta.url
  )
);
const migrationsBeforeVideoAuthRepair = migrationPaths.slice(0, 7);
const migrationsBeforeMatchingVideoAuth = migrationPaths.slice(0, 8);
const migrationsBeforeKling3VideoProtocol = migrationPaths.slice(0, 9);
const migrationsBeforeRemoveFireflyModelPrefix = migrationPaths.slice(0, 10);

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
      model text not null default 'firefly-sora2-4s-16x9',
      family text not null default 'sora2',
      status text not null default 'pending',
      updated_at timestamp not null default now(),
      adobe_id text,
      constraint video_generation_adobe_id_image_backend_adobe_id_fk
        foreign key (adobe_id) references image_backend_adobe(id)
    );
    create table generation (
      id text primary key,
      model text not null
    )
  `);
  return schemaName;
}

/**
 * 创建旧版 0060 已落库后的最小统一号池，用于验证 0066 的兼容升级路径。
 *
 * @param client 专用测试数据库连接。
 * @returns 随机隔离 schema 名。
 * @throws 任一 DDL 失败时抛出 PostgreSQL 错误。
 * @sideEffect 创建随机 schema 及旧 Adobe 内部账号池表。
 * @boundary 只包含 0066 读取或修改的列，不模拟无关业务表。
 */
async function createLegacyUnifiedAdobeSchema(
  client: PoolClient
): Promise<string> {
  const schemaName = `pool_migration_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteSchemaName(schemaName);
  await client.query(`create schema ${quotedSchema}`);
  await client.query(`set search_path to ${quotedSchema}, public`);
  await client.query(`
    create table image_backend_group (id text primary key);
    create table image_backend_member (
      id text primary key,
      type text not null,
      name text not null,
      supported_model_ids json not null,
      content_safety_enabled boolean not null default true,
      is_enabled boolean not null default true,
      always_active boolean not null default false,
      failure_cooldown_enabled boolean not null default false,
      priority integer not null default 50,
      concurrency integer not null default 10,
      lease_acquired_count integer not null default 0,
      success_count integer not null default 0,
      fail_count integer not null default 0,
      status text not null default 'active',
      health_status text not null default 'healthy',
      error_ewma numeric(8, 7) not null default 0,
      duration_ms_ewma numeric(18, 2),
      success_streak integer not null default 0,
      fail_streak integer not null default 0,
      last_observed_at timestamp,
      last_used_at timestamp,
      last_acquired_at timestamp,
      cooldown_until timestamp,
      last_error text,
      last_error_at timestamp,
      metadata json,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table image_backend_member_adobe_config (
      member_id text primary key references image_backend_member(id)
        on delete cascade,
      mode text not null,
      base_url text,
      api_key text,
      default_ratio text not null default '1x1',
      default_resolution text not null default '2k',
      gpt_image_quality text not null default 'high',
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
      constraint image_backend_member_adobe_config_shape_check
        check (
          (mode = 'gateway' and base_url is not null)
          or (mode = 'direct' and base_url is null and api_key is null)
        )
    );
    create table image_backend_member_group (
      id text primary key,
      member_id text not null references image_backend_member(id)
        on delete cascade,
      group_id text not null references image_backend_group(id)
        on delete cascade,
      created_at timestamp not null default now(),
      unique (member_id, group_id)
    );
    create table image_backend_member_lease (
      id text primary key,
      member_id text not null references image_backend_member(id)
        on delete cascade,
      owner_token text not null,
      expires_at timestamp not null,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table adobe_account (
      id text primary key,
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
      member_id text not null references image_backend_member(id)
        on delete cascade
    );
    create table adobe_token (
      id text primary key,
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
      member_id text not null references image_backend_member(id)
        on delete cascade
    );
    create table video_generation (
      id text primary key,
      model text not null default 'firefly-sora2-4s-16x9',
      family text not null default 'sora2',
      status text not null default 'pending',
      updated_at timestamp not null default now(),
      backend_member_id text references image_backend_member(id)
        on delete set null,
      stage text not null default 'created',
      adobe_token_id text references adobe_token(id) on delete set null
    );
    alter table video_generation
      rename constraint video_generation_adobe_token_id_fkey
      to video_generation_adobe_token_id_adobe_token_id_fk;
    create index video_generation_adobe_token_idx
      on video_generation(adobe_token_id);
    create table generation (
      id text primary key,
      model text not null
    );
  `);
  return schemaName;
}

/**
 * 创建 0073 已完成、0074 尚未执行的最小生产同形 schema。
 *
 * @param client 专用测试数据库连接。
 * @param includeInputManifest 是否模拟提前扩展过 input_manifest 的兼容环境。
 * @returns 随机隔离 schema 名。
 * @sideEffects 创建成员、Adobe 配置和保留完整恢复身份的视频任务表。
 * @throws 任一 DDL 失败时抛出 PostgreSQL 错误。
 */
async function createPost0073VideoSchema(
  client: PoolClient,
  includeInputManifest = false
): Promise<string> {
  const schemaName = `pool_migration_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteSchemaName(schemaName);
  await client.query(`create schema ${quotedSchema}`);
  await client.query(`set search_path to ${quotedSchema}, public`);
  await client.query(`
    create table image_backend_member (
      id text primary key,
      type text not null,
      name text not null,
      supported_model_ids json not null,
      updated_at timestamp not null default now(),
      constraint image_backend_member_supported_models_check
        check (
          json_typeof(supported_model_ids) = 'array'
          and json_array_length(supported_model_ids) > 0
        )
    );
    create table image_backend_member_adobe_config (
      member_id text primary key references image_backend_member(id)
        on delete cascade,
      mode text not null
    );
    create table video_generation (
      id text primary key,
      user_id text not null,
      model text not null,
      family text not null,
      prompt text not null default 'prompt',
      duration_seconds integer not null,
      aspect_ratio text not null,
      resolution text not null,
      status text not null default 'pending',
      stage text not null default 'created',
      backend_member_id text,
      member_lease_id text,
      member_lease_owner_token text,
      adobe_request_profile text not null default 'express',
      adobe_auth_profile text not null default 'express',
      input_image_refs json,
      staged_input_objects json,
      poll_url text,
      upstream_job_id text,
      submit_started_at timestamp,
      upstream_accepted_at timestamp,
      storage_key text,
      video_url text,
      credits_consumed numeric(18, 2) not null default 0,
      api_key_credits_reserved numeric(18, 2) not null default 0,
      next_poll_at timestamp,
      metadata json,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
  `);
  if (includeInputManifest) {
    await client.query(
      "alter table video_generation add column input_manifest json"
    );
  }
  return schemaName;
}

/** 创建符合资产收编后任务归属规则的 storage-only 输入对象。 */
function createMigratedVideoInputAsset(input: {
  userId: string;
  videoId: string;
  fileName: string;
}) {
  return {
    source: "storage",
    mimeType: "image/png",
    storageKey: `${input.userId}/video-inputs/${input.videoId}/adopted/${input.fileName}`,
    storageBucket: "video-inputs",
    byteLength: 128,
  };
}

/**
 * 插入一个可被 0074 转换的 Adobe direct 成员。
 *
 * @param client 专用测试数据库连接。
 * @param memberId 成员定位 ID。
 * @param modelIds 0073 后模型能力数组。
 * @returns 无。
 * @sideEffects 写入成员及其 direct 配置。
 * @throws 插入失败时抛出 PostgreSQL 错误。
 */
async function insertPost0073DirectMember(
  client: PoolClient,
  memberId: string,
  modelIds: readonly string[]
): Promise<void> {
  await client.query(
    `insert into image_backend_member (
       id, type, name, supported_model_ids
     ) values ($1, 'adobe', $2, $3::json)`,
    [memberId, memberId, JSON.stringify(modelIds)]
  );
  await client.query(
    `insert into image_backend_member_adobe_config (member_id, mode)
     values ($1, 'direct')`,
    [memberId]
  );
}

/**
 * 插入冻结映射对应的任务集合。
 *
 * @param client 专用测试数据库连接。
 * @param mappings 要验证的复合 ID 与独立参数。
 * @returns 无。
 * @sideEffects 批量写入视频任务，不包含输入对象。
 * @throws 参数化 JSON 展开或插入失败时抛出 PostgreSQL 错误。
 */
async function insertFrozenVideoTasks(
  client: PoolClient,
  mappings: readonly FrozenVideoMapping[]
): Promise<void> {
  await client.query(
    `insert into video_generation (
       id, user_id, model, family,
       duration_seconds, aspect_ratio, resolution, metadata
     )
     select
       fixture.id,
       'user-1',
       fixture.model,
       fixture.family,
       fixture.duration_seconds,
       fixture.aspect_ratio,
       fixture.resolution,
       '{"generateAudio":false}'::json
     from json_to_recordset($1::json) as fixture(
       id text,
       model text,
       family text,
       duration_seconds integer,
       aspect_ratio text,
       resolution text
     )`,
    [
      JSON.stringify(
        mappings.map((mapping, index) => ({
          id: `frozen-task-${index}`,
          model: mapping.legacyModel,
          family: mapping.realModel,
          duration_seconds: mapping.durationSeconds,
          aspect_ratio: mapping.aspectRatio,
          resolution: mapping.resolution,
        }))
      ),
    ]
  );
}

/** 删除当前测试创建的随机 schema。 */
async function dropLegacySchema(
  client: PoolClient,
  schemaName: string
): Promise<void> {
  await client.query("set search_path to public");
  await client.query(`drop schema ${quoteSchemaName(schemaName)} cascade`);
}

/**
 * 按 Drizzle statement breakpoint 执行真实连续迁移，并确保失败时整体回滚。
 *
 * @param client 专用测试数据库连接。
 * @param schemaName 随机隔离 schema。
 * @param selectedMigrationPaths 本次要执行的迁移文件，默认执行完整媒体迁移链。
 * @returns 全部语句提交后完成。
 * @throws 任一 SQL 失败时回滚并原样抛出。
 * @sideEffect 在隔离 schema 内执行迁移 DDL 与 DML。
 * @boundary 每个迁移文件按 Drizzle breakpoint 拆分，0066 单一 DO 块保持原子。
 */
async function executeMigrations(
  client: PoolClient,
  schemaName: string,
  selectedMigrationPaths: readonly string[] = migrationPaths
): Promise<void> {
  const migrations = await Promise.all(
    selectedMigrationPaths.map((migrationPath) =>
      readFile(migrationPath, "utf8")
    )
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

describe("0060-0063、0066、0068-0073 统一媒体号池迁移", () => {
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
        columnExists(
          client,
          schemaName,
          "video_generation",
          "adobe_request_profile"
        )
      ).resolves.toBe(true);
      await expect(
        columnExists(
          client,
          schemaName,
          "image_backend_member_adobe_config",
          "firefly_access_token"
        )
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "video_generation_callback_delivery")
      ).resolves.toBe(true);
      const principalScope = await client.query<{
        adobe_auth_profile: string;
        adobe_request_profile: string;
        principal_scope: string;
      }>(
        `select principal_scope, adobe_request_profile, adobe_auth_profile
         from video_generation
         where id = 'legacy-video'`
      );
      expect(principalScope.rows[0]?.principal_scope).toBe("user:user-1");
      expect(principalScope.rows[0]).toMatchObject({
        adobe_auth_profile: "express",
        adobe_request_profile: "express",
      });
      await executeMigrations(client, schemaName, profileMigrationPaths);
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
        insert into video_generation (
          id,
          user_id,
          model,
          family,
          status,
          adobe_id
        ) values
          (
            'legacy-adobe-video',
            'user-1',
            'firefly-seedance2-15s-9x16-480p',
            'seedance2',
            'completed',
            'legacy-adobe'
          ),
          (
            'legacy-runway-video',
            'user-1',
            'firefly-runway-gen45-5s-16x9',
            'runway-gen45',
            'completed',
            'legacy-adobe'
          )
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
              "sora2-4s-9x16",
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
              "sora2-4s-9x16",
            ]),
          }),
        ])
      );
      const migratedAdobeMember = members.rows.find(
        (member) => member.id === "legacy-adobe"
      );
      expect(new Set(migratedAdobeMember?.supported_model_ids)).toEqual(
        new Set(["gpt-image-2", ...PLATFORM_DIRECT_VIDEO_MODEL_IDS])
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
        firefly_access_token: string | null;
        firefly_consecutive_failures: number;
        firefly_credential_status: string | null;
        firefly_token_fails: number;
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
          firefly_access_token,
          firefly_credential_status,
          firefly_token_fails,
          firefly_consecutive_failures,
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
          firefly_access_token: null,
          firefly_consecutive_failures: 0,
          firefly_credential_status: null,
          firefly_token_fails: 0,
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
          firefly_access_token: null,
          firefly_consecutive_failures: 0,
          firefly_credential_status: null,
          firefly_token_fails: 0,
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
        adobe_auth_profile: string;
        adobe_request_profile: string;
        backend_member_id: string;
        id: string;
        stage: string;
      }>(`
        select
          id,
          backend_member_id,
          stage,
          adobe_request_profile,
          adobe_auth_profile
        from video_generation
        where id in ('legacy-adobe-video', 'legacy-runway-video')
        order by id
      `);
      expect(video.rows).toEqual([
        {
          adobe_auth_profile: "express",
          adobe_request_profile: "express",
          backend_member_id: "legacy-adobe",
          id: "legacy-adobe-video",
          stage: "completed",
        },
        {
          adobe_auth_profile: "express",
          adobe_request_profile: "firefly",
          backend_member_id: "legacy-adobe",
          id: "legacy-runway-video",
          stage: "completed",
        },
      ]);
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

  it("已应用旧版 0060 时由 0066 保留数据并移除 Adobe 子号池", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    if (!compatibilityMigrationPath) {
      throw new Error("0066 兼容迁移路径缺失");
    }
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacyUnifiedAdobeSchema(client);
      await client.query(`
        insert into image_backend_group (id)
        values ('group-1'), ('group-2');
        insert into image_backend_member (
          id,
          type,
          name,
          supported_model_ids,
          lease_acquired_count,
          success_count,
          fail_count,
          priority,
          concurrency,
          metadata
        ) values
          (
            'api-existing',
            'api',
            'API existing',
            '["gpt-image-2"]'::json,
            9,
            8,
            1,
            10,
            4,
            '{"source":"api"}'::json
          ),
          (
            'adobe-parent',
            'adobe',
            'Legacy Adobe pool',
            '["gpt-image-2","firefly-video"]'::json,
            7,
            5,
            2,
            60,
            3,
            '{"source":"adobe"}'::json
          );
        insert into image_backend_member_adobe_config (
          member_id,
          mode,
          base_url,
          api_key,
          default_ratio,
          default_resolution,
          gpt_image_quality
        ) values (
          'adobe-parent',
          'direct',
          null,
          null,
          '16x9',
          '2k',
          'medium'
        );
        insert into image_backend_member_group (id, member_id, group_id)
        values
          ('relation-1', 'adobe-parent', 'group-1'),
          ('relation-2', 'adobe-parent', 'group-2');
        insert into adobe_account (
          id,
          member_id,
          name,
          cookie,
          scope,
          display_name,
          email,
          account_user_id,
          created_at
        ) values
          (
            'account-1',
            'adobe-parent',
            'Account 1',
            'cookie-1',
            'scope-1',
            'Display 1',
            'account-1@example.test',
            'user-1',
            '2026-01-01 00:00:00'
          ),
          (
            'account-2',
            'adobe-parent',
            'Account 2',
            'cookie-2',
            'scope-2',
            'Display 2',
            'account-2@example.test',
            'user-2',
            '2026-01-02 00:00:00'
          );
        insert into adobe_token (
          id,
          member_id,
          account_id,
          value,
          account_user_id,
          fails,
          credits_total,
          credits_used,
          credits_available
        ) values
          (
            'token-1',
            'adobe-parent',
            'account-1',
            'access-token-1',
            'user-1',
            1,
            100,
            40,
            60
          ),
          (
            'token-2',
            'adobe-parent',
            'account-2',
            'access-token-2',
            'user-2',
            2,
            200,
            125,
            75
          );
        insert into video_generation (
          id,
          model,
          family,
          status,
          backend_member_id,
          stage,
          adobe_token_id
        ) values
          (
            'video-1',
            'firefly-ray314-5s-16x9-720p',
            'ray314',
            'completed',
            'adobe-parent',
            'completed',
            'token-1'
          ),
          (
            'video-2',
            'firefly-seedance2-15s-9x16-480p',
            'seedance2',
            'completed',
            'adobe-parent',
            'completed',
            'token-2'
          );
      `);

      await executeMigrations(client, schemaName, compatibilityUpgradePaths);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );

      const members = await client.query<{
        id: string;
        lease_acquired_count: number;
        name: string;
        type: string;
      }>(`
        select id, type, name, lease_acquired_count
        from image_backend_member
        order by id
      `);
      expect(members.rows).toEqual([
        {
          id: "adobe-direct:account-2",
          lease_acquired_count: 0,
          name: "Account 2",
          type: "adobe",
        },
        {
          id: "adobe-parent",
          lease_acquired_count: 7,
          name: "Account 1",
          type: "adobe",
        },
        {
          id: "api-existing",
          lease_acquired_count: 9,
          name: "API existing",
          type: "api",
        },
      ]);
      const configs = await client.query<{
        access_token: string;
        cookie: string;
        credits_available: number;
        firefly_access_token: string | null;
        firefly_credential_status: string | null;
        member_id: string;
        mode: string;
      }>(`
        select
          member_id,
          mode,
          cookie,
          access_token,
          firefly_access_token,
          firefly_credential_status,
          credits_available
        from image_backend_member_adobe_config
        order by member_id
      `);
      expect(configs.rows).toEqual([
        {
          access_token: "access-token-2",
          cookie: "cookie-2",
          credits_available: 75,
          firefly_access_token: null,
          firefly_credential_status: null,
          member_id: "adobe-direct:account-2",
          mode: "direct",
        },
        {
          access_token: "access-token-1",
          cookie: "cookie-1",
          credits_available: 60,
          firefly_access_token: null,
          firefly_credential_status: null,
          member_id: "adobe-parent",
          mode: "direct",
        },
      ]);
      const relations = await client.query<{
        group_id: string;
        member_id: string;
      }>(`
        select member_id, group_id
        from image_backend_member_group
        order by member_id, group_id
      `);
      expect(relations.rows).toEqual([
        { group_id: "group-1", member_id: "adobe-direct:account-2" },
        { group_id: "group-2", member_id: "adobe-direct:account-2" },
        { group_id: "group-1", member_id: "adobe-parent" },
        { group_id: "group-2", member_id: "adobe-parent" },
      ]);
      const videos = await client.query<{
        adobe_auth_profile: string;
        adobe_request_profile: string;
        backend_member_id: string;
        id: string;
      }>(`
        select
          id,
          backend_member_id,
          adobe_request_profile,
          adobe_auth_profile
        from video_generation
        order by id
      `);
      expect(videos.rows).toEqual([
        {
          adobe_auth_profile: "express",
          adobe_request_profile: "firefly",
          backend_member_id: "adobe-parent",
          id: "video-1",
        },
        {
          adobe_auth_profile: "express",
          adobe_request_profile: "express",
          backend_member_id: "adobe-direct:account-2",
          id: "video-2",
        },
      ]);
      await expect(
        tableExists(client, schemaName, "adobe_account")
      ).resolves.toBe(false);
      await expect(
        tableExists(client, schemaName, "adobe_token")
      ).resolves.toBe(false);
      await expect(
        columnExists(client, schemaName, "video_generation", "adobe_token_id")
      ).resolves.toBe(false);
      const credentialConstraintCount = await client.query<{ count: number }>(
        `select count(*)::integer as count
         from pg_constraint
         where connamespace = $1::regnamespace
           and conname in (
             'image_backend_member_adobe_config_credential_shape_check',
             'image_backend_member_adobe_config_credential_status_check',
             'image_backend_member_adobe_config_firefly_credential_status_check',
             'image_backend_member_adobe_config_failure_counts_check'
           )`,
        [schemaName]
      );
      expect(credentialConstraintCount.rows[0]?.count).toBe(4);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("0069 遇到未知且未终态的视频族时阻断并完整回滚", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacyUnifiedAdobeSchema(client);
      await client.query(`
        insert into video_generation (
          id,
          model,
          family,
          status,
          stage
        ) values (
          'unknown-profile-video',
          'firefly-experimental-5s-16x9',
          'experimental-family',
          'pending',
          'created'
        )
      `);

      await expect(
        executeMigrations(client, schemaName, compatibilityUpgradePaths)
      ).rejects.toThrow(
        /0069 blocked: unknown non-terminal Adobe video family/u
      );
      await expect(
        columnExists(
          client,
          schemaName,
          "video_generation",
          "adobe_request_profile"
        )
      ).resolves.toBe(false);
      await expect(
        tableExists(client, schemaName, "adobe_account")
      ).resolves.toBe(true);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("0070 只修正尚未提交任务的鉴权 Profile", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    if (!videoAuthRepairMigrationPath) {
      throw new Error("0070 视频鉴权修复迁移路径缺失");
    }
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(`
        insert into video_generation (id, user_id, status)
        values ('profile-repair-video', 'user-1', 'pending')
      `);
      await executeMigrations(
        client,
        schemaName,
        migrationsBeforeVideoAuthRepair
      );
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      await client.query(`
        update video_generation
        set adobe_request_profile = 'firefly',
            adobe_auth_profile = 'firefly',
            stage = 'created'
        where id = 'profile-repair-video'
      `);

      await executeMigrations(client, schemaName, [
        videoAuthRepairMigrationPath,
      ]);
      const repaired = await client.query<{
        adobe_auth_profile: string;
        adobe_request_profile: string;
      }>(`
        select adobe_request_profile, adobe_auth_profile
        from video_generation
        where id = 'profile-repair-video'
      `);
      expect(repaired.rows[0]).toEqual({
        adobe_auth_profile: "express",
        adobe_request_profile: "firefly",
      });

      await client.query(`
        update video_generation
        set adobe_auth_profile = 'firefly',
            stage = 'polling'
        where id = 'profile-repair-video'
      `);
      await executeMigrations(client, schemaName, [
        videoAuthRepairMigrationPath,
      ]);
      const accepted = await client.query<{ adobe_auth_profile: string }>(`
        select adobe_auth_profile
        from video_generation
        where id = 'profile-repair-video'
      `);
      expect(accepted.rows[0]?.adobe_auth_profile).toBe("firefly");
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("0071 只让尚未提交任务的鉴权 Profile 匹配请求端点", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    if (!matchingVideoAuthMigrationPath) {
      throw new Error("0071 视频鉴权匹配迁移路径缺失");
    }
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await client.query(`
        insert into video_generation (id, user_id, status)
        values ('matching-profile-video', 'user-1', 'pending')
      `);
      await executeMigrations(
        client,
        schemaName,
        migrationsBeforeMatchingVideoAuth
      );
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      await client.query(`
        update video_generation
        set adobe_request_profile = 'firefly',
            adobe_auth_profile = 'express',
            stage = 'created'
        where id = 'matching-profile-video'
      `);

      await executeMigrations(client, schemaName, [
        matchingVideoAuthMigrationPath,
      ]);
      const firefly = await client.query<{ adobe_auth_profile: string }>(`
        select adobe_auth_profile
        from video_generation
        where id = 'matching-profile-video'
      `);
      expect(firefly.rows[0]?.adobe_auth_profile).toBe("firefly");

      await client.query(`
        update video_generation
        set adobe_request_profile = 'express',
            adobe_auth_profile = 'firefly',
            stage = 'charged'
        where id = 'matching-profile-video'
      `);
      await executeMigrations(client, schemaName, [
        matchingVideoAuthMigrationPath,
      ]);
      const express = await client.query<{ adobe_auth_profile: string }>(`
        select adobe_auth_profile
        from video_generation
        where id = 'matching-profile-video'
      `);
      expect(express.rows[0]?.adobe_auth_profile).toBe("express");

      await client.query(`
        update video_generation
        set adobe_request_profile = 'firefly',
            adobe_auth_profile = 'express',
            stage = 'polling'
        where id = 'matching-profile-video'
      `);
      await executeMigrations(client, schemaName, [
        matchingVideoAuthMigrationPath,
      ]);
      const accepted = await client.query<{ adobe_auth_profile: string }>(`
        select adobe_auth_profile
        from video_generation
        where id = 'matching-profile-video'
      `);
      expect(accepted.rows[0]?.adobe_auth_profile).toBe("express");
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("0072 为已有 Kling 3.0 direct 成员追加规范组合并修复未提交任务身份", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    if (!kling3VideoProtocolMigrationPath) {
      throw new Error("0072 Kling 3.0 协议迁移路径缺失");
    }
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await executeMigrations(
        client,
        schemaName,
        migrationsBeforeKling3VideoProtocol
      );
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      await client.query(`
        insert into image_backend_member (
          id, type, name, supported_model_ids
        ) values (
          'kling3-direct-member',
          'adobe',
          'Kling 3.0 direct',
          '["firefly-kling3-10s-16x9"]'::json
        );
        insert into image_backend_member_adobe_config (
          member_id, mode, cookie, access_token, credential_status
        ) values (
          'kling3-direct-member',
          'direct',
          'cookie',
          'express-token',
          'active'
        );
        insert into video_generation (
          id, user_id, model, family, status,
          principal_scope, adobe_request_profile, adobe_auth_profile, stage
        ) values
          (
            'kling3-created-video', 'user-1',
            'firefly-kling3-3s-16x9-1080p', 'kling3', 'pending',
            'user:user-1', 'firefly', 'express', 'created'
          ),
          (
            'kling3-polling-video', 'user-1',
            'firefly-kling3-3s-16x9-1080p', 'kling3', 'pending',
            'user:user-1', 'firefly', 'express', 'polling'
          );
      `);

      await executeMigrations(client, schemaName, [
        kling3VideoProtocolMigrationPath,
      ]);

      const member = await client.query<{
        supported_model_ids: string[];
      }>(`
        select supported_model_ids
        from image_backend_member
        where id = 'kling3-direct-member'
      `);
      const modelIds = member.rows[0]?.supported_model_ids ?? [];
      expect(modelIds).toHaveLength(53);
      expect(modelIds).toEqual(
        expect.arrayContaining([
          "firefly-kling3-10s-16x9",
          "firefly-kling3-3s-16x9-1080p",
          "firefly-kling3-15s-9x16-720p",
        ])
      );
      expect(new Set(modelIds).size).toBe(modelIds.length);

      const videos = await client.query<{
        id: string;
        adobe_request_profile: string;
        adobe_auth_profile: string;
      }>(`
        select id, adobe_request_profile, adobe_auth_profile
        from video_generation
        where id in ('kling3-created-video', 'kling3-polling-video')
        order by id
      `);
      expect(videos.rows).toEqual([
        {
          id: "kling3-created-video",
          adobe_request_profile: "firefly",
          adobe_auth_profile: "firefly",
        },
        {
          id: "kling3-polling-video",
          adobe_request_profile: "firefly",
          adobe_auth_profile: "express",
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

  it("0073 将成员能力与历史任务幂等迁移为裸模型 ID", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    if (!removeFireflyModelPrefixMigrationPath) {
      throw new Error("0073 模型 ID 规范化迁移路径缺失");
    }
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacySchema(client);
      await executeMigrations(
        client,
        schemaName,
        migrationsBeforeRemoveFireflyModelPrefix
      );
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      await client.query(`
        insert into image_backend_member (
          id, type, name, supported_model_ids
        ) values (
          'prefixed-model-member',
          'api',
          'Prefixed model member',
          '["firefly-gpt-image-2","gpt-image-2","firefly-sora2-4s-16x9","sora2-4s-16x9","vendor-image"]'::json
        );
        insert into generation (id, model) values
          ('prefixed-image', 'FIREFLY-GPT-IMAGE-2'),
          ('bare-image', 'gpt-image-2');
        insert into video_generation (
          id, user_id, model, family, status,
          principal_scope, adobe_request_profile, adobe_auth_profile, stage
        ) values
          (
            'prefixed-video', 'user-1',
            'firefly-seedance2-15s-9x16-480p', 'seedance2', 'pending',
            'user:user-1', 'firefly', 'firefly', 'created'
          ),
          (
            'bare-video', 'user-1',
            'seedance2-15s-9x16-480p', 'seedance2', 'pending',
            'user:user-1', 'firefly', 'firefly', 'created'
          );
      `);

      await executeMigrations(client, schemaName, [
        removeFireflyModelPrefixMigrationPath,
      ]);
      await executeMigrations(client, schemaName, [
        removeFireflyModelPrefixMigrationPath,
      ]);

      const member = await client.query<{ supported_model_ids: string[] }>(`
        select supported_model_ids
        from image_backend_member
        where id = 'prefixed-model-member'
      `);
      expect(member.rows[0]?.supported_model_ids).toEqual([
        "gpt-image-2",
        "sora2-4s-16x9",
        "vendor-image",
      ]);

      const images = await client.query<{ id: string; model: string }>(`
        select id, model
        from generation
        where id in ('prefixed-image', 'bare-image')
        order by id
      `);
      expect(images.rows).toEqual([
        { id: "bare-image", model: "gpt-image-2" },
        { id: "prefixed-image", model: "GPT-IMAGE-2" },
      ]);

      const videos = await client.query<{ id: string; model: string }>(`
        select id, model
        from video_generation
        where id in ('prefixed-video', 'bare-video')
        order by id
      `);
      expect(videos.rows).toEqual([
        { id: "bare-video", model: "seedance2-15s-9x16-480p" },
        { id: "prefixed-video", model: "seedance2-15s-9x16-480p" },
      ]);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("0066 遇到运行中的 Adobe 视频时阻断并完整回滚", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    if (!compatibilityMigrationPath) {
      throw new Error("0066 兼容迁移路径缺失");
    }
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createLegacyUnifiedAdobeSchema(client);
      await client.query(`
        insert into image_backend_member (
          id,
          type,
          name,
          supported_model_ids
        ) values (
          'adobe-parent',
          'adobe',
          'Legacy Adobe pool',
          '["gpt-image-2"]'::json
        );
        insert into image_backend_member_adobe_config (
          member_id,
          mode,
          base_url,
          api_key
        ) values ('adobe-parent', 'direct', null, null);
        insert into adobe_account (
          id,
          member_id,
          name,
          cookie
        ) values (
          'account-1',
          'adobe-parent',
          'Account 1',
          'cookie-1'
        );
        insert into adobe_token (
          id,
          member_id,
          account_id,
          value
        ) values (
          'token-1',
          'adobe-parent',
          'account-1',
          'access-token-1'
        );
        insert into video_generation (
          id,
          status,
          backend_member_id,
          stage,
          adobe_token_id
        ) values (
          'video-active',
          'running',
          'adobe-parent',
          'polling',
          'token-1'
        );
      `);

      await expect(
        executeMigrations(client, schemaName, [compatibilityMigrationPath])
      ).rejects.toThrow(/0066 blocked/u);
      await expect(
        tableExists(client, schemaName, "adobe_account")
      ).resolves.toBe(true);
      await expect(
        tableExists(client, schemaName, "adobe_token")
      ).resolves.toBe(true);
      await expect(
        columnExists(
          client,
          schemaName,
          "image_backend_member_adobe_config",
          "cookie"
        )
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

describe("0074 视频真实模型请求契约迁移", () => {
  it("冻结迁移全部 573 个组合与 6 个别名并可幂等复跑", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    expect(FROZEN_VIDEO_MAPPINGS).toHaveLength(573);
    expect(
      new Set(FROZEN_VIDEO_MAPPINGS.map((mapping) => mapping.legacyModel)).size
    ).toBe(573);
    expect(FROZEN_KLING3_ALIASES).toHaveLength(6);

    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createPost0073VideoSchema(client);
      const allMappings = [...FROZEN_VIDEO_MAPPINGS, ...FROZEN_KLING3_ALIASES];
      await insertPost0073DirectMember(client, "frozen-member", [
        "image-first",
        ...FROZEN_VIDEO_MAPPINGS.map((mapping) => mapping.legacyModel),
        ...FROZEN_KLING3_ALIASES.map((mapping) => mapping.legacyModel),
        "seedance2",
        "image-last",
      ]);
      await insertFrozenVideoTasks(client, allMappings);
      await client.query(`
        insert into video_generation (
          id, user_id, model, family,
          duration_seconds, aspect_ratio, resolution, metadata
        ) values (
          'already-real-task', 'user-1', 'seedance2', 'seedance2',
          15, '9:16', '480p', '{"generateAudio":false}'::json
        )
      `);

      await executeMigrations(client, schemaName, [
        realVideoRequestMigrationPath,
      ]);
      await executeMigrations(client, schemaName, [
        realVideoRequestMigrationPath,
      ]);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );

      const member = await client.query<{ supported_model_ids: string[] }>(`
        select supported_model_ids
        from image_backend_member
        where id = 'frozen-member'
      `);
      expect(member.rows[0]?.supported_model_ids).toEqual([
        "image-first",
        ...FROZEN_VIDEO_FAMILIES.map((family) => family.realModel),
        "image-last",
      ]);

      const taskSummary = await client.query<{
        count: number;
        real_count: number;
      }>(`
        select
          count(*)::integer as count,
          count(*) filter (
            where model in (
              'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
              'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
              'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
            )
          )::integer as real_count
        from video_generation
      `);
      expect(taskSummary.rows[0]).toEqual({
        count: allMappings.length + 1,
        real_count: allMappings.length + 1,
      });
      const aliasTask = await client.query<{
        model: string;
        duration_seconds: number;
        aspect_ratio: string;
        resolution: string;
      }>(`
        select model, duration_seconds, aspect_ratio, resolution
        from video_generation
        where id = 'frozen-task-573'
      `);
      expect(aliasTask.rows[0]).toEqual({
        model: "kling3",
        duration_seconds: 5,
        aspect_ratio: "16:9",
        resolution: "720p",
      });

      for (const columnName of [
        "family",
        "input_image_refs",
        "staged_input_objects",
      ]) {
        await expect(
          columnExists(client, schemaName, "video_generation", columnName)
        ).resolves.toBe(false);
      }
      await expect(
        columnExists(client, schemaName, "video_generation", "input_manifest")
      ).resolves.toBe(true);

      const constraints = await client.query<{ conname: string }>(`
        select constraint_record.conname
        from pg_constraint as constraint_record
        inner join pg_class as relation
          on relation.oid = constraint_record.conrelid
        where relation.relnamespace = current_schema()::regnamespace
          and constraint_record.conname in (
            'image_backend_member_supported_models_check',
            'video_generation_real_model_check',
            'video_generation_input_manifest_check'
          )
        order by constraint_record.conname
      `);
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "image_backend_member_supported_models_check",
        "video_generation_input_manifest_check",
        "video_generation_real_model_check",
      ]);
      const functionSignatures = await client.query<{
        proname: string;
        pronargs: number;
      }>(`
        select procedure_record.proname, procedure_record.pronargs::integer
        from pg_proc as procedure_record
        where procedure_record.pronamespace = current_schema()::regnamespace
          and procedure_record.proname in (
            'media_supported_model_ids_are_valid',
            'video_input_manifest_is_valid'
          )
        order by procedure_record.proname
      `);
      expect(functionSignatures.rows).toEqual([
        { proname: "media_supported_model_ids_are_valid", pronargs: 1 },
        { proname: "video_input_manifest_is_valid", pronargs: 4 },
      ]);

      await expect(
        client.query(
          `update image_backend_member
           set supported_model_ids = '["seedance2-preview"]'::json
           where id = 'frozen-member'`
        )
      ).rejects.toThrow(/image_backend_member_supported_models_check/u);
      await expect(
        client.query(
          `update image_backend_member
           set supported_model_ids = '["SORA2"]'::json
           where id = 'frozen-member'`
        )
      ).rejects.toThrow(/image_backend_member_supported_models_check/u);
      await expect(
        client.query(`
          insert into video_generation (
            id, user_id, model,
            duration_seconds, aspect_ratio, resolution
          ) values (
            'invalid-new-task', 'user-1', 'seedance2-15s-9x16-480p',
            15, '9:16', '480p'
          )
        `)
      ).rejects.toThrow(/video_generation_real_model_check/u);
      for (const model of ["runway-gen45", "ray314", "ray314-hdr"]) {
        const inputAsset = createMigratedVideoInputAsset({
          userId: "user-1",
          videoId: `unsupported-input-${model}`,
          fileName: "first.png",
        });
        await expect(
          client.query(
            `insert into video_generation (
               id, user_id, model,
               duration_seconds, aspect_ratio, resolution, input_manifest
             ) values ($1, 'user-1', $2, 5, '16:9', '720p', $3::json)`,
            [
              `unsupported-input-${model}`,
              model,
              JSON.stringify({ firstFrame: inputAsset }),
            ]
          )
        ).rejects.toThrow(/video_generation_input_manifest_check/u);
      }
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("把历史角色转换为具名清单并保留非终态恢复身份", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createPost0073VideoSchema(client, true);
      await insertPost0073DirectMember(client, "input-member", [
        "veo31-4s-16x9-720p",
        "veo31-ref-4s-16x9-720p",
      ]);
      const firstFrame = createMigratedVideoInputAsset({
        userId: "user-1",
        videoId: "frame-one",
        fileName: "first.png",
      });
      const firstOfPair = createMigratedVideoInputAsset({
        userId: "user-1",
        videoId: "frame-pair",
        fileName: "first.png",
      });
      const lastOfPair = createMigratedVideoInputAsset({
        userId: "user-1",
        videoId: "frame-pair",
        fileName: "last.png",
      });
      const references = ["one.png", "two.png"].map((fileName) =>
        createMigratedVideoInputAsset({
          userId: "user-1",
          videoId: "references",
          fileName,
        })
      );
      const existingManifest = {
        firstFrame: createMigratedVideoInputAsset({
          userId: "user-1",
          videoId: "existing-manifest",
          fileName: "first.png",
        }),
      };
      await client.query(
        `insert into video_generation (
           id, user_id, model, family,
           duration_seconds, aspect_ratio, resolution,
           status, stage, backend_member_id, member_lease_id,
           member_lease_owner_token, poll_url, upstream_job_id,
           upstream_accepted_at, credits_consumed, next_poll_at, metadata,
           input_image_refs, input_manifest
         ) values
           (
             'frame-one', 'user-1', 'veo31-4s-16x9-720p', 'veo31',
             4, '16:9', '720p', 'pending', 'created', 'input-member', null,
             null, null, null, null, 0, null,
             '{"generateAudio":false,"inputImageRole":"frame"}'::json,
             $1::json, null
           ),
           (
             'frame-pair', 'user-1', 'veo31-4s-16x9-720p', 'veo31',
             4, '16:9', '720p', 'running', 'polling', 'input-member', 'lease-1',
             'owner-1', 'https://poll.example.test/task', 'upstream-1',
             '2026-07-30T11:59:00Z'::timestamp,
             12.5, '2026-07-30T12:00:00Z'::timestamp,
             '{"generateAudio":false,"inputImageRole":"frame"}'::json,
             $2::json, null
           ),
           (
             'references', 'user-1', 'veo31-ref-4s-16x9-720p', 'veo31-ref',
             4, '16:9', '720p', 'running', 'charged', 'input-member',
             'lease-2', 'owner-2', null, null, null, 3, null,
             '{"generateAudio":false,"inputImageRole":"reference"}'::json,
             $3::json, null
           ),
           (
             'existing-manifest', 'user-1', 'veo31-4s-16x9-720p', 'veo31',
             4, '16:9', '720p', 'completed', 'completed', 'input-member', null,
             null, null, null, null, 3, null,
             '{"generateAudio":false}'::json,
             null, $4::json
           )`,
        [
          JSON.stringify([firstFrame]),
          JSON.stringify([firstOfPair, lastOfPair]),
          JSON.stringify(references),
          JSON.stringify(existingManifest),
        ]
      );

      await executeMigrations(client, schemaName, [
        realVideoRequestMigrationPath,
      ]);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const tasks = await client.query<{
        id: string;
        model: string;
        input_manifest: Record<string, unknown>;
        metadata: Record<string, unknown>;
        stage: string;
        backend_member_id: string | null;
        member_lease_id: string | null;
        member_lease_owner_token: string | null;
        poll_url: string | null;
        upstream_job_id: string | null;
        credits_consumed: string;
        next_poll_at: string | null;
      }>(`
        select
          id, model, input_manifest, metadata, stage, backend_member_id,
          member_lease_id, member_lease_owner_token, poll_url,
          upstream_job_id, credits_consumed,
          to_char(next_poll_at, 'YYYY-MM-DD HH24:MI:SS') as next_poll_at
        from video_generation
        order by id
      `);
      const byId = new Map(tasks.rows.map((task) => [task.id, task]));
      expect(byId.get("frame-one")?.input_manifest).toEqual({
        firstFrame,
      });
      expect(byId.get("frame-pair")?.input_manifest).toEqual({
        firstFrame: firstOfPair,
        lastFrame: lastOfPair,
      });
      expect(byId.get("references")?.input_manifest).toEqual({
        referenceImages: references,
      });
      expect(byId.get("existing-manifest")?.input_manifest).toEqual(
        existingManifest
      );
      for (const task of tasks.rows) {
        expect(task.metadata).toEqual({ generateAudio: false });
      }
      expect(byId.get("frame-pair")).toMatchObject({
        model: "veo31",
        stage: "polling",
        backend_member_id: "input-member",
        member_lease_id: "lease-1",
        member_lease_owner_token: "owner-1",
        poll_url: "https://poll.example.test/task",
        upstream_job_id: "upstream-1",
        credits_consumed: "12.50",
      });
      expect(byId.get("frame-pair")?.next_poll_at).toBe("2026-07-30 12:00:00");

      await expect(
        client.query(
          `update video_generation
           set input_manifest = $1::json
           where id = 'frame-one'`,
          [
            JSON.stringify({
              firstFrame: {
                ...firstFrame,
                storageKey:
                  "other-user/video-inputs/frame-one/adopted/stolen.png",
              },
            }),
          ]
        )
      ).rejects.toThrow(/video_generation_input_manifest_check/u);
      await expect(
        client.query(
          `update video_generation
           set input_manifest = $1::json
           where id = 'frame-one'`,
          [
            JSON.stringify({
              firstFrame: {
                ...firstFrame,
                storageBucket: "invalid/bucket",
              },
            }),
          ]
        )
      ).rejects.toThrow(/video_generation_input_manifest_check/u);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("未知成员视频变体阻断且不折叠任何合法成员能力", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createPost0073VideoSchema(client);
      const originalModels = [
        "image-first",
        "sora2-4s-16x9",
        "seedance2-preview",
      ];
      await insertPost0073DirectMember(
        client,
        "unknown-member",
        originalModels
      );

      await expect(
        executeMigrations(client, schemaName, [realVideoRequestMigrationPath])
      ).rejects.toThrow(/unknown-member/u);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const member = await client.query<{ supported_model_ids: string[] }>(`
        select supported_model_ids
        from image_backend_member
        where id = 'unknown-member'
      `);
      expect(member.rows[0]?.supported_model_ids).toEqual(originalModels);
      await expect(
        columnExists(client, schemaName, "video_generation", "family")
      ).resolves.toBe(true);
      await expect(
        columnExists(client, schemaName, "video_generation", "input_manifest")
      ).resolves.toBe(false);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("任务参数、family 或模型无法证明时报告任务 ID 并完整回滚", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createPost0073VideoSchema(client);
      const originalModels = ["image-first", "sora2-4s-16x9"];
      await insertPost0073DirectMember(
        client,
        "conflict-member",
        originalModels
      );
      await client.query(`
        insert into video_generation (
          id, user_id, model, family,
          duration_seconds, aspect_ratio, resolution
        ) values
          (
            'conflict-task', 'user-1', 'sora2-4s-16x9', 'sora2',
            8, '16:9', '720p'
          ),
          (
            'family-conflict-task', 'user-1', 'sora2-4s-16x9', 'sora2-pro',
            4, '16:9', '720p'
          ),
          (
            'unknown-task', 'user-1', 'unknown-video-model', 'sora2',
            4, '16:9', '720p'
          )
      `);

      await expect(
        executeMigrations(client, schemaName, [realVideoRequestMigrationPath])
      ).rejects.toThrow(
        /conflict-task:parameter_conflict.*family-conflict-task:family_conflict.*unknown-task:unknown_model/u
      );
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const member = await client.query<{ supported_model_ids: string[] }>(`
        select supported_model_ids
        from image_backend_member
        where id = 'conflict-member'
      `);
      expect(member.rows[0]?.supported_model_ids).toEqual(originalModels);
      const tasks = await client.query<{ id: string; model: string }>(`
        select id, model
        from video_generation
        where id in ('conflict-task', 'family-conflict-task', 'unknown-task')
        order by id
      `);
      expect(tasks.rows).toEqual([
        { id: "conflict-task", model: "sora2-4s-16x9" },
        { id: "family-conflict-task", model: "sora2-4s-16x9" },
        { id: "unknown-task", model: "unknown-video-model" },
      ]);
      await expect(
        columnExists(client, schemaName, "video_generation", "family")
      ).resolves.toBe(true);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("历史输入缺少角色时阻断且不增加新清单列", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createPost0073VideoSchema(client);
      await insertPost0073DirectMember(client, "missing-role-member", [
        "sora2-4s-16x9",
      ]);
      const asset = createMigratedVideoInputAsset({
        userId: "user-1",
        videoId: "missing-role-task",
        fileName: "first.png",
      });
      await client.query(
        `insert into video_generation (
           id, user_id, model, family,
           duration_seconds, aspect_ratio, resolution,
           metadata, input_image_refs
         ) values (
           'missing-role-task', 'user-1', 'sora2-4s-16x9', 'sora2',
           4, '16:9', '720p', '{"generateAudio":false}'::json, $1::json
         )`,
        [JSON.stringify([asset])]
      );

      await expect(
        executeMigrations(client, schemaName, [realVideoRequestMigrationPath])
      ).rejects.toThrow(/missing-role-task/u);
      await expect(
        columnExists(client, schemaName, "video_generation", "input_manifest")
      ).resolves.toBe(false);
      const task = await client.query<{ model: string }>(`
        select model from video_generation where id = 'missing-role-task'
      `);
      expect(task.rows[0]?.model).toBe("sora2-4s-16x9");
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("在途任务缺少阶段恢复身份时阻断并完整回滚", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createPost0073VideoSchema(client);
      await insertPost0073DirectMember(client, "recovery-member", [
        "sora2-4s-16x9",
      ]);
      await client.query(`
        insert into video_generation (
          id, user_id, model, family, duration_seconds, aspect_ratio,
          resolution, status, stage, backend_member_id, member_lease_id,
          member_lease_owner_token, poll_url, upstream_accepted_at
        ) values (
          'broken-polling-task', 'user-1', 'sora2-4s-16x9', 'sora2',
          4, '16:9', '720p', 'running', 'polling', 'recovery-member',
          'lease-1', 'owner-1', null, now()
        )
      `);

      await expect(
        executeMigrations(client, schemaName, [realVideoRequestMigrationPath])
      ).rejects.toThrow(/broken-polling-task:recovery_identity/u);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      const task = await client.query<{ model: string; stage: string }>(`
        select model, stage
        from video_generation
        where id = 'broken-polling-task'
      `);
      expect(task.rows[0]).toEqual({
        model: "sora2-4s-16x9",
        stage: "polling",
      });
      await expect(
        columnExists(client, schemaName, "video_generation", "family")
      ).resolves.toBe(true);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("越权任务输入对象阻断且保留旧列与复合模型", async () => {
    if (!pool) throw new Error("迁移测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createPost0073VideoSchema(client);
      await insertPost0073DirectMember(client, "foreign-object-member", [
        "sora2-4s-16x9",
      ]);
      const foreignAsset = createMigratedVideoInputAsset({
        userId: "other-user",
        videoId: "foreign-object-task",
        fileName: "first.png",
      });
      await client.query(
        `insert into video_generation (
           id, user_id, model, family,
           duration_seconds, aspect_ratio, resolution,
           metadata, input_image_refs
         ) values (
           'foreign-object-task', 'user-1', 'sora2-4s-16x9', 'sora2',
           4, '16:9', '720p',
           '{"generateAudio":false,"inputImageRole":"frame"}'::json,
           $1::json
         )`,
        [JSON.stringify([foreignAsset])]
      );

      await expect(
        executeMigrations(client, schemaName, [realVideoRequestMigrationPath])
      ).rejects.toThrow(/foreign-object-task/u);
      await client.query(
        `set search_path to ${quoteSchemaName(schemaName)}, public`
      );
      await expect(
        columnExists(client, schemaName, "video_generation", "family")
      ).resolves.toBe(true);
      const task = await client.query<{
        model: string;
        input_image_refs: unknown;
      }>(`
        select model, input_image_refs
        from video_generation
        where id = 'foreign-object-task'
      `);
      expect(task.rows[0]?.model).toBe("sora2-4s-16x9");
      expect(task.rows[0]?.input_image_refs).toEqual([foreignAsset]);
    } finally {
      try {
        if (schemaName) await dropLegacySchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });
});
