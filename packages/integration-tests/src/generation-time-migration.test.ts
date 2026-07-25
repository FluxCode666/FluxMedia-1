/**
 * generation 历史时间迁移的真实 PostgreSQL 集成测试。
 *
 * 职责：覆盖旧 Asia/Shanghai 墙上时间与 UTC 混存、证据不足回滚及迁移幂等性。
 * 使用方：显式 `pnpm --filter @repo/integration-tests test:generation-time-migration`
 *   production 质量门。
 * 关键依赖：专用 GENERATION_TIME_MIGRATION_TEST_DATABASE_URL 与 0052 SQL。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

const migrationSql = readFileSync(
  fileURLToPath(
    new URL(
      "../../database/drizzle/0052_normalize_generation_created_at_utc.sql",
      import.meta.url
    )
  ),
  "utf8"
);

interface GenerationTimeRow {
  createdAt: string;
  id: string;
}

interface GenerationFixture {
  completedAt: string | null;
  createdAt: string;
  id: string;
  metadata: unknown;
}

let pool: Pool | null = null;

/**
 * 创建本轮测试专属 schema，并建立 0052 所需的最小 generation 表。
 *
 * @param client 专用测试数据库连接。
 * @returns 随机且仅含安全标识符字符的 schema 名称。
 * @throws PostgreSQL 无法创建 schema 或测试表时抛出。
 * @sideEffect 在专用测试数据库创建一个隔离 schema 和 generation 表。
 */
async function createFixtureSchema(client: PoolClient): Promise<string> {
  const schemaName = `generation_time_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create schema "${schemaName}"`);
  await client.query(`set search_path to "${schemaName}", public`);
  await client.query(`
    create table generation (
      id text primary key,
      status text not null default 'failed',
      metadata json,
      created_at timestamp not null default now(),
      completed_at timestamp
    )
  `);
  return schemaName;
}

/**
 * 向隔离 generation 表写入受控时间证据夹具。
 *
 * @param client 已切换到本轮 schema 的测试数据库连接。
 * @param fixtures 要写入的 UTC 或旧墙上时间样本。
 * @returns 所有样本写入完成后的 Promise。
 * @throws 参数化 INSERT 失败时抛出。
 * @sideEffect 仅向本轮隔离 schema 的 generation 表插入测试行。
 */
async function seedGenerationFixtures(
  client: PoolClient,
  fixtures: GenerationFixture[]
): Promise<void> {
  for (const fixture of fixtures) {
    await client.query(
      `insert into generation (id, metadata, created_at, completed_at)
       values ($1, $2::json, $3::timestamp, $4::timestamp)`,
      [
        fixture.id,
        JSON.stringify(fixture.metadata),
        fixture.createdAt,
        fixture.completedAt,
      ]
    );
  }
}

/**
 * 在显式事务与指定会话时区中执行真实 0052 SQL。
 *
 * @param client 已切换到本轮 schema 的测试数据库连接。
 * @param sessionTimeZone 迁移连接的 IANA 时区。
 * @returns 迁移提交后的 Promise。
 * @throws 迁移拒绝数据时先回滚，再透传 PostgreSQL 异常。
 * @sideEffect 可能更新隔离 generation 时间和默认值；失败时整体回滚。
 */
