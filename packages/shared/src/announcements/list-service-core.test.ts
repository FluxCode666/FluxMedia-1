/**
 * 公告分页服务的数据库无关聚焦测试。
 *
 * 覆盖 count→越界收敛→rows 顺序、管理统计与分页解耦，以及任一读取失败时
 * 不返回伪空态。生产事务配置由仓储集成实现固定为 repeatable-read/read-only。
 */
import { describe, expect, it, vi } from "vitest";

import type {
  AdminAnnouncementItem,
  UserAnnouncementListRecord,
} from "./list-contract";
import {
  type AnnouncementListRepository,
  type AnnouncementListSnapshot,
  listAdminAnnouncementsPage,
  listUserAnnouncementsPage,
} from "./list-service-core";

const createdAt = "2026-08-13T00:00:00.000Z";

/** 创建一条用户公告 DTO，允许覆盖测试关注字段。 */
function createUserRecord(
  input: Partial<UserAnnouncementListRecord> = {}
): UserAnnouncementListRecord {
  return {
    id: "announcement-1",
    title: "维护通知",
    content: "测试内容",
    severity: "info",
    isPinned: false,
    priority: 0,
    publishedAt: createdAt,
    expiresAt: null,
    createdAt,
    updatedAt: createdAt,
    isRead: false,
    ...input,
  };
}

/** 创建一条管理公告 DTO，允许覆盖测试关注字段。 */
function createAdminRecord(
  input: Partial<AdminAnnouncementItem> = {}
): AdminAnnouncementItem {
  return {
    id: "announcement-1",
    title: "维护通知",
    content: "测试内容",
    severity: "info",
    isPublished: true,
    isPinned: false,
    priority: 0,
    publishedAt: createdAt,
    expiresAt: null,
    createdByUserId: "admin-1",
    updatedByUserId: "admin-1",
    createdAt,
    updatedAt: createdAt,
    ...input,
  };
}

/** 把可注入快照包装成一次调用只执行一次的仓储。 */
function createRepository(
  snapshot: AnnouncementListSnapshot
): AnnouncementListRepository {
  return {
    withReadSnapshot: vi.fn(async (work) => work(snapshot)),
  };
}

/** 创建默认快照并允许覆盖单个读取端口。 */
function createSnapshot(
  overrides: Partial<AnnouncementListSnapshot> = {}
): AnnouncementListSnapshot {
  return {
    countActiveForUser: vi.fn(async () => 1),
    listActiveForUser: vi.fn(async () => [createUserRecord()]),
    countForAdmin: vi.fn(async () => 1),
    listForAdmin: vi.fn(async () => [createAdminRecord()]),
    readAdminStats: vi.fn(async () => ({ active: 8, drafts: 3, pinned: 2 })),
    ...overrides,
  };
}

describe("announcement list services", () => {
  it("clamps a user page before reading rows in the same snapshot", async () => {
    const snapshot = createSnapshot({
      countActiveForUser: vi.fn(async () => 21),
      listActiveForUser: vi.fn(async () => [
        createUserRecord({ id: "announcement-21" }),
      ]),
    });
    const repository = createRepository(snapshot);

    const output = await listUserAnnouncementsPage(
      "user-1",
      { page: 99, pageSize: 10 },
      repository
    );

    expect(output).toMatchObject({
      page: 3,
      pageSize: 10,
      totalCount: 21,
      totalPages: 3,
    });
    expect(snapshot.listActiveForUser).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 10,
      offset: 20,
    });
    expect(repository.withReadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns zero results on canonical page one without skipping the row read", async () => {
    const snapshot = createSnapshot({
      countActiveForUser: vi.fn(async () => 0),
      listActiveForUser: vi.fn(async () => []),
    });

    await expect(
      listUserAnnouncementsPage(
        "user-1",
        { page: 5, pageSize: 20 },
        createRepository(snapshot)
      )
    ).resolves.toEqual({
      records: [],
      page: 1,
      pageSize: 20,
      totalCount: 0,
      totalPages: 1,
    });
  });

  it("does not read user rows or disguise an empty list when count fails", async () => {
    const failure = new Error("count unavailable");
    const snapshot = createSnapshot({
      countActiveForUser: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      listUserAnnouncementsPage(
        "user-1",
        { page: 1, pageSize: 20 },
        createRepository(snapshot)
      )
    ).rejects.toBe(failure);
    expect(snapshot.listActiveForUser).not.toHaveBeenCalled();
  });

  it("propagates a row read failure after a successful count", async () => {
    const failure = new Error("rows unavailable");
    const snapshot = createSnapshot({
      listActiveForUser: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      listUserAnnouncementsPage(
        "user-1",
        { page: 1, pageSize: 20 },
        createRepository(snapshot)
      )
    ).rejects.toBe(failure);
  });

  it("keeps admin global stats independent from page and published filter", async () => {
    const snapshot = createSnapshot({
      countForAdmin: vi.fn(async () => 12),
      listForAdmin: vi.fn(async () => [
        createAdminRecord({ id: "draft-11", isPublished: false }),
        createAdminRecord({ id: "draft-12", isPublished: false }),
      ]),
      readAdminStats: vi.fn(async () => ({
        active: 40,
        drafts: 12,
        pinned: 5,
      })),
    });

    const output = await listAdminAnnouncementsPage(
      { page: 2, pageSize: 10, published: "unpublished" },
      createRepository(snapshot)
    );

    expect(output).toMatchObject({
      page: 2,
      totalCount: 12,
      totalPages: 2,
      stats: { active: 40, drafts: 12, pinned: 5 },
    });
    expect(snapshot.countForAdmin).toHaveBeenCalledWith("unpublished");
    expect(snapshot.listForAdmin).toHaveBeenCalledWith({
      limit: 10,
      offset: 10,
      published: "unpublished",
    });
  });
});
