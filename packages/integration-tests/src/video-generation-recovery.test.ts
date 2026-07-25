/**
 * 视频恢复状态机的真实 PostgreSQL 并发集成测试。
 *
 * 职责：验证到期任务的 SKIP LOCKED claim、state_version CAS 和终态副作用唯一键。
 * 使用方：显式 `test:video-generation-recovery` 质量门。
 * 关键依赖：专用 VIDEO_GENERATION_RECOVERY_TEST_DATABASE_URL 与 PostgreSQL 事务。
 */

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** 执行与生产 worker 等价的单行原子 claim。 */
async function claimOne(client: PoolClient, token: string): Promise<IdRow[]> {
  const result = await client.query<IdRow>(
    `with candidates as (
       select id
       from video_generation
       where stage in ('polling', 'downloading', 'refunding')
         and (next_poll_at is null or next_poll_at <= now())
         and (claim_expires_at is null or claim_expires_at <= now())
       order by created_at
       limit 1
       for update skip locked
     )
     update video_generation as task
     set claim_token = $1,
         claim_expires_at = now() + interval '2 minutes',
         updated_at = now()
     from candidates
     where task.id = candidates.id
     returning task.id`,
    [token]
  );
  return result.rows;
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
        const claims = await Promise.all([
          claimOne(first, "worker-a"),
          claimOne(second, "worker-b"),
        ]);
        expect(claims.flat()).toHaveLength(1);
        expect(claims.flat()[0]?.id).toBe("video-1");
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
