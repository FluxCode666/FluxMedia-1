/**
 * API 视频创建重试迁移与真实 PostgreSQL 并发测试。
 *
 * 职责：验证 0087 补齐历史账号默认重试配置、开放 retrying 阶段，并证明两个 Worker
 * 并发预留零重试账号时只有一次真实外呼资格。需要专用恢复测试数据库。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresVideoSubmissionAttemptRepository,
  type VideoSubmissionAttemptDatabase,
} from "../../../apps/web/src/features/image-generation/video-submission-attempt-repository";
import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

let pool: Pool | null = null;

/** 创建迁移前最小 schema，并返回随机 schema 名。 */
async function createFixture(client: PoolClient): Promise<string> {
  const schemaName = `video_retry_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create schema "${schemaName}"`);
  await client.query(`set search_path to "${schemaName}", public`);
  await client.query(`
    create table video_generation (
      id text primary key,
      stage text not null,
      upstream_job_id text
    );
    alter table video_generation
      add constraint video_generation_stage_check
      check (stage in ('created', 'charged', 'submitting', 'submit_uncertain',
        'polling', 'downloading', 'refunding', 'completed', 'failed'));
    create table image_backend_member_api_adapter_version (
      id text primary key,
      member_id_snapshot text not null,
      revision integer not null,
      credential_scope text not null,
      configuration json not null,
      created_at timestamp not null default now()
    );
  `);
  return schemaName;
}

/** 把 pg client 适配为尝试账本的事务端口。 */
function createDatabase(client: PoolClient): VideoSubmissionAttemptDatabase {
  return {
    async transaction<T>(
      work: (transaction: {
        execute(query: SQL): Promise<unknown>;
      }) => Promise<T>
    ): Promise<T> {
      await client.query("begin");
      try {
        const result = await work({
          execute: async (query) => {
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
    application_name: "fluxmedia-video-submission-retry-migration",
    connectionString: requireDedicatedTestDatabaseUrl(
      "VIDEO_GENERATION_RECOVERY_TEST_DATABASE_URL"
    ),
    max: 4,
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("0087 video submission retry migration", () => {
  it("补齐历史配置并由数据库阻止零重试账号的并发第二次外呼", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    const workerA = await pool.connect();
    const workerB = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixture(owner);
      await owner.query(`
        insert into image_backend_member_api_adapter_version (
          id, member_id_snapshot, revision, credential_scope, configuration
        ) values (
          'adapter-1', 'member-1', 1, 'https://video.example|bearer',
          '{"baseUrl":"https://video.example","useStream":false}'::json
        )
      `);
      const migrationPath = fileURLToPath(
        new URL(
          "../../database/drizzle/0087_video_submission_retry.sql",
          import.meta.url
        )
      );
      await owner.query(await readFile(migrationPath, "utf8"));
      const migrated = await owner.query<{
        video_submission_retry_count: number;
      }>(`
        select (configuration->>'videoSubmissionRetryCount')::integer
          as video_submission_retry_count
        from image_backend_member_api_adapter_version
        where id = 'adapter-1'
      `);
      expect(migrated.rows[0]?.video_submission_retry_count).toBe(2);
      await owner.query(
        "insert into video_generation (id, stage) values ('video-1', 'retrying')"
      );
      await workerA.query(`set search_path to "${schemaName}", public`);
      await workerB.query(`set search_path to "${schemaName}", public`);
      const reserve = (
        client: PoolClient,
        attemptId: string,
        requestId: string
      ) =>
        createPostgresVideoSubmissionAttemptRepository(
          createDatabase(client)
        ).reserveNext({
          attemptId,
          videoGenerationId: "video-1",
          backendMemberId: "member-1",
          requestId,
          videoSubmissionRetryCount: 0,
          supplierNameSnapshot: "供应商 A",
          apiAdapterMemberId: "member-1",
          apiAdapterVersionId: "adapter-1",
          now: new Date("2026-08-13T00:00:00.000Z"),
        });
      const results = await Promise.all([
        reserve(workerA, "attempt-a", "request-a"),
        reserve(workerB, "attempt-b", "request-b"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)).toMatchObject({
        memberAttemptNumber: 1,
        maxAttemptsSnapshot: 1,
      });
    } finally {
      await owner.query("set search_path to public");
      if (schemaName) {
        await owner.query(`drop schema "${schemaName}" cascade`);
      }
      owner.release();
      workerA.release();
      workerB.release();
    }
  });
});
