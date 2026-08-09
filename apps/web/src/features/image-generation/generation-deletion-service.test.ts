/**
 * 生成媒体删除服务的 DB-free 测试。
 *
 * 覆盖共享对象保护、媒体墓碑、历史用量证据保留和对象存储失败降级。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/shared/logger", () => ({ logError: vi.fn() }));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(),
}));

import {
  deleteGenerationMediaWithDependencies,
  type GenerationDeletionDependencies,
} from "./generation-deletion-service";

/** 创建可按测试覆盖的最小删除依赖。 */
function createDependencies(
  overrides: Partial<GenerationDeletionDependencies> = {}
): GenerationDeletionDependencies {
  return {
    loadOwned: vi.fn().mockResolvedValue([]),
    loadOther: vi.fn().mockResolvedValue([]),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    markMediaDeleted: vi.fn().mockResolvedValue(0),
    reportStorageError: vi.fn(),
    now: () => new Date("2026-08-09T06:00:00.000Z"),
    ...overrides,
  };
}

describe("generation deletion service", () => {
  it("removes unique media while preserving the task and usage evidence", async () => {
    const markMediaDeleted = vi.fn().mockResolvedValue(1);
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const dependencies = createDependencies({
      loadOwned: vi.fn().mockResolvedValue([
        {
          id: "generation-1",
          userId: "user-1",
          storageKey: "user-1/final.png",
          storageBucket: "generations",
          metadata: {
            outputImage: {
              billableImageOutputCount: 1,
              imageOutputs: [
                {
                  storageKey: "user-1/final.png",
                  imageUrl: "/api/storage/generations/user-1/final.png",
                },
              ],
            },
            inputImages: {
              images: [
                {
                  storageKey: "user-1/shared.png",
                  storageBucket: "generations",
                  imageUrl: "/api/storage/generations/user-1/shared.png",
                },
              ],
            },
          },
        },
      ]),
      loadOther: vi.fn().mockResolvedValue([
        {
          id: "generation-2",
          userId: "user-1",
          storageKey: null,
          storageBucket: "generations",
          metadata: {
            inputImages: {
              images: [
                {
                  storageKey: "user-1/shared.png",
                  storageBucket: "generations",
                },
              ],
            },
          },
        },
      ]),
      deleteObject,
      markMediaDeleted,
    });

    await expect(
      deleteGenerationMediaWithDependencies(
        { userId: "user-1", generationIds: ["generation-1"] },
        dependencies
      )
    ).resolves.toEqual({ deletedCount: 1 });

    expect(deleteObject).toHaveBeenCalledOnce();
    expect(deleteObject).toHaveBeenCalledWith({
      bucket: "generations",
      key: "user-1/final.png",
    });
    const updates = markMediaDeleted.mock.calls[0]?.[0];
    expect(updates).toHaveLength(1);
    expect(updates?.[0]?.metadata).toMatchObject({
      outputImage: {
        billableImageOutputCount: 1,
        photoRetention: {
          destroyedAt: "2026-08-09T06:00:00.000Z",
          reason: "user_deleted",
          storageObjectsDeleted: 1,
        },
      },
      inputImages: {
        images: [],
        photoRetention: { reason: "user_deleted" },
      },
    });
  });

  it("still hides media references when object storage deletion fails", async () => {
    const storageError = new Error("storage unavailable");
    const markMediaDeleted = vi.fn().mockResolvedValue(1);
    const reportStorageError = vi.fn();
    const dependencies = createDependencies({
      loadOwned: vi.fn().mockResolvedValue([
        {
          id: "generation-1",
          userId: "user-1",
          storageKey: "user-1/final.png",
          storageBucket: "generations",
          metadata: { outputImage: { billableImageOutputCount: 1 } },
        },
      ]),
      deleteObject: vi.fn().mockRejectedValue(storageError),
      markMediaDeleted,
      reportStorageError,
    });

    await expect(
      deleteGenerationMediaWithDependencies(
        { userId: "user-1", generationIds: ["generation-1"] },
        dependencies
      )
    ).resolves.toEqual({ deletedCount: 1 });
    expect(reportStorageError).toHaveBeenCalledWith(storageError, {
      userId: "user-1",
      generationCount: 1,
    });
    expect(markMediaDeleted).toHaveBeenCalledOnce();
  });
});
