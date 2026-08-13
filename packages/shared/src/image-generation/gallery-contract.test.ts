/**
 * 图库 UOL 共享契约测试。
 *
 * 覆盖输入身份隔离、三类安全 DTO、批次边界和敏感字段拒绝，防止图库读取在
 * Web、UOL 与未来客户端之间形成不同契约。
 */

import { describe, expect, it } from "vitest";
import {
  galleryListInputSchema,
  galleryListOutputSchema,
} from "./gallery-contract";

const commonImage = {
  id: "generation-1",
  parentId: "generation-1",
  prompt: "A quiet lake",
  revisedPrompt: null,
  promptRepairNotice: null,
  model: "gpt-image-2",
  size: "1024x1024",
  status: "completed" as const,
  creditsConsumed: 12,
  imageUrl: "/api/storage/generations/user/output.png?sig=signed",
  createdAt: "2026-08-13T08:00:00.000Z",
  referenceImages: [],
};

describe("gallery contract", () => {
  /** 默认输入固定首批大小，并拒绝由调用方伪造身份作用域。 */
  it("normalizes a first batch without accepting caller identity", () => {
    expect(galleryListInputSchema.parse({})).toEqual({
      cursor: null,
      limit: 20,
      tab: "final",
    });
    expect(
      galleryListInputSchema.safeParse({ userId: "forged-user" }).success
    ).toBe(false);
  });

  /** 页签、批次大小与不透明游标均在共享边界执行严格校验。 */
  it("accepts only supported tabs, bounded limits and opaque cursors", () => {
    expect(
      galleryListInputSchema.parse({
        cursor: "signed-cursor",
        limit: 50,
        tab: "uploads",
      })
    ).toEqual({
      cursor: "signed-cursor",
      limit: 50,
      tab: "uploads",
    });
    expect(
      galleryListInputSchema.safeParse({ tab: "recommended" }).success
    ).toBe(false);
    expect(galleryListInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(galleryListInputSchema.safeParse({ cursor: "" }).success).toBe(
      false
    );
  });

  /** 输出只包含卡片与下一边界，不允许图库重新引入总数或加载进度。 */
  it("returns only bounded gallery items and the next cursor", () => {
    expect(
      galleryListOutputSchema.parse({
        items: [{ ...commonImage, outputRole: "final" }],
        nextCursor: "next-signed-cursor",
      })
    ).toMatchObject({
      items: [{ id: "generation-1", outputRole: "final" }],
      nextCursor: "next-signed-cursor",
    });
    expect(
      galleryListOutputSchema.safeParse({
        items: [{ ...commonImage, outputRole: "final" }],
        loadedCount: 1,
        nextCursor: null,
        totalCount: 10,
      }).success
    ).toBe(false);
  });

  /** 成品、上传图和视频保持判别字段，避免客户端误用另一媒体类型的 URL。 */
  it("keeps image and video gallery fields mutually exclusive", () => {
    const upload = {
      ...commonImage,
      id: "generation-1-upload-0",
      outputRole: "upload" as const,
    };
    const video = {
      id: "video-1",
      parentId: "video-1",
      prompt: "Ocean waves",
      model: "sora-2",
      size: "8s · 16:9 · 1080p",
      status: "completed" as const,
      creditsConsumed: 24,
      videoUrl: "/api/storage/videos/user/output.mp4?sig=signed",
      createdAt: "2026-08-13T07:00:00.000Z",
      outputRole: "video" as const,
    };
    expect(
      galleryListOutputSchema
        .parse({
          items: [upload, video],
          nextCursor: null,
        })
        .items.map((item) => item.outputRole)
    ).toEqual(["upload", "video"]);
    expect(
      galleryListOutputSchema.safeParse({
        items: [{ ...video, imageUrl: "/wrong.png" }],
        nextCursor: null,
      }).success
    ).toBe(false);
  });

  /** 内部存储定位字段不得穿过图库 UOL 输出边界。 */
  it("rejects internal storage coordinates", () => {
    expect(
      galleryListOutputSchema.safeParse({
        items: [
          {
            ...commonImage,
            outputRole: "final",
            storageBucket: "private-bucket",
            storageKey: "users/user-1/output.png",
          },
        ],
        nextCursor: null,
      }).success
    ).toBe(false);
  });
});
