/**
 * 审核策略服务的真实 PostgreSQL 集成测试。
 *
 * 职责：验证生产仓储的行锁、并发 before/after 链、审计失败回滚与锁等待删除。
 * 使用方：显式 `pnpm --filter @repo/integration-tests test:moderation` 发布门禁。
 * 关键依赖：专用 MODERATION_TEST_DATABASE_URL、0056 迁移、@repo/shared 策略服务。
 */
import { randomUUID } from "node:crypto";
import type { ModerationPolicyService } from "@repo/shared/moderation/policy-service";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

const GLOBAL_SETTING_KEY = "CONTENT_MODERATION_BLOCK_RISK_LEVEL";
const GLOBAL_ACTION = "moderation.setGlobalRiskLevel";
const USER_ACTION = "moderation.setUserRiskLevelOverride";
const runPrefix = `moderation-policy-integration-${randomUUID()}`;
const actorId = `${runPrefix}-actor`;
const userTargetId = `${runPrefix}-user-concurrency`;
const rollbackTargetId = `${runPrefix}-audit-rollback`;
const deletionTargetId = `${runPrefix}-delete-wait`;
const missingActorId = `${runPrefix}-missing-actor`;
const seededUserIds = [
  actorId,
  userTargetId,
  rollbackTargetId,
  deletionTargetId,
] as const;

interface OriginalGlobalSetting {
  value: unknown;
  isSecret: boolean;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AuditLevelRow {
  requestId: string;
  beforeLevel: string | null;
  afterLevel: string | null;
}

let pool: Pool | null = null;
let policyService: Pick<
  ModerationPolicyService,
  "setGlobalRiskLevel" | "setUserRiskLevelOverride"
> | null = null;
let originalGlobalSetting: OriginalGlobalSetting | null = null;
let sharedDatabaseLoaded = false;

/** 要求测试库已应用审核治理迁移，缺列或约束时明确红灯。 */
async function assertGovernanceMigrationReady(client: Pool): Promise<void> {
  const result = await client.query<{
    overrideColumn: boolean;
    overrideCheck: boolean;
    globalRow: boolean;
  }>(
    `
    select
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'user'
          and column_name = 'moderation_block_risk_level_override'
      ) as "overrideColumn",
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.user'::regclass
          and conname = 'user_moderation_block_risk_level_override_check'
      ) as "overrideCheck",
      exists (
        select 1 from system_setting
        where key = $1
      ) as "globalRow"
  `,
    [GLOBAL_SETTING_KEY]
  );
  const state = result.rows[0];
  if (!state?.overrideColumn || !state.overrideCheck || !state.globalRow) {
    throw new Error(
      "审核治理迁移未就绪：需要 0056 的用户覆盖列、CHECK 约束和全站策略行"
    );
  }
}

/** 创建本轮唯一的管理员和目标用户，避免与其他测试数据相撞。 */
async function seedUsers(client: Pool): Promise<void> {
  const roles = ["super_admin", "user", "user", "user"] as const;
  for (const [index, userId] of seededUserIds.entries()) {
    await client.query(
      `insert into "user" (id, name, email, role)
       values ($1, $2, $3, $4)`,
      [userId, `Integration ${index}`, `${userId}@example.test`, roles[index]]
    );
  }
}

/** 生成可由审计查询精确过滤的唯一请求标识。 */
function requestId(label: string): string {
  return `${runPrefix}-${label}-${randomUUID()}`;
}

/** 查询本轮请求对应的前后档位，不读取或输出其他审计字段。 */
async function readAuditLevels(
  client: Pool,
  action: string,
  requestIds: string[]
): Promise<AuditLevelRow[]> {
  const result = await client.query<{
    requestId: string;
    beforeLevel: string | null;
    afterLevel: string | null;
  }>(
    `
    select metadata ->> 'requestId' as "requestId",
           before ->> 'level' as "beforeLevel",
           after ->> 'level' as "afterLevel"
    from admin_audit_log
    where action = $1
      and metadata ->> 'requestId' = any($2::text[])
  `,
    [action, requestIds]
  );
  return result.rows;
}

/** 断言两次并发写形成从初态到数据库终态的连续审计链。 */
function expectContinuousTwoWriteChain(
  rows: AuditLevelRow[],
  initialLevel: string | null,
  finalLevel: string | null
): void {
  expect(rows).toHaveLength(2);
  const first = rows.find((row) => row.beforeLevel === initialLevel);
  if (!first) throw new Error("并发审计缺少从初态开始的第一跳");
  const second = rows.find(
    (row) =>
      row.requestId !== first.requestId && row.beforeLevel === first.afterLevel
  );
  if (!second) throw new Error("并发审计 before/after 未形成连续链");
  expect(second.afterLevel).toBe(finalLevel);
}

/** 等待策略连接真实进入 PostgreSQL 行锁等待，避免用固定延时猜测时序。 */
async function waitForPolicyLockWait(client: Pool): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ waiting: boolean }>(`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%moderation_block_risk_level_override%'
          and query ilike '%for update%'
      ) as waiting
    `);
    if (result.rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("未观察到审核策略写入进入 PostgreSQL 行锁等待");
}

