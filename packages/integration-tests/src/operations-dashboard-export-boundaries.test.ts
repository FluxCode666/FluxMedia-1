/**
 * 运营总览生产迁移、并发事实、导出与明细 keyset 的真实 PostgreSQL 集成测试。
 *
 * 职责：在隔离 schema 原样执行生产运营迁移，证明 epoch 不可漂移、访问与支付
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
  buildOperationsActivityDetailSql,
  buildOperationsCommercialDetailSql,
  buildOperationsContentDetailSql,
  buildOperationsNewUserDetailSql,
  createOperationsGrowthDetailRepository,
  type OperationsDetailCursor,
  type OperationsGrowthDetailRow,
  paginateOperationsGrowthDetailRows,
} from "../../../apps/web/src/features/operations-dashboard/detail-repository";
import {
  buildOperationsExportSnapshotSql,
  readOperationsExportSnapshot,
} from "../../../apps/web/src/features/operations-dashboard/export-task-repository";
import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

const userIds = [
  "boundary-user-z",
  "boundary-user-y",
  "boundary-user-x",
] as const;
const createdAtValues = [
  "2000-01-02 12:34:56.123401",
  "2000-01-02 12:34:56.123403",
  "2000-01-02 12:34:56.123402",
] as const;

let fixtureSchemaName = "";
let pool: Pool | null = null;

const operationsMigrationSql = [
  "0093_operations_dashboard.sql",
  "0094_operations_detail_cursor_indexes.sql",
]
  .map((fileName) =>
    readFileSync(
      new URL(`../../database/drizzle/${fileName}`, import.meta.url),
      "utf8"
    )
  )
  .join("\n--> statement-breakpoint\n");

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

/** 递归提取 PostgreSQL JSON 执行计划节点类型，拒绝依赖驱动的宽松 any。 */
function collectExplainNodeTypes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectExplainNodeTypes(item));
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const current =
    typeof record["Node Type"] === "string" ? [record["Node Type"]] : [];
  return [
    ...current,
    ...collectExplainNodeTypes(record.Plan),
    ...collectExplainNodeTypes(record.Plans),
  ];
}

/** 递归提取 PostgreSQL JSON 执行计划中的指定文本字段。 */
function collectExplainTextValues(value: unknown, key: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectExplainTextValues(item, key));
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const current = typeof record[key] === "string" ? [record[key]] : [];
  return [
    ...current,
    ...collectExplainTextValues(record.Plan, key),
    ...collectExplainTextValues(record.Plans, key),
  ];
}

/** 执行参数化生产查询的结构化 EXPLAIN，并返回索引与排序证据。 */
async function explainDetailQuery(
  client: PoolClient,
  query: SQL
): Promise<{
  nodeTypes: string[];
  indexNames: string[];
  indexConditions: string[];
}> {
  const compiled = new PgDialect().sqlToQuery(query);
  const result = await client.query<{ "QUERY PLAN": unknown }>(
    `explain (analyze, buffers, format json) ${compiled.sql}`,
    compiled.params
  );
  const plan = result.rows[0]?.["QUERY PLAN"];
  return {
    nodeTypes: collectExplainNodeTypes(plan),
    indexNames: collectExplainTextValues(plan, "Index Name"),
    indexConditions: collectExplainTextValues(plan, "Index Cond"),
  };
}

/** 原样执行生产运营迁移的 statement-breakpoint 分段。 */
async function applyOperationsMigration(client: PoolClient): Promise<void> {
  for (const statement of operationsMigrationSql.split(
    "--> statement-breakpoint"
  )) {
    if (statement.trim()) await client.query(statement);
  }
}