async function runMigration(
  client: PoolClient,
  sessionTimeZone: "Asia/Shanghai" | "UTC"
): Promise<void> {
  await client.query("begin");
  try {
    await client.query(`set local time zone '${sessionTimeZone}'`);
    await client.query(migrationSql);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * 读取隔离 generation 的无时区墙上值，避免 Node 本地时区参与断言。
 *
 * @param client 已切换到本轮 schema 的测试数据库连接。
 * @returns 按 ID 排序的微秒精度时间文本。
 * @throws PostgreSQL 查询失败时抛出。
 * @sideEffect 只读查询，无写入副作用。
 */
async function readGenerationTimes(
  client: PoolClient
): Promise<GenerationTimeRow[]> {
  const result = await client.query<GenerationTimeRow>(`
    select id,
           to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.US') as "createdAt"
    from generation
    order by id
  `);
  return result.rows;
}

/**
 * 删除本轮随机 schema，避免专用测试库积累夹具。
 *
 * @param client 测试数据库连接。
 * @param schemaName createFixtureSchema 返回的受控 schema 名称。
 * @returns schema 删除完成后的 Promise。
 * @throws 清理失败时抛出，让质量门暴露测试污染。
 * @sideEffect 仅级联删除本测试创建的随机 schema。
 */
async function dropFixtureSchema(
  client: PoolClient,
  schemaName: string
): Promise<void> {
  await client.query("set search_path to public");
  await client.query(`drop schema "${schemaName}" cascade`);
}

beforeAll(() => {
  const databaseUrl = requireDedicatedTestDatabaseUrl(
    "GENERATION_TIME_MIGRATION_TEST_DATABASE_URL"
  );
  pool = new Pool({
    application_name: "fluxmedia-generation-time-migration-integration",
    connectionString: databaseUrl,
    max: 2,
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("generation UTC migration PostgreSQL integration", () => {
  it("在 UTC 迁移会话中逐行归一化混合口径并保持幂等", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(client);
      await seedGenerationFixtures(client, [
        {
          completedAt: "2026-07-24 02:20:00.000000",
          createdAt: "2026-07-24 10:00:00.004847",
          id: "legacy-completed",
          metadata: {
            upstreamStream: { startedAt: "2026-07-24T02:00:00.000Z" },
          },
        },
        {
          completedAt: null,
          createdAt: "2026-07-25 10:50:56.298137",
          id: "legacy-without-completed-at",
          metadata: {
            upstreamStream: { startedAt: "2026-07-25T02:50:56.297Z" },
          },
        },
        {
          completedAt: "2026-07-20 16:09:29.775000",
          createdAt: "2026-07-20 15:46:09.452566",
          id: "utc-completed-fallback",
          metadata: { timeout: { reason: "runtime_timeout" } },
        },
      ]);

      await runMigration(client, "UTC");
      expect(await readGenerationTimes(client)).toEqual([
        {
          createdAt: "2026-07-24 02:00:00.004847",
          id: "legacy-completed",
        },
        {
          createdAt: "2026-07-25 02:50:56.298137",
          id: "legacy-without-completed-at",
        },
        {
          createdAt: "2026-07-20 15:46:09.452566",
          id: "utc-completed-fallback",
        },
      ]);

      await runMigration(client, "Asia/Shanghai");
      expect(await readGenerationTimes(client)).toEqual([
        {
          createdAt: "2026-07-24 02:00:00.004847",
          id: "legacy-completed",
        },
        {
          createdAt: "2026-07-25 02:50:56.298137",
          id: "legacy-without-completed-at",
        },
        {
          createdAt: "2026-07-20 15:46:09.452566",
          id: "utc-completed-fallback",
        },
      ]);

      const defaultResult = await client.query<{ defaultExpression: string }>(`
        select pg_get_expr(adbin, adrelid) as "defaultExpression"
        from pg_attrdef
        where adrelid = 'generation'::regclass
          and adnum = (
            select attnum
            from pg_attribute
            where attrelid = 'generation'::regclass
              and attname = 'created_at'
          )
      `);
      expect(defaultResult.rows[0]?.defaultExpression).toContain(
        "CURRENT_TIMESTAMP AT TIME ZONE 'UTC'"
      );
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("证据缺失时回滚数据与默认值", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(client);
      await seedGenerationFixtures(client, [
        {
          completedAt: null,
          createdAt: "2026-07-25 10:50:56.298137",
          id: "ambiguous-without-anchor",
          metadata: {},
        },
      ]);

      await expect(runMigration(client, "UTC")).rejects.toThrow(
        "0052 无法逐行判断 generation 时间口径"
      );
      expect(await readGenerationTimes(client)).toEqual([
        {
          createdAt: "2026-07-25 10:50:56.298137",
          id: "ambiguous-without-anchor",
        },
      ]);

      const defaultResult = await client.query<{ defaultExpression: string }>(`
        select pg_get_expr(adbin, adrelid) as "defaultExpression"
        from pg_attrdef
        where adrelid = 'generation'::regclass
          and adnum = (
            select attnum
            from pg_attribute
            where attrelid = 'generation'::regclass
              and attname = 'created_at'
          )
      `);
      expect(defaultResult.rows[0]?.defaultExpression).toBe("now()");
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("拒绝非法服务端时间锚点而不回退到完成时间", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(client);
      await seedGenerationFixtures(client, [
        {
          completedAt: "2026-07-25 03:00:00.000000",
          createdAt: "2026-07-25 10:50:56.298137",
          id: "invalid-started-at",
          metadata: { upstreamStream: { startedAt: "not-an-iso-time" } },
        },
      ]);

      await expect(runMigration(client, "UTC")).rejects.toThrow(
        "0052 无法逐行判断 generation 时间口径"
      );
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("合法服务端锚点无法匹配候选时也不回退到完成时间", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(client);
      await seedGenerationFixtures(client, [
        {
          completedAt: "2026-07-25 03:00:00.000000",
          createdAt: "2026-07-25 02:50:56.298137",
          id: "unmatched-started-at",
          metadata: {
            upstreamStream: { startedAt: "2026-07-25T01:00:00.000Z" },
          },
        },
      ]);

      await expect(runMigration(client, "UTC")).rejects.toThrow(
        "0052 无法逐行判断 generation 时间口径"
      );
      expect(await readGenerationTimes(client)).toEqual([
        {
          createdAt: "2026-07-25 02:50:56.298137",
          id: "unmatched-started-at",
        },
      ]);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });

  it("服务端锚点与完成时间支持不同候选时整体回滚", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const client = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(client);
      await seedGenerationFixtures(client, [
        {
          completedAt: "2026-07-24 10:10:00.000000",
          createdAt: "2026-07-24 10:00:00.000501",
          id: "conflicting-evidence",
          metadata: {
            upstreamStream: { startedAt: "2026-07-24T02:00:00.000Z" },
          },
        },
      ]);

      await expect(runMigration(client, "Asia/Shanghai")).rejects.toThrow(
        "0052 无法逐行判断 generation 时间口径"
      );
      expect(await readGenerationTimes(client)).toEqual([
        {
          createdAt: "2026-07-24 10:00:00.000501",
          id: "conflicting-evidence",
        },
      ]);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(client, schemaName);
      } finally {
        client.release();
      }
    }
  });
});