/** 关闭 @repo/database 延迟创建的连接池，避免测试进程遗留连接。 */
async function closeSharedDatabasePool(): Promise<void> {
  if (!sharedDatabaseLoaded) return;
  const databaseModule = await import("@repo/database");
  const database = databaseModule.db as unknown as { $client?: unknown };
  const candidate = database.$client;
  if (
    candidate &&
    typeof candidate === "object" &&
    "end" in candidate &&
    typeof candidate.end === "function"
  ) {
    await candidate.end();
  }
}

/** 清除本轮数据并恢复测试前的全站设置。 */
async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query(
    `delete from admin_audit_log
     where metadata ->> 'requestId' like $1`,
    [`${runPrefix}%`]
  );
  if (originalGlobalSetting) {
    await pool.query(
      `update system_setting
       set value = $2::json,
           is_secret = $3,
           updated_by = $4,
           created_at = $5,
           updated_at = $6
       where key = $1`,
      [
        GLOBAL_SETTING_KEY,
        JSON.stringify(originalGlobalSetting.value),
        originalGlobalSetting.isSecret,
        originalGlobalSetting.updatedBy,
        originalGlobalSetting.createdAt,
        originalGlobalSetting.updatedAt,
      ]
    );
  }
  await pool.query(`delete from "user" where id = any($1::text[])`, [
    [...seededUserIds],
  ]);
}

beforeAll(async () => {
  const databaseUrl = requireDedicatedTestDatabaseUrl(
    "MODERATION_TEST_DATABASE_URL"
  );
  process.env.DATABASE_URL = databaseUrl;
  pool = new Pool({
    connectionString: databaseUrl,
    application_name: "fluxmedia-moderation-policy-integration",
    max: 6,
  });
  await assertGovernanceMigrationReady(pool);
  const original = await pool.query<{
    value: unknown;
    isSecret: boolean;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `
    select value,
           is_secret as "isSecret",
           updated_by as "updatedBy",
           created_at as "createdAt",
           updated_at as "updatedAt"
    from system_setting
    where key = $1
  `,
    [GLOBAL_SETTING_KEY]
  );
  originalGlobalSetting = original.rows[0] ?? null;
  await seedUsers(pool);
  await pool.query(
    `update system_setting
     set value = '"high"'::json, updated_by = $2, updated_at = now()
     where key = $1`,
    [GLOBAL_SETTING_KEY, actorId]
  );
  const [
    { createModerationPolicyService },
    { defaultModerationPolicyRepository },
  ] = await Promise.all([
    import("@repo/shared/moderation/policy-service"),
    import("../../shared/src/moderation/policy-repository"),
  ]);
  policyService = createModerationPolicyService({
    repository: defaultModerationPolicyRepository,
    invalidateSystemSettingsCache: async () => undefined,
    warn: () => undefined,
    now: () => new Date(),
    createAuditId: randomUUID,
  });
  sharedDatabaseLoaded = true;
});

afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await closeSharedDatabasePool();
    await pool?.end();
  }
});

