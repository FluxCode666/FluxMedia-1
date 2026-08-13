/**
 * 统一号池 PostgreSQL 仓储测试。
 *
 * 职责：用可注入事务端口验证策略直读、稳定锁、容量聚合、原子获租与 owner token
 * 比较交换语义，同时覆盖 node-postgres/Neon 两种 execute 返回形态和失败不降级。
 * 关键依赖：Vitest、Drizzle PgDialect、repository 公开事务端口。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  type AcquireBackendMemberLeaseInput,
  type BackendPoolDatabase,
  type BackendPoolTransaction,
  createPostgresBackendPoolRepository,
  IMAGE_BACKEND_SCHEDULING_STRATEGY_SETTING_KEY,
} from "./repository";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-26T00:05:00.000Z");

interface CompiledQueryRecord {
  sql: string;
  params: unknown[];
}

/** 把仓储发出的 Drizzle SQL 编译为可断言的 PostgreSQL 文本和参数。 */
function compileQuery(query: SQL): CompiledQueryRecord {
  const compiled = new PgDialect().sqlToQuery(query);
  return { sql: compiled.sql, params: compiled.params };
}

/** 创建顺序返回模拟结果的事务数据库，并记录每一条参数化 SQL。 */
function createDatabase(responses: readonly unknown[]): {
  database: BackendPoolDatabase;
  queries: CompiledQueryRecord[];
  transaction: ReturnType<typeof vi.fn>;
} {
  const queries: CompiledQueryRecord[] = [];
  const pendingResponses = [...responses];
  const transaction = vi.fn();
  const database: BackendPoolDatabase = {
    async transaction<T>(
      work: (transaction: BackendPoolTransaction) => Promise<T>
    ): Promise<T> {
      transaction();
      return work({
        async execute(query) {
          queries.push(compileQuery(query));
          return pendingResponses.shift();
        },
      });
    },
  };
  return {
    database,
    queries,
    transaction,
  };
}

/** 构造数据库锁定候选行；覆盖字段均保持数据库 snake_case 形态。 */
function memberRow(
  id: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    type: "api",
    name: `Member ${id}`,
    supported_model_ids: ["gpt-image-2"],
    content_safety_enabled: true,
    is_enabled: true,
    priority: 10,
    concurrency: 10,
    lease_acquired_count: 3,
    status: "active",
    health_status: "healthy",
    last_acquired_at: null,
    last_used_at: null,
    cooldown_until: null,
    api_adapter_member_id: id,
    api_adapter_version_id: `adapter-version-${id}`,
    ...overrides,
  };
}

