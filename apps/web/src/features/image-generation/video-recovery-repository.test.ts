/**
 * 视频恢复 claim 仓储的 DB-free SQL 契约测试。
 *
 * 职责：验证生产仓储只认领一条任务、覆盖全部可恢复阶段并拒绝无效 claim 时序。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  createPostgresVideoRecoveryRepository,
  type VideoRecoveryDatabase,
} from "./video-recovery-repository";

const NOW = new Date("2026-07-26T00:00:00.000Z");

/** 构造记录生产 SQL 的可注入数据库桩。 */
function createDatabase(rows: unknown[]) {
  const queries: SQL[] = [];
  let transactionCalls = 0;
  const database: VideoRecoveryDatabase = {
    async transaction<T>(
      work: (transaction: {
        execute(query: SQL): Promise<unknown>;
      }) => Promise<T>
    ): Promise<T> {
      transactionCalls += 1;
      return work({
        async execute(query) {
          queries.push(query);
          return { rows };
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

describe("video recovery repository", () => {
  it("用生产 SQL 即时认领一条完整恢复阶段任务", async () => {
    const { database, queries } = createDatabase([{ id: "video-1" }]);
    const repository = createPostgresVideoRecoveryRepository(database);

    await expect(
      repository.claimNext({
        claimToken: "worker-1",
        now: NOW,
        claimExpiresAt: new Date(NOW.getTime() + 21 * 60_000),
      })
    ).resolves.toEqual({ id: "video-1", claimToken: "worker-1" });

    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(compiled.sql).toContain("limit 1");
    expect(compiled.sql).toContain("for update skip locked");
    expect(compiled.sql).toContain("'charged'");
    expect(compiled.sql).toContain("'submitting'");
    expect(compiled.sql).not.toContain("'submit_uncertain'");
    expect(compiled.sql).toContain("'polling'");
    expect(compiled.sql).toContain("'downloading'");
    expect(compiled.sql).toContain("'refunding'");
    expect(compiled.sql).toContain("state_version = state_version + 1");
    expect(compiled.sql).toContain("submit_started_at");
  });

  it("没有到期任务时返回 null", async () => {
    const { database } = createDatabase([]);
    const repository = createPostgresVideoRecoveryRepository(database);

    await expect(
      repository.claimNext({
        claimToken: "worker-1",
        now: NOW,
        claimExpiresAt: new Date(NOW.getTime() + 21 * 60_000),
      })
    ).resolves.toBeNull();
  });

  it("claim 到期时间无效时不打开事务", async () => {
    const { database, getTransactionCalls } = createDatabase([]);
    const repository = createPostgresVideoRecoveryRepository(database);

    await expect(
      repository.claimNext({
        claimToken: "worker-1",
        now: NOW,
        claimExpiresAt: NOW,
      })
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(getTransactionCalls()).toBe(0);
  });
});
