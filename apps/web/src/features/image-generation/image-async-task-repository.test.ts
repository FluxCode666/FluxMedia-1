/**
 * 图片异步任务 PostgreSQL 仓储的 DB-free SQL 契约测试。
 *
 * 职责：验证单项权威字段、Phase A 旧列双写、generation 唯一冲突、claim 与
 * admission fencing、终态 release ack，防止重复消息产生重复副作用或泄漏用户槽。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  createImageAsyncTaskInputDigest,
  createPostgresImageAsyncTaskRepository,
  type ImageAsyncTaskDatabase,
} from "./image-async-task-repository";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const LEASE_EXPIRES_AT = new Date(NOW.getTime() + 22 * 60_000);
const RENEWAL_DUE_AT = new Date(NOW.getTime() + 11 * 60_000);
const GENERATION_INPUT = {
  operation: "generate" as const,
  prompt: "test",
  model: "gpt-image-2",
  generationId: "generation-1",
};
const INPUT_DIGEST = createImageAsyncTaskInputDigest(GENERATION_INPUT);

/** 构造一条与生产 SQL 返回列一致的单项测试任务行。 */
function createRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "task_123",
    user_id: "user-1",
    api_key_id: "key-1",
    plan: "pro",
    operation: "generate",
    generation_inputs: [GENERATION_INPUT],
    generation_ids: ["generation-1"],
    generation_input: GENERATION_INPUT,
    input_digest: INPUT_DIGEST,
    generation_id: "generation-1",
    effective_user_concurrency: 20,
    group_id_snapshot: "group-1",
    group_priority_snapshot: 7,
    admission_lease_token: "admission-1",
    admission_lease_expires_at: LEASE_EXPIRES_AT,
    admission_lease_released_at: null,
    mq_delivery_due_at: NOW,
    claim_recovery_due_at: null,
    admission_renewal_due_at: RENEWAL_DUE_AT,
    terminal_release_due_at: null,
    response_format: "url",
    callback_url: null,
    status: "queued",
    attempt_count: 0,
    claim_token: null,
    claim_expires_at: null,
    error: null,
    created_at: NOW,
    started_at: null,
    completed_at: null,
    updated_at: NOW,
    ...overrides,
  };
}

/** 构造按调用顺序返回 SQL 行的可注入数据库桩。 */
function createDatabase(resultRows: unknown[][]) {
  const queries: SQL[] = [];
  let resultIndex = 0;
  let transactionCalls = 0;
  const database: ImageAsyncTaskDatabase = {
    async execute(query) {
      queries.push(query);
      return { rows: resultRows[resultIndex++] ?? [] };
    },
    async transaction<T>(
      work: (transaction: {
        execute(query: SQL): Promise<unknown>;
      }) => Promise<T>
    ): Promise<T> {
      transactionCalls += 1;
      return work({
        async execute(query) {
          queries.push(query);
          return { rows: resultRows[resultIndex++] ?? [] };
        },
      });
    },
  };
  return {
    database,
    queries,
    getTransactionCalls: () => transactionCalls,
  };
}

/** 创建一个最小合法仓储创建输入。 */
function createInput() {
  return {
    task: {
      taskId: "task_123",
      generationInput: GENERATION_INPUT,
      responseFormat: "url" as const,
    },
    userId: "user-1",
    apiKeyId: "key-1",
    legacyPlan: "pro",
    effectiveUserConcurrency: 20,
    groupIdSnapshot: "group-1",
    groupPrioritySnapshot: 7,
    admissionLeaseToken: "admission-1",
    admissionLeaseExpiresAt: LEASE_EXPIRES_AT,
    admissionRenewalDueAt: RENEWAL_DUE_AT,
    now: NOW,
  };
}

