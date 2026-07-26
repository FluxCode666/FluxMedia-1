/**
 * 视频任务创建准入的 DB-free SQL 契约测试。
 *
 * 职责：验证用户事务锁、幂等任务优先，以及 Principal/用户双层非终态上限。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  admitVideoTaskCreation,
  checkVideoTaskCapacity,
  reserveVideoTaskStaging,
  VideoActiveTaskLimitError,
  type VideoTaskAdmissionDatabase,
  type VideoTaskAdmissionTransaction,
  VideoTaskStagingInProgressError,
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

/** 构造只记录一次事务的 staging reservation 数据库桩。 */
function createDatabase(resultRows: unknown[][]) {
  const { transaction, queries } = createTransaction(resultRows);
  const database: VideoTaskAdmissionDatabase = {
    async transaction(work) {
      return work(transaction);
    },
  };
  return { database, queries };
}

describe("video task admission", () => {
  it("在统计前获得作用域事务锁并允许低于上限的任务", async () => {
    const { transaction, queries } = createTransaction([
      [],
      [],
      [{ principalActiveCount: 4, userActiveCount: 4 }],
    ]);

    await expect(
      admitVideoTaskCreation(transaction, {
        taskId: "video-1",
        userId: "user-1",
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
        userId: "user-1",
        principalScope: "user:user-1",
        maxPrincipalActiveTasks: 1,
        maxUserActiveTasks: 1,
      })
    ).resolves.toBe("existing");
    expect(queries).toHaveLength(2);
  });

  it("达到 Principal 上限时拒绝新任务", async () => {
    const { transaction } = createTransaction([
      [],
      [],
      [{ principalActiveCount: "5", userActiveCount: "5" }],
    ]);

    await expect(
      admitVideoTaskCreation(transaction, {
        taskId: "video-2",
        userId: "user-1",
        principalScope: "user:user-1",
      })
    ).rejects.toMatchObject({
      limitKind: "principal",
      maxActiveTasks: 5,
    });
  });

  it("不同 API Key 合计达到用户上限时拒绝新任务", async () => {
    const { transaction } = createTransaction([
      [],
      [],
      [{ principalActiveCount: "1", userActiveCount: "10" }],
    ]);

    await expect(
      admitVideoTaskCreation(transaction, {
        taskId: "video-2",
        userId: "user-1",
        principalScope: "external:user-1:key-2",
      })
    ).rejects.toMatchObject({
      limitKind: "user",
      maxActiveTasks: 10,
    });
  });

  it("廉价预检不加事务锁且使用相同双层计数", async () => {
    const { transaction, queries } = createTransaction([
      [],
      [{ principalActiveCount: 0, userActiveCount: 10 }],
    ]);

    await expect(
      checkVideoTaskCapacity(transaction, {
        taskId: "video-3",
        userId: "user-1",
        principalScope: "external:user-1:key-3",
      })
    ).rejects.toBeInstanceOf(VideoActiveTaskLimitError);

    const compiled = queries.map(
      (query) => new PgDialect().sqlToQuery(query).sql
    );
    expect(compiled).toHaveLength(2);
    expect(compiled.every((query) => !query.includes("pg_advisory"))).toBe(
      true
    );
  });

  it("在上传前持久预留用户级 staging 槽位", async () => {
    const { database, queries } = createDatabase([
      [],
      [],
      [],
      [],
      [{ principalActiveCount: 0, userActiveCount: 0 }],
      [{ taskId: "video-1" }],
    ]);
    const now = new Date("2026-07-26T00:00:00.000Z");

    await expect(
      reserveVideoTaskStaging(
        database,
        {
          taskId: "video-1",
          userId: "user-1",
          principalScope: "external:user-1:key-1",
        },
        {
          now,
          expiresAt: new Date(now.getTime() + 60_000),
          reservationToken: "reservation-1",
        }
      )
    ).resolves.toEqual({
      status: "reserved",
      reservationToken: "reservation-1",
    });
    expect(queries).toHaveLength(6);
    expect(new PgDialect().sqlToQuery(queries[4] as SQL).sql).toContain(
      "video_task_staging_reservation"
    );
  });

  it("已有 staging reservation 时拒绝重复上传", async () => {
    const { database } = createDatabase([[], [], [], [{ taskId: "video-1" }]]);
    const now = new Date("2026-07-26T00:00:00.000Z");

    await expect(
      reserveVideoTaskStaging(
        database,
        {
          taskId: "video-1",
          userId: "user-1",
          principalScope: "external:user-1:key-1",
        },
        {
          now,
          expiresAt: new Date(now.getTime() + 60_000),
          reservationToken: "reservation-2",
        }
      )
    ).rejects.toBeInstanceOf(VideoTaskStagingInProgressError);
  });
});
