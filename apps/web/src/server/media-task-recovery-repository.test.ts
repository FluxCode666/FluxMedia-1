/**
 * Redis 媒体任务补偿扫描的 DB-free SQL 契约测试。
 *
 * 职责：验证四类图片 due 独立扫描、补投携带持久 priority，视频复用延迟策略。
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
  it("分别返回图片补投、续期、终态释放和到期视频", async () => {
    const { database, queries } = createDatabase([
      [
        {
          id: "task_mq",
          mq_delivery_version: 5,
          mq_delivery_due_at: NOW,
          claim_recovery_due_at: null,
          group_priority_snapshot: 7,
        },
      ],
      [
        {
          id: "task_claim",
          mq_delivery_version: 6,
          mq_delivery_due_at: null,
          claim_recovery_due_at: NOW,
          group_priority_snapshot: 2,
        },
      ],
      [
        {
          id: "task_admission",
          user_id: "user-1",
          effective_user_concurrency: 20,
          admission_lease_token: "admission-1",
          admission_lease_expires_at: NOW,
          admission_renewal_due_at: NOW,
        },
      ],
      [
        {
          id: "task_terminal",
          user_id: "user-1",
          admission_lease_token: "admission-2",
          admission_lease_expires_at: NOW,
        },
      ],
      [
        {
          id: "video-1",
          stage: "polling",
          state_version: 7,
          next_poll_at: NOW,
          claim_expires_at: null,
          submit_started_at: null,
          refund_exhausted_at: null,
          updated_at: NOW,
        },
      ],
    ]);
    const repository = createPostgresMediaTaskRecoveryRepository(database);

    await expect(repository.scan({ now: NOW, limit: 100 })).resolves.toEqual({
      images: [
        {
          taskId: "task_mq",
          deliveryVersion: 5,
          dueAt: NOW,
          priority: 8,
          recoveryKind: "mq",
        },
        {
          taskId: "task_claim",
          deliveryVersion: 6,
          dueAt: NOW,
          priority: 3,
          recoveryKind: "claim",
        },
      ],
      imageAdmissions: [
        {
          taskId: "task_admission",
          userId: "user-1",
          effectiveUserConcurrency: 20,
          token: "admission-1",
          expiresAt: NOW,
          renewalDueAt: NOW,
        },
      ],
      imageTerminalReleases: [
        {
          taskId: "task_terminal",
          userId: "user-1",
          token: "admission-2",
          expiresAt: NOW,
        },
      ],
      videos: [{ taskId: "video-1", stateVersion: 7, runAt: NOW }],
    });
    expect(queries).toHaveLength(5);
    for (const query of queries) {
      const compiled = new PgDialect().sqlToQuery(query);
      expect(compiled.sql).toMatch(/^\s*select/);
      expect(compiled.sql).not.toContain("for update");
      expect(compiled.sql).not.toContain("claim_token =");
    }
  });

  it("图片四类 due 使用独立游标和排序，视频排除终态", async () => {
    const { database, queries } = createDatabase([[], [], [], [], []]);
    const repository = createPostgresMediaTaskRecoveryRepository(database);

    await repository.scan({ now: NOW, limit: 25 });
    const mqSql = new PgDialect().sqlToQuery(queries[0] as SQL).sql;
    const claimSql = new PgDialect().sqlToQuery(queries[1] as SQL).sql;
    const admissionSql = new PgDialect().sqlToQuery(queries[2] as SQL).sql;
    const terminalSql = new PgDialect().sqlToQuery(queries[3] as SQL).sql;
    const videoSql = new PgDialect().sqlToQuery(queries[4] as SQL).sql;
    expect(mqSql).toContain("mq_delivery_due_at <=");
    expect(mqSql).toContain("order by mq_delivery_due_at, id");
    expect(claimSql).toContain("claim_recovery_due_at <=");
    expect(claimSql).toContain("mq_delivery_due_at is null");
    expect(admissionSql).toContain("admission_renewal_due_at <=");
    expect(terminalSql).toContain("terminal_release_due_at <=");
    expect(terminalSql).toContain("admission_lease_released_at is null");
    expect(videoSql).toContain("'submit_uncertain'");
    expect(videoSql).toContain("metadata->>'videoBackendProtocol'");
    expect(new PgDialect().sqlToQuery(queries[4] as SQL).params).toContain(
      "api"
    );
    expect(videoSql).toContain("'retrying'");
    expect(videoSql).toContain("next_poll_at <=");
    expect(videoSql).toContain("refund_exhausted_at is null");
  });
});
