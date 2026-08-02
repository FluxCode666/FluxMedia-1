/**
 * 视频输入持久清理队列的 DB-free SQL 契约测试。
 *
 * 职责：验证稳定去重登记、原子 claim、成功删除事实和失败退避均受 claim token 保护。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  createPostgresVideoInputCleanupRepository,
  type VideoInputCleanupDatabase,
} from "./video-input-cleanup-queue";

/** 构造按调用顺序返回行的 SQL 端口。 */
function createDatabase(resultRows: unknown[][]) {
  const queries: SQL[] = [];
  let index = 0;
  const database: VideoInputCleanupDatabase = {
    async execute(query) {
      queries.push(query);
      const rows = resultRows[index] ?? [];
      index += 1;
      return { rows };
    },
  };
  return { database, queries };
}

describe("video input cleanup queue", () => {
  it("相同对象只登记一个稳定队列身份", async () => {
    const { database, queries } = createDatabase([[]]);
    const repository = createPostgresVideoInputCleanupRepository(database);
    const object = {
      reason: "orphan" as const,
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
      storageBucket: "b",
    };

    await expect(repository.enqueue([object, object])).resolves.toBe(1);
    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL);
    expect(compiled.sql).toContain("on conflict (id) do update");
    expect(compiled.params[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("用 skip locked 原子认领到期对象", async () => {
    const now = new Date("2026-07-26T00:00:00.000Z");
    const { database, queries } = createDatabase([
      [],
      [
        {
          id: "a".repeat(64),
          reason: "lifecycle_delete",
          userId: "user-1",
          videoId: "video-1",
          attemptId: "reservation-1",
          storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
          storageBucket: "uploads",
          attemptCount: "2",
          claimToken: "worker-1",
        },
      ],
    ]);
    const repository = createPostgresVideoInputCleanupRepository(database);

    await expect(
      repository.claimNext({
        claimToken: "worker-1",
        now,
        claimExpiresAt: new Date(now.getTime() + 60_000),
      })
    ).resolves.toMatchObject({ attemptCount: 2, claimToken: "worker-1" });
    const compiled = queries.map(
      (query) => new PgDialect().sqlToQuery(query).sql
    );
    expect(compiled[0]).toContain("delete from video_task_staging_reservation");
    expect(compiled[0]).toContain("for update skip locked");
    expect(compiled[1]).toContain("for update skip locked");
    expect(compiled[1]).toContain("claim_expires_at");
    expect(compiled[1]).toContain("reservation.reservation_token =");
    expect(compiled[1]).toContain("video_input_cleanup.reason = 'orphan'");
    expect(compiled[1]).toContain(
      "video_input_cleanup.reason = 'lifecycle_delete'"
    );
    expect(compiled[1]).toContain("task.stage in ('completed', 'failed')");
    expect(compiled[1]).toContain("account.banned_reason = 'account_deleted'");
  });

  it("完成和失败退避都限定当前 claim token", async () => {
    const now = new Date("2026-07-26T00:00:00.000Z");
    const claimed = {
      id: "b".repeat(64),
      reason: "orphan" as const,
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
      storageBucket: "uploads",
      attemptCount: 0,
      claimToken: "worker-1",
    };
    const { database, queries } = createDatabase([
      [{ id: claimed.id }],
      [{ id: claimed.id }],
    ]);
    const repository = createPostgresVideoInputCleanupRepository(database);

    await repository.complete({ id: claimed.id, claimToken: "worker-1" });
    await repository.retry({ claimed, error: new Error("offline"), now });

    const compiled = queries.map(
      (query) => new PgDialect().sqlToQuery(query).sql
    );
    expect(compiled[0]).toContain("claim_token =");
    expect(compiled[1]).toContain("next_attempt_at =");
    expect(compiled[1]).toContain("claim_token = null");
  });

  it("任务事务采用对象时完成 orphan 意图", async () => {
    const object = {
      reason: "orphan" as const,
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
      storageBucket: "uploads",
    };
    const { database, queries } = createDatabase([[{ id: "d".repeat(64) }]]);
    const repository = createPostgresVideoInputCleanupRepository(database);

    await repository.adoptOrphans([object]);

    const compiled = new PgDialect().sqlToQuery(queries[0] as SQL).sql;
    expect(compiled).toContain("delete from video_input_cleanup");
    expect(compiled).toContain("reason = 'orphan'");
    expect(compiled).toContain("claim_token is null");
  });

  it("清理对象数量沿用共享 256 上限", async () => {
    const createObject = (index: number) => ({
      reason: "orphan" as const,
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      storageKey: `user-1/video-inputs/video-1/reservation-1/${index}.png`,
      storageBucket: "uploads",
    });
    const { database } = createDatabase(Array.from({ length: 256 }, () => []));
    const repository = createPostgresVideoInputCleanupRepository(database);

    await expect(
      repository.enqueue(
        Array.from({ length: 256 }, (_, index) => createObject(index))
      )
    ).resolves.toBe(256);
    await expect(
      repository.enqueue(
        Array.from({ length: 257 }, (_, index) => createObject(index))
      )
    ).rejects.toThrow();
  });
});
