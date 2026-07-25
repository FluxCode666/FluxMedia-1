/**
 * UOL 媒体引用加载器单元测试。
 *
 * 职责：覆盖 data 实际字节校验与 storage 归属边界，确保 UOL 不能用
 * 任意对象键读取其他用户的媒体。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMock = vi.hoisted(() => ({
  getObject: vi.fn(),
}));

vi.mock("@repo/shared/storage/providers", () => ({
  getStorageRuntimeSnapshot: vi.fn(async () => ({
    provider: storageMock,
    bucketName: "generations",
    endpoint: null,
  })),
}));

import { loadMediaInputs } from "./media-input-loader";

describe("loadMediaInputs", () => {
  beforeEach(() => {
    storageMock.getObject.mockReset();
  });

  it("解码 data 引用并复核真实字节数", async () => {
    const bytes = Buffer.from("image-bytes");

    await expect(
      loadMediaInputs({
        userId: "user-1",
        references: [
          {
            source: "data",
            mimeType: "image/png",
            base64: bytes.toString("base64"),
            byteLength: bytes.byteLength,
          },
        ],
      })
    ).resolves.toEqual([{ data: bytes, type: "image/png" }]);
  });

  it("只读取当前用户前缀且位于当前生成桶的对象", async () => {
    storageMock.getObject.mockResolvedValue(Buffer.from("stored-image"));

    await expect(
      loadMediaInputs({
        userId: "user-1",
        references: [
          {
            source: "storage",
            mimeType: "image/png",
            storageKey: "user-2/private.png",
            storageBucket: "generations",
            byteLength: 12,
          },
        ],
      })
    ).rejects.toThrow("Stored media is not owned by caller");
    expect(storageMock.getObject).not.toHaveBeenCalled();

    await expect(
      loadMediaInputs({
        userId: "user-1",
        references: [
          {
            source: "storage",
            mimeType: "image/png",
            storageKey: "user-1/input.png",
            storageBucket: "generations",
            byteLength: 12,
          },
        ],
      })
    ).resolves.toEqual([
      { data: Buffer.from("stored-image"), type: "image/png" },
    ]);
  });
});
