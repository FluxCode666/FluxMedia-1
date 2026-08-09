/**
 * 用户数据看板一致快照的真实 PostgreSQL 集成测试。
 *
 * 职责：以生产 SQL 和事务配置证明 readiness、数据库时钟、成功产出、积分、模型与
 * 失败任务都读取同一个 repeatable-read 快照；测试只连接显式专用数据库。
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDataDashboardSnapshotRepository,
  type DataDashboardTransactionDatabase,
  loadDataDashboardSnapshot,
} from "../../../apps/web/src/features/data-dashboard/data-dashboard-service";
import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

let fixtureSchemaName = "";
let ownerPool: Pool | null = null;

/** 创建测试进程唯一 schema 与生产查询访问的最小表。 */
async function createFixtureSchema(client: PoolClient): Promise<string> {
  const schemaName = `data_dashboard_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create schema "${schemaName}"`);
  await client.query(`set search_path to "${schemaName}", public`);
  await client.query(`
    create table analytics_read_model_state (
      read_model text primary key,
      version integer not null,
      status text not null
    );
    create table user_output_usage_event (
      output_kind text not null,
      source_task_id text not null,
      user_id text not null,
      operation_created_at timestamp not null,
      image_count integer not null default 0,
      video_seconds integer not null default 0,
      primary key (output_kind, source_task_id)
    );
    create index user_output_usage_event_user_created_kind_idx
      on user_output_usage_event (user_id, operation_created_at, output_kind);
    create table credit_usage_operation (
      user_id text not null,
      operation_type text not null,
      operation_id text not null,
      operation_created_at timestamp not null,
      net_consumed numeric(18, 2) not null default 0,
      primary key (user_id, operation_type, operation_id)
    );
    create table generation (
      id text primary key,
      user_id text not null,
      model text not null,
      status text not null,
      metadata jsonb,
      created_at timestamp not null
    );
    create index generation_user_id_created_at_idx
      on generation (user_id, created_at);
    create table video_generation (
      id text primary key,
      user_id text not null,
      model text not null,
      status text not null,
      created_at timestamp not null
    );
    create index video_generation_user_idx
      on video_generation (user_id, created_at)
  `);
  return schemaName;
}

/** 插入首个快照应观察到的 ready 状态、成功产出、净积分与失败任务。 */
async function seedInitialSnapshot(client: PoolClient): Promise<void> {
  await client.query(`
    insert into analytics_read_model_state (read_model, version, status)
    values ('output_usage', 1, 'ready'), ('credit_usage', 1, 'ready');
    insert into generation (id, user_id, model, status, metadata, created_at)
    values
      ('image-1', 'user-a', 'image-model', 'completed', '{"mode":"generate"}', '2000-01-01 01:00:00'),
      ('failed-1', 'user-a', 'failed-model', 'failed', '{"mode":"edit"}', '2000-01-01 03:00:00');
    insert into video_generation (id, user_id, model, status, created_at)
    values ('video-1', 'user-a', 'video-model', 'completed', '2000-01-01 02:00:00');
    insert into user_output_usage_event (
      output_kind,
      source_task_id,
      user_id,
      operation_created_at,
      image_count,
      video_seconds
    ) values
      ('image', 'image-1', 'user-a', '2000-01-01 01:00:00', 4, 0),
      ('video', 'video-1', 'user-a', '2000-01-01 02:00:00', 0, 5);
    insert into credit_usage_operation (
      user_id,
      operation_type,
      operation_id,
      operation_created_at,
      net_consumed
    ) values (
      'user-a',
      'image_generation',
      'image-1',
      '2000-01-01 01:00:00',
      60
    )
  `);
}

/** 把 Drizzle SQL 编译后交给指定 pg 连接执行。 */
async function executeSql(client: PoolClient, query: SQL): Promise<unknown> {
  const compiled = new PgDialect().sqlToQuery(query);
  return client.query(compiled.sql, compiled.params);
}

/**
 * 创建执行生产 SQL 的事务端口，并允许在首条 header 已固定快照后提交并发变更。
 *
 * @param pool 专用 PostgreSQL 连接池。
 * @param afterHeader 首条 SQL 返回后、第二条 SQL 前执行的外部事务。
 * @returns 与生产仓储相同的事务结构；失败时回滚并释放连接。
 */