describe("image async task repository", () => {
  it("事务插入单项权威字段并双写长度为一的兼容数组", async () => {
    const { database, queries, getTransactionCalls } = createDatabase([
      [createRow()],
    ]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(repository.create(createInput())).resolves.toMatchObject({
      created: true,
      task: {
        id: "task_123",
        generationId: "generation-1",
        inputDigest: INPUT_DIGEST,
      },
    });
    expect(getTransactionCalls()).toBe(1);
    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(compiled.sql).toContain("on conflict do nothing");
    expect(compiled.sql).toContain("generation_input");
    expect(compiled.sql).toContain("generation_inputs");
    expect(compiled.params).toContain(INPUT_DIGEST);
    const serializedInputs = compiled.params.filter(
      (value): value is string =>
        typeof value === "string" && value.includes('"generationId"')
    );
    const persistedJson: unknown[] = serializedInputs.map(
      (value) => JSON.parse(value) as unknown
    );
    expect(persistedJson).toContainEqual(GENERATION_INPUT);
    expect(persistedJson).toContainEqual([GENERATION_INPUT]);
  });

  it("task 或 generation 唯一冲突后读取现有任务", async () => {
    const { database, queries } = createDatabase([[], [createRow()]]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(repository.create(createInput())).resolves.toMatchObject({
      created: false,
      task: { id: "task_123" },
    });
    const select = new PgDialect().sqlToQuery(queries[1] as SQL);
    expect(select.sql).toContain("where id =");
    expect(select.sql).toContain("or generation_id =");
  });

  it("输入摘要对对象属性顺序稳定且使用 SHA-256", () => {
    const reordered = {
      generationId: "generation-1",
      model: "gpt-image-2",
      prompt: "test",
      operation: "generate" as const,
    };
    expect(createImageAsyncTaskInputDigest(reordered)).toBe(INPUT_DIGEST);
    expect(INPUT_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("claim 与 heartbeat 都以 token CAS 并同步维护恢复 due", async () => {
    const runningRow = createRow({
      status: "running",
      attempt_count: 1,
      claim_token: "worker-1",
      claim_expires_at: LEASE_EXPIRES_AT,
      claim_recovery_due_at: LEASE_EXPIRES_AT,
      mq_delivery_due_at: null,
      started_at: NOW,
    });
    const { database, queries } = createDatabase([[runningRow], [runningRow]]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await repository.claimById({
      taskId: "task_123",
      claimToken: "worker-1",
      now: NOW,
      claimExpiresAt: LEASE_EXPIRES_AT,
    });
    await repository.heartbeatClaim({
      taskId: "task_123",
      claimToken: "worker-1",
      admissionLeaseToken: "admission-1",
      now: NOW,
      claimExpiresAt: LEASE_EXPIRES_AT,
      admissionLeaseExpiresAt: LEASE_EXPIRES_AT,
      admissionRenewalDueAt: RENEWAL_DUE_AT,
    });

    const claim = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(claim.sql).toContain("attempt_count = attempt_count + 1");
    expect(claim.sql).toContain("claim_recovery_due_at =");
    expect(claim.sql).toContain("claim_expires_at <=");
    const heartbeat = new PgDialect().sqlToQuery(queries[1] as SQL);
    expect(heartbeat.sql).toContain("and claim_token =");
    expect(heartbeat.sql).toContain("and admission_lease_token =");
    expect(heartbeat.sql).toContain("admission_renewal_due_at =");
  });

  it("终态 CAS 保留 admission token 并在 Redis 释放后单独 ack", async () => {
    const completedRow = createRow({
      status: "completed",
      attempt_count: 1,
      admission_renewal_due_at: null,
      terminal_release_due_at: NOW,
      completed_at: NOW,
    });
    const releasedRow = createRow({
      ...completedRow,
      admission_lease_released_at: NOW,
      terminal_release_due_at: null,
    });
    const { database, queries } = createDatabase([
      [completedRow],
      [releasedRow],
    ]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(
      repository.complete({
        taskId: "task_123",
        claimToken: "worker-1",
        now: NOW,
      })
    ).resolves.toMatchObject({
      status: "completed",
      admissionLeaseToken: "admission-1",
      terminalReleaseDueAt: NOW,
    });
    await expect(
      repository.markAdmissionReleased({
        taskId: "task_123",
        admissionLeaseToken: "admission-1",
        now: NOW,
      })
    ).resolves.toMatchObject({ admissionLeaseReleasedAt: NOW });

    const complete = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(complete.sql).not.toContain("admission_lease_token = null");
    expect(complete.sql).toContain("terminal_release_due_at =");
    const ack = new PgDialect().sqlToQuery(queries[1] as SQL);
    expect(ack.sql).toContain("admission_lease_released_at =");
    expect(ack.sql).toContain("terminal_release_due_at = null");
  });

  it("拒绝兼容数组与单项权威字段不一致的数据库脏行", async () => {
    const { database } = createDatabase([
      [createRow({ generation_ids: ["generation-other"] })],
    ]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(repository.findById("task_123")).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
