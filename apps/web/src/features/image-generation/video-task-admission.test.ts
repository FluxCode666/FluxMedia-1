/**
 * 视频任务创建准入的 DB-free SQL 契约测试。
 *
 * 职责：验证 Principal 事务锁、幂等任务优先和非终态上限口径。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  admitVideoTaskCreation,
  VideoActiveTaskLimitError,
  type VideoTaskAdmissionTransaction,
} from "./video-task-admission";

/** 构造按查询顺序返回行的事务桩。 */
function createTransaction(resultRows: unknown[][]) {
  const queries: SQL[] = [];
  let index = 0;
  const transaction: VideoTaskAdmissionTransaction = {
    async execute(query) {
      queries.push(query);
      const rows = resultRows[index] ?? [];
      index += 1;
      return { rows };
    },
  };
  return { transaction, queries };
}

describe("video task admission", () => {
  it("在统计前获得作用域事务锁并允许低于上限的任务", async () => {
    const { transaction, queries } = createTransaction([
      [],
      [],
      [{ activeCount: 4 }],
    ]);

    await expect(
      admitVideoTaskCreation(transaction, {
        taskId: "video-1",
        principalScope: "external:user-1:key-1",
      })
    ).resolves.toBe("admitted");

    const compiled = queries.map(
      (query) => new PgDialect().sqlToQuery(query).sql
    );
    expect(compiled[0]).toContain("pg_advisory_xact_lock");
    expect(compiled[1]).toContain("where id =");
    expect(compiled[2]).toContain("stage not in ('completed', 'failed')");
  });

  it("并发幂等任务已存在时不受活跃上限影响", async () => {
    const { transaction, queries } = createTransaction([
      [],
      [{ id: "video-1" }],
    ]);

    await expect(
      admitVideoTaskCreation(transaction, {
        taskId: "video-1",
        principalScope: "user:user-1",
        maxActiveTasks: 1,
      })
    ).resolves.toBe("existing");
    expect(queries).toHaveLength(2);
  });

  it("达到上限时拒绝新任务", async () => {
    const { transaction } = createTransaction([[], [], [{ activeCount: "5" }]]);

    await expect(
      admitVideoTaskCreation(transaction, {
        taskId: "video-2",
        principalScope: "user:user-1",
      })
    ).rejects.toBeInstanceOf(VideoActiveTaskLimitError);
  });
});