describe("moderation policy service PostgreSQL integration", () => {
  it("串行化并发全站写并形成连续审计链", async () => {
    if (!pool || !policyService) throw new Error("集成测试尚未初始化");
    await pool.query(
      `update system_setting set value = '"high"'::json where key = $1`,
      [GLOBAL_SETTING_KEY]
    );
    const lowRequestId = requestId("global-low");
    const mediumRequestId = requestId("global-medium");
    const requests = [lowRequestId, mediumRequestId];
    await Promise.all([
      policyService.setGlobalRiskLevel({
        actor: { userId: actorId, role: "super_admin" },
        level: "low",
        reason: "并发全站写 low",
        requestId: lowRequestId,
      }),
      policyService.setGlobalRiskLevel({
        actor: { userId: actorId, role: "super_admin" },
        level: "medium",
        reason: "并发全站写 medium",
        requestId: mediumRequestId,
      }),
    ]);
    const current = await pool.query<{ level: string }>(
      `select value #>> '{}' as level from system_setting where key = $1`,
      [GLOBAL_SETTING_KEY]
    );
    const rows = await readAuditLevels(pool, GLOBAL_ACTION, requests);
    expectContinuousTwoWriteChain(rows, "high", current.rows[0]?.level ?? null);
  });

  it("串行化并发用户覆盖写并形成连续审计链", async () => {
    if (!pool || !policyService) throw new Error("集成测试尚未初始化");
    await pool.query(
      `update "user" set moderation_block_risk_level_override = null where id = $1`,
      [userTargetId]
    );
    const lowRequestId = requestId("user-low");
    const mediumRequestId = requestId("user-medium");
    const requests = [lowRequestId, mediumRequestId];
    await Promise.all([
      policyService.setUserRiskLevelOverride({
        actor: { userId: actorId, role: "super_admin" },
        userId: userTargetId,
        level: "low",
        reason: "并发用户覆盖 low",
        requestId: lowRequestId,
      }),
      policyService.setUserRiskLevelOverride({
        actor: { userId: actorId, role: "super_admin" },
        userId: userTargetId,
        level: "medium",
        reason: "并发用户覆盖 medium",
        requestId: mediumRequestId,
      }),
    ]);
    const current = await pool.query<{ level: string | null }>(
      `select moderation_block_risk_level_override as level from "user" where id = $1`,
      [userTargetId]
    );
    const rows = await readAuditLevels(pool, USER_ACTION, requests);
    expectContinuousTwoWriteChain(rows, null, current.rows[0]?.level ?? null);
  });

  it("审计插入失败时回滚用户覆盖", async () => {
    if (!pool || !policyService) throw new Error("集成测试尚未初始化");
    await pool.query(
      `update "user" set moderation_block_risk_level_override = null where id = $1`,
      [rollbackTargetId]
    );
    const currentRequestId = requestId("audit-failure");
    await expect(
      policyService.setUserRiskLevelOverride({
        actor: { userId: missingActorId, role: "super_admin" },
        userId: rollbackTargetId,
        level: "medium",
        reason: "强制审计外键失败",
        requestId: currentRequestId,
      })
    ).rejects.toThrow();
    const state = await pool.query<{ level: string | null }>(
      `select moderation_block_risk_level_override as level from "user" where id = $1`,
      [rollbackTargetId]
    );
    expect(state.rows[0]?.level ?? null).toBeNull();
    expect(
      (await readAuditLevels(pool, USER_ACTION, [currentRequestId])).length
    ).toBe(0);
  });

  it("审计插入失败时回滚全站设置", async () => {
    if (!pool || !policyService) throw new Error("集成测试尚未初始化");
    await pool.query(
      `update system_setting set value = '"high"'::json where key = $1`,
      [GLOBAL_SETTING_KEY]
    );
    const currentRequestId = requestId("global-audit-failure");
    await expect(
      policyService.setGlobalRiskLevel({
        actor: { userId: missingActorId, role: "super_admin" },
        level: "medium",
        reason: "强制全站审计外键失败",
        requestId: currentRequestId,
      })
    ).rejects.toThrow();
    const state = await pool.query<{ level: string }>(
      `select value #>> '{}' as level from system_setting where key = $1`,
      [GLOBAL_SETTING_KEY]
    );
    expect(state.rows[0]?.level).toBe("high");
    expect(
      (await readAuditLevels(pool, GLOBAL_ACTION, [currentRequestId])).length
    ).toBe(0);
  });

  it("目标在锁等待期间删除时返回 not_found 且不审计", async () => {
    if (!pool || !policyService) throw new Error("集成测试尚未初始化");
    const holder: PoolClient = await pool.connect();
    const currentRequestId = requestId("delete-during-lock-wait");
    let transactionOpen = false;
    let writePromise: Promise<unknown> | null = null;
    try {
      await holder.query("begin");
      transactionOpen = true;
      await holder.query(`select id from "user" where id = $1 for update`, [
        deletionTargetId,
      ]);
      writePromise = policyService.setUserRiskLevelOverride({
        actor: { userId: actorId, role: "super_admin" },
        userId: deletionTargetId,
        level: "low",
        reason: "目标锁等待删除",
        requestId: currentRequestId,
      });
      await waitForPolicyLockWait(pool);
      await holder.query(`delete from "user" where id = $1`, [
        deletionTargetId,
      ]);
      await holder.query("commit");
      transactionOpen = false;
      await expect(writePromise).rejects.toMatchObject({ code: "not_found" });
      expect(
        (await readAuditLevels(pool, USER_ACTION, [currentRequestId])).length
      ).toBe(0);
    } finally {
      if (transactionOpen) await holder.query("rollback");
      holder.release();
      await writePromise?.catch(() => undefined);
    }
  });
});
