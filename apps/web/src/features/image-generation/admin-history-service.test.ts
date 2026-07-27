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
} from "./admin-history-service";

const TOKEN_SECRET = "admin-history-service-test-secret";

/** 创建一条完整的管理端图片仓储窄行。 */
function imageRow(
  id: string,
  createdAt: string,
  userEmail = "member@example.com"
): AdminHistoryListRow {
  return {
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
    ...overrides,
  };
}

describe("admin history service", () => {
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
      userId: "user-1",
      userEmail: "member@example.com",
    });
    expect(result.nextCursor).toEqual(expect.any(String));
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