/** 创建生产迁移的前置表及其它只读事实源，再原样应用运营迁移。 */
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
    create type output_usage_kind as enum ('image', 'video');
    create table user_output_usage_event (
      created_at timestamp not null,
      output_kind output_usage_kind not null,
      source_task_id text not null,
      user_id text not null,
      operation_created_at timestamp not null,
      image_count integer not null default 1,
      video_seconds integer not null default 0,
      primary key (output_kind, source_task_id)
    );
    create table payment_order (
      id text primary key,
      provider_trade_no text,
      user_id text not null default 'boundary-user-z',
      purpose text not null default 'credit_top_up',
      status text not null default 'pending',
      currency text not null default 'CNY',
      amount_minor bigint not null default 100,
      fulfilled_at timestamp,
      created_at timestamp not null default now()
    );
    create index payment_order_admin_recharge_created_id_idx
      on payment_order (created_at desc, id desc, status, user_id)
      where purpose in ('credit_top_up', 'credit_package');
    create index payment_order_admin_created_id_idx
      on payment_order (created_at desc, id desc);
    create table credit_usage_projection_entry (
      transaction_id text primary key,
      projected_at timestamp not null,
      user_id text not null,
      operation_type text not null,
      operation_id text not null,
      operation_created_at timestamp not null,
      contribution_kind text not null,
      amount numeric(18, 2) not null
    );
    create table credit_usage_operation (
      user_id text not null,
      operation_type text not null,
      operation_id text not null,
      operation_created_at timestamp not null,
      net_consumed numeric(18, 2) not null,
      primary key (user_id, operation_type, operation_id)
    );
    create table generation (
      id text primary key,
      user_id text not null,
      model text
    );
    create table video_generation (
      id text primary key,
      user_id text not null,
      model text
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
  it("实际运营迁移创建全部约束与明细游标索引", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const result = await pool.query<{ relation_name: string }>(
      `select to_regclass($1)::text as relation_name`,
      [`${fixtureSchemaName}.operations_export_task`]
    );

    expect(result.rows[0]?.relation_name).toBe("operations_export_task");
    const indexes = await pool.query<{ index_name: string }>(
      `select indexname as index_name
      from pg_indexes
      where schemaname = $1 and indexname = any($2::text[])
      order by indexname`,
      [
        fixtureSchemaName,
        [
          "credit_usage_projection_entry_projected_cursor_idx",
          "payment_lifecycle_event_occurred_id_idx",
          "payment_lifecycle_event_recorded_id_idx",
          "payment_order_operations_fulfilled_cursor_idx",
          "user_output_usage_event_created_cursor_idx",
          "user_output_usage_event_operation_cursor_idx",
          "user_web_visit_created_cursor_idx",
        ],
      ]
    );
    expect(indexes.rows.map((row) => row.index_name)).toEqual([
      "credit_usage_projection_entry_projected_cursor_idx",
      "payment_lifecycle_event_occurred_id_idx",
      "payment_lifecycle_event_recorded_id_idx",
      "payment_order_operations_fulfilled_cursor_idx",
      "user_output_usage_event_created_cursor_idx",
      "user_output_usage_event_operation_cursor_idx",
      "user_web_visit_created_cursor_idx",
    ]);
  });

  it("导出高水位查询复用各事实追加时间索引", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    try {
      await client.query("begin read only");
      await client.query(
        `set local search_path to ${quoteFixtureSchema(fixtureSchemaName)}, public`
      );
      await client.query("set local enable_seqscan = off");
      const plan = await explainDetailQuery(
        client,
        buildOperationsExportSnapshotSql()
      );

      expect(plan.indexNames).toEqual(
        expect.arrayContaining([
          "user_created_at_id_idx",
          "user_web_visit_created_cursor_idx",
          "user_output_usage_event_created_cursor_idx",
          "payment_order_admin_created_id_idx",
          "payment_lifecycle_event_recorded_id_idx",
          "credit_usage_projection_entry_projected_cursor_idx",
        ])
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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
          id: userIds[1],
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

  it("旧订单在任务冻结后履约不会穿透已履约与付费活跃 CSV", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const schema = quoteFixtureSchema(fixtureSchemaName);
    await pool.query(
      `insert into ${schema}.payment_order (
        id, user_id, purpose, status, currency, amount_minor, created_at
      ) values ($1, $2, 'credit_top_up', 'pending', 'CNY', 8800, $3::timestamp)`,
      ["frozen-order-late-fulfillment", userIds[0], "2006-08-01 12:00:00"]
    );
    await pool.query(
      `insert into ${schema}.payment_lifecycle_event (
        id, payment_order_id, event_type, source_ref, occurred_at,
        recorded_at, timestamp_source, provider
      ) values ($1, $2, 'order_created', $3, $4::timestamp,
        $4::timestamp, 'server_generated', 'creem')`,
      [
        "frozen-event-created",
        "frozen-order-late-fulfillment",
        "frozen-source-created",
        "2006-08-01 12:00:00",
      ]
    );

    const snapshotClient = await pool.connect();
    let snapshot: Awaited<ReturnType<typeof readOperationsExportSnapshot>>;
    try {
      await snapshotClient.query(
        "begin isolation level repeatable read read only"
      );
      await snapshotClient.query(`set local search_path to ${schema}, public`);
      snapshot = await readOperationsExportSnapshot((query) =>
        executeSql(snapshotClient, query)
      );
      await snapshotClient.query("commit");
    } catch (error) {
      await snapshotClient.query("rollback");
      throw error;
    } finally {
      snapshotClient.release();
    }

    await pool.query(
      `update ${schema}.payment_order
      set status = 'fulfilled', fulfilled_at = $2::timestamp,
        provider_trade_no = 'late-provider-trade'
      where id = $1`,
      ["frozen-order-late-fulfillment", "2006-08-02 12:00:00"]
    );
    await pool.query(
      `insert into ${schema}.payment_lifecycle_event (
        id, payment_order_id, event_type, source_ref, occurred_at,
        recorded_at, timestamp_source, provider
      ) values ($1, $2, 'fulfillment_succeeded', $3, $4::timestamp,
        '2100-01-01 00:00:00'::timestamp, 'server_generated', 'creem')`,
      [
        "frozen-event-fulfilled",
        "frozen-order-late-fulfillment",
        "frozen-source-fulfilled",
        "2006-08-02 12:00:00",
      ]
    );

    const queryClient = await pool.connect();
    try {
      await queryClient.query(`set search_path to ${schema}, public`);
      const baseQuery = {
        start: new Date("2006-08-01T00:00:00.000Z"),
        end: new Date("2006-08-03T00:00:00.000Z"),
        epochStart: new Date("2000-01-01T00:00:00.000Z"),
        asOf: snapshot.snapshotAt,
        cursor: null,
        limit: 10,
      };
      const frozenFulfilled = new PgDialect().sqlToQuery(
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "fulfilled_orders",
          currency: null,
          highWatermarks: snapshot.highWatermarks,
        })
      );
      const liveFulfilled = new PgDialect().sqlToQuery(
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "fulfilled_orders",
          currency: null,
        })
      );
      const frozenPaymentActivity = new PgDialect().sqlToQuery(
        buildOperationsActivityDetailSql({
          ...baseQuery,
          kind: "activity",
          activityKind: "payment",
          highWatermarks: snapshot.highWatermarks,
        })
      );
      const frozenOrders = new PgDialect().sqlToQuery(
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "orders",
          highWatermarks: snapshot.highWatermarks,
        })
      );
      const liveOrders = new PgDialect().sqlToQuery(
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "orders",
        })
      );
      const frozenLifecycle = new PgDialect().sqlToQuery(
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "payment_lifecycle",
          highWatermarks: snapshot.highWatermarks,
        })
      );

      const frozenRows = await queryClient.query<Record<string, unknown>>(
        frozenFulfilled.sql,
        frozenFulfilled.params
      );
      const liveRows = await queryClient.query<Record<string, unknown>>(
        liveFulfilled.sql,
        liveFulfilled.params
      );
      const frozenActivityRows = await queryClient.query<
        Record<string, unknown>
      >(frozenPaymentActivity.sql, frozenPaymentActivity.params);
      const frozenOrderRows = await queryClient.query<Record<string, unknown>>(
        frozenOrders.sql,
        frozenOrders.params
      );
      const liveOrderRows = await queryClient.query<Record<string, unknown>>(
        liveOrders.sql,
        liveOrders.params
      );
      const frozenLifecycleRows = await queryClient.query<
        Record<string, unknown>
      >(frozenLifecycle.sql, frozenLifecycle.params);

      expect(frozenRows.rows).toHaveLength(0);
      expect(frozenActivityRows.rows).toHaveLength(0);
      expect(frozenOrderRows.rows).toHaveLength(1);
      expect(frozenOrderRows.rows[0]).toMatchObject({
        order_status: "creating",
        fulfilled_at: null,
        provider_trade_no: null,
      });
      expect(liveOrderRows.rows).toHaveLength(1);
      expect(liveOrderRows.rows[0]).toMatchObject({
        order_status: "fulfilled",
        provider_trade_no: "late-provider-trade",
      });
      expect(liveOrderRows.rows[0]?.fulfilled_at).not.toBeNull();
      expect(frozenLifecycleRows.rows).toHaveLength(1);
      expect(frozenLifecycleRows.rows[0]).toMatchObject({
        event_type: "order_created",
        order_status: "creating",
        fulfilled_at: null,
        provider_trade_no: null,
      });
      expect(liveRows.rows).toHaveLength(1);
      expect(liveRows.rows[0]?.payment_order_id).toBe(
        "frozen-order-late-fulfillment"
      );
    } finally {
      queryClient.release();
    }
  });

  it("同一毫秒内的明细按稳定 ID 跨页不丢记录", async () => {
    const repository = createOperationsGrowthDetailRepository(
      createDetailTransactionDatabase()
    );
    /** 读取一页真实新增用户 SQL，并把 limit+1 结果收敛为公开分页结构。 */
    const readPage = async (cursor: OperationsDetailCursor | null) =>
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
      userIds[1],
      userIds[2],
    ]);
    expect(firstPage.nextCursor).toMatchObject({ stableId: userIds[2] });

    const secondPage = await readPage(firstPage.nextCursor);
    expect(secondPage.rows.map((row) => row.userId)).toEqual([userIds[0]]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("深 keyset 页复用原始时间索引且不产生 Sort", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const schema = quoteFixtureSchema(fixtureSchemaName);
    await pool.query(`insert into ${schema}."user" (
      id, name, email, role, banned, created_at
    )
    select
      'explain-user-' || lpad(series::text, 5, '0'),
      'Explain User ' || series,
      'explain-user-' || series || '@example.test',
      'user',
      false,
      '2001-01-01 00:00:00'::timestamp + series * interval '1 microsecond'
    from generate_series(1, 3005) as series
    on conflict (id) do nothing`);

    const repository = createOperationsGrowthDetailRepository(
      createDetailTransactionDatabase()
    );
    let cursor: OperationsDetailCursor | null = null;
    const seen = new Set<string>();
    for (;;) {
      const page = await repository.withReadOnlySnapshot(async (reader) => {
        const rows = await reader.readRows({
          kind: "users",
          start: new Date("2001-01-01T00:00:00.000Z"),
          end: new Date("2001-01-02T00:00:00.000Z"),
          epochStart: new Date("2000-01-01T00:00:00.000Z"),
          asOf: new Date("2001-01-02T00:00:00.000Z"),
          cursor,
          limit: 1001,
        });
        const growthRows = rows.filter(
          (row): row is OperationsGrowthDetailRow => row.kind === "growth"
        );
        return paginateOperationsGrowthDetailRows(growthRows, 1000);
      });
      for (const row of page.rows) seen.add(row.userId);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(3005);

    const client = await pool.connect();
    try {
      await client.query("begin read only");
      await client.query(`set local search_path to ${schema}, public`);
      await client.query("set local enable_seqscan = off");
      await client.query("set local enable_bitmapscan = off");
      const query = buildOperationsNewUserDetailSql({
        kind: "users",
        start: new Date("2001-01-01T00:00:00.000Z"),
        end: new Date("2001-01-02T00:00:00.000Z"),
        epochStart: new Date("2000-01-01T00:00:00.000Z"),
        asOf: new Date("2001-01-02T00:00:00.000Z"),
        cursor: {
          businessTime: new Date("2001-01-01T00:00:00.002Z"),
          businessTimeKey: "2001-01-01T00:00:00.002000Z",
          stableId: "explain-user-02000",
        },
        limit: 1001,
      });
      const plan = await explainDetailQuery(client, query);
      expect(plan.indexNames).toContain("user_created_at_id_idx");
      expect(plan.indexConditions.join(" ")).toContain("ROW(created_at, id)");
      expect(plan.nodeTypes).not.toContain("Sort");
      expect(plan.nodeTypes).not.toContain("Incremental Sort");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  it("商业化与内容直接事实查询均复用匹配的 tuple cursor 索引", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const schema = quoteFixtureSchema(fixtureSchemaName);
    await pool.query(
      `insert into ${schema}.payment_order (
      id, provider_trade_no, user_id, purpose, status, currency,
      amount_minor, fulfilled_at, created_at
    )
    select
      'detail-order-' || lpad(series::text, 5, '0'),
      'detail-trade-' || series,
      $1,
      'credit_top_up',
      'fulfilled',
      'CNY',
      100,
      '2002-01-01 00:00:00'::timestamp + series * interval '1 microsecond',
      '2002-01-01 00:00:00'::timestamp + series * interval '1 microsecond'
    from generate_series(1, 3005) as series
    on conflict (id) do nothing`,
      [userIds[0]]
    );
    await pool.query(`insert into ${schema}.payment_lifecycle_event (
      id, payment_order_id, event_type, source_ref, occurred_at,
      recorded_at, timestamp_source, provider
    )
    select
      'detail-event-' || lpad(series::text, 5, '0'),
      'detail-order-' || lpad(series::text, 5, '0'),
      'fulfillment_succeeded',
      'detail-source-' || series,
      '2003-01-01 00:00:00'::timestamp + series * interval '1 microsecond',
      '2003-01-01 00:00:00'::timestamp + series * interval '1 microsecond',
      'server_generated',
      'creem'
    from generate_series(1, 3005) as series
    on conflict (payment_order_id, event_type, source_ref) do nothing`);
    await pool.query(
      `insert into ${schema}.user_output_usage_event (
      created_at, output_kind, source_task_id, user_id,
      operation_created_at, image_count, video_seconds
    )
    select
      '2004-01-01 00:00:00'::timestamp + series * interval '1 microsecond',
      'image'::output_usage_kind,
      'detail-task-' || lpad(series::text, 5, '0'),
      $1,
      '2004-01-01 00:00:00'::timestamp + series * interval '1 microsecond',
      1,
      0
    from generate_series(1, 3005) as series
    on conflict (output_kind, source_task_id) do nothing`,
      [userIds[0]]
    );

    const client = await pool.connect();
    try {
      await client.query("begin read only");
      await client.query(`set local search_path to ${schema}, public`);
      await client.query("set local enable_seqscan = off");
      await client.query("set local enable_bitmapscan = off");
      const baseQuery = {
        epochStart: new Date("2000-01-01T00:00:00.000Z"),
        asOf: new Date("2005-01-01T00:00:00.000Z"),
        limit: 1001,
      };
      const ordersPlan = await explainDetailQuery(
        client,
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "orders",
          start: new Date("2002-01-01T00:00:00.000Z"),
          end: new Date("2002-01-02T00:00:00.000Z"),
          cursor: {
            businessTime: new Date("2002-01-01T00:00:00.002Z"),
            businessTimeKey: "2002-01-01T00:00:00.002000Z",
            stableId: "detail-order-02000",
          },
        })
      );
      const fulfilledPlan = await explainDetailQuery(
        client,
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "fulfilled_orders",
          start: new Date("2002-01-01T00:00:00.000Z"),
          end: new Date("2002-01-02T00:00:00.000Z"),
          cursor: {
            businessTime: new Date("2002-01-01T00:00:00.002Z"),
            businessTimeKey: "2002-01-01T00:00:00.002000Z",
            stableId: "detail-order-02000",
          },
          currency: null,
        })
      );
      const lifecyclePlan = await explainDetailQuery(
        client,
        buildOperationsCommercialDetailSql({
          ...baseQuery,
          kind: "payment_lifecycle",
          start: new Date("2003-01-01T00:00:00.000Z"),
          end: new Date("2003-01-02T00:00:00.000Z"),
          cursor: {
            businessTime: new Date("2003-01-01T00:00:00.002Z"),
            businessTimeKey: "2003-01-01T00:00:00.002000Z",
            stableId: "detail-event-02000",
          },
        })
      );
      const contentPlan = await explainDetailQuery(
        client,
        buildOperationsContentDetailSql({
          ...baseQuery,
          kind: "content",
          start: new Date("2004-01-01T00:00:00.000Z"),
          end: new Date("2004-01-02T00:00:00.000Z"),
          cursor: {
            businessTime: new Date("2004-01-01T00:00:00.002Z"),
            businessTimeKey: "2004-01-01T00:00:00.002000Z",
            stableId: "image:detail-task-02000",
          },
          detail: "image_outputs",
        })
      );

      expect(ordersPlan.indexNames).toContain(
        "payment_order_admin_recharge_created_id_idx"
      );
      expect(fulfilledPlan.indexNames).toContain(
        "payment_order_operations_fulfilled_cursor_idx"
      );
      expect(lifecyclePlan.indexNames).toContain(
        "payment_lifecycle_event_occurred_id_idx"
      );
      expect(contentPlan.indexNames).toContain(
        "user_output_usage_event_operation_cursor_idx"
      );
      for (const plan of [
        ordersPlan,
        fulfilledPlan,
        lifecyclePlan,
        contentPlan,
      ]) {
        expect(plan.indexConditions.join(" ")).toContain("ROW(");
        expect(plan.nodeTypes).not.toContain("Sort");
        expect(plan.nodeTypes).not.toContain("Incremental Sort");
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
});
