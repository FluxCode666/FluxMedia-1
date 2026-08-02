/**
 * 统一媒体号池的真实 PostgreSQL 并发集成测试。
 *
 * 职责：使用生产仓储验证多连接稳定锁、最小负载、最少获租、容量上限、过期租约、
 * 排除集合和 owner token 释放语义。
 * 使用方：显式 `test:image-backend-pool` 质量门。
 * 关键依赖：专用 IMAGE_BACKEND_POOL_TEST_DATABASE_URL、生产 PostgreSQL 仓储与 PgDialect。
 */

import { randomUUID } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BackendPoolDatabase,
  type BackendPoolRepository,
  type BackendPoolTransaction,
  createPostgresBackendPoolRepository,
} from "../../../apps/web/src/features/image-backend-pool/repository";
import { requireDedicatedTestDatabaseUrl } from "./test-database-url";

interface MemberCountRow {
  id: string;
  lease_acquired_count: number;
}

interface MemberLeaseCountRow {
  member_id: string;
  lease_count: number;
}

let pool: Pool | null = null;

/** 验证随机 schema 名只包含安全标识符字符，再返回带双引号的 SQL 标识符。 */
function quoteSchemaName(schemaName: string): string {
  if (!/^pool_scheduler_[a-f0-9]+$/u.test(schemaName)) {
    throw new Error("集成测试 schema 名非法");
  }
  return `"${schemaName}"`;
}

