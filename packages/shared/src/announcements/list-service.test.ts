/** 公告 Go 适配器测试：验证请求转发与后端计数契约。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAll = vi.fn(() => [{ name: "session", value: "token" }]);
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ getAll })) }));

import {
  markAllActiveAnnouncementsReadForUser,
  readAdminAnnouncementsPage,
  readUserAnnouncementsPage,
} from "./list-service";

describe("announcement Go adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getAll.mockClear();
  });

  it("forwards user pagination with the current session cookie", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          records: [],
          page: 2,
          pageSize: 20,
          totalCount: 0,
          totalPages: 1,
        }),
        { status: 200 }
      )
    );
    await expect(
      readUserAnnouncementsPage("user-1", { page: 2, pageSize: 20 })
    ).resolves.toMatchObject({ page: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/announcements?page=2&pageSize=20"),
      expect.objectContaining({ headers: expect.any(Headers) })
    );
  });

  it("forwards admin filters and set-based read-all count", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [],
            page: 1,
            pageSize: 20,
            totalCount: 0,
            totalPages: 1,
            stats: { active: 0, drafts: 0, pinned: 0 },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 3 }), { status: 200 }));
    await readAdminAnnouncementsPage({ page: 1, pageSize: 20, published: "published" });
    await expect(markAllActiveAnnouncementsReadForUser("user-1")).resolves.toBe(3);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
