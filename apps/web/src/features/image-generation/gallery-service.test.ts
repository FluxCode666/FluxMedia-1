/**
 * 图库 keyset 服务的 DB-free 单元测试。
 *
 * 覆盖批次裁剪、下一边界、主体/页签/批大小绑定及篡改拒绝，避免无限滚动在
 * 快速切换页签或复制 cursor 时跨越权限和排序作用域。
 */

import type { GalleryItem } from "@repo/shared/image-generation/gallery-contract";
import { describe, expect, it, vi } from "vitest";
import {
  type GalleryRepository,
  GalleryServiceError,
  loadGalleryItems,
} from "./gallery-service";

const tokenSecret = "gallery-test-secret";
const now = new Date("2026-08-13T08:00:00.000Z");

/** 创建最小成品卡片，便于测试 keyset 逻辑而不依赖数据库。 */
function row(id: string, createdAt: string) {
  return {
    item: {
      id,
      parentId: id,
      prompt: `Prompt ${id}`,
      revisedPrompt: null,
      promptRepairNotice: null,
      model: "gpt-image-2",
      size: "1024x1024",
      status: "completed" as const,
      creditsConsumed: 1,
      imageUrl: `/image/${id}`,
      createdAt,
      outputRole: "final" as const,
      referenceImages: [],
    },
    sortKey: { createdAt: new Date(createdAt), id },
  };
}

describe("gallery service", () => {
  /** limit+1 只用于判定下一页，输出保持产品批大小且不携带总数。 */
  it("returns a bounded batch and signs the next cursor", async () => {
    const repository: GalleryRepository = {
      readItems: vi.fn(async () => [
        row("3", "2026-08-13T07:00:00.000Z"),
        row("2", "2026-08-13T06:00:00.000Z"),
        row("1", "2026-08-13T05:00:00.000Z"),
      ]),
    };
    const result = await loadGalleryItems(
      { userId: "user-1", input: { limit: 2, tab: "final" }, now },
      { repository, tokenSecret }
    );
    expect(result.items.map((item: GalleryItem) => item.id)).toEqual([
      "3",
      "2",
    ]);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(repository.readItems).toHaveBeenCalledWith({
      userId: "user-1",
      tab: "final",
      asOf: now,
      cursor: null,
      limit: 3,
    });
    expect(result).not.toHaveProperty("totalCount");
  });

  /** 下一请求必须恢复相同 asOf 和最后卡片排序键。 */
  it("restores the signed browsing boundary", async () => {
    const firstRepository: GalleryRepository = {
      readItems: vi.fn(async () => [
        row("2", "2026-08-13T07:00:00.000Z"),
        row("1", "2026-08-13T06:00:00.000Z"),
      ]),
    };
    const first = await loadGalleryItems(
      { userId: "user-1", input: { limit: 1, tab: "final" }, now },
      { repository: firstRepository, tokenSecret }
    );
    const readItems = vi.fn(async () => []);
    await loadGalleryItems(
      {
        userId: "user-1",
        input: { cursor: first.nextCursor, limit: 1, tab: "final" },
        now: new Date("2026-08-13T09:00:00.000Z"),
      },
      { repository: { readItems }, tokenSecret }
    );
    expect(readItems).toHaveBeenCalledWith({
      userId: "user-1",
      tab: "final",
      asOf: now,
      cursor: { createdAt: new Date("2026-08-13T07:00:00.000Z"), id: "2" },
      limit: 2,
    });
  });

  /** cursor 不能跨用户、页签、批大小使用，也不能修改任一字节。 */
  it("rejects scope mismatches and tampering", async () => {
    const repository: GalleryRepository = {
      readItems: vi.fn(async () => [
        row("2", "2026-08-13T07:00:00.000Z"),
        row("1", "2026-08-13T06:00:00.000Z"),
      ]),
    };
    const first = await loadGalleryItems(
      { userId: "user-1", input: { limit: 1, tab: "final" }, now },
      { repository, tokenSecret }
    );
    const attempts = [
      { userId: "user-2", limit: 1, tab: "final" },
      { userId: "user-1", limit: 1, tab: "videos" },
      { userId: "user-1", limit: 2, tab: "final" },
    ] as const;
    for (const attempt of attempts) {
      await expect(
        loadGalleryItems(
          {
            userId: attempt.userId,
            input: {
              cursor: first.nextCursor,
              limit: attempt.limit,
              tab: attempt.tab,
            },
            now,
          },
          { repository, tokenSecret }
        )
      ).rejects.toBeInstanceOf(GalleryServiceError);
    }
    await expect(
      loadGalleryItems(
        {
          userId: "user-1",
          input: {
            cursor: `${first.nextCursor?.slice(0, -1)}A`,
            limit: 1,
            tab: "final",
          },
          now,
        },
        { repository, tokenSecret }
      )
    ).rejects.toBeInstanceOf(GalleryServiceError);
  });
});
