/**
 * 视频恢复状态机的真实 PostgreSQL 并发集成测试。
 *
 * 职责：验证到期任务的 SKIP LOCKED claim、state_version CAS 和终态副作用唯一键。
 * 使用方：显式 `test:video-generation-recovery` 质量门。
 * 关键依赖：专用 VIDEO_GENERATION_RECOVERY_TEST_DATABASE_URL 与 PostgreSQL 事务。
 */

import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresVideoApiKeyQuotaRepository,
  type VideoApiKeyQuotaDatabase,
} from "../../../apps/web/src/features/image-generation/video-api-key-quota";
import {
  assertVideoInputCleanupAvailableForPersistence,
  createPostgresVideoInputCleanupRepository,
  type VideoInputCleanupDatabase,
} from "../../../apps/web/src/features/image-generation/video-input-cleanup-queue";
import {
  createPostgresVideoRecoveryRepository,
  VIDEO_SUBMISSION_RECOVERY_GRACE_MS,
  type VideoRecoveryDatabase,
} from "../../../apps/web/src/features/image-generation/video-recovery-repository";
import {
  admitVideoTaskCreation,
  consumeVideoTaskStagingReservation,
  reserveVideoTaskStaging,
  VideoActiveTaskLimitError,
} from "../../../apps/web/src/features/image-generation/video-task-admission";
import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

interface IdRow {
  id: string;
}

let pool: Pool | null = null;

/** 创建本轮专属 schema 和状态机最小夹具表。 */
async function createFixtureSchema(client: PoolClient): Promise<string> {
  const schemaName = `video_recovery_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create schema "${schemaName}"`);
  await client.query(`set search_path to "${schemaName}", public`);
  await client.query(`
    create table video_generation (
      id text primary key,
      user_id text not null default 'user-1',
      api_key_id text,
      api_key_credits_reserved numeric(18, 2) not null default 0,
      staged_input_objects json,
      principal_scope text not null default 'user:user-1',
      stage text not null,
      state_version integer not null default 0,
      next_poll_at timestamp,
      claim_token text,
      claim_expires_at timestamp,
      submit_started_at timestamp,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table external_api_key (
      id text primary key,
      user_id text not null,
      credit_limit numeric(18, 2),
      credits_used numeric(18, 2) not null default 0,
      is_active boolean not null default true,
      updated_at timestamp not null default now()
    );
    create table terminal_effect (
      task_id text not null,
      kind text not null,
      primary key (task_id, kind)
    );
    create table video_input_cleanup (
      id text primary key,
      user_id text not null,
      video_id text not null,
      attempt_id text not null,
      storage_key text not null,
      storage_bucket text not null,
      attempt_count integer not null default 0,
      next_attempt_at timestamp not null default now(),
      claim_token text,
      claim_expires_at timestamp,
      last_error text,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table video_task_staging_reservation (
      task_id text primary key,
      reservation_token text not null unique,
      user_id text not null,
      principal_scope text not null,
      expires_at timestamp not null,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    )
  `);
  return schemaName;
}

/** 删除当前测试创建的随机 schema。 */
async function dropFixtureSchema(
  client: PoolClient,
  schemaName: string
): Promise<void> {
  await client.query("set search_path to public");
  await client.query(`drop schema "${schemaName}" cascade`);
}

/** 将 pg client 适配为生产 claim 仓储使用的事务与 SQL 执行端口。 */
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
          async execute(query) {
            const compiled = new PgDialect().sqlToQuery(query);
            return client.query(compiled.sql, compiled.params);
          },
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

/** 复用同一事务适配器执行任务级 API Key 配额 SQL。 */
function createQuotaDatabase(client: PoolClient): VideoApiKeyQuotaDatabase {
  return createRecoveryDatabase(client);
}

