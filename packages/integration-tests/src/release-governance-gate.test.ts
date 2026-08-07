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
const mediaUsageGovernanceMigrationStatements = readFileSync(
  new URL(
    "../../database/drizzle/0081_add_media_usage_governance.sql",
    import.meta.url
  ),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);
const imageBatchRetirementMigrationStatements = readFileSync(
  new URL(
    "../../database/drizzle/0084_remove_image_batch_contract.sql",
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
const mediaUsageUserId = `${runPrefix}-media-usage-user`;
const seededUserIds = [relayUserId, overrideUserId, mediaUsageUserId] as const;
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
  databaseUrl: string,
  expectedLedgerDigest?: string
): Promise<ReleaseGateResult> {
  return new Promise<ReleaseGateResult>((resolve, reject) => {
    const child = spawn(process.execPath, [releaseGatePath, command], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ...(expectedLedgerDigest
          ? { RELEASE_CREDITS_LEDGER_DIGEST: expectedLedgerDigest }
          : {}),
      },
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
 * 在当前连接中逐句执行 0081，验证手写迁移可重复且遇到 blocker 整体失败。
 *
 * @param client 已由调用方控制事务边界的 PostgreSQL 连接。
 * @returns 全部 0081 语句执行完成时完成的 Promise。
 * @throws 任一 preflight、DDL、回填、索引或 trigger 语句失败时原样抛错。
 * @sideEffect 修改当前连接可见的用户、图片任务与 credits trigger schema。
 * @boundary 不自行提交；测试调用方必须 rollback 或保证只操作隔离数据库。
 */
async function applyMediaUsageGovernanceMigration(
  client: PoolClient | Pool
): Promise<void> {
  for (const statement of mediaUsageGovernanceMigrationStatements) {
    await client.query(statement);
  }
}

/**
 * 在当前连接中逐句执行 0084，验证历史 count=1 归一化与批量阻断。
 *
 * @param client 已由调用方控制事务边界的 PostgreSQL 连接。
 * @returns 全部 0084 语句执行完成时完成的 Promise。
 * @throws 活跃任务、count>1、非法 count 或 DDL 失败时原样抛错。
 * @sideEffect 规范图片任务 JSON、摘要并重建批量字段 CHECK。
 * @boundary 不自行提交；调用方必须在隔离数据库中执行并负责回滚。
 */
async function applyImageBatchRetirementMigration(
  client: PoolClient | Pool
): Promise<void> {
  for (const statement of imageBatchRetirementMigrationStatements) {
    await client.query(statement);
  }
}

/**
 * 从门禁单行证据中读取稳定值。
 *
 * @param stdout 门禁子进程的非敏感标准输出。
 * @param key 不含等号的稳定证据键。
 * @returns 对应证据值，不包含键和等号。
 * @throws 输出缺少指定键时抛错，避免摘要测试静默使用空值。
 * @sideEffect 无副作用。
 * @boundary 只用于测试已知键，不解析或记录数据库连接信息。
 */
function readEvidence(stdout: string, key: string): string {
  const prefix = `${key}=`;
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`门禁缺少证据：${key}`);
  return line.slice(prefix.length);
}

/**
 * 以当前 preflight 账本摘要执行 postcheck，复现发布流程的显式摘要传递。
 *
 * @param command 要执行的首次或后续 postcheck 命令。
 * @param databaseUrl 已通过专用测试库校验的 PostgreSQL URL。
 * @returns postcheck 子进程的退出码和标准输出、错误输出。
 * @throws preflight 自身被 blocker 拒绝时抛错，避免伪造摘要继续验证。
 * @sideEffect 依次启动两个只读发布门禁子进程。
 * @boundary 仅传递 SHA-256 聚合摘要，不读取或传递任何账本行级数据。
 */
async function runReleasePostcheck(
  command: "postcheck" | "postcheck-initial",
  databaseUrl: string
): Promise<ReleaseGateResult> {
  const preflight = await runReleaseGate("preflight", databaseUrl);
  if (preflight.exitCode !== 0) {
    throw new Error(`postcheck 基线 preflight 失败：${preflight.stderr}`);
  }
  return runReleaseGate(
    command,
    databaseUrl,
    readEvidence(preflight.stdout, "credits_ledger_digest")
  );
}

/**
 * 创建迁移和门禁测试共用的最小 storage-only 单项图片输入。
 *
 * @param generationId 与旧 generation_ids 数组必须一致的稳定 ID。
 * @param operation 要构造的图片动作；编辑和蒙版会附带 storage 引用。
 * @returns 满足当前单项持久输入契约的 JSON-safe 对象。
 * @throws 不抛错；参数由测试用例控制。
 * @sideEffect 无副作用。
 * @boundary 不生成真实媒体、凭据或外部 URL，仅包含隔离测试对象键。
 */
function createStoredImageInput(
  generationId: string,
  operation: "generate" | "edit" | "mask" = "generate"
): Record<string, unknown> {
  const common = {
    generationId,
    model: "gpt-image-2",
    operation,
    prompt: "release governance fixture",
  };
  if (operation === "generate") return common;
  const reference = {
    byteLength: 4,
    mimeType: "image/png",
    source: "storage",
    storageBucket: "media-input",
    storageKey: `${runPrefix}/${generationId}.png`,
  };
  return operation === "edit"
    ? { ...common, images: [reference] }
    : { ...common, images: [reference], mask: reference };
}

/**
 * 插入一条仍使用旧数组列的图片异步任务。
 *
 * @param client 隔离 PostgreSQL 连接池或事务连接。
 * @param input 旧数组、外层动作、状态和本轮唯一任务 ID。
 * @returns 插入成功时完成的 Promise。
 * @throws 旧约束或测试数据库写入失败时原样抛错。
 * @sideEffect 写入一条引用 mediaUsageUserId 的 image_async_task。
 * @boundary 刻意不写 0081 新列，以复现 Phase A 迁移前历史形态。
 */
async function seedLegacyImageAsyncTask(
  client: Pool | PoolClient,
  input: {
    generationIds: unknown;
    generationInputs: unknown;
    id: string;
    operation?: "generate" | "edit" | "mask";
    status?: "queued" | "running" | "completed" | "failed";
  }
): Promise<void> {
  await client.query(
    `insert into image_async_task (
       id, user_id, api_key_id, plan, operation, generation_inputs,
       generation_ids, response_format, status
     ) values ($1, $2, 'release-gate-api-key', 'legacy-plan', $3, $4::json,
       $5::json, 'url', $6)`,
    [
      input.id,
      mediaUsageUserId,
      input.operation ?? "generate",
      JSON.stringify(input.generationInputs),
      JSON.stringify(input.generationIds),
      input.status ?? "completed",
    ]
  );
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
  await client.query(`
    alter table credits_batch
      enable trigger credits_batch_reject_subscription_insert;
    alter table credits_transaction
      enable trigger credits_transaction_reject_monthly_grant_insert;
  `);
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
  await applyMediaUsageGovernanceMigration(client);
  await applyImageBatchRetirementMigration(client);
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

  it("preflight-early 在 0081 前按 legacy 图片任务结构只读检查", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(`alter table image_async_task
      drop column generation_input,
      drop column input_digest,
      drop column generation_id,
      drop column effective_user_concurrency,
      drop column group_id_snapshot,
      drop column group_priority_snapshot,
      drop column admission_lease_token,
      drop column admission_lease_expires_at,
      drop column admission_lease_released_at,
      drop column mq_delivery_due_at,
      drop column claim_recovery_due_at,
      drop column admission_renewal_due_at,
      drop column terminal_release_due_at`);

    const result = await runReleaseGate("preflight-early", testDatabaseUrl);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("image_async_task_schema_state=legacy\n");
    expect(result.stdout).toContain(
      "image_async_task_legacy_nonterminal_count=0\n"
    );
    expect(result.stderr).toBe("");
  });

  it.each([
    { evidence: "subscription_active_count=1\n", status: "active" },
    { evidence: "subscription_active_count=1\n", status: "trialing" },
    { evidence: "subscription_active_count=1\n", status: "past_due" },
    {
      evidence: "subscription_effective_canceled_count=1\n",
      status: "canceled",
    },
  ])("preflight 拒绝仍需履约的 $status 订阅", async ({ evidence, status }) => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await seedUser(pool, relayUserId);
    await pool.query(
      `insert into subscription (
         id,
         user_id,
         subscription_id,
         price_id,
         status,
         current_period_start,
         current_period_end
       ) values ($1, $2, $3, 'price-test', $4, now(), now() + interval '1 day')`,
      [
        `${runPrefix}-subscription`,
        relayUserId,
        `${runPrefix}-provider-subscription`,
        status,
      ]
    );

    for (const command of ["preflight-early", "preflight"] as const) {
      const result = await runReleaseGate(command, testDatabaseUrl);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(evidence);
      expect(result.stderr).toContain(
        "release governance gate failed: subscription retirement preflight failed"
      );
    }
  });

  it.each([
    {
      evidence: "epay_subscription_pending_count=1\n",
      minutesAgo: 0,
      status: "pending",
    },
    {
      evidence: "epay_subscription_fulfilling_count=1\n",
      minutesAgo: 0,
      status: "fulfilling",
    },
    {
      evidence: "epay_subscription_expired_fulfilling_count=1\n",
      minutesAgo: 10,
      status: "fulfilling",
    },
    {
      evidence: "epay_subscription_unknown_status_count=1\n",
      minutesAgo: 0,
      status: "mystery",
    },
  ])("preflight 拒绝 Epay 订阅订单状态 $status（距更新 $minutesAgo 分钟）", async ({
    evidence,
    minutesAgo,
    status,
  }) => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await seedUser(pool, relayUserId);
    await pool.query(
      `insert into epay_order (
           out_trade_no, user_id, business_type, amount, status, metadata,
           updated_at
         ) values ($1, $2, 'subscription', 1, $3, '{}'::json,
           now() - ($4::text || ' minutes')::interval)`,
      [`${runPrefix}-epay`, relayUserId, status, minutesAgo]
    );

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(evidence);
    expect(result.stderr).toContain(
      "release governance gate failed: subscription retirement preflight failed"
    );
  });

  it.each([
    "success",
    "failed",
  ])("preflight 放行 Epay 订阅历史终态 %s", async (status) => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await seedUser(pool, relayUserId);
    await pool.query(
      `insert into epay_order (
           out_trade_no, user_id, business_type, amount, status, metadata
         ) values ($1, $2, 'subscription', 1, $3, '{}'::json)`,
      [`${runPrefix}-epay`, relayUserId, status]
    );

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("epay_subscription_pending_count=0\n");
    expect(result.stdout).toContain("epay_subscription_fulfilling_count=0\n");
    expect(result.stderr).toBe("");
  });

  it("preflight 按 metadata.type 识别业务类型不一致的 Epay 订阅订单", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await seedUser(pool, relayUserId);
    await pool.query(
      `insert into epay_order (
           out_trade_no, user_id, business_type, amount, status, metadata
         ) values ($1, $2, 'credit_top_up', 1, 'pending', $3::json)`,
      [
        `${runPrefix}-epay-metadata-subscription`,
        relayUserId,
        JSON.stringify({ type: "subscription" }),
      ]
    );

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("epay_subscription_pending_count=1\n");
    expect(result.stderr).toContain(
      "release governance gate failed: subscription retirement preflight failed"
    );
  });

  it("用户生图并发覆盖只接受 null 或 1..10000", async () => {
    if (!pool) throw new Error("集成测试尚未初始化");
    await seedUser(pool, mediaUsageUserId);
    await expect(
      pool.query(
        `update "user"
         set image_generation_concurrency_override = 0
         where id = $1`,
        [mediaUsageUserId]
      )
    ).rejects.toThrow(/user_image_generation_concurrency_override_check/);
    await expect(
      pool.query(
        `update "user"
         set image_generation_concurrency_override = 10001
         where id = $1`,
        [mediaUsageUserId]
      )
    ).rejects.toThrow(/user_image_generation_concurrency_override_check/);

    await pool.query(
      `update "user"
       set image_generation_concurrency_override = 1
       where id = $1`,
      [mediaUsageUserId]
    );
    await pool.query(
      `update "user"
       set image_generation_concurrency_override = 10000
       where id = $1`,
      [mediaUsageUserId]
    );
    await pool.query(
      `update "user"
       set image_generation_concurrency_override = null
       where id = $1`,
      [mediaUsageUserId]
    );
  });

  it("0081 只回填严格合法的终态单项任务并可重复执行", async () => {
    if (!pool) throw new Error("集成测试尚未初始化");
    const client = await pool.connect();
    const generationId = `${runPrefix}-migrated-generation`;
    const taskId = `${runPrefix}-migrated-task`;
    try {
      await client.query("begin");
      await client.query(
        `insert into "user" (id, name, email)
         values ($1, 'Media usage migration', $2)`,
        [mediaUsageUserId, `${mediaUsageUserId}@example.test`]
      );
      await seedLegacyImageAsyncTask(client, {
        generationIds: [generationId],
        generationInputs: [createStoredImageInput(generationId, "edit")],
        id: taskId,
        operation: "edit",
        status: "completed",
      });

      await applyMediaUsageGovernanceMigration(client);
      await applyMediaUsageGovernanceMigration(client);
      const result = await client.query<{
        api_key_id: string;
        generation_id: string;
        generation_input: Record<string, unknown>;
        generation_inputs: Array<Record<string, unknown>>;
        input_digest: string;
        plan: string;
        user_id: string;
      }>(
        `select
           user_id, api_key_id, plan, generation_inputs, generation_input,
           generation_id, input_digest
         from image_async_task
         where id = $1`,
        [taskId]
      );
      expect(result.rows[0]).toMatchObject({
        api_key_id: "release-gate-api-key",
        generation_inputs: [createStoredImageInput(generationId, "edit")],
        plan: "legacy-plan",
        user_id: mediaUsageUserId,
      });
      expect(result.rows[0]?.generation_id).toBe(generationId);
      expect(result.rows[0]?.generation_input).toEqual(
        createStoredImageInput(generationId, "edit")
      );
      expect(result.rows[0]?.input_digest).toMatch(/^md5:[0-9a-f]{32}$/);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("0084 删除历史 count=1、重算 md5 并可重复执行", async () => {
    if (!pool) throw new Error("集成测试尚未初始化");
    const client = await pool.connect();
    const generationId = `${runPrefix}-single-count-generation`;
    const taskId = `${runPrefix}-single-count-task`;
    const legacyInput = {
      ...createStoredImageInput(generationId),
      count: 1,
    };
    try {
      await client.query("begin");
      await client.query(
        `alter table image_async_task
         drop constraint image_async_task_batch_count_retired_check`
      );
      await client.query(
        `insert into "user" (id, name, email)
         values ($1, 'Image batch migration', $2)`,
        [mediaUsageUserId, `${mediaUsageUserId}@example.test`]
      );
      await seedLegacyImageAsyncTask(client, {
        generationIds: [generationId],
        generationInputs: [legacyInput],
        id: taskId,
      });

      await applyMediaUsageGovernanceMigration(client);
      await applyImageBatchRetirementMigration(client);
      await applyImageBatchRetirementMigration(client);

      const result = await client.query<{
        generation_input: Record<string, unknown>;
        generation_inputs: Array<Record<string, unknown>>;
        input_digest: string;
      }>(
        `select generation_input, generation_inputs, input_digest
         from image_async_task
         where id = $1`,
        [taskId]
      );
      const normalized = createStoredImageInput(generationId);
      expect(result.rows[0]).toMatchObject({
        generation_input: normalized,
        generation_inputs: [normalized],
      });
      expect(result.rows[0]?.generation_input).not.toHaveProperty("count");
      expect(result.rows[0]?.input_digest).toMatch(/^md5:[0-9a-f]{32}$/);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("0084 遇到历史 count>1 时整体阻断", async () => {
    if (!pool) throw new Error("集成测试尚未初始化");
    const client = await pool.connect();
    const generationId = `${runPrefix}-batch-count-generation`;
    try {
      await client.query("begin");
      await client.query(
        `alter table image_async_task
         drop constraint image_async_task_batch_count_retired_check`
      );
      await client.query(
        `insert into "user" (id, name, email)
         values ($1, 'Image batch blocker', $2)`,
        [mediaUsageUserId, `${mediaUsageUserId}@example.test`]
      );
      await seedLegacyImageAsyncTask(client, {
        generationIds: [generationId],
        generationInputs: [
          { ...createStoredImageInput(generationId), count: 2 },
        ],
        id: `${runPrefix}-batch-count-task`,
      });

      await applyMediaUsageGovernanceMigration(client);
      await expect(applyImageBatchRetirementMigration(client)).rejects.toThrow(
        /invalid=1/
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it.each([
    "queued",
    "running",
  ] as const)("preflight 与 0081 都拒绝非终态旧图片任务 %s", async (status) => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    const generationId = `${runPrefix}-${status}-generation`;
    await seedUser(pool, mediaUsageUserId);
    await seedLegacyImageAsyncTask(pool, {
      generationIds: [generationId],
      generationInputs: [createStoredImageInput(generationId)],
      id: `${runPrefix}-${status}-task`,
      status,
    });

    const gateResult = await runReleaseGate("preflight", testDatabaseUrl);
    expect(gateResult.exitCode).toBe(1);
    expect(gateResult.stdout).toContain(
      "image_async_task_legacy_nonterminal_count=1\n"
    );
    expect(gateResult.stderr).toContain(
      "image async task retirement preflight failed"
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(applyMediaUsageGovernanceMigration(client)).rejects.toThrow(
        /legacy_nonterminal=1/
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("preflight 拒绝缺少治理与 admission 快照的新非终态任务", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    const generationId = `${runPrefix}-incomplete-additive-generation`;
    const generationInput = createStoredImageInput(generationId);
    await seedUser(pool, mediaUsageUserId);
    await pool.query(
      `insert into image_async_task (
         id, user_id, api_key_id, plan, operation, generation_inputs,
         generation_ids, generation_input, generation_id, input_digest,
         response_format, status
       ) values (
         $1, $2, 'release-gate-api-key', 'legacy-plan', 'generate', $3::json,
         $4::json, $5::json, $6, $7, 'url', 'queued'
       )`,
      [
        `${runPrefix}-incomplete-additive-task`,
        mediaUsageUserId,
        JSON.stringify([generationInput]),
        JSON.stringify([generationId]),
        JSON.stringify(generationInput),
        generationId,
        `sha256:${"0".repeat(64)}`,
      ]
    );

    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "image_async_task_new_field_invalid_count=1\n"
    );
    expect(result.stderr).toContain(
      "image async task retirement preflight failed"
    );
  });

  it("generation、admission token 与 due 状态由数据库约束兜底", async () => {
    if (!pool) throw new Error("集成测试尚未初始化");
    const database = pool;
    await seedUser(database, mediaUsageUserId);
    /**
     * 插入一条终态 additive 任务以定向触发 token 或 due 数据库约束。
     *
     * @param input 唯一任务/generation 身份及可选租约到期、MQ due 时间。
     * @returns 插入成功时完成的 Promise。
     * @throws partial unique 或 CHECK 不满足时透传 PostgreSQL 错误。
     * @sideEffect 写入隔离测试库的 image_async_task；afterEach 级联清理。
     * @boundary 始终写入完整策略快照，不混入待验证约束之外的脏字段。
     */
    const insertTask = async (input: {
      generationId: string;
      mqDeliveryDueAt?: Date;
      taskId: string;
      token: string;
      tokenExpiresAt?: Date;
    }): Promise<void> => {
      const generationInput = createStoredImageInput(input.generationId);
      await database.query(
        `insert into image_async_task (
           id, user_id, api_key_id, plan, operation, generation_inputs,
           generation_ids, generation_input, generation_id, input_digest,
           effective_user_concurrency, group_id_snapshot,
           group_priority_snapshot, admission_lease_token,
           admission_lease_expires_at, mq_delivery_due_at, response_format,
           status
         ) values (
           $1, $2, 'release-gate-api-key', 'legacy-plan', 'generate', $3::json,
           $4::json, $5::json, $6, $7, 20, 'default-group', 50, $8, $9,
           $10, 'url', 'completed'
         )`,
        [
          input.taskId,
          mediaUsageUserId,
          JSON.stringify([generationInput]),
          JSON.stringify([input.generationId]),
          JSON.stringify(generationInput),
          input.generationId,
          `sha256:${"1".repeat(64)}`,
          input.token,
          input.tokenExpiresAt ?? null,
          input.mqDeliveryDueAt ?? null,
        ]
      );
    };
    await insertTask({
      generationId: `${runPrefix}-constraint-generation-a`,
      taskId: `${runPrefix}-constraint-task-a`,
      token: `${runPrefix}-shared-token`,
      tokenExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      insertTask({
        generationId: `${runPrefix}-constraint-generation-a`,
        taskId: `${runPrefix}-constraint-task-generation-duplicate`,
        token: `${runPrefix}-generation-duplicate-token`,
        tokenExpiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toThrow(/image_async_task_generation_id_unique/);
    await expect(
      insertTask({
        generationId: `${runPrefix}-constraint-generation-b`,
        taskId: `${runPrefix}-constraint-task-b`,
        token: `${runPrefix}-shared-token`,
        tokenExpiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toThrow(/image_async_task_admission_lease_token_unique/);
    await expect(
      insertTask({
        generationId: `${runPrefix}-constraint-generation-c`,
        taskId: `${runPrefix}-constraint-task-c`,
        token: `${runPrefix}-unpaired-token`,
      })
    ).rejects.toThrow(/image_async_task_admission_lease_state_check/);
    await expect(
      insertTask({
        generationId: `${runPrefix}-constraint-generation-d`,
        mqDeliveryDueAt: new Date(),
        taskId: `${runPrefix}-constraint-task-d`,
        token: `${runPrefix}-due-token`,
        tokenExpiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toThrow(/image_async_task_due_state_check/);
  });

  it.each([
    {
      generationIds: ["non-array"],
      generationInputs: createStoredImageInput("non-array"),
      name: "输入不是数组",
    },
    { generationIds: [], generationInputs: [], name: "空数组" },
    {
      generationIds: ["multi-a", "multi-b"],
      generationInputs: [
        createStoredImageInput("multi-a"),
        createStoredImageInput("multi-b"),
      ],
      name: "多项数组",
    },
    {
      generationIds: ["array-id"],
      generationInputs: [createStoredImageInput("input-id")],
      name: "generation ID 不一致",
    },
    {
      generationIds: ["operation-mismatch"],
      generationInputs: [createStoredImageInput("operation-mismatch", "edit")],
      name: "operation 不一致",
    },
    {
      generationIds: [" "],
      generationInputs: [createStoredImageInput(" ")],
      name: "generation ID 为空",
    },
    {
      generationIds: ["invalid-schema"],
      generationInputs: [
        { ...createStoredImageInput("invalid-schema"), prompt: " " },
      ],
      name: "不满足新输入 schema",
    },
    {
      generationIds: ["unknown-field"],
      generationInputs: [
        { ...createStoredImageInput("unknown-field"), unexpected: true },
      ],
      name: "包含 strict schema 未知字段",
    },
    {
      generationIds: ["non-storage-edit"],
      generationInputs: [
        {
          ...createStoredImageInput("non-storage-edit", "edit"),
          images: [
            {
              base64: "dGVzdA==",
              byteLength: 4,
              mimeType: "image/png",
              source: "data",
            },
          ],
        },
      ],
      name: "编辑输入不是 storage-only",
    },
  ])("preflight 与 0081 对 $name fail-closed", async (fixture) => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await seedUser(pool, mediaUsageUserId);
    await seedLegacyImageAsyncTask(pool, {
      generationIds: fixture.generationIds,
      generationInputs: fixture.generationInputs,
      id: `${runPrefix}-invalid-task`,
    });

    const gateResult = await runReleaseGate("preflight", testDatabaseUrl);
    expect(gateResult.exitCode).toBe(1);
    expect(gateResult.stdout).toContain(
      "image_async_task_invalid_mapping_count=1\n"
    );
    expect(gateResult.stderr).toContain(
      "image async task retirement preflight failed"
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(applyMediaUsageGovernanceMigration(client)).rejects.toThrow(
        /legacy_invalid=1/
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("preflight 与 0081 拒绝跨任务重复 generation ID", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    const generationId = `${runPrefix}-duplicate-generation`;
    await seedUser(pool, mediaUsageUserId);
    await seedLegacyImageAsyncTask(pool, {
      generationIds: [generationId],
      generationInputs: [createStoredImageInput(generationId)],
      id: `${runPrefix}-duplicate-task-a`,
    });
    await seedLegacyImageAsyncTask(pool, {
      generationIds: [generationId],
      generationInputs: [createStoredImageInput(generationId)],
      id: `${runPrefix}-duplicate-task-b`,
      status: "failed",
    });

    const gateResult = await runReleaseGate("preflight", testDatabaseUrl);
    expect(gateResult.exitCode).toBe(1);
    expect(gateResult.stdout).toContain(
      "image_async_task_generation_conflict_count=1\n"
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(applyMediaUsageGovernanceMigration(client)).rejects.toThrow(
        /generation_conflict=1/
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("credits 守门只拒绝新订阅分类并放行历史 UPDATE", async () => {
    if (!pool) throw new Error("集成测试尚未初始化");
    await seedUser(pool, mediaUsageUserId);
    await expect(
      pool.query(
        `insert into credits_batch (
           id, user_id, amount, remaining, source_type, source_ref
         ) values ($1, $2, 10, 10, 'subscription', $3)`,
        [
          `${runPrefix}-new-subscription-batch`,
          mediaUsageUserId,
          `${runPrefix}-new-subscription-source`,
        ]
      )
    ).rejects.toThrow(/new subscription credits batches are retired/);
    await expect(
      pool.query(
        `insert into credits_transaction (
           id, user_id, type, amount, debit_account, credit_account
         ) values ($1, $2, 'monthly_grant', 10, 'SYSTEM', 'USER')`,
        [`${runPrefix}-new-monthly-grant`, mediaUsageUserId]
      )
    ).rejects.toThrow(/new monthly grant credits transactions are retired/);

    try {
      await pool.query(`
        alter table credits_batch
          disable trigger credits_batch_reject_subscription_insert;
        alter table credits_transaction
          disable trigger credits_transaction_reject_monthly_grant_insert;
      `);
      await pool.query(
        `insert into credits_batch (
           id, user_id, amount, remaining, status, source_type, source_ref
         ) values ($1, $2, 10, 10, 'active', 'subscription', $3)`,
        [
          `${runPrefix}-historical-subscription-batch`,
          mediaUsageUserId,
          `${runPrefix}-historical-subscription-source`,
        ]
      );
      await pool.query(
        `insert into credits_transaction (
           id, user_id, type, amount, debit_account, credit_account
         ) values ($1, $2, 'monthly_grant', 10, 'SYSTEM', 'USER')`,
        [`${runPrefix}-historical-monthly-grant`, mediaUsageUserId]
      );
    } finally {
      await pool.query(`
        alter table credits_batch
          enable trigger credits_batch_reject_subscription_insert;
        alter table credits_transaction
          enable trigger credits_transaction_reject_monthly_grant_insert;
      `);
    }

    await pool.query(
      `update credits_batch
       set remaining = 0, status = 'consumed', expires_at = now()
       where id = $1`,
      [`${runPrefix}-historical-subscription-batch`]
    );
    await pool.query(
      `update credits_transaction
       set description = 'historical row remains updateable'
       where id = $1`,
      [`${runPrefix}-historical-monthly-grant`]
    );
    await pool.query(
      `insert into credits_batch (
         id, user_id, amount, remaining, source_type, source_ref
       ) values ($1, $2, 2, 2, 'refund', $3)`,
      [
        `${runPrefix}-retained-refund-batch`,
        mediaUsageUserId,
        `${runPrefix}-retained-refund-source`,
      ]
    );
    await pool.query(
      `insert into credits_transaction (
         id, user_id, type, amount, debit_account, credit_account,
         operation_type, operation_id, operation_created_at
       ) values (
         $1, $2, 'refund', 2, 'SYSTEM', 'USER', 'image_generation', $3, now()
       )`,
      [
        `${runPrefix}-retained-refund-transaction`,
        mediaUsageUserId,
        `${runPrefix}-retained-refund-operation`,
      ]
    );
    const result = await pool.query<{
      description: string;
      remaining: string;
      status: string;
    }>(
      `select
         batch.remaining::text as remaining,
         batch.status::text as status,
         transaction.description
       from credits_batch as batch
       inner join credits_transaction as transaction
         on transaction.user_id = batch.user_id
       where batch.id = $1 and transaction.id = $2`,
      [
        `${runPrefix}-historical-subscription-batch`,
        `${runPrefix}-historical-monthly-grant`,
      ]
    );
    expect(result.rows[0]).toEqual({
      description: "historical row remains updateable",
      remaining: "0.00",
      status: "consumed",
    });
  });

  it("账本摘要在 preflight 与 postcheck 间稳定并拒绝漂移", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await seedUser(pool, mediaUsageUserId);
    await pool.query(
      `insert into credits_batch (
         id, user_id, amount, remaining, source_type, source_ref
       ) values ($1, $2, 8, 8, 'bonus', $3)`,
      [
        `${runPrefix}-ledger-batch`,
        mediaUsageUserId,
        `${runPrefix}-ledger-source`,
      ]
    );
    await pool.query(
      `insert into credits_transaction (
         id, user_id, type, amount, debit_account, credit_account
       ) values ($1, $2, 'admin_grant', 8, 'SYSTEM', 'USER')`,
      [`${runPrefix}-ledger-transaction`, mediaUsageUserId]
    );

    const preflight = await runReleaseGate("preflight", testDatabaseUrl);
    expect(preflight.exitCode).toBe(0);
    const digest = readEvidence(preflight.stdout, "credits_ledger_digest");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const unchanged = await runReleaseGate(
      "postcheck",
      testDatabaseUrl,
      digest
    );
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout).toContain("credits_ledger_digest_expected=true\n");
    expect(unchanged.stdout).toContain(
      "media_usage_image_task_column_count=13\n"
    );
    expect(unchanged.stdout).toContain(
      "media_usage_mq_delivery_version_valid=true\n"
    );
    expect(unchanged.stdout).toContain("media_usage_constraint_count=8\n");
    expect(unchanged.stdout).toContain("media_usage_partial_index_count=6\n");
    expect(unchanged.stdout).toContain("media_usage_enabled_trigger_count=2\n");

    await pool.query(
      `update credits_batch set source_type = 'refund' where id = $1`,
      [`${runPrefix}-ledger-batch`]
    );
    const sourceChanged = await runReleaseGate(
      "postcheck",
      testDatabaseUrl,
      digest
    );
    expect(sourceChanged.exitCode).toBe(1);
    expect(sourceChanged.stderr).toContain(
      "release governance gate failed: credits ledger digest changed during release"
    );
    await pool.query(
      `update credits_batch set source_type = 'bonus' where id = $1`,
      [`${runPrefix}-ledger-batch`]
    );

    await pool.query(`update credits_batch set remaining = 7 where id = $1`, [
      `${runPrefix}-ledger-batch`,
    ]);
    const changed = await runReleaseGate("postcheck", testDatabaseUrl, digest);
    expect(changed.exitCode).toBe(1);
    expect(changed.stderr).toContain(
      "release governance gate failed: credits ledger digest changed during release"
    );
  });

  it("postcheck 缺少 preflight 账本摘要时 fail-closed", async () => {
    if (!testDatabaseUrl) throw new Error("集成测试尚未初始化");
    const result = await runReleaseGate("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("credits_ledger_digest_expected=false\n");
    expect(result.stderr).toContain(
      "RELEASE_CREDITS_LEDGER_DIGEST is required for postcheck"
    );
  });

  it("postcheck 拒绝缺失的 0081 partial index", async () => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query("drop index image_async_task_claim_recovery_due_idx");

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("media_usage_partial_index_count=5\n");
    expect(result.stderr).toContain(
      "post-migration media usage governance invariants failed"
    );
  });

  it.each([
    {
      evidence: "media_usage_user_override_column_valid=false\n",
      name: "用户覆盖字段缺失",
      sql: `alter table "user"
        drop column image_generation_concurrency_override`,
    },
    {
      evidence: "media_usage_constraint_count=7\n",
      name: "CHECK 缺失",
      sql: `alter table image_async_task
        drop constraint image_async_task_due_state_check`,
    },
    {
      evidence: "media_usage_enabled_trigger_count=1\n",
      name: "INSERT-only trigger 被禁用",
      sql: `alter table credits_batch
        disable trigger credits_batch_reject_subscription_insert`,
    },
  ])("postcheck 在 $name 时拒绝发布", async ({ evidence, sql }) => {
    if (!pool || !testDatabaseUrl) throw new Error("集成测试尚未初始化");
    await pool.query(sql);

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(evidence);
    expect(result.stderr).toContain(
      "post-migration media usage governance invariants failed"
    );
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

    const initialResult = await runReleasePostcheck(
      "postcheck-initial",
      testDatabaseUrl
    );
    expect(initialResult.exitCode).toBe(1);
    expect(initialResult.stdout).toContain("non_null_user_override_count=1\n");
    expect(initialResult.stderr).toContain(
      "release governance gate failed: post-migration governance invariants failed"
    );

    const subsequentResult = await runReleasePostcheck(
      "postcheck",
      testDatabaseUrl
    );
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

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
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

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
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

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
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

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
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

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
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

    const result = await runReleasePostcheck("postcheck", testDatabaseUrl);
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
