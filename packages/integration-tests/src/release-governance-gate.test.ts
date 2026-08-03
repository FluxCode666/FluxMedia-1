/**
 * 生产发布治理门禁的真实 PostgreSQL 集成测试。
 *
 * 职责：通过真实子进程覆盖迁移前后门禁的成功与拒绝路径。
 * 使用方：显式 `pnpm --filter @repo/integration-tests test:release-governance`
 *   production 质量门。
 * 关键依赖：专用 RELEASE_GATE_TEST_DATABASE_URL、0056 迁移、发布门禁脚本。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

const releaseGatePath = fileURLToPath(
  new URL("../../database/scripts/release-governance-gate.mjs", import.meta.url)
);
const databasePackagePath = fileURLToPath(
  new URL("../../database", import.meta.url)
);
const videoInputCleanupReasonMigrationStatements = readFileSync(
  new URL(
    "../../database/drizzle/0076_video_input_cleanup_reason.sql",
    import.meta.url
  ),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);
const runPrefix = `release-governance-gate-integration-${randomUUID()}`;
const relayUserId = `${runPrefix}-relay-user`;
const overrideUserId = `${runPrefix}-override-user`;
const seededUserIds = [relayUserId, overrideUserId] as const;
const hiddenOverrideColumn =
  "moderation_block_risk_level_override_release_gate_test";
const hiddenMediaMarkerTable = "image_backend_member_release_gate_test";

type ReleaseGateCommand =
  | "legacy-startup"
  | "postcheck"
  | "postcheck-initial"
  | "preflight"
  | "preflight-early";

interface ReleaseGateResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface GovernanceSchemaState {
  externalApiKeyTable: boolean;
  globalPolicyRow: boolean;
  oldColumnCount: string;
  overrideCheck: boolean;
  overrideColumn: boolean;
  userTable: boolean;
  videoContractConstraintCount: string;
  videoInputCleanupReasonColumn: boolean;
  videoInputManifestColumn: boolean;
  videoLegacyColumnCount: string;
}

let pool: Pool | null = null;
let testDatabaseUrl: string | null = null;
let legacyVideoDatabaseName: string | null = null;
let legacyVideoDatabaseUrl: string | null = null;
let legacyVideoPool: Pool | null = null;

/** 使用 pnpm 对隔离数据库执行完整迁移集。 */
async function migrateReleaseGateDatabase(databaseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["db:migrate"], {
      cwd: databasePackagePath,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`隔离发布门禁数据库迁移失败：${stderr.trim()}`));
    });
  });
}

/** 构造同一 PostgreSQL 实例中指定数据库的连接串。 */
function replaceDatabaseName(
  databaseUrl: string,
  databaseName: string
): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/** 创建已完成 0073、保留三个视频旧列的隔离真实数据库。 */
async function createLegacyVideoGateDatabase(
  adminPool: Pool,
  adminDatabaseUrl: string
): Promise<{ databaseName: string; databaseUrl: string; pool: Pool }> {
  const databaseName = `legacy_gate_${randomUUID().replaceAll("-", "")}`;
  if (!/^legacy_gate_[a-f0-9]{32}$/.test(databaseName)) {
    throw new Error("隔离发布门禁数据库名称无效");
  }
  await adminPool.query(`create database "${databaseName}"`);
  const databaseUrl = replaceDatabaseName(adminDatabaseUrl, databaseName);
  let isolatedPool: Pool | null = null;
  try {
    await migrateReleaseGateDatabase(databaseUrl);
    isolatedPool = new Pool({
      application_name: "fluxmedia-release-gate-legacy-fixture",
      connectionString: databaseUrl,
      max: 2,
    });
    await isolatedPool.query(`
      alter table video_generation
        drop constraint video_generation_real_model_check,
        drop constraint video_generation_input_manifest_check,
        add column family text,
        add column input_image_refs json,
        add column staged_input_objects json;
      update video_generation set family = model;
      alter table video_generation
        alter column family set not null,
        drop column input_manifest;
      alter table image_backend_member
        drop constraint image_backend_member_supported_models_check,
        add constraint image_backend_member_supported_models_check
          check (
            json_typeof(supported_model_ids) = 'array'
            and json_array_length(supported_model_ids) > 0
          );
    `);
    return { databaseName, databaseUrl, pool: isolatedPool };
  } catch (error) {
    await isolatedPool?.end().catch(() => undefined);
    await dropLegacyVideoGateDatabase(adminPool, databaseName).catch(
      () => undefined
    );
    throw error;
  }
}