/** 构造数据库 RETURNING 的完整租约行。 */
function leaseRow(
  ownerToken = "owner-new",
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: "lease-1",
    member_id: "member-low-load",
    owner_token: ownerToken,
    api_adapter_member_id: "member-low-load",
    api_adapter_version_id: "adapter-version-member-low-load",
    expires_at: EXPIRES_AT,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** 构造一次固定获租请求，测试只覆盖关心字段。 */
function acquireInput(
  overrides: Partial<AcquireBackendMemberLeaseInput> = {}
): AcquireBackendMemberLeaseInput {
  return {
    groupId: "group-a",
    requestedModel: "gpt-image-2",
    excludedMemberIds: ["member-excluded"],
    requiresContentSafety: true,
    leaseId: "lease-1",
    ownerToken: "owner-new",
    now: NOW,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

describe("backend pool PostgreSQL repository", () => {
  it("同账号重试把 requiredMemberId 编入候选 SQL", async () => {
    const { database, queries } = createDatabase([
      { rows: [{ value: "least_load" }] },
      { rowCount: 0 },
      { rows: [] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    await repository.acquireLease(
      acquireInput({ requiredMemberId: "member-required" })
    );

    const candidateQuery = queries[2];
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery?.sql).toContain("m.id =");
    expect(candidateQuery?.params).toContain("member-required");
  });

  it("API 视频调度把成员类型限制编入权威获租 SQL", async () => {
    const { database, queries } = createDatabase([
      { rows: [{ value: "least_load" }] },
      { rowCount: 0 },
      { rows: [] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    await repository.acquireLease(
      acquireInput({ requiredMemberType: "api", requestedModel: "seedance2" })
    );

    const candidateQuery = queries[2];
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery?.sql).toContain("m.type =");
    expect(candidateQuery?.params).toContain("api");
  });

  it("同账号重试把固定 API 适配版本编入权威获租 SQL", async () => {
    const { database, queries } = createDatabase([
      { rows: [{ value: "least_load" }] },
      { rowCount: 0 },
      { rows: [] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    await repository.acquireLease(
      acquireInput({
        requiredMemberId: "member-required",
        requiredMemberType: "api",
        requiredApiAdapterMemberId: "member-required",
        requiredApiAdapterVersionId: "adapter-version-fixed",
      })
    );

    const candidateQuery = queries[2];
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery?.sql).toContain("api_version.id = coalesce(");
    expect(candidateQuery?.sql).toContain(
      "api_config.current_adapter_version_id"
    );
    expect(candidateQuery?.sql).toContain(
      "api_version.member_id_snapshot = m.id"
    );
    expect(candidateQuery?.params).toEqual(
      expect.arrayContaining([
        "member-required",
        "api",
        "adapter-version-fixed",
      ])
    );
  });

  it("权威获租只把配置完整的成员计入候选和容量", async () => {
    const { database, queries } = createDatabase([
      { rows: [{ value: "least_load" }] },
      { rowCount: 0 },
      { rows: [] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    await repository.acquireLease(acquireInput());

    const candidateQuery = queries[2];
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery?.sql).toContain(
      "image_backend_member_api_adapter_version"
    );
    expect(candidateQuery?.sql).toContain("api_config.api_key is not null");
    expect(candidateQuery?.sql).toContain("api_version.id is not null");
    expect(candidateQuery?.sql).toContain("adobe_config.cookie is not null");
    expect(candidateQuery?.sql).toContain(
      "adobe_config.access_token is not null"
    );
  });

  it("acquires the least-loaded eligible member in one transaction", async () => {
    const { database, queries, transaction } = createDatabase([
      { rows: [{ value: "least_load" }] },
      { rowCount: 2 },
      [
        memberRow("member-low-load"),
        memberRow("member-high-load", { concurrency: 2 }),
      ],
      {
        rows: [
          { member_id: "member-low-load", inflight_count: "2" },
          { member_id: "member-high-load", inflight_count: "1" },
        ],
      },
      [leaseRow()],
      { rows: [{ id: "member-low-load" }] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    const result = await repository.acquireLease(acquireInput());

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "acquired",
      acquisition: {
        strategy: "least_load",
        member: {
          id: "member-low-load",
          inflightCount: 3,
          leaseAcquiredCount: 4,
          lastAcquiredAt: NOW,
        },
        lease: {
          id: "lease-1",
          memberId: "member-low-load",
          ownerToken: "owner-new",
          apiAdapterMemberId: "member-low-load",
          apiAdapterVersionId: "adapter-version-member-low-load",
        },
        eligibleCandidateCount: 2,
      },
    });
    expect(queries).toHaveLength(6);
    expect(queries[0]?.sql).toContain("from system_setting");
    expect(queries[0]?.params).toContain(
      IMAGE_BACKEND_SCHEDULING_STRATEGY_SETTING_KEY
    );
    expect(queries[1]?.sql).toContain("delete from image_backend_member_lease");
    expect(queries[2]?.sql).toContain("order by m.id asc");
    expect(queries[2]?.sql).toContain("for update of m");
    expect(queries[2]?.sql).toContain(
      "left join image_backend_member_api_config"
    );
    expect(queries[2]?.sql).toContain(
      "json_array_elements_text(m.supported_model_ids)"
    );
    expect(queries[2]?.sql).toContain("lower(trim(supported_model.model_id))");
    expect(queries[2]?.sql.toLowerCase()).not.toContain(" like ");
    expect(queries[2]?.sql).toContain("m.cooldown_until");
    expect(queries[2]?.sql).toContain("m.status not in");
    expect(queries[2]?.sql).toContain("from adobe_credential_health");
    expect(queries[2]?.sql).toContain("credential_health.status =");
    expect(queries[2]?.params).toEqual(
      expect.arrayContaining([
        "group-a",
        "error",
        "gpt-image-2",
        "member-excluded",
      ])
    );
    expect(queries[2]?.sql).not.toContain("group-a");
    expect(queries[2]?.sql).not.toContain("member-excluded");
    expect(queries[4]?.params).toContain("member-low-load");
    expect(queries[4]?.sql).toContain("api_adapter_member_id");
    expect(queries[4]?.sql).toContain("api_adapter_version_id");
    expect(queries[5]?.sql).toContain(
      "lease_acquired_count = lease_acquired_count + 1"
    );
  });

  it("falls back to priority when the database strategy is invalid", async () => {
    const { database } = createDatabase([
      [{ value: { invalid: true } }],
      [],
      [
        memberRow("priority-later", { priority: 20 }),
        memberRow("priority-first", { priority: 1 }),
      ],
      [],
      {
        rows: [
          leaseRow("owner-new", {
            member_id: "priority-first",
          }),
        ],
      },
      [{ id: "priority-first" }],
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    const result = await repository.acquireLease(acquireInput());

    expect(result).toMatchObject({
      status: "acquired",
      acquisition: {
        strategy: "priority",
        member: { id: "priority-first" },
      },
    });
  });

  it("returns no_candidate without writing when no locked candidate exists", async () => {
    const { database, queries } = createDatabase([
      { rows: [] },
      { rowCount: 0 },
      { rows: [] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(repository.acquireLease(acquireInput())).resolves.toEqual({
      status: "no_candidate",
      strategy: "priority",
      eligibleCandidateCount: 0,
    });
    expect(queries).toHaveLength(3);
    expect(queries.every((query) => !query.sql.includes("insert into"))).toBe(
      true
    );
  });

  it("returns capacity_rejected when every eligible member is full", async () => {
    const { database, queries } = createDatabase([
      { rows: [{ value: "least_load" }] },
      { rowCount: 0 },
      { rows: [memberRow("member-full", { concurrency: 1 })] },
      { rows: [{ member_id: "member-full", inflight_count: "1" }] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(repository.acquireLease(acquireInput())).resolves.toEqual({
      status: "capacity_rejected",
      strategy: "least_load",
      eligibleCandidateCount: 1,
    });
    expect(queries).toHaveLength(4);
    expect(queries.every((query) => !query.sql.includes("insert into"))).toBe(
      true
    );
  });

  it("rejects malformed database candidate rows before any lease write", async () => {
    const { database, queries } = createDatabase([
      { rows: [{ value: "priority" }] },
      { rowCount: 0 },
      { rows: [memberRow("bad", { concurrency: 0 })] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(repository.acquireLease(acquireInput())).rejects.toMatchObject(
      { name: "ZodError" }
    );
    expect(queries).toHaveLength(3);
  });

  it("rejects invalid lease timing before opening a transaction", async () => {
    const { database, transaction } = createDatabase([]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(
      repository.acquireLease(
        acquireInput({ expiresAt: new Date(NOW.getTime() - 1) })
      )
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("拒绝不完整的固定 API 适配版本对且不打开事务", async () => {
    const { database, transaction } = createDatabase([]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(
      repository.acquireLease(
        acquireInput({
          requiredMemberId: "member-required",
          requiredMemberType: "api",
          requiredApiAdapterMemberId: "member-required",
        })
      )
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("拒绝固定适配版本与必选 API 成员归属不一致", async () => {
    const { database, transaction } = createDatabase([]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(
      repository.acquireLease(
        acquireInput({
          requiredMemberId: "member-a",
          requiredMemberType: "api",
          requiredApiAdapterMemberId: "member-b",
          requiredApiAdapterVersionId: "adapter-version-member-b",
        })
      )
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("renews only a live lease owned by the supplied token", async () => {
    const { database, queries } = createDatabase([
      { rows: [leaseRow("owner-current")] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    const result = await repository.renewLease({
      leaseId: "lease-1",
      ownerToken: "owner-current",
      now: NOW,
      expiresAt: EXPIRES_AT,
    });

    expect(result).toMatchObject({ ownerToken: "owner-current" });
    expect(queries[0]?.sql).toContain("owner_token =");
    expect(queries[0]?.sql).toContain("expires_at >");
    expect(queries[0]?.params).toEqual(
      expect.arrayContaining(["lease-1", "owner-current", NOW])
    );
  });

  it("uses compare-and-swap takeover and blocks the previous owner release", async () => {
    const { database, queries } = createDatabase([
      [leaseRow("owner-next")],
      { rows: [] },
    ]);
    const repository = createPostgresBackendPoolRepository(database);

    const takeover = await repository.takeoverLease({
      leaseId: "lease-1",
      memberId: "member-1",
      currentOwnerToken: "owner-current",
      nextOwnerToken: "owner-next",
      now: NOW,
      expiresAt: EXPIRES_AT,
      apiAdapterMemberId: "member-1",
      apiAdapterVersionId: "adapter-version-member-1",
    });
    const staleRelease = await repository.releaseLease({
      leaseId: "lease-1",
      ownerToken: "owner-current",
    });

    expect(takeover).toMatchObject({ ownerToken: "owner-next" });
    expect(staleRelease).toBe(false);
    expect(queries[0]?.sql).toContain("from image_backend_member");
    expect(queries[0]?.sql).toContain("for update");
    expect(queries[0]?.sql).toContain("inflight_count <");
    expect(queries[0]?.sql).toContain("on conflict do nothing");
    expect(queries[0]?.sql).toContain("api_adapter_version_id");
    expect(queries[0]?.params).toEqual(
      expect.arrayContaining([
        "lease-1",
        "member-1",
        "owner-current",
        "owner-next",
        NOW,
      ])
    );
    expect(queries[1]?.params).toEqual(["lease-1", "owner-current"]);
  });

  it("rejects a half-populated API adapter ownership pair before SQL", async () => {
    const { database, transaction } = createDatabase([]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(
      repository.takeoverLease({
        leaseId: "lease-1",
        memberId: "member-1",
        currentOwnerToken: "owner-current",
        nextOwnerToken: "owner-next",
        now: NOW,
        expiresAt: EXPIRES_AT,
        apiAdapterMemberId: "member-1",
        apiAdapterVersionId: null,
      })
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("releases idempotently only for the current owner", async () => {
    const { database } = createDatabase([[{ id: "lease-1" }], []]);
    const repository = createPostgresBackendPoolRepository(database);

    await expect(
      repository.releaseLease({
        leaseId: "lease-1",
        ownerToken: "owner-current",
      })
    ).resolves.toBe(true);
    await expect(
      repository.releaseLease({
        leaseId: "lease-1",
        ownerToken: "owner-current",
      })
    ).resolves.toBe(false);
  });

  it("propagates transaction failures without a local lease fallback", async () => {
    const failure = new Error("database unavailable");
    const database: BackendPoolDatabase = {
      async transaction() {
        throw failure;
      },
    };
    const repository = createPostgresBackendPoolRepository(database);

    await expect(repository.acquireLease(acquireInput())).rejects.toBe(failure);
  });
});
