/** 公告集合已读写入的 PostgreSQL 适配器聚焦测试。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  db: {
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@repo/database", () => ({
  db: databaseMocks.db,
}));

import { markAllActiveAnnouncementsReadForUser } from "./list-service";

describe("markAllActiveAnnouncementsReadForUser", () => {
  beforeEach(() => {
    databaseMocks.db.execute.mockReset();
    databaseMocks.db.transaction.mockReset();
  });

  it("uses one set-based statement and returns the affected row count", async () => {
    databaseMocks.db.execute.mockResolvedValue({
      rows: [
        { announcement_id: "announcement-1" },
        { announcement_id: "announcement-2" },
      ],
    });

    await expect(markAllActiveAnnouncementsReadForUser("user-1")).resolves.toBe(
      2
    );
    expect(databaseMocks.db.execute).toHaveBeenCalledTimes(1);
    expect(databaseMocks.db.transaction).not.toHaveBeenCalled();
  });

  it("supports the Neon array result shape without pre-reading IDs", async () => {
    databaseMocks.db.execute.mockResolvedValue([
      { announcement_id: "announcement-1" },
    ]);

    await expect(markAllActiveAnnouncementsReadForUser("user-1")).resolves.toBe(
      1
    );
    expect(databaseMocks.db.execute).toHaveBeenCalledTimes(1);
  });
});
