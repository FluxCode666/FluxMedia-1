/**
 * 运营总览生产迁移、并发事实、导出与明细 keyset 的真实 PostgreSQL 集成测试。
 *
 * 职责：在隔离 schema 原样执行生产 0093 迁移，证明 epoch 不可漂移、访问与支付
 * 事实可抵抗并发重放，并验证导出快照微秒与明细 keyset。普通 turbo test 不发现
 * 本文件，发布前由 operations-dashboard 专用命令显式执行。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOperationsGrowthDetailRepository,
  type OperationsGrowthDetailRow,
  paginateOperationsGrowthDetailRows,
} from "../../../apps/web/src/features/operations-dashboard/detail-repository";
import { readOperationsExportSnapshot } from "../../../apps/web/src/features/operations-dashboard/export-task-repository";
import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

const userIds = [
  "boundary-user-z",
  "boundary-user-y",
  "boundary-user-x",
] as const;
const createdAtValues = [
  "2000-01-02 12:34:56.123403",
  "2000-01-02 12:34:56.123402",
  "2000-01-02 12:34:56.123401",
] as const;

let fixtureSchemaName = "";
let pool: Pool | null = null;

const operationsMigrationSql = readFileSync(
  new URL(
    "../../database/drizzle/0093_operations_dashboard.sql",
    import.meta.url
  ),
  "utf8"
);

/** 验证并引用本测试生成的隔离 schema 名，禁止把动态标识符直接拼进 SQL。 */
function quoteFixtureSchema(schemaName: string): string {
  if (!/^operations_boundaries_[a-f0-9]+$/u.test(schemaName)) {
    throw new Error("运营边界测试 schema 名非法");
  }
  return `"${schemaName}"`;
}

/** 将 Drizzle SQL 按生产 PostgreSQL 方言执行，保留参数化边界。 */
async function executeSql(client: PoolClient, query: SQL): Promise<unknown> {
  const compiled = new PgDialect().sqlToQuery(query);
  return client.query(compiled.sql, compiled.params);
}

/** 原样执行生产 0093 迁移的 statement-breakpoint 分段。 */
async function applyOperationsMigration(client: PoolClient): Promise<void> {
  for (const statement of operationsMigrationSql.split(
    "--> statement-breakpoint"
  )) {
    if (statement.trim()) await client.query(statement);
  }
}