/** 终止隔离数据库连接并删除仅含本测试数据的数据库。 */
async function dropLegacyVideoGateDatabase(
  adminPool: Pool,
  databaseName: string
): Promise<void> {
  await adminPool.query(
    `select pg_terminate_backend(pid)
       from pg_stat_activity
      where datname = $1
        and pid <> pg_backend_pid()`,
    [databaseName]
  );
  await adminPool.query(`drop database "${databaseName}"`);
}

/** 插入满足统一媒体 preflight 的 Adobe direct 成员。 */
async function seedLegacyVideoMember(
  client: Pool,
  memberId: string,
  supportedModels: readonly string[]
): Promise<void> {
  await client.query(
    `insert into image_backend_member (
       id, type, name, supported_model_ids
     ) values ($1, 'adobe', $1, $2::json)`,
    [memberId, JSON.stringify(supportedModels)]
  );
  await client.query(
    `insert into image_backend_member_adobe_config (
       member_id, mode, cookie, access_token, credential_status
     ) values ($1, 'direct', 'test-cookie', 'test-token', 'active')`,
    [memberId]
  );
}

/** 插入一个真实模型参数合法、但 polling 恢复身份不完整的旧任务。 */
async function seedBrokenLegacyPollingTask(
  client: Pool,
  input: { memberId: string; taskId: string; userId: string }
): Promise<void> {
  await client.query(
    `insert into "user" (id, name, email)
     values ($1, 'Legacy gate user', $2)`,
    [input.userId, `${input.userId}@release-gate-legacy.test`]
  );
  await client.query(
    `insert into video_generation (
       id, user_id, principal_scope, backend_member_id, model, family,
       adobe_request_profile, adobe_auth_profile, prompt, duration_seconds,
       aspect_ratio, resolution, status, stage
     ) values (
       $1, $2, $3, $4, 'sora2-4s-16x9', 'sora2', 'express', 'express',
       'prompt', 4, '16:9', '720p', 'running', 'polling'
     )`,
    [input.taskId, input.userId, `user:${input.userId}`, input.memberId]
  );
}

/**
 * 要求测试库处于 0056 与 0076 完成后的干净治理状态。
 *
 * @param client 连接专用测试数据库的 PostgreSQL 连接池。
 * @returns 数据库满足发布门禁测试前置条件时完成的 Promise。
 * @throws 必需表、全站策略、用户覆盖列或约束缺失，或旧治理列仍存在时抛错。
 * @sideEffect 对 information_schema、pg_constraint 与 system_setting 执行只读查询。
 * @boundary 不修复迁移状态，避免测试把错误数据库静默改造成可运行状态。
 */
