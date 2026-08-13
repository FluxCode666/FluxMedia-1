/**
 * 统一生成历史 SQL 构造器测试。
 *
 * 不连接数据库，编译 Drizzle SQL 并映射受控夹具，证明图片/视频分支有界、筛选
 * 参数化、双向 keyset 使用原始主键列，视频详情不从 model 反推独立参数。
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@repo/database", () => ({ db: { execute } }));

import {
  buildHistoryListSql,
  buildHistoryModelOptionsSql,
  databaseHistoryRepository,
} from "./history-repository";

const baseQuery = {
  userId: "user-1",
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-23T00:00:00.000Z"),
  asOf: new Date("2026-07-22T12:00:00.000Z"),
  model: "gpt-image-2",
  status: "completed" as const,
  type: null,
  cursor: null,
  branchLimit: 21,
};

describe("history repository SQL", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    execute.mockReset();
    process.env.BETTER_AUTH_SECRET = "history-repository-test-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it("maps persisted video parameters, audio and named input summary", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          record_kind: "video",
          id: "video-1",
          prompt: "video prompt",
          model: "seedance2",
          status: "completed",
          credits_consumed: 20,
          error: null,
          created_at: "2026-07-22T12:00:00.000Z",
          completed_at: "2026-07-22T12:01:00.000Z",
          metadata: null,
          revised_prompt: null,
          size: null,
          storage_key: "user-1/videos/video-1.mp4",
          storage_bucket: "runtime-generations",
          resolution: "1080p",
          duration_seconds: 8,
          aspect_ratio: "16x9",
          generate_audio: true,
          input_manifest: {
            referenceImages: [
              {
                source: "storage",
                mimeType: "image/png",
                storageKey:
                  "user-1/video-inputs/video-1/reservation-1/reference-0.png",
                storageBucket: "uploads",
                byteLength: 12,
              },
            ],
          },
        },
      ],
    });

    await expect(
      databaseHistoryRepository.readRecords(baseQuery)
    ).resolves.toEqual([
      expect.objectContaining({
        model: "seedance2",
        duration: 8,
        aspectRatio: "16x9",
        resolution: "1080p",
        generateAudio: true,
        input: { mode: "references", count: 1 },
        videoUrl: expect.stringMatching(
          /^\/api\/storage\/runtime-generations\/user-1\/videos\/video-1\.mp4\?sig=/
        ),
      }),
    ]);
  });

  it("builds one bounded parameterized image/video union", () => {
    const compiled = new PgDialect().sqlToQuery(buildHistoryListSql(baseQuery));

    expect(compiled.sql).toContain("with image_rows as");
    expect(compiled.sql).toContain("video_rows as");
    expect(compiled.sql).toContain("union all");
    expect(compiled.sql).toContain("order by g.created_at desc, g.id desc");
    expect(compiled.sql).toContain("order by v.created_at desc, v.id desc");
    expect(compiled.params).toContain("user-1");
    expect(compiled.params).toContain("gpt-image-2");
    expect(compiled.params.filter((value) => value === 21)).toHaveLength(3);
    expect(compiled.sql).not.toContain("sql.raw");
    expect(compiled.sql).toContain("jsonb_build_object");
    expect(compiled.sql).toContain("'settledResolution'");
    expect(compiled.sql).toContain("'inputImages'");
    expect(compiled.sql).toContain("null::jsonb as metadata");
    expect(compiled.sql).toContain("v.input_manifest");
    expect(compiled.sql).toContain("v.storage_bucket::text as storage_bucket");
    expect(compiled.sql).toContain("generateAudio");
    expect(compiled.sql).not.toContain("v.family");
    expect(compiled.sql).not.toContain("g.metadata,");
    expect(compiled.sql).not.toContain("v.metadata,");
    expect(compiled.sql).not.toContain("webConversation");
    expect(compiled.sql).toContain("v.stage in ('created', 'charged')");
    expect(compiled.sql).toContain("else 'in_progress'");
  });

  it("按视频四态筛选 stage 且不改变图片 processing 谓词", () => {
    const queued = new PgDialect().sqlToQuery(
      buildHistoryListSql({ ...baseQuery, status: "queued", type: null })
    );
    const inProgress = new PgDialect().sqlToQuery(
      buildHistoryListSql({
        ...baseQuery,
        status: "in_progress",
        type: "video",
      })
    );
    const imageProcessing = new PgDialect().sqlToQuery(
      buildHistoryListSql({
        ...baseQuery,
        status: "processing",
        type: "image",
      })
    );
    const videoProcessing = new PgDialect().sqlToQuery(
      buildHistoryListSql({
        ...baseQuery,
        status: "processing",
        type: "video",
      })
    );

    expect(queued.sql).toContain("v.stage in ('created', 'charged')");
    expect(inProgress.sql).toContain("else 'in_progress'");
    expect(inProgress.params).toContain("in_progress");
    expect(imageProcessing.sql).toContain("g.status = 'pending'");
    expect(videoProcessing.sql).toMatch(
      /from video_generation v[\s\S]*and false/
    );
  });

  it("reverses comparison and order for a signed previous cursor", () => {
    const compiled = new PgDialect().sqlToQuery(
      buildHistoryListSql({
        ...baseQuery,
        cursor: {
          createdAt: new Date("2026-07-20T12:00:00.000Z"),
          kindRank: 1,
          id: "image-20",
          direction: "previous",
        },
      })
    );

    expect(compiled.sql).toMatch(/g\.created_at > \$\d+/);
    expect(compiled.sql).toMatch(/g\.id > \$\d+/);
    expect(compiled.sql).toContain("order by g.created_at asc, g.id asc");
    expect(compiled.sql).toContain(
      "order by created_at asc, kind_rank asc, id asc"
    );
  });

  it("reads real distinct models scoped only by user and selected type", () => {
    const compiled = new PgDialect().sqlToQuery(
      buildHistoryModelOptionsSql({
        userId: "user-1",
        type: "image",
        limit: 200,
      })
    );

    expect(compiled.sql).toContain("from generation g");
    expect(compiled.sql).toContain("from video_generation v");
    expect(compiled.sql).toContain("union");
    expect(compiled.sql).toContain("order by model asc");
    expect(compiled.params).toContain("user-1");
    expect(compiled.params).toContain(200);
  });
});
