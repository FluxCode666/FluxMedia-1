/**
 * 视频恢复状态机的真实 PostgreSQL 并发集成测试。
 *
 * 职责：验证到期任务的 SKIP LOCKED claim、state_version CAS 和终态副作用唯一键。
 * 使用方：显式 `test:video-generation-recovery` 质量门。
 * 关键依赖：专用 VIDEO_GENERATION_RECOVERY_TEST_DATABASE_URL 与 PostgreSQL 事务。
 */

import { randomUUID } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresVideoRecoveryRepository,
  VIDEO_SUBMISSION_RECOVERY_GRACE_MS,
  type VideoRecoveryDatabase,
} from "../../../apps/web/src/features/image-generation/video-recovery-repository";
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
      stage text not null,
      state_version integer not null default 0,
      next_poll_at timestamp,
      claim_token text,
      claim_expires_at timestamp,
      submit_started_at timestamp,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table terminal_effect (
      task_id text not null,
      kind text not null,
      primary key (task_id, kind)
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
      for (let index = 0; index < 4; index += 1) {
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
});
