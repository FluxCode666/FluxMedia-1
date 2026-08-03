/**
 * 图片异步任务 PostgreSQL 仓储的 DB-free SQL 契约测试。
 *
 * 职责：验证幂等创建、定向原子 claim、终态 claim token CAS 和持久行校验，避免
 * 重复 Redis 消息造成重复执行或旧 Worker 覆盖新 Worker 的结果。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  createPostgresImageAsyncTaskRepository,
  type ImageAsyncTaskDatabase,
} from "./image-async-task-repository";

const NOW = new Date("2026-08-04T00:00:00.000Z");

/** 构造一条与生产 SQL 返回列一致的测试任务行。 */
function createRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "task_123",
    user_id: "user-1",
    api_key_id: "key-1",
    plan: "pro",
    operation: "generate",
    generation_inputs: [
      {
        operation: "generate",
        prompt: "test",
        model: "gpt-image-2",
        generationId: "generation-1",
      },
    ],
    generation_ids: ["generation-1"],
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
      work: (transaction: { execute(query: SQL): Promise<unknown> }) => Promise<T>
    ): Promise<T> {
      transactionCalls += 1;
      return work({
        async execute(query: SQL) {
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
      generationInputs: [
        {
          operation: "generate" as const,
          prompt: "test",
          model: "gpt-image-2",
          generationId: "generation-1",
        },
      ],
      responseFormat: "url" as const,
    },
    userId: "user-1",
    apiKeyId: "key-1",
    plan: "pro",
    now: NOW,
  };
}

describe("image async task repository", () => {
  it("在事务中幂等插入任务且只持久化媒体引用 JSON", async () => {
    const { database, queries, getTransactionCalls } = createDatabase([
      [createRow()],
    ]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(repository.create(createInput())).resolves.toMatchObject({
      created: true,
      task: { id: "task_123", status: "queued" },
    });
    expect(getTransactionCalls()).toBe(1);
    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(compiled.sql).toContain("on conflict (id) do nothing");
    expect(compiled.sql).toContain("generation_inputs");
    expect(compiled.params).toContain("task_123");
    expect(
      compiled.params.some(
        (value) =>
          typeof value === "string" &&
          value.includes('"generationId":"generation-1"')
      )
    ).toBe(true);
  });

  it("主键冲突后读取已有任务并标记为幂等命中", async () => {
    const { database, queries } = createDatabase([[], [createRow()]]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(repository.create(createInput())).resolves.toMatchObject({
      created: false,
      task: { id: "task_123" },
    });
    expect(queries).toHaveLength(2);
    const select = new PgDialect().sqlToQuery(queries[1] as SQL);
    expect(select.sql).toContain("where id =");
  });

  it("只 claim 指定 queued 或租约过期任务并递增 attempt", async () => {
    const { database, queries } = createDatabase([
      [
        createRow({
          status: "running",
          attempt_count: 1,
          claim_token: "worker-1",
          claim_expires_at: new Date(NOW.getTime() + 22 * 60_000),
          started_at: NOW,
        }),
      ],
    ]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await repository.claimById({
      taskId: "task_123",
      claimToken: "worker-1",
      now: NOW,
      claimExpiresAt: new Date(NOW.getTime() + 22 * 60_000),
    });
    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(compiled.sql).toContain("attempt_count = attempt_count + 1");
    expect(compiled.sql).toContain("status = 'queued'");
    expect(compiled.sql).toContain("claim_expires_at <=");
    expect(compiled.params).toContain("task_123");
    expect(compiled.params).toContain("worker-1");
  });

  it("完成与失败都以当前 claim token 比较交换终态", async () => {
    const completedRow = createRow({
      status: "completed",
      attempt_count: 1,
      completed_at: NOW,
    });
    const failedRow = createRow({
      status: "failed",
      attempt_count: 1,
      error: "生成失败",
      completed_at: NOW,
    });
    const { database, queries } = createDatabase([
      [completedRow],
      [failedRow],
    ]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(
      repository.complete({
        taskId: "task_123",
        claimToken: "worker-1",
        now: NOW,
      })
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      repository.fail({
        taskId: "task_123",
        claimToken: "worker-1",
        now: NOW,
        error: "生成失败",
      })
    ).resolves.toMatchObject({ status: "failed", error: "生成失败" });

    for (const query of queries) {
      const compiled = new PgDialect().sqlToQuery(query);
      expect(compiled.sql).toContain("and claim_token =");
      expect(compiled.params).toContain("worker-1");
    }
  });

  it("拒绝过期时间不晚于 claim 时间且不访问数据库", async () => {
    const { database, queries } = createDatabase([]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(
      repository.claimById({
        taskId: "task_123",
        claimToken: "worker-1",
        now: NOW,
        claimExpiresAt: NOW,
      })
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(queries).toHaveLength(0);
  });

  it("拒绝 generationIds 与持久输入不一致的数据库脏行", async () => {
    const { database } = createDatabase([
      [createRow({ generation_ids: ["generation-other"] })],
    ]);
    const repository = createPostgresImageAsyncTaskRepository(database);

    await expect(repository.findById("task_123")).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
