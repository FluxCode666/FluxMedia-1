/**
 * 管理端全局历史应用服务测试。
 *
 * 使用注入仓储保持 DB-free，覆盖邮箱筛选进入查询、用户身份字段输出，以及 cursor 绑定
 * 管理员和筛选条件，防止跨管理员或跨用户条件重放分页 token。
 */

import { describe, expect, it, vi } from "vitest";

import {
  type AdminHistoryListRow,
  type AdminHistoryRepository,
  loadAdminHistoryRecords,
  loadAdminHistoryRequestSnapshot,
} from "./admin-history-service";

const TOKEN_SECRET = "admin-history-service-test-secret";

/** 创建一条完整的管理端图片仓储窄行。 */
function imageRow(
  id: string,
  createdAt: string,
  userEmail = "member@example.com"
): AdminHistoryListRow {
  return {
    backendAccount: {
      id: "backend-1",
      name: "Primary supplier",
    },
    kind: "image",
    id,
    userId: "user-1",
    userEmail,
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

/** 创建默认 DB-free 管理端仓储并允许目标读取覆写。 */
function createRepository(
  overrides: Partial<AdminHistoryRepository> = {}
): AdminHistoryRepository {
  return {
    readRecords: vi.fn().mockResolvedValue([]),
    readModelOptions: vi.fn().mockResolvedValue([]),
    readUserOptions: vi.fn().mockResolvedValue([]),
    readRequestSnapshot: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("admin history service", () => {
  it("returns a validated request snapshot and keeps invalid historical metadata hidden", async () => {
    const repository = createRepository({
      readRequestSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          snapshot: {
            operation: "videos.generate",
            contentType: "application/json",
            body: { reference_mode: "media" },
          },
        })
        .mockResolvedValueOnce({
          snapshot: { authorization: "unsafe historical metadata" },
        }),
    });

    await expect(
      loadAdminHistoryRequestSnapshot(
        { input: { id: "video-1", kind: "video" } },
        { repository }
      )
    ).resolves.toEqual({
      id: "video-1",
      kind: "video",
      snapshot: {
        operation: "videos.generate",
        contentType: "application/json",
        body: { reference_mode: "media" },
      },
    });

    await expect(
      loadAdminHistoryRequestSnapshot(
        { input: { id: "image-1", kind: "image" } },
        { repository }
      )
    ).resolves.toEqual({ id: "image-1", kind: "image", snapshot: null });
  });

  it("returns real video model, independent parameters and input summary", async () => {
    const result = await loadAdminHistoryRecords(
      {
        actorUserId: "admin-1",
        timeZone: "UTC",
        input: { type: "video" },
        now: new Date("2026-07-22T13:00:00.000Z"),
      },
      {
        repository: createRepository({
          readRecords: vi.fn().mockResolvedValue([
            {
              backendAccount: {
                id: "backend-video",
                name: "Video supplier",
              },
              kind: "video",
              id: "video-1",
              userId: "user-1",
              userEmail: "member@example.com",
              prompt: "video prompt",
              model: "seedance2",
              resolution: "1080p",
              duration: 8,
              aspectRatio: "16x9",
              generateAudio: false,
              input: { mode: "references", count: 3 },
              submissionAttempts: [
                {
                  attemptNumber: 1,
                  supplierName: "Video supplier",
                  failureCode: "submission_timeout",
                  failureReason: "生成服务请求超时，请稍后重试",
                  operationsReason: "上游视频创建请求超时",
                  failedAt: "2026-07-22T12:00:30.000Z",
                },
              ],
              status: "completed",
              creditsConsumed: 20,
              rawError: null,
              videoUrl: "/video/video-1",
              createdAt: "2026-07-22T12:00:00.000Z",
              completedAt: "2026-07-22T12:01:00.000Z",
            },
          ]),
        }),
        tokenSecret: TOKEN_SECRET,
      }
    );

    expect(result.records[0]).toEqual(
      expect.objectContaining({
        model: "seedance2",
        duration: 8,
        aspectRatio: "16x9",
        resolution: "1080p",
        generateAudio: false,
        input: { mode: "references", count: 3 },
        submissionAttempts: [
          {
            attemptNumber: 1,
            supplierName: "Video supplier",
            failureCode: "submission_timeout",
            failureReason: "生成服务请求超时，请稍后重试",
            operationsReason: "上游视频创建请求超时",
            failedAt: "2026-07-22T12:00:30.000Z",
          },
        ],
        processingDurationSeconds: 60,
      })
    );
    expect(result.records[0]).not.toHaveProperty("family");
  });

  it("passes the exact email filter to the global repository and returns user identity", async () => {
    const readRecords = vi
      .fn()
      .mockResolvedValue([
        imageRow("image-2", "2026-07-22T12:00:00.000Z"),
        imageRow("image-1", "2026-07-22T11:00:00.000Z"),
      ]);
    const readModelOptions = vi.fn().mockResolvedValue(["gpt-image-2"]);
    const readUserOptions = vi
      .fn()
      .mockResolvedValue([{ id: "user-1", email: "member@example.com" }]);

    const result = await loadAdminHistoryRecords(
      {
        actorUserId: "admin-1",
        timeZone: "UTC",
        input: { userEmail: "member@example.com", limit: 1 },
        now: new Date("2026-07-22T13:00:00.000Z"),
      },
      {
        repository: createRepository({
          readRecords,
          readModelOptions,
          readUserOptions,
        }),
        tokenSecret: TOKEN_SECRET,
      }
    );

    expect(readRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        branchLimit: 2,
        userEmail: "member@example.com",
      })
    );
    expect(readModelOptions).toHaveBeenCalledWith({
      userEmail: "member@example.com",
      type: null,
      limit: 200,
    });
    expect(readUserOptions).toHaveBeenCalledWith({ type: null, limit: 200 });
    expect(result.records[0]).toMatchObject({
      backendAccount: {
        id: "backend-1",
        name: "Primary supplier",
      },
      userId: "user-1",
      userEmail: "member@example.com",
    });
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("keeps records visible when no supplier account can be resolved", async () => {
    const row = imageRow("image-1", "2026-07-22T12:00:00.000Z");
    row.backendAccount = null;

    const result = await loadAdminHistoryRecords(
      {
        actorUserId: "admin-1",
        timeZone: "UTC",
        input: {},
        now: new Date("2026-07-22T13:00:00.000Z"),
      },
      {
        repository: createRepository({
          readRecords: vi.fn().mockResolvedValue([row]),
        }),
        tokenSecret: TOKEN_SECRET,
      }
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.backendAccount).toBeNull();
  });

  it("binds global cursors to both the administrator and email filter", async () => {
    const first = await loadAdminHistoryRecords(
      {
        actorUserId: "admin-1",
        timeZone: "UTC",
        input: { userEmail: "member@example.com", limit: 1 },
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
      loadAdminHistoryRecords(
        {
          actorUserId: "admin-2",
          timeZone: "UTC",
          input: {
            userEmail: "member@example.com",
            cursor: first.nextCursor,
            limit: 1,
          },
          now: new Date("2026-07-22T13:01:00.000Z"),
        },
        {
          repository: createRepository({ readRecords }),
          tokenSecret: TOKEN_SECRET,
        }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      loadAdminHistoryRecords(
        {
          actorUserId: "admin-1",
          timeZone: "UTC",
          input: {
            userEmail: "another@example.com",
            cursor: first.nextCursor,
            limit: 1,
          },
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
});
