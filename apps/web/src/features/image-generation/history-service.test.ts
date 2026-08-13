/**
 * 统一生成历史应用服务测试。
 *
 * 通过注入仓储保持 DB-free，覆盖用户时区日期、主体/筛选绑定 cursor、双向分页、
 * 模型选项范围与原始失败信息脱敏。
 */

import { describe, expect, it, vi } from "vitest";
import {
  calculateHistoryProcessingDurationSeconds,
  type HistoryListRow,
  type HistoryRepository,
  loadHistoryRecords,
  resolveHistoryDateRange,
  sanitizeHistoryError,
} from "./history-service";

const TOKEN_SECRET = "history-service-test-secret";

/** 创建一条完整图片窄行，允许测试覆盖排序身份。 */
function imageRow(id: string, createdAt: string): HistoryListRow {
  return {
    kind: "image",
    id,
    prompt: `prompt-${id}`,
    revisedPrompt: null,
    model: "gpt-image-2",
    size: "1024x1024",
    status: "completed",
    creditsConsumed: 10,
    creditDetails: null,
    promptRepairNotice: null,
    referenceImages: [],
    rawError: null,
    imageUrl: `/image/${id}`,
    createdAt,
    completedAt: createdAt,
  };
}

/** 创建默认 DB-free 仓储并允许覆盖目标读取。 */
function createRepository(
  overrides: Partial<HistoryRepository> = {}
): HistoryRepository {
  return {
    readRecords: vi.fn().mockResolvedValue([]),
    readModelOptions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("history service", () => {
  it("calculates rounded terminal processing seconds and preserves incomplete state", () => {
    expect(
      calculateHistoryProcessingDurationSeconds({
        createdAt: "2026-07-22T12:00:00.000Z",
        completedAt: "2026-07-22T12:01:00.499Z",
      })
    ).toBe(60);
    expect(
      calculateHistoryProcessingDurationSeconds({
        createdAt: "2026-07-22T12:00:01.000Z",
        completedAt: "2026-07-22T12:00:00.000Z",
      })
    ).toBe(0);
    expect(
      calculateHistoryProcessingDurationSeconds({
        createdAt: "2026-07-22T12:00:00.000Z",
        completedAt: null,
      })
    ).toBeNull();
    expect(() =>
      calculateHistoryProcessingDurationSeconds({
        createdAt: "invalid",
        completedAt: "2026-07-22T12:00:00.000Z",
      })
    ).toThrow(RangeError);
  });

  it("uses calendar-day boundaries across daylight-saving changes", () => {
    const springForward = resolveHistoryDateRange({
      createdFrom: "2026-03-08",
      createdTo: "2026-03-08",
      timeZone: "America/New_York",
    });
    const fallBack = resolveHistoryDateRange({
      createdFrom: "2026-11-01",
      createdTo: "2026-11-01",
      timeZone: "America/New_York",
    });

    expect(springForward.start?.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(springForward.end?.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(fallBack.start?.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fallBack.end?.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("uses the user time zone and includes the complete createdTo day", async () => {
    const rows = [
      imageRow("image-3", "2026-07-22T12:00:00.000Z"),
      {
        kind: "video" as const,
        id: "video-2",
        prompt: "video prompt",
        model: "sora2",
        resolution: "1080p",
        duration: 8,
        aspectRatio: "16x9",
        generateAudio: true,
        input: { mode: "first-last-frames" as const, count: 2 },
        status: "in_progress" as const,
        creditsConsumed: 20,
        rawError: null,
        videoUrl: null,
        createdAt: "2026-07-22T11:00:00.000Z",
        completedAt: null,
      },
      imageRow("image-1", "2026-07-22T10:00:00.000Z"),
    ];
    const readRecords = vi.fn().mockResolvedValue(rows);
    const readModelOptions = vi
      .fn()
      .mockResolvedValue(["gpt-image-2", "firefly-sora2", "gpt-image-2"]);
    const result = await loadHistoryRecords(
      {
        userId: "user-1",
        timeZone: "Asia/Shanghai",
        input: {
          createdFrom: "2026-07-01",
          createdTo: "2026-07-22",
          limit: 2,
        },
        now: new Date("2026-07-22T13:00:00.000Z"),
      },
      {
        repository: createRepository({ readRecords, readModelOptions }),
        tokenSecret: TOKEN_SECRET,
      }
    );

    expect(readRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        start: new Date("2026-06-30T16:00:00.000Z"),
        end: new Date("2026-07-22T16:00:00.000Z"),
        branchLimit: 3,
      })
    );
    expect(readModelOptions).toHaveBeenCalledWith({
      userId: "user-1",
      type: null,
      limit: 200,
    });
    expect(result.records.map((record) => record.kind)).toEqual([
      "image",
      "video",
    ]);
    expect(result.records[1]?.model).toBe("sora2");
    expect(result.records[1]).toMatchObject({
      duration: 8,
      aspectRatio: "16x9",
      resolution: "1080p",
      generateAudio: true,
      input: { mode: "first-last-frames", count: 2 },
      processingDurationSeconds: null,
    });
    expect(result.modelOptions).toEqual(["gpt-image-2", "sora2"]);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.previousCursor).toBeNull();
  });

  it("binds cursors to user and filters before querying the repository", async () => {
    const first = await loadHistoryRecords(
      {
        userId: "user-1",
        timeZone: "UTC",
        input: { type: "image", limit: 1 },
        now: new Date("2026-07-22T13:00:00.000Z"),
      },
      {
        repository: createRepository({
          readRecords: vi
            .fn()
            .mockResolvedValue([
              imageRow("image-2", "2026-07-22T12:00:00.000Z"),
              imageRow("image-1", "2026-07-22T11:00:00.000Z"),
            ]),
        }),
        tokenSecret: TOKEN_SECRET,
      }
    );
    const readRecords = vi.fn();

    await expect(
      loadHistoryRecords(
        {
          userId: "user-2",
          timeZone: "UTC",
          input: { type: "image", cursor: first.nextCursor, limit: 1 },
          now: new Date("2026-07-22T13:01:00.000Z"),
        },
        {
          repository: createRepository({ readRecords }),
          tokenSecret: TOKEN_SECRET,
        }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      loadHistoryRecords(
        {
          userId: "user-1",
          timeZone: "UTC",
          input: { type: "video", cursor: first.nextCursor, limit: 1 },
          now: new Date("2026-07-22T13:01:00.000Z"),
        },
        {
          repository: createRepository({ readRecords }),
          tokenSecret: TOKEN_SECRET,
        }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(readRecords).not.toHaveBeenCalled();
  });

  it("creates previous and next cursors without a URL cursor stack", async () => {
    const firstPage = await loadHistoryRecords(
      {
        userId: "user-1",
        timeZone: "UTC",
        input: { limit: 2 },
        now: new Date("2026-07-22T13:00:00.000Z"),
      },
      {
        repository: createRepository({
          readRecords: vi
            .fn()
            .mockResolvedValue([
              imageRow("image-5", "2026-07-22T12:00:00.000Z"),
              imageRow("image-4", "2026-07-22T11:00:00.000Z"),
              imageRow("image-3", "2026-07-22T10:00:00.000Z"),
            ]),
        }),
        tokenSecret: TOKEN_SECRET,
      }
    );
    const secondPage = await loadHistoryRecords(
      {
        userId: "user-1",
        timeZone: "UTC",
        input: { cursor: firstPage.nextCursor, limit: 2 },
        now: new Date("2026-07-22T13:01:00.000Z"),
      },
      {
        repository: createRepository({
          readRecords: vi
            .fn()
            .mockResolvedValue([
              imageRow("image-3", "2026-07-22T10:00:00.000Z"),
              imageRow("image-2", "2026-07-22T09:00:00.000Z"),
              imageRow("image-1", "2026-07-22T08:00:00.000Z"),
            ]),
        }),
        tokenSecret: TOKEN_SECRET,
      }
    );
    const readPrevious = vi
      .fn()
      .mockResolvedValue([
        imageRow("image-4", "2026-07-22T11:00:00.000Z"),
        imageRow("image-5", "2026-07-22T12:00:00.000Z"),
      ]);
    const previousPage = await loadHistoryRecords(
      {
        userId: "user-1",
        timeZone: "UTC",
        input: { cursor: secondPage.previousCursor, limit: 2 },
        now: new Date("2026-07-22T13:02:00.000Z"),
      },
      {
        repository: createRepository({ readRecords: readPrevious }),
        tokenSecret: TOKEN_SECRET,
      }
    );

    expect(secondPage.previousCursor).toEqual(expect.any(String));
    expect(readPrevious).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: expect.objectContaining({ direction: "previous" }),
      })
    );
    expect(previousPage.records.map((record) => record.id)).toEqual([
      "image-5",
      "image-4",
    ]);
    expect(previousPage.previousCursor).toBeNull();
    expect(previousPage.nextCursor).toEqual(expect.any(String));
  });

  it("maps raw provider and internal errors to a small safe allowlist", () => {
    expect(
      sanitizeHistoryError("Failed query: select secret from account")
    ).toBe("Generation failed");
    expect(sanitizeHistoryError("provider deadline exceeded")).toBe(
      "Generation timed out"
    );
    expect(sanitizeHistoryError("moderation content policy rejected")).toBe(
      "Prompt did not pass content safety review; modify the prompt and retry"
    );
    expect(sanitizeHistoryError("poll failed: 451 image_unsafe")).toBe(
      "Prompt did not pass content safety review; modify the prompt and retry"
    );
  });
});
