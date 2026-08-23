/**
 * 媒体生成财务与 API 适配版本恢复的真实 PostgreSQL 集成测试。
 *
 * 职责：验证图片实时/stale 竞争只退款一次、视频重复退款与 API Key 配额幂等，
 * 以及视频恢复固定旧适配版本并读取同凭据域当前密钥。
 * 使用方：显式 `test:media-generation-financial-recovery` 发布质量门。
 */

import { randomUUID } from "node:crypto";
import { createDefaultApiUpstreamOperations } from "@repo/shared/image-backend/api-upstream-adaptation";
import { eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiVideoRecoveryConfigDatabase } from "../../../apps/web/src/features/image-backend-pool/runtime-service";
import {
  createPostgresVideoApiKeyQuotaRepository,
  type VideoApiKeyQuotaDatabase,
} from "../../../apps/web/src/features/image-generation/video-api-key-quota";
import {
  createPostgresVideoRecoveryRepository,
  type VideoRecoveryDatabase,
} from "../../../apps/web/src/features/image-generation/video-recovery-repository";
import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

type RefundGenerationCredits =
  typeof import("@repo/shared/generation-maintenance").refundGenerationCredits;
type RefundExternalApiKeyCredits =
  typeof import("../../../apps/web/src/features/external-api/quota").refundExternalApiKeyCredits;
type LoadApiVideoRecoveryConfig =
  typeof import("../../../apps/web/src/features/image-backend-pool/runtime-service").loadApiVideoRecoveryConfig;

interface CountRow {
  count: string;
}

interface FinancialSnapshotRow {
  balance: string;
  total_refunded: string;
  credits_used: string;
}

let baseDatabaseUrl = "";
let fixtureSchemaName = "";
let ownerPool: Pool | null = null;
let loadApiVideoRecoveryConfig: LoadApiVideoRecoveryConfig;
let refundGenerationCredits: RefundGenerationCredits;
let refundExternalApiKeyCredits: RefundExternalApiKeyCredits;

/** 创建测试进程唯一 schema，包含生产财务函数和恢复仓储实际访问的最小表。 */
async function createFixtureSchema(client: PoolClient): Promise<string> {
  const schemaName = `media_financial_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create schema "${schemaName}"`);
  await client.query(`set search_path to "${schemaName}", public`);
  await client.query(`
    create table "user" (
      id text primary key
    );
    create table system_setting (
      key text primary key,
      value jsonb not null,
      is_secret boolean not null default false,
      updated_by text,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table credits_balance (
      id text primary key,
      user_id text not null unique,
      balance numeric(18, 2) not null default 0,
      total_earned numeric(18, 2) not null default 0,
      total_spent numeric(18, 2) not null default 0,
      total_refunded numeric(18, 2) not null default 0,
      status text not null default 'active',
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table credits_batch (
      id text primary key,
      user_id text not null,
      amount numeric(18, 2) not null,
      remaining numeric(18, 2) not null,
      issued_at timestamp not null default now(),
      expires_at timestamp,
      status text not null default 'active',
      source_type text not null,
      source_ref text,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create unique index credits_batch_source_ref_unique
      on credits_batch (source_type, source_ref)
      where source_ref is not null;
    create table credits_transaction (
      id text primary key,
      user_id text not null,
      type text not null,
      amount numeric(18, 2) not null,
      debit_account text not null,
      credit_account text not null,
      description text,
      source_ref text,
      operation_type text,
      operation_id text,
      operation_created_at timestamp,
      metadata jsonb,
      created_at timestamp not null default now()
    );
    create unique index credits_transaction_user_type_source_ref_unique
      on credits_transaction (user_id, type, source_ref)
      where source_ref is not null;
    create table credit_usage_operation (
      user_id text not null,
      operation_type text not null,
      operation_id text not null,
      operation_created_at timestamp not null,
      gross_consumed numeric(18, 2) not null default 0,
      refunded numeric(18, 2) not null default 0,
      net_consumed numeric(18, 2) not null default 0,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
      primary key (user_id, operation_type, operation_id)
    );
    create table credit_usage_projection_entry (
      transaction_id text primary key,
      user_id text not null,
      contribution_kind text not null,
      amount numeric(18, 2) not null,
      operation_type text not null,
      operation_id text not null,
      operation_created_at timestamp not null,
      transaction_created_at timestamp not null,
      projected_at timestamp not null default now()
    );
    create table external_api_key (
      id text primary key,
      user_id text not null,
      name text not null default 'test key',
      key_prefix text not null default 'test',
      key_hash text not null unique,
      last_four text not null default 'test',
      generation_group_id text,
      credit_limit numeric(18, 2),
      credits_used numeric(18, 2) not null default 0,
      last_used_at timestamp,
      is_active boolean not null default true,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table generation (
      id text primary key,
      user_id text not null,
      status text not null,
      credits_consumed numeric(18, 2) not null default 0,
      created_at timestamp not null default now()
    );
    create table video_generation (
      id text primary key,
      user_id text not null,
      api_key_id text,
      api_key_credits_reserved numeric(18, 2) not null default 0,
      metadata jsonb,
      stage text not null,
      state_version integer not null default 0,
      next_poll_at timestamp,
      refund_exhausted_at timestamp,
      claim_token text,
      claim_expires_at timestamp,
      submit_started_at timestamp,
      api_adapter_member_id text,
      api_adapter_version_id text,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table image_backend_member (
      id text primary key,
      type text not null
    );
    create table image_backend_member_api_config (
      member_id text primary key,
      credential_scope text not null,
      api_key text not null
    );
    create table image_backend_member_api_adapter_version (
      id text primary key,
      member_id_snapshot text not null,
      credential_scope text not null,
      configuration jsonb not null
    )
  `);
  return schemaName;
}

