/**
 * 视频输入持久存储测试。
 *
 * 职责：验证 base64 不会保留在结果引用、稳定键可幂等重写、失败会清理且不会回退。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getStorageRuntimeSnapshot: vi.fn(),
}));

vi.mock("@repo/shared/storage/providers", () => ({
  getStorageRuntimeSnapshot: storage.getStorageRuntimeSnapshot,
}));

import {
  cleanupUnusedStagedVideoInputs,
  stageVideoInputReferences,
} from "./video-input-storage";

const DATA_REFERENCE = {
  source: "data" as const,
  mimeType: "image/png" as const,
  base64: Buffer.from("video-input").toString("base64"),
  byteLength: Buffer.byteLength("video-input"),
};

describe("video input storage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("把 data 引用写成稳定 storage 引用且不返回 base64", async () => {
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });

    const result = await stageVideoInputReferences({
      userId: "user-1",
      videoId: "video-1",
      references: [DATA_REFERENCE],
    });

    expect(result.references).toEqual([
      expect.objectContaining({
        source: "storage",
        storageBucket: "uploads",
        storageKey: expect.stringMatching(
          /^user-1\/video-inputs\/video-1\/0-[a-f0-9]{32}\.png$/
        ),
      }),
    ]);
    expect(JSON.stringify(result.references)).not.toContain("base64");
    expect(storage.putObject).toHaveBeenCalledTimes(1);
  });

  it("持久任务使用同一对象时竞争失败请求不会误删", async () => {
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });
    const staged = await stageVideoInputReferences({
      userId: "user-1",
      videoId: "video-1",
      references: [DATA_REFERENCE],
    });

    await cleanupUnusedStagedVideoInputs({
      objects: staged.objects,
      persistedReferences: staged.references,
    });

    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("上传失败时拒绝创建且不回退为 data 引用", async () => {
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });
    storage.putObject.mockRejectedValue(new Error("storage unavailable"));

    await expect(
      stageVideoInputReferences({
        userId: "user-1",
        videoId: "video-1",
        references: [DATA_REFERENCE],
      })
    ).rejects.toThrow("storage unavailable");
  });
});
