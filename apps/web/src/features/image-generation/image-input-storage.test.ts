/**
 * 同步图片输入转存测试。
 *
 * 使用方：Vitest；验证 data/remote 转存、已有 storage 复用、MIME/字节复验和部分
 * 上传失败清理，确保等待队列只接收 storage-only 清单。
 */

import type { MediaInputReference } from "@repo/shared/image-generation/media-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getStorageRuntimeSnapshot: vi.fn(),
}));
const mediaLoader = vi.hoisted(() => ({ loadMediaInputs: vi.fn() }));

vi.mock("@repo/shared/storage/providers", () => ({
  getStorageRuntimeSnapshot: storage.getStorageRuntimeSnapshot,
}));
vi.mock("./media-input-loader", () => ({
  loadMediaInputs: mediaLoader.loadMediaInputs,
}));

import {
  cleanupStagedImageInputs,
  stageImageInputReferences,
  withStagedImageInputOwnership,
} from "./image-input-storage";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("image-input"),
]);

/** 构造声明与实际测试字节一致的 data 引用。 */
function createDataReference(): MediaInputReference {
  return {
    source: "data",
    mimeType: "image/png",
    base64: PNG_BYTES.toString("base64"),
    byteLength: PNG_BYTES.byteLength,
  };
}

/** 配置成功加载和对象存储桩。 */
function setupStorage(): void {
  storage.getStorageRuntimeSnapshot.mockResolvedValue({
    provider: {
      putObject: storage.putObject,
      deleteObject: storage.deleteObject,
    },
    bucketName: "uploads",
  });
  storage.putObject.mockResolvedValue(undefined);
  storage.deleteObject.mockResolvedValue(undefined);
  mediaLoader.loadMediaInputs.mockImplementation(
    async (input: { references: MediaInputReference[] }) =>
      input.references.map(() => ({ data: PNG_BYTES, type: "image/png" }))
  );
}

describe("stageImageInputReferences", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("把 data 与 remote 输入转成当前用户的 storage-only 清单", async () => {
    setupStorage();
    const result = await stageImageInputReferences({
      userId: "user-1",
      generationId: "../unsafe-generation",
      references: [
        createDataReference(),
        {
          source: "remote",
          mimeType: "image/png",
          url: "https://cdn.example.test/input.png",
          byteLength: PNG_BYTES.byteLength,
        },
      ],
    });

    expect(result.references).toHaveLength(2);
    expect(
      result.references.every((reference) => reference.source === "storage")
    ).toBe(true);
    expect(result.objects).toHaveLength(2);
    expect(storage.putObject).toHaveBeenCalledTimes(2);
    const firstKey = storage.putObject.mock.calls[0]?.[0];
    expect(firstKey).toMatch(
      /^user-1\/image-inputs\/[a-f0-9]{32}\/[a-f0-9-]{36}\//
    );
    expect(firstKey).not.toContain("unsafe-generation");
  });

  it("同 generationId 的并发尝试使用不同对象前缀", async () => {
    setupStorage();

    await Promise.all([
      stageImageInputReferences({
        userId: "user-1",
        generationId: "generation-1",
        references: [createDataReference()],
      }),
      stageImageInputReferences({
        userId: "user-1",
        generationId: "generation-1",
        references: [createDataReference()],
      }),
    ]);

    const keys = storage.putObject.mock.calls.map((call) => call[0]);
    expect(new Set(keys).size).toBe(2);
  });

  it("复验并复用归属合法的现有 storage 引用", async () => {
    setupStorage();
    const reference = {
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: "user-1/existing.png",
      storageBucket: "uploads",
      byteLength: PNG_BYTES.byteLength,
    };
    mediaLoader.loadMediaInputs.mockResolvedValueOnce([
      {
        data: PNG_BYTES,
        type: "image/png",
        storageKey: reference.storageKey,
        storageBucket: reference.storageBucket,
      },
    ]);

    await expect(
      stageImageInputReferences({
        userId: "user-1",
        generationId: "generation-1",
        references: [reference],
      })
    ).resolves.toEqual({ references: [reference], objects: [] });
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("实际 MIME 或字节与声明不一致时不写对象", async () => {
    setupStorage();
    mediaLoader.loadMediaInputs.mockResolvedValueOnce([
      { data: Buffer.from("not-an-image"), type: "image/png" },
    ]);

    await expect(
      stageImageInputReferences({
        userId: "user-1",
        generationId: "generation-1",
        references: [createDataReference()],
      })
    ).rejects.toThrow();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("部分上传失败时删除本轮已经写入的对象", async () => {
    setupStorage();
    storage.putObject
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("upload failed"));

    await expect(
      stageImageInputReferences({
        userId: "user-1",
        generationId: "generation-1",
        references: [createDataReference(), createDataReference()],
      })
    ).rejects.toThrow("upload failed");
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it("未被 generation 采用时删除本轮对象", async () => {
    setupStorage();
    const staged = await stageImageInputReferences({
      userId: "user-1",
      generationId: "generation-1",
      references: [createDataReference()],
    });

    await expect(
      withStagedImageInputOwnership({
        objects: staged.objects,
        run: async () => "not-adopted",
      })
    ).resolves.toBe("not-adopted");
    expect(storage.deleteObject).toHaveBeenCalledWith(
      staged.objects[0]?.storageKey,
      "uploads"
    );
  });

  it("generation 持久化采用后保留输入对象", async () => {
    setupStorage();
    const staged = await stageImageInputReferences({
      userId: "user-1",
      generationId: "generation-1",
      references: [createDataReference()],
    });

    await expect(
      withStagedImageInputOwnership({
        objects: staged.objects,
        run: async (markAdopted) => {
          markAdopted();
          return "adopted";
        },
      })
    ).resolves.toBe("adopted");
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("generation 采用后的后续失败不会删除历史输入对象", async () => {
    setupStorage();
    const staged = await stageImageInputReferences({
      userId: "user-1",
      generationId: "generation-1",
      references: [createDataReference()],
    });

    await expect(
      withStagedImageInputOwnership({
        objects: staged.objects,
        run: async (markAdopted) => {
          markAdopted();
          throw new Error("failed after generation insert");
        },
      })
    ).rejects.toThrow("failed after generation insert");
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("拒绝清理当前 staging 空间以外的对象", async () => {
    setupStorage();

    await expect(
      cleanupStagedImageInputs([
        {
          userId: "user-1",
          storageKey: "user-2/image-inputs/foreign/input.png",
          storageBucket: "uploads",
        },
      ])
    ).rejects.toThrow("不属于当前 staging 空间");
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