/** 创建生产迁移的前置表及其它只读事实源，再原样应用 0093。 */
async function createFixtureSchema(client: PoolClient): Promise<string> {
  const schemaName = `operations_boundaries_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteFixtureSchema(schemaName);
  await client.query(`create schema ${quotedSchema}`);
  await client.query(`set search_path to ${quotedSchema}, public`);
  await client.query(`
    create table "user" (
      id text primary key,
      name text not null,
      email text not null,
      role text not null,
      banned boolean not null,
      created_at timestamp not null
    );
    create table user_output_usage_event (
      created_at timestamp not null,
      output_kind text not null,
      source_task_id text not null
    );
    create table payment_order (
      id text primary key,
      created_at timestamp not null default now()
    );
    create table credit_usage_projection_entry (
      transaction_id text primary key,
      projected_at timestamp not null
    );
  `);
  await applyOperationsMigration(client);
  // WHY：部署恢复可能重放尚未登记完成的手写迁移，第二次执行必须保持结构不变。
  await applyOperationsMigration(client);
  for (const [index, userId] of userIds.entries()) {
    await client.query(
      `insert into "user" (
        id, name, email, role, banned, created_at
      ) values ($1, $1, $2, 'user', false, $3::timestamp)`,
      [userId, `${userId}@example.com`, createdAtValues[index]]
    );
  }
  return schemaName;
}

/** 为明细仓储提供真实 repeatable-read、read-only 事务端口。 */
function createDetailTransactionDatabase() {
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
      if (!pool) throw new Error("集成测试数据库尚未初始化");
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        await client.query(
          `set local search_path to "${fixtureSchemaName}", public`
        );
        const result = await work({
          execute: (query) => executeSql(client, query),
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
    "OPERATIONS_DASHBOARD_TEST_DATABASE_URL"
  );
  pool = new Pool({
    application_name: "fluxmedia-operations-dashboard-boundaries",
    connectionString: databaseUrl,
    max: 4,
    options: "-c timezone=UTC",
  });
  const client = await pool.connect();
  try {
    fixtureSchemaName = await createFixtureSchema(client);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (pool && fixtureSchemaName) {
    await pool.query(`drop schema "${fixtureSchemaName}" cascade`);
  }
  await pool?.end();
  pool = null;
});

describe("operations dashboard PostgreSQL boundaries", () => {
  it("实际 0093 迁移创建全部运营约束与索引", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const result = await pool.query<{ relation_name: string }>(
      `select to_regclass($1)::text as relation_name`,
      [`${fixtureSchemaName}.operations_export_task`]
    );

    expect(result.rows[0]?.relation_name).toBe("operations_export_task");
  });

  it("网页访问复合主键在真实并发下只保留一行", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const attempts = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        if (!pool) throw new Error("集成测试数据库尚未初始化");
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(
            `set local search_path to ${quoteFixtureSchema(fixtureSchemaName)}, public`
          );
          const result = await client.query(
            `insert into user_web_visit (
              user_id, app_date, first_visited_at
            ) values ($1, $2, $3::timestamp)
            on conflict (user_id, app_date) do nothing
            returning user_id`,
            [userIds[0], "2000-01-03", `2000-01-03 00:00:00.${index}`]
          );
          await client.query("commit");
          return result.rowCount ?? 0;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      })
    );
    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count
      from ${quoteFixtureSchema(fixtureSchemaName)}.user_web_visit
      where user_id = $1 and app_date = $2`,
      [userIds[0], "2000-01-03"]
    );

    expect(attempts.reduce((total, value) => total + value, 0)).toBe(1);
    expect(count.rows[0]?.count).toBe("1");
  });

  it("epoch request 同值重放幂等、冲突拒绝且更新删除均被触发器阻止", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    try {
      await client.query(
        `set search_path to ${quoteFixtureSchema(fixtureSchemaName)}, public`
      );
      const insertEpoch = `insert into operations_analytics_epoch (
        id, app_date, starts_at, initialized_by, initialization_request_id
      ) values (1, $1, $2::timestamp, $3, $4)
      on conflict (initialization_request_id) do nothing
      returning id`;
      const first = await client.query(insertEpoch, [
        "2000-01-01",
        "2000-01-01 00:00:00",
        "operator-1",
        "request-1",
      ]);
      const replay = await client.query(insertEpoch, [
        "2000-01-01",
        "2000-01-01 00:00:00",
        "operator-1",
        "request-1",
      ]);

      expect(first.rowCount).toBe(1);
      expect(replay.rowCount).toBe(0);
      await expect(
        client.query(insertEpoch, [
          "2000-01-02",
          "2000-01-02 00:00:00",
          "operator-2",
          "request-2",
        ])
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        client.query(
          `insert into operations_analytics_epoch (
            id, app_date, starts_at, initialized_by, initialization_request_id
          ) values (2, '2000-01-02', '2000-01-02 00:00:00',
            'operator-2', 'request-singleton')`
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query(
          "update operations_analytics_epoch set app_date = '2000-01-02' where id = 1"
        )
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        client.query("delete from operations_analytics_epoch where id = 1")
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      client.release();
    }
  });

  it("支付生命周期与履约工作项在并发重放下各只创建一行", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const schema = quoteFixtureSchema(fixtureSchemaName);
    await pool.query(`insert into ${schema}.payment_order (id) values ($1)`, [
      "payment-order-concurrent",
    ]);
    const attempts = await Promise.all(
      Array.from({ length: 12 }, async () => {
        if (!pool) throw new Error("集成测试数据库尚未初始化");
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`set local search_path to ${schema}, public`);
          const event = await client.query(
            `insert into payment_lifecycle_event (
              id, payment_order_id, event_type, source_ref,
              occurred_at, timestamp_source, provider
            ) values ($1, $2, 'payment_confirmed', $3, now(), 'provider', 'creem')
            on conflict (payment_order_id, event_type, source_ref) do nothing
            returning id`,
            [randomUUID(), "payment-order-concurrent", "provider-event-1"]
          );
          const workItem = await client.query(
            `insert into payment_fulfillment_work_item (
              id, payment_order_id, user_id, provider, provider_trade_no,
              credit_source_ref, credits_amount, debit_account, description,
              metadata
            ) values ($1, $2, $3, 'creem', $4, $5, 10, $6, $7, '{}'::json)
            on conflict (payment_order_id) do nothing
            returning id`,
            [
              randomUUID(),
              "payment-order-concurrent",
              userIds[0],
              "trade-1",
              "credit-source-1",
              "platform:revenue",
              "concurrency test",
            ]
          );
          await client.query("commit");
          return {
            event: event.rowCount ?? 0,
            workItem: workItem.rowCount ?? 0,
          };
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      })
    );
    const counts = await pool.query<{
      event_count: string;
      work_item_count: string;
    }>(
      `select
        (select count(*)::text from ${schema}.payment_lifecycle_event
          where payment_order_id = $1) as event_count,
        (select count(*)::text from ${schema}.payment_fulfillment_work_item
          where payment_order_id = $1) as work_item_count`,
      ["payment-order-concurrent"]
    );

    expect(attempts.reduce((sum, item) => sum + item.event, 0)).toBe(1);
    expect(attempts.reduce((sum, item) => sum + item.workItem, 0)).toBe(1);
    expect(counts.rows[0]).toEqual({
      event_count: "1",
      work_item_count: "1",
    });
  });

  it("支付事件与履约工作项同事务失败时不留下孤儿事件", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `set local search_path to ${quoteFixtureSchema(fixtureSchemaName)}, public`
      );
      await client.query(
        "insert into payment_order (id) values ('payment-order-rollback')"
      );
      await client.query(`insert into payment_lifecycle_event (
        id, payment_order_id, event_type, source_ref,
        occurred_at, timestamp_source, provider
      ) values (
        'event-rollback', 'payment-order-rollback', 'payment_confirmed',
        'provider-event-rollback', now(), 'provider', 'creem'
      )`);
      await expect(
        client.query(
          `insert into payment_fulfillment_work_item (
          id, payment_order_id, user_id, provider, provider_trade_no,
          credit_source_ref, credits_amount, debit_account, description, metadata
        ) values (
          'work-rollback', 'payment-order-rollback', $1, 'invalid-provider',
          'trade-rollback', 'credit-source-rollback', 10,
          'platform:revenue', 'rollback test', '{}'::json
        )`,
          [userIds[0]]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback");
    } finally {
      client.release();
    }
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count
      from ${quoteFixtureSchema(fixtureSchemaName)}.payment_lifecycle_event
      where id = 'event-rollback'`
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("导出快照高水位保留 PostgreSQL 六位微秒", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    try {
      await client.query(
        `set search_path to ${quoteFixtureSchema(fixtureSchemaName)}, public`
      );
      await client.query(`truncate table
        user_web_visit,
        payment_fulfillment_work_item,
        payment_lifecycle_event,
        payment_order
      cascade`);
      await client.query("begin isolation level repeatable read read only");
      await client.query(
        `set local search_path to "${fixtureSchemaName}", public`
      );
      const snapshot = await readOperationsExportSnapshot((query) =>
        executeSql(client, query)
      );
      await client.query("commit");
      expect(snapshot.highWatermarks).toEqual({
        users: {
          createdAt: "2000-01-02T12:34:56.123403Z",
          id: userIds[0],
        },
        webVisits: null,
        outputs: null,
        paymentOrders: null,
        paymentLifecycle: null,
        creditContributions: null,
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  it("同一毫秒内的明细按稳定 ID 跨页不丢记录", async () => {
    const repository = createOperationsGrowthDetailRepository(
      createDetailTransactionDatabase()
    );
    /** 读取一页真实新增用户 SQL，并把 limit+1 结果收敛为公开分页结构。 */
    const readPage = async (
      cursor: { businessTime: Date; stableId: string } | null
    ) =>
      repository.withReadOnlySnapshot(async (reader) => {
        const header = await reader.readHeader();
        const rows = await reader.readRows({
          kind: "users",
          start: new Date("2000-01-02T00:00:00.000Z"),
          end: new Date("2000-01-03T00:00:00.000Z"),
          epochStart: new Date("2000-01-01T00:00:00.000Z"),
          asOf: header.asOf,
          cursor,
          limit: 3,
        });
        const growthRows = rows.filter(
          (row): row is OperationsGrowthDetailRow =>
            row.kind === undefined || row.kind === "growth"
        );
        return paginateOperationsGrowthDetailRows(growthRows, 2);
      });

    const firstPage = await readPage(null);
    expect(firstPage.rows.map((row) => row.userId)).toEqual([
      userIds[0],
      userIds[1],
    ]);
    expect(firstPage.nextCursor).toMatchObject({ stableId: userIds[1] });

    const secondPage = await readPage(firstPage.nextCursor);
    expect(secondPage.rows.map((row) => row.userId)).toEqual([userIds[2]]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
