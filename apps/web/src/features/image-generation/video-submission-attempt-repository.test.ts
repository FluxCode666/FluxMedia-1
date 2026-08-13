/**
 * API 视频提交尝试账本仓储测试。
 *
 * 职责：验证外呼前的原子预留 SQL 固定账号重试快照、阻止超过上限，并且只返回
 * 一条可执行尝试；真实唯一约束并发由 PostgreSQL 集成测试覆盖。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  createPostgresVideoSubmissionAttemptRepository,
  type VideoSubmissionAttemptDatabase,
} from "./video-submission-attempt-repository";

describe("video submission attempt repository", () => {
  it("预留 SQL 在数据库中计算账号内和全局序号并限制最大请求次数", async () => {
    const executedQueries: SQL[] = [];
    const execute = vi.fn(async (query: SQL) => {
      executedQueries.push(query);
      return {
        rows: [
          {
            id: "attempt-1",
            video_generation_id: "video-1",
            backend_member_id: "member-1",
            member_attempt_number: 3,
            global_attempt_number: 4,
            request_id: "request-1",
            retry_count_snapshot: 2,
            max_attempts_snapshot: 3,
            supplier_name_snapshot: "供应商 A",
            api_adapter_member_id: "member-1",
            api_adapter_version_id: "adapter-1",
            created_at: new Date("2026-08-13T00:00:00.000Z"),
          },
        ],
      };
    });
    const database: VideoSubmissionAttemptDatabase = {
      transaction: async (work) => work({ execute }),
    };
    const repository = createPostgresVideoSubmissionAttemptRepository(database);

    const result = await repository.reserveNext({
      attemptId: "attempt-1",
      videoGenerationId: "video-1",
      backendMemberId: "member-1",
      requestId: "request-1",
      videoSubmissionRetryCount: 2,
      supplierNameSnapshot: "供应商 A",
      apiAdapterMemberId: "member-1",
      apiAdapterVersionId: "adapter-1",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      memberAttemptNumber: 3,
      globalAttemptNumber: 4,
      retryCountSnapshot: 2,
      maxAttemptsSnapshot: 3,
    });
    const query = executedQueries[0];
    if (!query) throw new Error("尝试预留未执行 SQL");
    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("for update");
    expect(compiled.sql).toContain("member_attempt_number");
    expect(compiled.sql).toContain("max_attempts_snapshot");
    expect(compiled.sql).toContain("on conflict do nothing");
  });

  it("数据库未返回预留行时明确拒绝外呼", async () => {
    const repository = createPostgresVideoSubmissionAttemptRepository({
      transaction: async (work) =>
        work({ execute: async () => ({ rows: [] }) }),
    });

    await expect(
      repository.reserveNext({
        attemptId: "attempt-4",
        videoGenerationId: "video-1",
        backendMemberId: "member-1",
        requestId: "request-4",
        videoSubmissionRetryCount: 2,
        supplierNameSnapshot: "供应商 A",
        apiAdapterMemberId: "member-1",
        apiAdapterVersionId: "adapter-1",
        now: new Date(),
      })
    ).resolves.toBeNull();
  });
});