async function assertGovernanceMigrationReady(client: Pool): Promise<void> {
  const result = await client.query<GovernanceSchemaState>(`
    select
      to_regclass('public.user') is not null as "userTable",
      to_regclass('public.external_api_key') is not null as "externalApiKeyTable",
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'user'
          and column_name = 'moderation_block_risk_level_override'
      ) as "overrideColumn",
      exists (
        select 1
        from pg_constraint
        where conrelid = 'public.user'::regclass
          and conname = 'user_moderation_block_risk_level_override_check'
      ) as "overrideCheck",
      exists (
        select 1
        from system_setting
        where key = 'CONTENT_MODERATION_BLOCK_RISK_LEVEL'
      ) as "globalPolicyRow",
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'video_generation'
          and column_name = 'input_manifest'
      ) as "videoInputManifestColumn",
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'video_input_cleanup'
          and column_name = 'reason'
          and is_nullable = 'NO'
          and column_default = '''orphan''::text'
      ) as "videoInputCleanupReasonColumn",
      (
        select count(*)::text
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'video_generation'
          and column_name in (
            'family', 'input_image_refs', 'staged_input_objects'
          )
      ) as "videoLegacyColumnCount",
      (
        select count(*)::text
        from pg_constraint
        where connamespace = 'public'::regnamespace
          and conname in (
            'image_backend_member_supported_models_check',
            'video_generation_real_model_check',
            'video_generation_input_manifest_check',
            'video_input_cleanup_reason_check'
          )
      ) as "videoContractConstraintCount",
      (
        select count(*)::text
        from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'user'
              and column_name = 'moderation_block_risk_level')
            or (
              table_name = 'external_api_key'
              and column_name in (
                'moderation_block_risk_level',
                'relay_only'
              )
            )
          )
      ) as "oldColumnCount"
  `);
  const state = result.rows[0];
  if (
    !state?.userTable ||
    !state.externalApiKeyTable ||
    !state.overrideColumn ||
    !state.overrideCheck ||
    !state.globalPolicyRow ||
    !state.videoInputManifestColumn ||
    !state.videoInputCleanupReasonColumn ||
    state.videoLegacyColumnCount !== "0" ||
    state.videoContractConstraintCount !== "4" ||
    state.oldColumnCount !== "0"
  ) {
    throw new Error(
      "发布门禁测试库未就绪：需要 0056 与 0076 完整迁移且不能残留旧列"
    );
  }
}

/**
 * 以专用测试数据库执行真实发布门禁子进程并收集非敏感输出。
 *
 * @param command 要执行的 preflight 或 postcheck 命令。
 * @param databaseUrl 已通过专用测试数据库安全校验的连接串。
 * @returns 子进程退出码以及 stdout、stderr 文本。
 * @throws 子进程无法启动，或被信号终止且没有退出码时抛错。
 * @sideEffect 启动 Node.js 子进程，并仅为该进程设置 DATABASE_URL。
 * @boundary 不使用 shell，不记录连接串；门禁业务拒绝以非零退出码返回而非抛错。
 */
async function runReleaseGate(
  command: ReleaseGateCommand,
  databaseUrl: string
): Promise<ReleaseGateResult> {
  return new Promise<ReleaseGateResult>((resolve, reject) => {
    const child = spawn(process.execPath, [releaseGatePath, command], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === null) {
        reject(new Error(`发布门禁 ${command} 子进程被信号终止`));
        return;
      }
      resolve({ exitCode, stderr, stdout });
    });
  });
}

/**
 * 在当前事务中逐句执行 0076，复现 Drizzle 迁移器的 statement breakpoint 语义。
 *
 * @param client 已开启测试事务的 PostgreSQL 专用连接。
 * @returns 全部 0076 语句执行完成时完成的 Promise。
 * @throws 任一迁移语句无法应用时抛出 PostgreSQL 错误。
 * @sideEffect 修改当前事务内的 video_input_cleanup 表结构与存量行。
 * @boundary 调用方必须控制事务并在测试结束时回滚，避免污染共享测试库。
 */
async function applyVideoInputCleanupReasonMigration(
  client: PoolClient
): Promise<void> {
  for (const statement of videoInputCleanupReasonMigrationStatements) {
    await client.query(statement);
  }
}

/**
 * 创建满足外键约束且仅属于本轮测试的用户。
 *
 * @param client 专用测试数据库连接池。
 * @param userId 本轮唯一用户 ID。
 * @param overrideLevel 可选的合法用户审核覆盖档位。
 * @returns 插入完成后的 Promise。
 * @throws PostgreSQL 插入失败或唯一约束冲突时抛错。
 * @sideEffect 向 public.user 插入一行测试数据。
 * @boundary 邮箱和主键均带 UUID 前缀，避免与并行或历史测试数据冲突。
 */
async function seedUser(
  client: Pool,
  userId: string,
  overrideLevel: "low" | null = null
): Promise<void> {
  await client.query(
    `insert into "user" (
       id,
       name,
       email,
       moderation_block_risk_level_override
     )
     values ($1, $2, $3, $4)`,
    [
      userId,
      "Release gate integration",
      `${userId}@example.test`,
      overrideLevel,
    ]
  );
}