/** 为数据库单例追加本轮 schema search_path，不改变专用数据库主机或库名。 */
function createSchemaDatabaseUrl(databaseUrl: string, schemaName: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schemaName},public`);
  return url.toString();
}

/** 把 Drizzle SQL 编译后交给指定 pg 连接执行。 */
async function executeSql(client: PoolClient, query: SQL): Promise<unknown> {
  const compiled = new PgDialect().sqlToQuery(query);
  return client.query(compiled.sql, compiled.params);
}

/** 创建生产视频恢复仓储所需的事务端口。 */
function createRecoveryDatabase(client: PoolClient): VideoRecoveryDatabase {
  return {
    async transaction<T>(
      work: (transaction: {
        execute(query: SQL): Promise<unknown>;
      }) => Promise<T>
    ): Promise<T> {
      await client.query("begin");
      try {
        const result = await work({
          execute: (query) => executeSql(client, query),
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    },
  };
}

/** 视频配额仓储与恢复 claim 共享同一事务形状。 */
function createQuotaDatabase(client: PoolClient): VideoApiKeyQuotaDatabase {
  return createRecoveryDatabase(client);
}

/** 固定版本配置加载只需要单语句 SQL 执行端口。 */
function createRecoveryConfigDatabase(
  client: PoolClient
): ApiVideoRecoveryConfigDatabase {
  return { execute: (query) => executeSql(client, query) };
}

/** 插入一个已完成初始扣费、可安全执行关联退款的计费操作。 */
async function seedConsumedOperation(
  client: PoolClient,
  input: {
    userId: string;
    operationType: "image_generation" | "video_generation";
    operationId: string;
    amount: number;
    apiKeyId: string;
    apiKeyCreditsUsed: number;
  }
): Promise<Date> {
  const operationCreatedAt = new Date("2026-08-01T00:00:00.000Z");
  const consumptionId = `consumption-${input.operationId}`;
  await client.query('insert into "user" (id) values ($1)', [input.userId]);
  await client.query(
    `insert into credits_balance (
       id, user_id, balance, total_earned, total_spent, total_refunded
     ) values ($1, $2, 100 - $3, 100, $3, 0)`,
    [`balance-${input.userId}`, input.userId, input.amount]
  );
  await client.query(
    `insert into external_api_key (
       id, user_id, key_hash, credit_limit, credits_used
     ) values ($1, $2, $3, 100, $4)`,
    [
      input.apiKeyId,
      input.userId,
      `hash-${input.apiKeyId}`,
      input.apiKeyCreditsUsed,
    ]
  );
  await client.query(
    `insert into credits_transaction (
       id, user_id, type, amount, debit_account, credit_account,
       source_ref, operation_type, operation_id, operation_created_at
     ) values (
       $1, $2, 'consumption', $3, 'WALLET:' || $2,
       'SYSTEM:image-generation', $4, $5, $6, $7
     )`,
    [
      consumptionId,
      input.userId,
      input.amount,
      `${input.operationId}:charge`,
      input.operationType,
      input.operationId,
      operationCreatedAt,
    ]
  );
  await client.query(
    `insert into credit_usage_operation (
       user_id, operation_type, operation_id, operation_created_at,
       gross_consumed, refunded, net_consumed
     ) values ($1, $2, $3, $4, $5, 0, $5)`,
    [
      input.userId,
      input.operationType,
      input.operationId,
      operationCreatedAt,
      input.amount,
    ]
  );
  await client.query(
    `insert into credit_usage_projection_entry (
       transaction_id, user_id, contribution_kind, amount, operation_type,
       operation_id, operation_created_at, transaction_created_at
     ) values ($1, $2, 'consumption', $3, $4, $5, $6, $6)`,
    [
      consumptionId,
      input.userId,
      input.amount,
      input.operationType,
      input.operationId,
      operationCreatedAt,
    ]
  );
  const database = await import("@repo/database");
  const [storedOperation] = await database.db
    .select({
      operationCreatedAt: database.creditUsageOperation.operationCreatedAt,
    })
    .from(database.creditUsageOperation)
    .where(eq(database.creditUsageOperation.operationId, input.operationId))
    .limit(1);
  const storedOperationCreatedAt = storedOperation?.operationCreatedAt;
  if (!storedOperationCreatedAt) {
    throw new Error("计费操作夹具缺少权威创建时间");
  }
  return storedOperationCreatedAt;
}

/** 关闭数据库单例为本测试创建的标准 PostgreSQL 连接池。 */
async function closeApplicationDatabasePool(): Promise<void> {
  const databaseGlobal = globalThis as typeof globalThis & {
    fluxMediaPostgresPool?: { end(): Promise<void> };
  };
  await databaseGlobal.fluxMediaPostgresPool?.end();
  delete databaseGlobal.fluxMediaPostgresPool;
}

beforeAll(async () => {
  baseDatabaseUrl = requireDedicatedTestDatabaseUrl(
    "MEDIA_GENERATION_FINANCIAL_RECOVERY_TEST_DATABASE_URL"
  );
  ownerPool = new Pool({
    application_name: "fluxmedia-media-financial-recovery-integration",
    connectionString: baseDatabaseUrl,
    max: 6,
  });
  const client = await ownerPool.connect();
  try {
    fixtureSchemaName = await createFixtureSchema(client);
  } finally {
    client.release();
  }

  process.env.DATABASE_URL = createSchemaDatabaseUrl(
    baseDatabaseUrl,
    fixtureSchemaName
  );
  ({ loadApiVideoRecoveryConfig } = await import(
    "../../../apps/web/src/features/image-backend-pool/runtime-service"
  ));
  ({ refundGenerationCredits } = await import(
    "@repo/shared/generation-maintenance"
  ));
  ({ refundExternalApiKeyCredits } = await import(
    "../../../apps/web/src/features/external-api/quota"
  ));
});

afterAll(async () => {
  await closeApplicationDatabasePool();
  if (ownerPool && fixtureSchemaName) {
    await ownerPool.query(`drop schema "${fixtureSchemaName}" cascade`);
  }
  await ownerPool?.end();
});

describe("media generation financial recovery", () => {
  it("图片实时失败与 stale-pending 竞争只生成一笔退款并保留其他 API Key 用量", async () => {
    if (!ownerPool) throw new Error("集成测试数据库尚未初始化");
    const owner = await ownerPool.connect();
    const first = await ownerPool.connect();
    const second = await ownerPool.connect();
    try {
      await Promise.all(
        [owner, first, second].map((client) =>
          client.query(`set search_path to "${fixtureSchemaName}", public`)
        )
      );
      const operationCreatedAt = await seedConsumedOperation(owner, {
        userId: "image-user",
        operationType: "image_generation",
        operationId: "image-1",
        amount: 10,
        apiKeyId: "image-key",
        apiKeyCreditsUsed: 20,
      });
      await owner.query(`
        insert into generation (id, user_id, status, credits_consumed)
        values ('image-1', 'image-user', 'pending', 10)
      `);

      /** 复刻实时失败与维护清扫共有的 pending CAS，只有胜者执行财务副作用。 */
      const settleCandidate = async (client: PoolClient) => {
        const updated = await client.query<{ id: string }>(`
          update generation
          set status = 'failed', credits_consumed = 0
          where id = 'image-1' and status = 'pending'
          returning id
        `);
        if (updated.rows.length !== 1) return false;
        await refundGenerationCredits({
          generationId: "image-1",
          userId: "image-user",
          amount: 10,
          sourceRef: "image-1:timeout-refund",
          description: "Refund failed image generation",
          operation: {
            operationType: "image_generation",
            operationId: "image-1",
            operationCreatedAt,
          },
        });
        await refundExternalApiKeyCredits({
          apiKeyId: "image-key",
          userId: "image-user",
          amount: 10,
        });
        return true;
      };

      const settled = await Promise.all([
        settleCandidate(first),
        settleCandidate(second),
      ]);
      expect(settled.filter(Boolean)).toHaveLength(1);

      const refundBatch = await owner.query<CountRow>(`
        select count(*)::text as count
        from credits_batch
        where source_type = 'refund'
          and source_ref = 'image-1:timeout-refund'
      `);
      const refundLedger = await owner.query<CountRow>(`
        select count(*)::text as count
        from credits_transaction
        where user_id = 'image-user'
          and type = 'refund'
          and source_ref = 'image-1:timeout-refund'
      `);
      const snapshot = await owner.query<FinancialSnapshotRow>(`
        select
          balance.balance::text,
          balance.total_refunded::text,
          key.credits_used::text
        from credits_balance balance
        join external_api_key key on key.user_id = balance.user_id
        where balance.user_id = 'image-user'
      `);
      expect(refundBatch.rows[0]?.count).toBe("1");
      expect(refundLedger.rows[0]?.count).toBe("1");
      expect(snapshot.rows[0]).toEqual({
        balance: "100.00",
        total_refunded: "10.00",
        credits_used: "10.00",
      });
    } finally {
      owner.release();
      first.release();
      second.release();
    }
  });

  it("视频重复退款只有一笔账本且任务级 API Key 预留只归还一次", async () => {
    if (!ownerPool) throw new Error("集成测试数据库尚未初始化");
    const owner = await ownerPool.connect();
    const first = await ownerPool.connect();
    const second = await ownerPool.connect();
    try {
      await Promise.all(
        [owner, first, second].map((client) =>
          client.query(`set search_path to "${fixtureSchemaName}", public`)
        )
      );
      const operationCreatedAt = await seedConsumedOperation(owner, {
        userId: "video-user",
        operationType: "video_generation",
        operationId: "video-1",
        amount: 8,
        apiKeyId: "video-key",
        apiKeyCreditsUsed: 18,
      });
      await owner.query(`
        insert into video_generation (
          id, user_id, api_key_id, api_key_credits_reserved, stage
        ) values ('video-1', 'video-user', 'video-key', 8, 'refunding')
      `);

      const refundInput = {
        generationId: "video-1",
        userId: "video-user",
        amount: 8,
        sourceRef: "video-1:refund",
        description: "Refund failed video generation",
        operation: {
          operationType: "video_generation" as const,
          operationId: "video-1",
          operationCreatedAt,
        },
      };
      const refundResults = await Promise.all([
        refundGenerationCredits(refundInput),
        refundGenerationCredits(refundInput),
      ]);
      expect(refundResults.map((result) => result.refunded).sort()).toEqual([
        false,
        true,
      ]);

      const quotaResults = await Promise.all([
        createPostgresVideoApiKeyQuotaRepository(
          createQuotaDatabase(first)
        ).refund({ videoId: "video-1" }),
        createPostgresVideoApiKeyQuotaRepository(
          createQuotaDatabase(second)
        ).refund({ videoId: "video-1" }),
      ]);
      expect(quotaResults.sort((left, right) => left - right)).toEqual([0, 8]);

      const refundLedger = await owner.query<CountRow>(`
        select count(*)::text as count
        from credits_transaction
        where user_id = 'video-user'
          and type = 'refund'
          and source_ref = 'video-1:refund'
      `);
      const snapshot = await owner.query<
        FinancialSnapshotRow & { api_key_credits_reserved: string }
      >(`
        select
          balance.balance::text,
          balance.total_refunded::text,
          key.credits_used::text,
          task.api_key_credits_reserved::text
        from credits_balance balance
        join external_api_key key on key.user_id = balance.user_id
        join video_generation task on task.user_id = balance.user_id
        where balance.user_id = 'video-user'
      `);
      expect(refundLedger.rows[0]?.count).toBe("1");
      expect(snapshot.rows[0]).toEqual({
        balance: "100.00",
        total_refunded: "8.00",
        credits_used: "10.00",
        api_key_credits_reserved: "0.00",
      });
    } finally {
      owner.release();
      first.release();
      second.release();
    }
  });

  it("恢复 claim 固定旧适配版本并只读取同凭据域当前密钥", async () => {
    if (!ownerPool) throw new Error("集成测试数据库尚未初始化");
    const owner = await ownerPool.connect();
    try {
      await owner.query(`set search_path to "${fixtureSchemaName}", public`);
      const operationsV1 = createDefaultApiUpstreamOperations();
      operationsV1["videos.query"].path = "/v1/jobs/{task_id}";
      operationsV1["videos.query"].responseScript =
        'return { status: "processing", progress: 25 };';
      const operationsV2 = createDefaultApiUpstreamOperations();
      operationsV2["videos.query"].path = "/v2/jobs/{task_id}";
      const credentialScope = "https://video.example.test|bearer";
      const versionV1 = {
        baseUrl: "https://video.example.test",
        useStream: false,
        modelMappings: [
          { modelId: "seedance2", upstreamModelId: "seedande-2.0" },
        ],
        authentication: { mode: "bearer" },
        credentialScope,
        operations: operationsV1,
      };
      const versionV2 = { ...versionV1, operations: operationsV2 };
      await owner.query(`
        update video_generation
        set stage = 'completed', next_poll_at = null
        where stage not in ('completed', 'failed')
      `);
      const now = new Date();
      // WHY：PostgreSQL timestamp 保留微秒，而 JavaScript Date 只有毫秒；显式使用
      // 过去时间可避免同一毫秒内插入后立即 claim 时偶发判定为尚未到期。
      const nextPollAt = new Date(now.getTime() - 1_000);
      await owner.query(
        `insert into image_backend_member (id, type)
         values ('api-member-1', 'api')`
      );
      await owner.query(
        `insert into image_backend_member_api_config (
           member_id, credential_scope, api_key
         ) values ('api-member-1', $1, 'rotated-current-key')`,
        [credentialScope]
      );
      await owner.query(
        `insert into image_backend_member_api_adapter_version (
           id, member_id_snapshot, credential_scope, configuration
         ) values
           ('adapter-v1', 'api-member-1', $1, $2::jsonb),
           ('adapter-v2', 'api-member-1', $1, $3::jsonb)`,
        [credentialScope, JSON.stringify(versionV1), JSON.stringify(versionV2)]
      );
      await owner.query(
        `
        insert into video_generation (
          id, user_id, stage, next_poll_at,
          api_adapter_member_id, api_adapter_version_id
        ) values (
          'video-version-1', 'video-user', 'polling', $1,
          'api-member-1', 'adapter-v1'
        )
      `,
        [nextPollAt]
      );

      const claim = await createPostgresVideoRecoveryRepository(
        createRecoveryDatabase(owner)
      ).claimNext({
        claimToken: "version-worker",
        now,
        claimExpiresAt: new Date(now.getTime() + 60_000),
      });
      expect(claim).toMatchObject({
        id: "video-version-1",
        apiAdapterMemberId: "api-member-1",
        apiAdapterVersionId: "adapter-v1",
      });

      const config = await loadApiVideoRecoveryConfig(
        "api-member-1",
        "api-member-1",
        "adapter-v1",
        "seedance2",
        createRecoveryConfigDatabase(owner)
      );
      expect(config).toMatchObject({
        baseUrl: "https://video.example.test",
        apiKey: "rotated-current-key",
        model: "seedance2",
        backend: {
          type: "pool-api",
          id: "api-member-1",
          modelMappings: [
            { modelId: "seedance2", upstreamModelId: "seedande-2.0" },
          ],
          apiUpstreamAdapter: {
            operations: {
              "videos.query": {
                path: "/v1/jobs/{task_id}",
                responseScript:
                  'return { status: "processing", progress: 25 };',
              },
            },
          },
        },
      });

      await owner.query(`
        update image_backend_member_api_config
        set credential_scope = 'https://other.example.test|bearer'
        where member_id = 'api-member-1'
      `);
      await expect(
        loadApiVideoRecoveryConfig(
          "api-member-1",
          "api-member-1",
          "adapter-v1",
          "seedance2",
          createRecoveryConfigDatabase(owner)
        )
      ).resolves.toBeNull();
    } finally {
      owner.release();
    }
  });
});
