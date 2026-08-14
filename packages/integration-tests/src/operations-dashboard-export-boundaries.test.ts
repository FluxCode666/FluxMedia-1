/**
 * 运营总览导出与明细 keyset 的真实 PostgreSQL 边界集成测试。
 *
 * 职责：用隔离 schema 证明导出快照保留 PostgreSQL 六位微秒，并证明同一毫秒内
 * 的多条用户记录按稳定 ID 跨页完整返回。普通 turbo test 不发现本文件，发布前由
 * operations-dashboard 专用命令显式执行。
 */

import { randomUUID } from "node:crypto";
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

/** 将 Drizzle SQL 按生产 PostgreSQL 方言执行，保留参数化边界。 */
async function executeSql(client: PoolClient, query: SQL): Promise<unknown> {
  const compiled = new PgDialect().sqlToQuery(query);
  return client.query(compiled.sql, compiled.params);
}

/** 创建生产快照和新增用户明细所需的最小隔离表。 */
async function createFixtureSchema(client: PoolClient): Promise<string> {
  const schemaName = `operations_boundaries_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create schema "${schemaName}"`);
  await client.query(`set search_path to "${schemaName}", public`);
  await client.query(`
    create table operations_analytics_epoch (
      id integer primary key,
      app_date text not null,
      starts_at timestamp not null
    );
    create table "user" (
      id text primary key,
      name text not null,
      email text not null,
      role text not null,
      banned boolean not null,
      created_at timestamp not null
    );
    create table user_web_visit (
      created_at timestamp not null,
      user_id text not null,
      app_date text not null
    );
    create table user_output_usage_event (
      created_at timestamp not null,
      output_kind text not null,
      source_task_id text not null
    );
    create table payment_order (
      id text primary key,
      created_at timestamp not null
    );
    create table payment_lifecycle_event (
      id text primary key,
      recorded_at timestamp not null
    );
    create table credit_usage_projection_entry (
      transaction_id text primary key,
      projected_at timestamp not null
    );
    insert into operations_analytics_epoch (id, app_date, starts_at)
    values (1, '2000-01-01', '2000-01-01 00:00:00');
  `);
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
  it("导出快照高水位保留 PostgreSQL 六位微秒", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    try {
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