function createPostgresTransactionDatabase(
  pool: Pool,
  afterHeader: () => Promise<void>
): DataDashboardTransactionDatabase {
  return {
    async transaction<T>(
      work: (transaction: {
        execute: (query: SQL) => Promise<unknown>;
      }) => Promise<T>,
      config: {
        isolationLevel: "repeatable read";
        accessMode: "read only";
      }
    ): Promise<T> {
      expect(config).toEqual({
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
      const client = await pool.connect();
      let statementCount = 0;
      try {
        await client.query(`set search_path to "${fixtureSchemaName}", public`);
        await client.query("begin isolation level repeatable read read only");
        const result = await work({
          async execute(query: SQL): Promise<unknown> {
            const value = await executeSql(client, query);
            statementCount += 1;
            if (statementCount === 1) await afterHeader();
            return value;
          },
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

beforeAll(async () => {
  const databaseUrl = requireDedicatedTestDatabaseUrl(
    "DATA_DASHBOARD_SNAPSHOT_TEST_DATABASE_URL"
  );
  ownerPool = new Pool({
    application_name: "fluxmedia-data-dashboard-snapshot-integration",
    connectionString: databaseUrl,
    max: 4,
  });
  const client = await ownerPool.connect();
  try {
    fixtureSchemaName = await createFixtureSchema(client);
    await seedInitialSnapshot(client);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (ownerPool && fixtureSchemaName) {
    await ownerPool.query(`drop schema "${fixtureSchemaName}" cascade`);
  }
  await ownerPool?.end();
});

describe("data dashboard snapshot", () => {
  it("并发切换 readiness 与追加事件后仍返回首条 SQL 建立的完整旧快照", async () => {
    if (!ownerPool) throw new Error("集成测试数据库尚未初始化");
    let mutationCount = 0;
    const mutateAfterHeader = async (): Promise<void> => {
      mutationCount += 1;
      if (mutationCount !== 1 || !ownerPool) return;
      const client = await ownerPool.connect();
      try {
        await client.query(`set search_path to "${fixtureSchemaName}", public`);
        await client.query(`
          update analytics_read_model_state
          set status = 'backfilling'
          where read_model = 'output_usage';
          insert into generation (id, user_id, model, status, metadata, created_at)
          values ('image-2', 'user-a', 'new-model', 'completed', '{"mode":"generate"}', '2000-01-01 04:00:00');
          insert into user_output_usage_event (
            output_kind,
            source_task_id,
            user_id,
            operation_created_at,
            image_count,
            video_seconds
          ) values ('image', 'image-2', 'user-a', '2000-01-01 04:00:00', 9, 0);
          insert into credit_usage_operation (
            user_id,
            operation_type,
            operation_id,
            operation_created_at,
            net_consumed
          ) values (
            'user-a',
            'image_generation',
            'image-2',
            '2000-01-01 04:00:00',
            10
          )
        `);
      } finally {
        client.release();
      }
    };
    const repository = createDataDashboardSnapshotRepository(
      createPostgresTransactionDatabase(ownerPool, mutateAfterHeader)
    );

    const snapshot = await loadDataDashboardSnapshot(
      {
        userId: "user-a",
        timeZone: "UTC",
        rangeInput: { startDate: "2000-01-01", endDate: "2000-01-01" },
      },
      repository
    );

    expect(snapshot.metrics).toMatchObject({
      imageCount: 4,
      videoSeconds: 5,
      creditsConsumed: 60,
      successRate: { succeeded: 2, failed: 1, terminal: 3 },
    });
    expect(snapshot.taskComposition).toEqual({
      imageTaskCount: 1,
      videoCount: 1,
      totalTasks: 2,
    });
    expect(snapshot.metrics.mostUsedModel).toEqual({
      model: "image-model",
      taskCount: 1,
    });
    expect(mutationCount).toBe(1);

    await expect(
      loadDataDashboardSnapshot(
        {
          userId: "user-a",
          timeZone: "UTC",
          rangeInput: {
            startDate: "2000-01-01",
            endDate: "2000-01-01",
          },
        },
        repository
      )
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it("发现范围外计费 operation 时拒绝积分口径漂移", async () => {
    if (!ownerPool) throw new Error("集成测试数据库尚未初始化");
    const client = await ownerPool.connect();
    try {
      await client.query(`set search_path to "${fixtureSchemaName}", public`);
      await client.query(`
        update analytics_read_model_state
        set status = 'ready'
        where read_model in ('output_usage', 'credit_usage');
        insert into generation (id, user_id, model, status, metadata, created_at)
        values (
          'image-drift',
          'user-a',
          'image-model',
          'completed',
          '{"mode":"generate"}',
          '2000-01-01 05:00:00'
        );
        insert into user_output_usage_event (
          output_kind,
          source_task_id,
          user_id,
          operation_created_at,
          image_count,
          video_seconds
        ) values (
          'image',
          'image-drift',
          'user-a',
          '2000-01-01 05:00:00',
          1,
          0
        );
        insert into credit_usage_operation (
          user_id,
          operation_type,
          operation_id,
          operation_created_at,
          net_consumed
        ) values (
          'user-a',
          'image_generation',
          'image-drift',
          '1999-12-31 23:00:00',
          10
        );
      `);
    } finally {
      client.release();
    }

    const repository = createDataDashboardSnapshotRepository(
      createPostgresTransactionDatabase(ownerPool, async () => undefined)
    );
    await expect(
      loadDataDashboardSnapshot(
        {
          userId: "user-a",
          timeZone: "UTC",
          rangeInput: {
            startDate: "2000-01-01",
            endDate: "2000-01-01",
          },
        },
        repository
      )
    ).rejects.toMatchObject({ code: "invalid_data" });
  });
});