/**
 * 恢复测试添加或隐藏的列，并清除本轮测试用户。
 *
 * @param client 专用测试数据库连接池。
 * @returns 恢复完成后的 Promise。
 * @throws 数据库出现预期列与隐藏列同时存在等无法安全恢复的状态时抛错。
 * @sideEffect 执行受限 DDL、恢复测试约束，并删除 UUID 前缀限定的测试用户及其级联 API Key。
 * @boundary 仅操作本测试创建的旧列名、隐藏列名、约束和两个固定用户 ID。
 */
async function restoreReleaseGateFixtures(client: Pool): Promise<void> {
  const columnResult = await client.query<{
    hiddenOverrideColumn: boolean;
    overrideColumn: boolean;
  }>(
    `select
       exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'user'
           and column_name = $1
       ) as "hiddenOverrideColumn",
       exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'user'
           and column_name = 'moderation_block_risk_level_override'
       ) as "overrideColumn"`,
    [hiddenOverrideColumn]
  );
  const columns = columnResult.rows[0];
  if (columns?.hiddenOverrideColumn && columns.overrideColumn) {
    throw new Error("测试恢复失败：用户覆盖列与隐藏列同时存在");
  }
  if (columns?.hiddenOverrideColumn) {
    await client.query(
      `alter table "user"
       rename column moderation_block_risk_level_override_release_gate_test
       to moderation_block_risk_level_override`
    );
  }

  await client.query(`delete from "user" where id = any($1::text[])`, [
    [...seededUserIds],
  ]);
  await client.query(
    `alter table external_api_key
       drop column if exists moderation_block_risk_level,
       drop column if exists relay_only`
  );
  await client.query(
    `alter table "user"
       drop column if exists moderation_block_risk_level`
  );
  await client.query(
    "drop table if exists image_backend_account, image_backend_api"
  );
  const mediaMarkerResult = await client.query<{
    hidden: boolean;
    visible: boolean;
  }>(`
    select
      to_regclass('public.${hiddenMediaMarkerTable}') is not null as hidden,
      to_regclass('public.image_backend_member') is not null as visible
  `);
  const mediaMarker = mediaMarkerResult.rows[0];
  if (mediaMarker?.hidden && mediaMarker.visible) {
    throw new Error("测试恢复失败：统一媒体成员表与隐藏表同时存在");
  }
  if (mediaMarker?.hidden) {
    await client.query(
      `alter table ${hiddenMediaMarkerTable} rename to image_backend_member`
    );
  }
  await client.query(`
    alter table video_generation
      drop constraint if exists video_generation_real_model_check;
    alter table video_generation
      add constraint video_generation_real_model_check
      check (
        model in (
          'sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref',
          'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45',
          'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast'
        )
      );
    alter table video_input_cleanup
      drop constraint if exists video_input_cleanup_reason_check;
    alter table video_input_cleanup
      alter column reason set default 'orphan',
      alter column reason set not null;
    alter table video_input_cleanup
      add constraint video_input_cleanup_reason_check
      check (reason in ('orphan', 'lifecycle_delete'));
  `);
}

beforeAll(async () => {
  testDatabaseUrl = requireDedicatedTestDatabaseUrl(
    "RELEASE_GATE_TEST_DATABASE_URL"
  );
  pool = new Pool({
    application_name: "fluxmedia-release-governance-gate-integration",
    connectionString: testDatabaseUrl,
    max: 2,
  });
  await assertGovernanceMigrationReady(pool);
  const legacyDatabase = await createLegacyVideoGateDatabase(
    pool,
    testDatabaseUrl
  );
  legacyVideoDatabaseName = legacyDatabase.databaseName;
  legacyVideoDatabaseUrl = legacyDatabase.databaseUrl;
  legacyVideoPool = legacyDatabase.pool;
});

afterEach(async () => {
  if (pool) await restoreReleaseGateFixtures(pool);
  if (legacyVideoPool) {
    await legacyVideoPool.query(`
      delete from video_generation;
      delete from image_backend_member;
      delete from "user"
      where email like '%@release-gate-legacy.test';
    `);
  }
});