/** 创建每个测试独占的最小统一号池 schema。 */
async function createFixtureSchema(client: PoolClient): Promise<string> {
  const schemaName = `pool_scheduler_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteSchemaName(schemaName);
  await client.query(`create schema ${quotedSchema}`);
  await client.query(`set search_path to ${quotedSchema}, public`);
  await client.query(`
    create table system_setting (
      key text primary key,
      value json not null
    );
    create table image_backend_group (
      id text primary key
    );
    create table image_backend_member (
      id text primary key,
      type text not null,
      name text not null,
      supported_model_ids json not null,
      content_safety_enabled boolean not null,
      is_enabled boolean not null,
      priority integer not null,
      concurrency integer not null,
      lease_acquired_count integer not null default 0,
      status text not null,
      health_status text not null,
      last_acquired_at timestamp,
      last_used_at timestamp,
      cooldown_until timestamp,
      updated_at timestamp not null default now()
    );
    create table image_backend_member_api_config (
      member_id text primary key references image_backend_member(id),
      current_adapter_version_id text
    );
    create table image_backend_member_group (
      id text primary key,
      member_id text not null references image_backend_member(id),
      group_id text not null references image_backend_group(id),
      unique (member_id, group_id)
    );
    create table image_backend_member_lease (
      id text primary key,
      member_id text not null references image_backend_member(id),
      owner_token text not null,
      api_adapter_member_id text,
      api_adapter_version_id text,
      expires_at timestamp not null,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    insert into image_backend_group (id) values ('group-a')
  `);
  return schemaName;
}

/** 删除测试创建的独占 schema。 */
async function dropFixtureSchema(
  client: PoolClient,
  schemaName: string
): Promise<void> {
  await client.query("set search_path to public");
  await client.query(`drop schema ${quoteSchemaName(schemaName)} cascade`);
}

/** 插入一个默认健康、支持测试模型且具有当前适配器版本的 API 成员。 */
async function insertMember(
  client: PoolClient,
  input: {
    id: string;
    priority?: number;
    concurrency?: number;
    leaseAcquiredCount?: number;
  }
): Promise<void> {
  await client.query(
    `insert into image_backend_member (
       id, type, name, supported_model_ids, content_safety_enabled,
       is_enabled, priority, concurrency, lease_acquired_count,
       status, health_status
     ) values ($1, 'api', $2, '["gpt-image-2"]'::json, true,
       true, $3, $4, $5, 'active', 'healthy')`,
    [
      input.id,
      `Member ${input.id}`,
      input.priority ?? 10,
      input.concurrency ?? 10,
      input.leaseAcquiredCount ?? 0,
    ]
  );
  await client.query(
    `insert into image_backend_member_api_config (
       member_id, current_adapter_version_id
     ) values ($1, $2)`,
    [input.id, `adapter-version-${input.id}`]
  );
  await client.query(
    `insert into image_backend_member_group (id, member_id, group_id)
     values ($1, $2, 'group-a')`,
    [`membership-${input.id}`, input.id]
  );
}

/** 把生产仓储的 Drizzle SQL 适配到指定 schema 的 node-postgres 事务。 */
function createRepository(
  databasePool: Pool,
  schemaName: string
): BackendPoolRepository {
  const dialect = new PgDialect();
  const quotedSchema = quoteSchemaName(schemaName);
  const database: BackendPoolDatabase = {
    async transaction<T>(
      work: (transaction: BackendPoolTransaction) => Promise<T>
    ): Promise<T> {
      const client = await databasePool.connect();
      try {
        await client.query("begin");
        await client.query(`set local search_path to ${quotedSchema}, public`);
        const result = await work({
          async execute(query: SQL): Promise<unknown> {
            const compiled = dialect.sqlToQuery(query);
            return client.query(compiled.sql, compiled.params);
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
  return createPostgresBackendPoolRepository(database);
}

/** 构造生产仓储需要的稳定获租输入。 */
function acquireInput(
  leaseId: string,
  ownerToken: string,
  excludedMemberIds: string[] = []
) {
  const now = new Date();
  return {
    groupId: "group-a",
    requestedModel: "gpt-image-2",
    excludedMemberIds,
    requiresContentSafety: true,
    leaseId,
    ownerToken,
    now,
    expiresAt: new Date(now.getTime() + 300_000),
  };
}

beforeAll(() => {
  pool = new Pool({
    application_name: "fluxmedia-pool-scheduler-integration",
    connectionString: requireDedicatedTestDatabaseUrl(
      "IMAGE_BACKEND_POOL_TEST_DATABASE_URL"
    ),
    max: 6,
  });
});

afterAll(async () => {
  await pool?.end();
});

describe("backend pool PostgreSQL concurrency", () => {
  it("least_load 让并发请求看到前一事务租约并分散到两个成员", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await owner.query(
        "insert into system_setting (key, value) values ('IMAGE_BACKEND_SCHEDULING_STRATEGY', '\"least_load\"'::json)"
      );
      await insertMember(owner, { id: "member-a", concurrency: 1 });
      await insertMember(owner, { id: "member-b", concurrency: 1 });
      const repository = createRepository(pool, schemaName);

      const results = await Promise.all([
        repository.acquireLease(acquireInput("lease-a", "owner-a")),
        repository.acquireLease(acquireInput("lease-b", "owner-b")),
      ]);

      expect(results.every((result) => result.status === "acquired")).toBe(
        true
      );
      const selectedIds = results.flatMap((result) =>
        result.status === "acquired" ? [result.acquisition.member.id] : []
      );
      expect(selectedIds.sort()).toEqual(["member-a", "member-b"]);
      const counts = await owner.query<MemberLeaseCountRow>(
        `select member_id, count(*)::integer as lease_count
         from image_backend_member_lease group by member_id order by member_id`
      );
      expect(counts.rows).toEqual([
        { member_id: "member-a", lease_count: 1 },
        { member_id: "member-b", lease_count: 1 },
      ]);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("least_acquired 在并发事务中连续更新累计获租次数", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await owner.query(
        "insert into system_setting (key, value) values ('IMAGE_BACKEND_SCHEDULING_STRATEGY', '\"least_acquired\"'::json)"
      );
      await insertMember(owner, { id: "member-a", concurrency: 2 });
      const repository = createRepository(pool, schemaName);

      const results = await Promise.all([
        repository.acquireLease(acquireInput("lease-a", "owner-a")),
        repository.acquireLease(acquireInput("lease-b", "owner-b")),
      ]);

      expect(results.every((result) => result.status === "acquired")).toBe(
        true
      );
      const count = await owner.query<MemberCountRow>(
        "select id, lease_acquired_count from image_backend_member where id = 'member-a'"
      );
      expect(count.rows).toEqual([{ id: "member-a", lease_acquired_count: 2 }]);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("容量为一时并发获租不会超卖", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await insertMember(owner, { id: "member-only", concurrency: 1 });
      const repository = createRepository(pool, schemaName);

      const results = await Promise.all([
        repository.acquireLease(acquireInput("lease-a", "owner-a")),
        repository.acquireLease(acquireInput("lease-b", "owner-b")),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "acquired",
        "capacity_rejected",
      ]);
      const leaseCount = await owner.query<{ count: number }>(
        "select count(*)::integer as count from image_backend_member_lease"
      );
      expect(leaseCount.rows[0]?.count).toBe(1);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("清理过期租约、应用排除集合并以 owner token 幂等释放", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await insertMember(owner, { id: "member-a", concurrency: 1 });
      await insertMember(owner, { id: "member-b", concurrency: 1 });
      await owner.query(
        `insert into image_backend_member_lease
          (id, member_id, owner_token, expires_at)
         values ('expired', 'member-a', 'old-owner', now() - interval '1 minute')`
      );
      const repository = createRepository(pool, schemaName);

      const result = await repository.acquireLease(
        acquireInput("lease-new", "owner-new", ["member-b"])
      );

      expect(result).toMatchObject({
        status: "acquired",
        acquisition: { member: { id: "member-a" } },
      });
      await expect(
        repository.releaseLease({
          leaseId: "lease-new",
          ownerToken: "wrong-owner",
        })
      ).resolves.toBe(false);
      await expect(
        repository.releaseLease({
          leaseId: "lease-new",
          ownerToken: "owner-new",
        })
      ).resolves.toBe(true);
      await expect(
        repository.releaseLease({
          leaseId: "lease-new",
          ownerToken: "owner-new",
        })
      ).resolves.toBe(false);
      const remaining = await owner.query<{ count: number }>(
        "select count(*)::integer as count from image_backend_member_lease"
      );
      expect(remaining.rows[0]?.count).toBe(0);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });

  it("接管过期租约时遵守容量，仍有效的原租约可在满载时换 owner", async () => {
    if (!pool) throw new Error("集成测试数据库尚未初始化");
    const owner = await pool.connect();
    let schemaName: string | null = null;
    try {
      schemaName = await createFixtureSchema(owner);
      await insertMember(owner, { id: "member-a", concurrency: 1 });
      const now = new Date("2026-07-26T01:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 21 * 60_000);
      await owner.query(
        `insert into image_backend_member_lease
          (id, member_id, owner_token, expires_at)
         values
          ('recovering', 'member-a', 'owner-old', $1),
          ('active', 'member-a', 'owner-active', $2)`,
        [new Date(now.getTime() - 1), expiresAt]
      );
      const repository = createRepository(pool, schemaName);

      await expect(
        repository.takeoverLease({
          leaseId: "recovering",
          memberId: "member-a",
          currentOwnerToken: "owner-old",
          nextOwnerToken: "owner-next",
          now,
          expiresAt,
        })
      ).resolves.toBeNull();

      await owner.query(
        "delete from image_backend_member_lease where id = 'active'"
      );
      const recovered = await repository.takeoverLease({
        leaseId: "recovering",
        memberId: "member-a",
        currentOwnerToken: "owner-old",
        nextOwnerToken: "owner-next",
        now,
        expiresAt,
      });
      expect(recovered).toMatchObject({ ownerToken: "owner-next" });

      const handedOff = await repository.takeoverLease({
        leaseId: "recovering",
        memberId: "member-a",
        currentOwnerToken: "owner-next",
        nextOwnerToken: "owner-final",
        now,
        expiresAt,
      });
      expect(handedOff).toMatchObject({ ownerToken: "owner-final" });
      const activeCount = await owner.query<{ count: number }>(
        "select count(*)::integer as count from image_backend_member_lease where expires_at > $1",
        [now]
      );
      expect(activeCount.rows[0]?.count).toBe(1);
    } finally {
      try {
        if (schemaName) await dropFixtureSchema(owner, schemaName);
      } finally {
        owner.release();
      }
    }
  });
});