/** 将 pg client 适配为持久对象清理队列的单语句执行端口。 */
function createCleanupDatabase(client: PoolClient): VideoInputCleanupDatabase {
  return {
    async execute(query) {
      const compiled = new PgDialect().sqlToQuery(query);
      return client.query(compiled.sql, compiled.params);
    },
  };
}

beforeAll(() => {
  pool = new Pool({
    application_name: "fluxmedia-video-recovery-integration",
    connectionString: requireDedicatedTestDatabaseUrl(
      "VIDEO_GENERATION_RECOVERY_TEST_DATABASE_URL"
    ),
    max: 4,
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("video recovery PostgreSQL concurrency", () => {
  it("并发清理 worker 只认领同一临时对象一次", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      const repository = createPostgresVideoInputCleanupRepository(
        createCleanupDatabase(owner)
      );
      await repository.enqueue([
        {
          userId: "user-1",
          videoId: "video-1",
          attemptId: "reservation-1",
          storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
          storageBucket: "uploads",
        },
      ]);
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await Promise.all([
          first.query(`set search_path to "${schemaName}", public`),
          second.query(`set search_path to "${schemaName}", public`),
        ]);
        const now = new Date();
        const claims = await Promise.all([
          createPostgresVideoInputCleanupRepository(
            createCleanupDatabase(first)
          ).claimNext({
            claimToken: "cleanup-worker-1",
            now,
            claimExpiresAt: new Date(now.getTime() + 60_000),
          }),
          createPostgresVideoInputCleanupRepository(
            createCleanupDatabase(second)
          ).claimNext({
            claimToken: "cleanup-worker-2",
            now,
            claimExpiresAt: new Date(now.getTime() + 60_000),
          }),
        ]);
        const claimed = claims.filter((claim) => claim !== null);
        expect(claimed).toHaveLength(1);
        if (!claimed[0]) throw new Error("清理对象未被认领");
        await repository.complete({
          id: claimed[0].id,
          claimToken: claimed[0].claimToken,
        });
        const remaining = await owner.query<{ count: string }>(
          "select count(*)::text as count from video_input_cleanup"
        );
        expect(remaining.rows[0]?.count).toBe("0");
      } finally {
        first.release();
        second.release();
      }
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("reservation 与 created 保护输入，submit_uncertain 后允许清理", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      const object = {
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
        storageBucket: "uploads",
      };
      const repository = createPostgresVideoInputCleanupRepository(
        createCleanupDatabase(owner)
      );
      await repository.enqueue([object]);
      const reservationNow = new Date();
      await reserveVideoTaskStaging(
        createQuotaDatabase(owner),
        {
          taskId: "video-1",
          userId: "user-1",
          principalScope: "external:user-1:key-1",
        },
        {
          now: reservationNow,
          expiresAt: new Date(reservationNow.getTime() + 60_000),
          reservationToken: object.attemptId,
        }
      );

      await expect(
        repository.claimNext({
          claimToken: "cleanup-worker-reservation",
          now: new Date(),
          claimExpiresAt: new Date(Date.now() + 60_000),
        })
      ).resolves.toBeNull();

      await createQuotaDatabase(owner).transaction(async (transaction) => {
        const admission = await admitVideoTaskCreation(transaction, {
          taskId: "video-1",
          userId: "user-1",
          principalScope: "external:user-1:key-1",
        });
        expect(admission).toBe("admitted");
        await assertVideoInputCleanupAvailableForPersistence(transaction, [
          object,
        ]);
        await consumeVideoTaskStagingReservation(transaction, {
          taskId: "video-1",
          userId: "user-1",
          reservationToken: object.attemptId,
          required: true,
        });
        await transaction.execute(sql`
          insert into video_generation (
            id,
            user_id,
            principal_scope,
            stage,
            staged_input_objects
          )
          values (
            'video-1',
            'user-1',
            'external:user-1:key-1',
            'created',
            ${JSON.stringify([object])}::json
          )
        `);
      });

      const now = new Date();
      await expect(
        repository.claimNext({
          claimToken: "cleanup-worker-1",
          now,
          claimExpiresAt: new Date(now.getTime() + 60_000),
        })
      ).resolves.toBeNull();

      await owner.query(`
        update video_generation
        set stage = 'submit_uncertain'
        where id = 'video-1'
      `);
      await expect(
        repository.claimNext({
          claimToken: "cleanup-worker-2",
          now: new Date(),
          claimExpiresAt: new Date(Date.now() + 60_000),
        })
      ).resolves.toMatchObject({ id: expect.any(String), videoId: "video-1" });
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("旧 attempt 的迟到清理不会认领新 reservation 对象", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      const expiredObject = {
        userId: "user-1",
        videoId: "video-1",
        attemptId: "expired-reservation",
        storageKey: "user-1/video-inputs/video-1/expired-reservation/input.png",
        storageBucket: "uploads",
      };
      const currentObject = {
        userId: "user-1",
        videoId: "video-1",
        attemptId: "current-reservation",
        storageKey: "user-1/video-inputs/video-1/current-reservation/input.png",
        storageBucket: "uploads",
      };
      const repository = createPostgresVideoInputCleanupRepository(
        createCleanupDatabase(owner)
      );
      await repository.enqueue([expiredObject, currentObject]);
      const now = new Date();
      await reserveVideoTaskStaging(
        createQuotaDatabase(owner),
        {
          taskId: "video-1",
          userId: "user-1",
          principalScope: "external:user-1:key-1",
        },
        {
          now,
          expiresAt: new Date(now.getTime() + 60_000),
          reservationToken: currentObject.attemptId,
        }
      );

      const expiredClaim = await repository.claimNext({
        claimToken: "cleanup-worker-expired",
        now: new Date(),
        claimExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(expiredClaim).toMatchObject({
        attemptId: expiredObject.attemptId,
        storageKey: expiredObject.storageKey,
      });
      if (!expiredClaim) throw new Error("旧 attempt 清理对象未被认领");
      await repository.complete({
        id: expiredClaim.id,
        claimToken: expiredClaim.claimToken,
      });
      await expect(
        repository.claimNext({
          claimToken: "cleanup-worker-current",
          now: new Date(),
          claimExpiresAt: new Date(Date.now() + 60_000),
        })
      ).resolves.toBeNull();
      const remaining = await owner.query<{
        attempt_id: string;
        storage_key: string;
      }>(`
        select attempt_id, storage_key
        from video_input_cleanup
      `);
      expect(remaining.rows).toEqual([
        {
          attempt_id: currentObject.attemptId,
          storage_key: currentObject.storageKey,
        },
      ]);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("清理 worker 已先认领时任务事务拒绝持久化对象引用", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      const object = {
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
        storageBucket: "uploads",
      };
      const repository = createPostgresVideoInputCleanupRepository(
        createCleanupDatabase(owner)
      );
      await repository.enqueue([object]);
      const now = new Date();
      await expect(
        repository.claimNext({
          claimToken: "cleanup-worker-1",
          now,
          claimExpiresAt: new Date(now.getTime() + 60_000),
        })
      ).resolves.toMatchObject({ claimToken: "cleanup-worker-1" });

      await expect(
        createQuotaDatabase(owner).transaction(async (transaction) => {
          const admission = await admitVideoTaskCreation(transaction, {
            taskId: "video-1",
            userId: "user-1",
            principalScope: "external:user-1:key-1",
          });
          expect(admission).toBe("admitted");
          await assertVideoInputCleanupAvailableForPersistence(transaction, [
            object,
          ]);
        })
      ).rejects.toThrow("已被 worker 认领");
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("并发 worker 只认领同一到期任务一次", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await owner.query(
        "insert into video_generation (id, stage, next_poll_at) values ('video-1', 'polling', now())"
      );
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await Promise.all([
          first.query(`set search_path to "${schemaName}", public`),
          second.query(`set search_path to "${schemaName}", public`),
        ]);
        const now = new Date();
        const claimExpiresAt = new Date(now.getTime() + 21 * 60_000);
        const claims = await Promise.all([
          createPostgresVideoRecoveryRepository(
            createRecoveryDatabase(first)
          ).claimNext({ claimToken: "worker-1", now, claimExpiresAt }),
          createPostgresVideoRecoveryRepository(
            createRecoveryDatabase(second)
          ).claimNext({ claimToken: "worker-2", now, claimExpiresAt }),
        ]);
        const claimedJobs = claims.filter((claim) => claim !== null);
        expect(claimedJobs).toHaveLength(1);
        expect(claimedJobs[0]?.id).toBe("video-1");
        const claimed = (
          await owner.query<{ state_version: number }>(
            "select state_version from video_generation where id = 'video-1'"
          )
        ).rows[0];
        expect(claimed?.state_version).toBe(1);
      } finally {
        first.release();
        second.release();
      }
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("不抢占活跃提交，只认领过期提交和到期轮询任务", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(client);
      const now = new Date("2026-07-26T00:30:00.000Z");
      const staleAt = new Date(
        now.getTime() - VIDEO_SUBMISSION_RECOVERY_GRACE_MS - 1
      );
      const activeClaimExpiresAt = new Date(now.getTime() + 60_000);
      const expiredClaimAt = new Date(now.getTime() - 1);
      await client.query(
        `insert into video_generation
          (id, stage, next_poll_at, claim_token, claim_expires_at,
           submit_started_at, updated_at)
         values
          ('ready-created', 'created', $1, null, null, null, $1),
          ('active-charged', 'charged', null, 'live-1', $2, null, $1),
          ('active-submitting', 'submitting', null, 'live-2', $2, $1, $1),
          ('stale-charged', 'charged', null, 'dead-1', $3, null, $4),
          ('stale-submitting', 'submitting', null, 'dead-2', $3, $4, $4),
          ('legacy-uncertain', 'submit_uncertain', null, null, null, $1, $1),
          ('due-polling', 'polling', $1, null, null, null, $1)`,
        [now, activeClaimExpiresAt, expiredClaimAt, staleAt]
      );

      const repository = createPostgresVideoRecoveryRepository(
        createRecoveryDatabase(client)
      );
      const claims = [];
      for (let index = 0; index < 5; index += 1) {
        const claim = await repository.claimNext({
          claimToken: `worker-${index}`,
          now,
          claimExpiresAt: new Date(now.getTime() + 21 * 60_000),
        });
        if (!claim) break;
        claims.push(claim);
      }

      expect(claims.map((claim) => claim.id).sort()).toEqual([
        "due-polling",
        "ready-created",
        "stale-charged",
        "stale-submitting",
      ]);
      const active = await client.query<IdRow>(
        `select id
         from video_generation
         where id in ('active-charged', 'active-submitting')
           and claim_token like 'live-%'
         order by id`
      );
      expect(active.rows.map((row) => row.id)).toEqual([
        "active-charged",
        "active-submitting",
      ]);
      const uncertain = await client.query<IdRow>(
        `select id
         from video_generation
         where stage = 'submit_uncertain' and claim_token is null`
      );
      expect(uncertain.rows).toEqual([{ id: "legacy-uncertain" }]);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("状态 CAS 和终态唯一键阻止重复完成或退款", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(client);
      await client.query(
        "insert into video_generation (id, stage) values ('video-2', 'downloading')"
      );
      const casSql = `update video_generation
        set stage = 'completed', state_version = state_version + 1
        where id = 'video-2' and stage = 'downloading' and state_version = 0
        returning id`;
      const [first, second] = await Promise.all([
        client.query<IdRow>(casSql),
        client.query<IdRow>(casSql),
      ]);
      expect(first.rows.length + second.rows.length).toBe(1);

      const effectSql = `insert into terminal_effect (task_id, kind)
        values ('video-2', 'complete')
        on conflict do nothing
        returning task_id as id`;
      const [effectA, effectB] = await Promise.all([
        client.query<IdRow>(effectSql),
        client.query<IdRow>(effectSql),
      ]);
      expect(effectA.rows.length + effectB.rows.length).toBe(1);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("并发重放只预留并归还一次 API Key 配额", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await owner.query(`
        insert into external_api_key
          (id, user_id, credit_limit, credits_used)
        values ('key-1', 'user-1', 10, 0);
        insert into video_generation
          (id, api_key_id, stage)
        values ('video-quota-1', 'key-1', 'charged')
      `);
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await Promise.all([
          first.query(`set search_path to "${schemaName}", public`),
          second.query(`set search_path to "${schemaName}", public`),
        ]);
        const firstRepository = createPostgresVideoApiKeyQuotaRepository(
          createQuotaDatabase(first)
        );
        const secondRepository = createPostgresVideoApiKeyQuotaRepository(
          createQuotaDatabase(second)
        );

        await expect(
          Promise.all([
            firstRepository.reserve({ videoId: "video-quota-1", amount: 4 }),
            secondRepository.reserve({ videoId: "video-quota-1", amount: 4 }),
          ])
        ).resolves.toEqual([4, 4]);
        const reserved = await owner.query<{
          credits_used: string;
          api_key_credits_reserved: string;
        }>(`
          select key.credits_used::text, task.api_key_credits_reserved::text
          from external_api_key key
          join video_generation task on task.api_key_id = key.id
          where task.id = 'video-quota-1'
        `);
        expect(reserved.rows[0]).toEqual({
          credits_used: "4.00",
          api_key_credits_reserved: "4.00",
        });

        await expect(
          Promise.all([
            firstRepository.refund({ videoId: "video-quota-1" }),
            secondRepository.refund({ videoId: "video-quota-1" }),
          ])
        ).resolves.toEqual(expect.arrayContaining([0, 4]));
        const refunded = await owner.query<{
          credits_used: string;
          api_key_credits_reserved: string;
        }>(`
          select key.credits_used::text, task.api_key_credits_reserved::text
          from external_api_key key
          join video_generation task on task.api_key_id = key.id
          where task.id = 'video-quota-1'
        `);
        expect(refunded.rows[0]).toEqual({
          credits_used: "0.00",
          api_key_credits_reserved: "0.00",
        });
      } finally {
        first.release();
        second.release();
      }
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("API Key 被物理删除后仍能完成任务级配额退款", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await owner.query(`
        insert into external_api_key
          (id, user_id, credit_limit, credits_used)
        values ('deleted-key', 'user-1', 10, 4);
        insert into video_generation
          (id, user_id, api_key_id, api_key_credits_reserved, stage)
        values ('video-deleted-key', 'user-1', 'deleted-key', 4, 'refunding');
        delete from external_api_key where id = 'deleted-key'
      `);

      await expect(
        createPostgresVideoApiKeyQuotaRepository(
          createQuotaDatabase(owner)
        ).refund({ videoId: "video-deleted-key" })
      ).resolves.toBe(4);
      const task = await owner.query<{ api_key_credits_reserved: string }>(`
        select api_key_credits_reserved::text
        from video_generation
        where id = 'video-deleted-key'
      `);
      expect(task.rows[0]?.api_key_credits_reserved).toBe("0.00");
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("Principal 活跃任务上限在并发创建下只放行一个事务", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await Promise.all([
          first.query(`set search_path to "${schemaName}", public`),
          second.query(`set search_path to "${schemaName}", public`),
        ]);
        /** 在独立连接事务内执行生产准入并紧接着插入任务。 */
        const createTask = async (client: PoolClient, taskId: string) =>
          createQuotaDatabase(client).transaction(async (transaction) => {
            const admission = await admitVideoTaskCreation(transaction, {
              taskId,
              userId: "user-1",
              principalScope: "external:user-1:key-1",
              maxPrincipalActiveTasks: 1,
              maxUserActiveTasks: 10,
            });
            if (admission === "admitted") {
              await transaction.execute(sql`
                insert into video_generation (id, principal_scope, stage)
                values (${taskId}, 'external:user-1:key-1', 'created')
              `);
            }
            return admission;
          });

        const results = await Promise.allSettled([
          createTask(first, "admission-1"),
          createTask(second, "admission-2"),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled")
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(rejected).toMatchObject({
          status: "rejected",
          reason: expect.any(VideoActiveTaskLimitError),
        });
        const count = await owner.query<{ count: string }>(`
          select count(*)::text as count
          from video_generation
          where principal_scope = 'external:user-1:key-1'
        `);
        expect(count.rows[0]?.count).toBe("1");
      } finally {
        first.release();
        second.release();
      }
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("并发大媒体请求在上传前只能占用用户允许的 reservation 数", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await Promise.all([
          first.query(`set search_path to "${schemaName}", public`),
          second.query(`set search_path to "${schemaName}", public`),
        ]);
        const now = new Date();
        /** 每个请求只有拿到持久 reservation 后才会进入对象存储转存。 */
        const reserve = (
          client: PoolClient,
          taskId: string,
          principalScope: string
        ) =>
          reserveVideoTaskStaging(
            createQuotaDatabase(client),
            {
              taskId,
              userId: "user-1",
              principalScope,
              maxPrincipalActiveTasks: 5,
              maxUserActiveTasks: 1,
            },
            {
              now,
              expiresAt: new Date(now.getTime() + 60_000),
              reservationToken: `${taskId}-token`,
            }
          );

        const results = await Promise.allSettled([
          reserve(first, "staging-1", "external:user-1:key-1"),
          reserve(second, "staging-2", "external:user-1:key-2"),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled")
        ).toHaveLength(1);
        expect(
          results.find((result) => result.status === "rejected")
        ).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({ limitKind: "user" }),
        });
        const count = await owner.query<{ count: string }>(`
          select count(*)::text as count
          from video_task_staging_reservation
          where user_id = 'user-1'
        `);
        expect(count.rows[0]?.count).toBe("1");
      } finally {
        first.release();
        second.release();
      }
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("不同 API Key 并发创建也只能占用同一用户总上限", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await Promise.all([
          first.query(`set search_path to "${schemaName}", public`),
          second.query(`set search_path to "${schemaName}", public`),
        ]);
        /** 用不同 Principal 竞争同一 userId 的最后一个用户级槽位。 */
        const createTask = async (
          client: PoolClient,
          taskId: string,
          principalScope: string
        ) =>
          createQuotaDatabase(client).transaction(async (transaction) => {
            const admission = await admitVideoTaskCreation(transaction, {
              taskId,
              userId: "user-1",
              principalScope,
              maxPrincipalActiveTasks: 5,
              maxUserActiveTasks: 1,
            });
            if (admission === "admitted") {
              await transaction.execute(sql`
                insert into video_generation (
                  id,
                  user_id,
                  principal_scope,
                  stage
                )
                values (${taskId}, 'user-1', ${principalScope}, 'created')
              `);
            }
            return admission;
          });

        const results = await Promise.allSettled([
          createTask(first, "user-admission-1", "external:user-1:key-1"),
          createTask(second, "user-admission-2", "external:user-1:key-2"),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled")
        ).toHaveLength(1);
        expect(
          results.find((result) => result.status === "rejected")
        ).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({ limitKind: "user" }),
        });
        const count = await owner.query<{ count: string }>(`
          select count(*)::text as count
          from video_generation
          where user_id = 'user-1'
        `);
        expect(count.rows[0]?.count).toBe("1");
      } finally {
        first.release();
        second.release();
      }
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });
});