afterAll(async () => {
  try {
    if (pool) await restoreReleaseGateFixtures(pool);
  } finally {
    await legacyVideoPool?.end();
    if (pool && legacyVideoDatabaseName) {
      await dropLegacyVideoGateDatabase(pool, legacyVideoDatabaseName);
    }
    await pool?.end();
  }
});

describe("release governance gate PostgreSQL integration", () => {
  it("0076 回填已有清理记录并收紧 reason 契约", async () => {
    if (!pool) throw new Error("集成测试尚未初始化");
    const client = await pool.connect();
    const cleanupId = `${runPrefix}-legacy-cleanup`;
    try {
      await client.query("begin");
      await client.query(`
        alter table video_input_cleanup
          drop constraint video_input_cleanup_reason_check;
        alter table video_input_cleanup
          drop column reason;
        insert into video_input_cleanup (
          id,
          user_id,
          video_id,
          attempt_id,
          storage_key,
          storage_bucket
        ) values (
          '${cleanupId}',
          '${runPrefix}-legacy-user',
          '${runPrefix}-legacy-video',
          '${runPrefix}-legacy-attempt',
          '${runPrefix}/legacy-input.png',
          'video-input'
        );
      `);

      await applyVideoInputCleanupReasonMigration(client);

      const rowResult = await client.query<{ reason: string }>(
        "select reason from video_input_cleanup where id = $1",
        [cleanupId]
      );
      expect(rowResult.rows).toEqual([{ reason: "orphan" }]);

      const contractResult = await client.query<{
        constraintDefinition: string;
        defaultValue: string;
        nullable: string;
      }>(`
        select
          column_default as "defaultValue",
          is_nullable as nullable,
          pg_get_constraintdef(constraint_record.oid, true)
            as "constraintDefinition"
        from information_schema.columns
        join pg_constraint as constraint_record
          on constraint_record.conrelid = 'public.video_input_cleanup'::regclass
         and constraint_record.conname = 'video_input_cleanup_reason_check'
        where table_schema = 'public'
          and table_name = 'video_input_cleanup'
          and column_name = 'reason'
      `);
      expect(contractResult.rows).toEqual([
        {
          constraintDefinition:
            "CHECK (reason = ANY (ARRAY['orphan'::text, 'lifecycle_delete'::text]))",
          defaultValue: "'orphan'::text",
          nullable: "NO",
        },
      ]);

      await client.query("savepoint invalid_reason");
      await expect(
        client.query(
          "update video_input_cleanup set reason = 'unknown' where id = $1",
          [cleanupId]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback to savepoint invalid_reason");

      await client.query("savepoint null_reason");
      await expect(
        client.query(
          "update video_input_cleanup set reason = null where id = $1",
          [cleanupId]
        )
      ).rejects.toMatchObject({ code: "23502" });
      await client.query("rollback to savepoint null_reason");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("旧 schema preflight 接受可稳定折叠的重复视频能力", async () => {
    if (!legacyVideoPool || !legacyVideoDatabaseUrl) {
      throw new Error("旧 schema 门禁测试库尚未初始化");
    }
    await seedLegacyVideoMember(legacyVideoPool, "duplicate-video-member", [
      "sora2-4s-16x9",
      "sora2-8s-16x9",
      "sora2",
    ]);

    const result = await runReleaseGate("preflight", legacyVideoDatabaseUrl);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("video_contract_schema_state=legacy\n");
    expect(result.stdout).toContain("video_contract_blocker_count=0\n");
    expect(result.stdout).toContain("video_contract_blocker_ids=[]\n");
  });

  it("旧 schema preflight 用单行 JSON 阻断恢复身份不完整的任务", async () => {
    if (!legacyVideoPool || !legacyVideoDatabaseUrl) {
      throw new Error("旧 schema 门禁测试库尚未初始化");
    }
    const taskId = "broken\npolling\u2028task";
    await seedLegacyVideoMember(legacyVideoPool, "broken-task-member", [
      "sora2-4s-16x9",
    ]);
    await seedBrokenLegacyPollingTask(legacyVideoPool, {
      memberId: "broken-task-member",
      taskId,
      userId: "broken-task-user",
    });

    const result = await runReleaseGate("preflight", legacyVideoDatabaseUrl);
    const evidenceLines = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("video_contract_blocker_ids="));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("video_contract_blocker_count=1\n");
    expect(evidenceLines).toHaveLength(1);
    expect(evidenceLines[0]).toBe(
      'video_contract_blocker_ids=["task:broken\\npolling\\u2028task"]'
    );
    expect(result.stderr).toContain(
      "video request contract preflight failed: 1 records blocked"
    );
  });

  it("后续发布在 relay_only 旧列已删除时允许 preflight", async () => {
    if (!testDatabaseUrl) throw new Error("集成测试尚未初始化");
    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("relay_only_column=absent\n");
    expect(result.stdout).toContain("relay_only_true_count=0\n");
    expect(result.stdout).toContain("video_contract_schema_state=applied\n");
    expect(result.stdout).toContain("video_contract_blocker_count=0\n");
    expect(result.stdout).toContain("video_contract_blocker_ids=[]\n");
  });

  it("0074 后明确拒绝旧应用启动门禁", async () => {
    if (!testDatabaseUrl) throw new Error("集成测试尚未初始化");
    const result = await runReleaseGate("legacy-startup", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("legacy_video_contract_column_count=0\n");
    expect(result.stderr).toContain(
      "legacy video application cannot start on the real video contract schema"
    );
  });

  it("relay_only=true 时拒绝迁移前检查", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(
      `alter table external_api_key
       add column relay_only boolean not null default false`
    );
    await seedUser(pool, relayUserId);
    await pool.query(
      `insert into external_api_key (
         id,
         user_id,
         key_prefix,
         key_hash,
         last_four,
         relay_only
       )
       values ($1, $2, $3, $4, $5, true)`,
      [
        `${runPrefix}-relay-key`,
        relayUserId,
        "fm_test",
        `${runPrefix}-relay-hash`,
        "test",
      ]
    );

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("relay_only_column=present\n");
    expect(result.stdout).toContain("relay_only_true_count=1\n");
    expect(result.stderr).toContain(
      "release governance gate failed: relay-only preflight failed: 1 rows found"
    );
  });

  it("旧 API 数据可迁移时允许统一号池迁移前检查", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(
      `alter table image_backend_member rename to ${hiddenMediaMarkerTable}`
    );
    await pool.query("create table image_backend_api (id text primary key)");
    await pool.query(
      "insert into image_backend_api (id) values ('legacy-api')"
    );

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("legacy_media_image_backend_api_count=1\n");
    expect(result.stdout).toContain("legacy_media_total_count=1\n");
    expect(result.stdout).toContain("legacy_media_blocker_total_count=0\n");
    expect(result.stderr).toBe("");
  });

  it("旧 Web 账号数据仍存在时拒绝统一号池迁移前检查", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(
      `alter table image_backend_member rename to ${hiddenMediaMarkerTable}`
    );
    await pool.query(
      "create table image_backend_account (id text primary key)"
    );
    await pool.query(
      "insert into image_backend_account (id) values ('legacy-web-account')"
    );

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "legacy_media_image_backend_account_count=1\n"
    );
    expect(result.stdout).toContain("legacy_media_blocker_total_count=1\n");
    expect(result.stderr).toContain(
      "release governance gate failed: unified media preflight failed: 1 non-migratable rows found"
    );
  });

  it("非法模型元素与 Responses API 配置拒绝统一号池迁移前检查", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(
      `alter table image_backend_member rename to ${hiddenMediaMarkerTable}`
    );
    await pool.query(`
      create table image_backend_api (
        id text primary key,
        interface_mode text not null,
        image_upstream_mode text not null,
        supported_model_ids json not null
      )
    `);
    await pool.query(`
      insert into image_backend_api (
        id,
        interface_mode,
        image_upstream_mode,
        supported_model_ids
      ) values (
        'invalid-api',
        'responses',
        'responses',
        '[1, ""]'::json
      )
    `);

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("legacy_media_invalid_api_model_count=1\n");
    expect(result.stdout).toContain(
      "legacy_media_incompatible_api_protocol_count=1\n"
    );
    expect(result.stdout).toContain("legacy_media_blocker_total_count=2\n");
    expect(result.stderr).toContain(
      "release governance gate failed: unified media preflight failed: 2 non-migratable rows found"
    );
  });

  it("首次 postcheck 拒绝残留覆盖，后续 postcheck 允许合法覆盖", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await seedUser(pool, overrideUserId, "low");

    const initialResult = await runReleaseGate(
      "postcheck-initial",
      testDatabaseUrl
    );
    expect(initialResult.exitCode).toBe(1);
    expect(initialResult.stdout).toContain("non_null_user_override_count=1\n");
    expect(initialResult.stderr).toContain(
      "release governance gate failed: post-migration governance invariants failed"
    );

    const subsequentResult = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(subsequentResult.exitCode).toBe(0);
    expect(subsequentResult.stderr).toBe("");
    expect(subsequentResult.stdout).toContain(
      "non_null_user_override_count=1\n"
    );
  });

  it("后续 postcheck 在必需覆盖列缺失时拒绝发布", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(
      `alter table "user"
       rename column moderation_block_risk_level_override
       to moderation_block_risk_level_override_release_gate_test`
    );

    const result = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("release governance gate failed:");
    expect(result.stderr).toContain(
      'column "moderation_block_risk_level_override" does not exist'
    );
  });

  it("后续 postcheck 接受 0077 已移除的 API Images 流式配置列", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(`
      alter table image_backend_member_api_config
        drop column if exists use_stream
    `);

    const result = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("required_media_column_count=33\n");
    expect(result.stderr).toBe("");
  });

  it("后续 postcheck 在旧治理列残留时拒绝发布", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(
      `alter table "user"
       add column moderation_block_risk_level text not null default 'low'`
    );

    const result = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("old_governance_column_count=1\n");
    expect(result.stderr).toContain(
      "release governance gate failed: post-migration governance invariants failed"
    );
  });

  it("后续 postcheck 在视频真实模型约束定义漂移时拒绝发布", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(`
      alter table video_generation
        drop constraint video_generation_real_model_check;
      alter table video_generation
        add constraint video_generation_real_model_check
        check (model is not null)
    `);

    const result = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("video_contract_constraint_count=3\n");
    expect(result.stderr).toContain(
      "release governance gate failed: post-migration video request invariants failed"
    );
  });

  it("后续 postcheck 在视频输入清理原因约束缺失时拒绝发布", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(`
      alter table video_input_cleanup
        drop constraint video_input_cleanup_reason_check
    `);

    const result = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "video_contract_cleanup_reason_column_count=1\n"
    );
    expect(result.stdout).toContain("video_contract_constraint_count=3\n");
    expect(result.stderr).toContain(
      "release governance gate failed: post-migration video request invariants failed"
    );
  });

  it.each([
    {
      cleanupReasonColumnCount: "0",
      constraintCount: undefined,
      errorKind: "schema invariants",
      name: "默认值缺失",
      sql: `alter table video_input_cleanup
        alter column reason drop default`,
    },
    {
      cleanupReasonColumnCount: "0",
      constraintCount: undefined,
      errorKind: "schema invariants",
      name: "允许空值",
      sql: `alter table video_input_cleanup
        alter column reason drop not null`,
    },
    {
      cleanupReasonColumnCount: "1",
      constraintCount: "3",
      errorKind: "invariants",
      name: "同名约束定义漂移",
      sql: `alter table video_input_cleanup
        drop constraint video_input_cleanup_reason_check;
      alter table video_input_cleanup
        add constraint video_input_cleanup_reason_check
        check (reason in ('orphan', 'lifecycle_delete', 'unknown'))`,
    },
  ])("后续 postcheck 在视频输入清理 reason $name 时拒绝发布", async ({
    cleanupReasonColumnCount,
    constraintCount,
    errorKind,
    sql,
  }) => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(sql);

    const result = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `video_contract_cleanup_reason_column_count=${cleanupReasonColumnCount}\n`
    );
    if (constraintCount) {
      expect(result.stdout).toContain(
        `video_contract_constraint_count=${constraintCount}\n`
      );
    }
    expect(result.stderr).toContain(
      `release governance gate failed: post-migration video request ${errorKind} failed`
    );
  });
});
