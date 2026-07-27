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
const cleanupQueue = vi.hoisted(() => ({
  enqueueVideoInputCleanup: vi.fn(),
}));

vi.mock("@repo/shared/storage/providers", () => ({
  getStorageRuntimeSnapshot: storage.getStorageRuntimeSnapshot,
}));

vi.mock("./video-input-cleanup-queue", () => ({
  enqueueVideoInputCleanup: cleanupQueue.enqueueVideoInputCleanup,
}));

import {
  cleanupUnusedStagedVideoInputs,
  stageVideoInputReferences,
  VIDEO_INPUT_UPLOAD_TIMEOUT_MS,
} from "./video-input-storage";
import { VIDEO_STAGING_RESERVATION_TTL_MS } from "./video-task-admission";

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
      attemptId: "reservation-1",
      references: [DATA_REFERENCE],
    });

    expect(result.references).toEqual([
      expect.objectContaining({
        source: "storage",
        storageBucket: "uploads",
        storageKey: expect.stringMatching(
          /^user-1\/video-inputs\/video-1\/reservation-1\/0-[a-f0-9]{32}\.png$/
        ),
      }),
    ]);
    expect(JSON.stringify(result.references)).not.toContain("base64");
    expect(cleanupQueue.enqueueVideoInputCleanup).toHaveBeenCalledTimes(1);
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(
      cleanupQueue.enqueueVideoInputCleanup.mock.invocationCallOrder[0]
    ).toBeLessThan(storage.putObject.mock.invocationCallOrder[0] ?? 0);
  });

  it("过期 reservation 的迟到清理不会命中新尝试对象 key", async () => {
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });
    storage.putObject.mockResolvedValue(undefined);

    const first = await stageVideoInputReferences({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "expired-reservation",
      references: [DATA_REFERENCE],
    });
    const second = await stageVideoInputReferences({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "current-reservation",
      references: [DATA_REFERENCE],
    });

    expect(first.objects[0]?.storageKey).not.toBe(
      second.objects[0]?.storageKey
    );
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
      attemptId: "reservation-1",
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
        attemptId: "reservation-1",
        references: [DATA_REFERENCE],
      })
    ).rejects.toThrow("storage unavailable");
  });

  it("上传取消边界早于 reservation 到期且保留持久清理意图", async () => {
    let uploadSignal: AbortSignal | undefined;
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });
    storage.putObject.mockImplementation((...args: unknown[]) => {
      uploadSignal = (args[4] as { signal?: AbortSignal } | undefined)?.signal;
      return Promise.reject(new DOMException("upload timed out", "AbortError"));
    });

    await expect(
      stageVideoInputReferences({
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        references: [DATA_REFERENCE],
      })
    ).rejects.toThrow("upload timed out");

    expect(VIDEO_INPUT_UPLOAD_TIMEOUT_MS).toBeLessThan(
      VIDEO_STAGING_RESERVATION_TTL_MS
    );
    expect(uploadSignal).toBeInstanceOf(AbortSignal);
    expect(cleanupQueue.enqueueVideoInputCleanup).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("同一次 staging 的所有对象共享绝对上传 deadline", async () => {
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });
    storage.putObject.mockResolvedValue(undefined);

    await stageVideoInputReferences({
      userId: "user-1",
      videoId: "video-1",
      attemptId: "reservation-1",
      references: [DATA_REFERENCE, DATA_REFERENCE],
    });

    const firstOptions = storage.putObject.mock.calls[0]?.[4] as
      | { signal?: AbortSignal }
      | undefined;
    const secondOptions = storage.putObject.mock.calls[1]?.[4] as
      | { signal?: AbortSignal }
      | undefined;
    expect(firstOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(secondOptions?.signal).toBe(firstOptions?.signal);
  });

  it("即时删除失败时登记持久清理而不遗失对象身份", async () => {
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });
    storage.deleteObject.mockRejectedValue(new Error("storage offline"));
    cleanupQueue.enqueueVideoInputCleanup.mockResolvedValue(1);

    await expect(
      cleanupUnusedStagedVideoInputs({
        objects: [
          {
            userId: "user-1",
            videoId: "video-1",
            attemptId: "reservation-1",
            storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
            storageBucket: "uploads",
          },
        ],
      })
    ).rejects.toThrow("storage offline");
    expect(cleanupQueue.enqueueVideoInputCleanup).toHaveBeenCalledWith([
      {
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        storageKey: "user-1/video-inputs/video-1/reservation-1/input.png",
        storageBucket: "uploads",
      },
    ]);
  });

  it("持久化前拒绝客户端指定其他 bucket 的 storage 引用", async () => {
    storage.getStorageRuntimeSnapshot.mockResolvedValue({
      provider: {
        putObject: storage.putObject,
        deleteObject: storage.deleteObject,
      },
      bucketName: "uploads",
    });

    await expect(
      stageVideoInputReferences({
        userId: "user-1",
        videoId: "video-1",
        attemptId: "reservation-1",
        references: [
          {
            source: "storage",
            mimeType: "image/png",
            storageKey: "user-1/existing.png",
            storageBucket: "other-bucket",
            byteLength: 10,
          },
        ],
      })
    ).rejects.toThrow("不属于当前用户或 bucket");
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
