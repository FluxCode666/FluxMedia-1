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
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

const releaseGatePath = fileURLToPath(
  new URL("../../database/scripts/release-governance-gate.mjs", import.meta.url)
);
const runPrefix = `release-governance-gate-integration-${randomUUID()}`;
const relayUserId = `${runPrefix}-relay-user`;
const overrideUserId = `${runPrefix}-override-user`;
const seededUserIds = [relayUserId, overrideUserId] as const;
const hiddenOverrideColumn =
  "moderation_block_risk_level_override_release_gate_test";
const hiddenMediaMarkerTable = "image_backend_member_release_gate_test";

type ReleaseGateCommand = "postcheck" | "postcheck-initial" | "preflight";

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
}

let pool: Pool | null = null;
let testDatabaseUrl: string | null = null;

/**
 * 要求测试库处于 0056 完成后的干净治理状态。
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
    state.oldColumnCount !== "0"
  ) {
    throw new Error(
      "发布门禁测试库未就绪：需要 0056 完整迁移且不能残留旧治理列"
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
 * @sideEffect 执行受限 DDL，并删除 UUID 前缀限定的测试用户及其级联 API Key。
 * @boundary 仅操作本测试创建的三个旧列名、一个隐藏列名和两个固定用户 ID。
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
});

afterEach(async () => {
  if (pool) await restoreReleaseGateFixtures(pool);
});

afterAll(async () => {
  try {
    if (pool) await restoreReleaseGateFixtures(pool);
  } finally {
    await pool?.end();
  }
});

describe("release governance gate PostgreSQL integration", () => {
  it("后续发布在 relay_only 旧列已删除时允许 preflight", async () => {
    if (!testDatabaseUrl) throw new Error("集成测试尚未初始化");
    const result = await runReleaseGate("preflight", testDatabaseUrl);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("relay_only_column=absent\n");
    expect(result.stdout).toContain("relay_only_true_count=0\n");
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
});
