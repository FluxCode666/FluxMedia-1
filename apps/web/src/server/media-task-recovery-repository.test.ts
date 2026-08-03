/**
 * Redis 媒体任务补偿扫描的 DB-free SQL 契约测试。
 *
 * 职责：验证扫描只读、不 claim，图片携带 attempt 投递版本，视频复用统一延迟策略。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  createPostgresMediaTaskRecoveryRepository,
  type MediaTaskRecoveryDatabase,
} from "./media-task-recovery-repository";

const NOW = new Date("2026-08-04T00:00:00.000Z");

/** 构造按图片、视频顺序返回结果并记录 SQL 的数据库桩。 */
function createDatabase(results: unknown[][]) {
  const queries: SQL[] = [];
  let index = 0;
  const database: MediaTaskRecoveryDatabase = {
    async execute(query) {
      queries.push(query);
      return { rows: results[index++] ?? [] };
    },
  };
  return { database, queries };
}

describe("media task recovery repository", () => {
  it("扫描图片 attempt 版本与到期视频状态，但不执行 claim update", async () => {
    const { database, queries } = createDatabase([
      [{ id: "task_123", attempt_count: 5 }],
      [
        {
          id: "video-1",
          stage: "polling",
          state_version: 7,
          next_poll_at: NOW,
          claim_expires_at: null,
          submit_started_at: null,
          updated_at: NOW,
        },
      ],
    ]);
    const repository = createPostgresMediaTaskRecoveryRepository(database);

    await expect(repository.scan({ now: NOW, limit: 100 })).resolves.toEqual({
      images: [{ taskId: "task_123", deliveryVersion: 5 }],
      videos: [{ taskId: "video-1", stateVersion: 7, runAt: NOW }],
    });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      const compiled = new PgDialect().sqlToQuery(query);
      expect(compiled.sql).toMatch(/^\s*select/);
      expect(compiled.sql).not.toContain("for update");
      expect(compiled.sql).not.toContain("claim_token =");
    }
  });

  it("图片扫描覆盖 queued 与过期 running，视频排除终态", async () => {
    const { database, queries } = createDatabase([[], []]);
    const repository = createPostgresMediaTaskRecoveryRepository(database);

    await repository.scan({ now: NOW, limit: 25 });
    const imageSql = new PgDialect().sqlToQuery(queries[0] as SQL).sql;
    const videoSql = new PgDialect().sqlToQuery(queries[1] as SQL).sql;
    expect(imageSql).toContain("status = 'queued'");
    expect(imageSql).toContain("status = 'running'");
    expect(imageSql).toContain("claim_expires_at <=");
    expect(videoSql).toContain("'submit_uncertain'");
    expect(videoSql).toContain("next_poll_at <=");
  });
});
