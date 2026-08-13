/**
 * 视频公开四态投影测试。
 *
 * 覆盖内部执行阶段、持久粗状态和升级前遗留人工态，保证所有视频消费者只能取得
 * queued、in_progress、completed、failed；图片历史状态不由本模块处理。
 */

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildVideoPublicStatusPredicate,
  buildVideoPublicStatusSql,
  toLegacyVideoPublicStatus,
  toVideoPublicStatus,
  videoPublicStatusSchema,
} from "./video-public-status";

describe("video public status", () => {
  it.each([
    ["pending", "created", "queued"],
    ["running", "charged", "queued"],
    ["running", "submitting", "in_progress"],
    ["running", "polling", "in_progress"],
    ["running", "downloading", "in_progress"],
    ["running", "refunding", "failed"],
    ["completed", "completed", "completed"],
    ["failed", "failed", "failed"],
  ])("把 %s/%s 投影为 %s", (status, stage, expected) => {
    expect(toVideoPublicStatus(status, stage)).toBe(expected);
  });

  it("只接受 OpenAI 视频四态", () => {
    for (const status of ["queued", "in_progress", "completed", "failed"]) {
      expect(videoPublicStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const status of [
      "pending",
      "submitting",
      "processing",
      "needs_attention",
    ]) {
      expect(videoPublicStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it("迁移窗口内不公开遗留人工态", () => {
    expect(toLegacyVideoPublicStatus("running", "submit_uncertain")).toBe(
      "in_progress"
    );
    expect(toLegacyVideoPublicStatus("needs_attention")).toBe("in_progress");
  });

  it("SQL 投影和筛选只使用公开四态", () => {
    const dialect = new PgDialect();
    const projection = dialect.sqlToQuery(
      buildVideoPublicStatusSql(sql`v.status`, sql`v.stage`)
    );
    const filter = dialect.sqlToQuery(
      buildVideoPublicStatusPredicate(
        "in_progress",
        sql`v.status`,
        sql`v.stage`
      )
    );

    expect(projection.sql).toContain("then 'queued'");
    expect(projection.sql).toContain("else 'in_progress'");
    expect(projection.sql).not.toContain("needs_attention");
    expect(filter.params).toEqual(["in_progress"]);
  });
});
