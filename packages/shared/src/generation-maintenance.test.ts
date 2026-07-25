/**
 * 生成维护模块的 DB-free 纯逻辑测试。
 *
 * 覆盖超时退款、图片引用清理及保留策略，避免测试触发真实数据库写入。
 */

import { describe, expect, it } from "vitest";

async function loadHelpers() {
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/gpt2image_test";
  return await import("./generation-maintenance");
}

describe("generation photo retention helpers", () => {
  it("collects primary, additional output, and uploaded input storage keys without duplicates", async () => {
    const { collectGenerationImageStorageReferences } = await loadHelpers();

    expect(
      collectGenerationImageStorageReferences({
        storageBucket: "generations",
        storageKey: "user/final.png",
        metadata: {
          inputImages: {
            images: [
              {
                storageKey: "user/reference.png",
                storageBucket: "generations",
              },
              { storageKey: "user/final.png" },
            ],
          },
          outputImage: {
            imageOutputs: [
              { storageKey: "user/draft.png" },
              { storageKey: "user/final.png" },
              { imageUrl: "/api/storage/generations/user/remote.png" },
            ],
          },
        },
      })
    ).toEqual([
      { bucket: "generations", key: "user/final.png" },
      { bucket: "generations", key: "user/draft.png" },
      { bucket: "generations", key: "user/reference.png" },
    ]);
  });

  it("strips image references while keeping accounting metadata", async () => {
    const { stripDestroyedGenerationImageReferences } = await loadHelpers();

    const metadata = stripDestroyedGenerationImageReferences(
      {
        inputImages: {
          images: [
            {
              id: "input-1",
              storageBucket: "generations",
              storageKey: "user/reference.png",
              imageUrl: "/api/storage/generations/user/reference.png",
              name: "reference.png",
            },
          ],
        },
        outputImage: {
          actualSize: "1024x1024",
          billableImageOutputCount: 1,
          imageOutputs: [
            {
              generationId: "gen-1",
              storageKey: "user/final.png",
              imageUrl: "/api/storage/generations/user/final.png",
              imageFileId: "file-1",
              size: "1024x1024",
              primary: true,
            },
          ],
        },
      },
      {
        destroyedAt: "2026-05-27T00:00:00.000Z",
        retentionHours: 24,
        storageObjectsDeleted: 1,
      }
    );

    expect(metadata.outputImage).toMatchObject({
      actualSize: "1024x1024",
      billableImageOutputCount: 1,
      photoRetention: {
        destroyedAt: "2026-05-27T00:00:00.000Z",
        retentionHours: 24,
        storageObjectsDeleted: 1,
      },
    });
    expect(
      (
        metadata.outputImage as {
          imageOutputs: Array<Record<string, unknown>>;
        }
      ).imageOutputs[0]
    ).toEqual({
      generationId: "gen-1",
      size: "1024x1024",
      primary: true,
    });
    expect(
      (
        metadata.inputImages as {
          images: Array<Record<string, unknown>>;
        }
      ).images[0]
    ).toEqual({
      id: "input-1",
      name: "reference.png",
    });
  });
});

describe("computeTimeoutRefund", () => {
  it("refunds the whole charge when target keeps nothing", async () => {
    const { computeTimeoutRefund } = await loadHelpers();
    expect(computeTimeoutRefund({ chargedCredits: 10, targetCredits: 0 })).toBe(
      10
    );
  });

  it("refunds only the difference above the target", async () => {
    const { computeTimeoutRefund } = await loadHelpers();
    expect(computeTimeoutRefund({ chargedCredits: 10, targetCredits: 4 })).toBe(
      6
    );
  });

  it("never refunds a negative amount when target exceeds the charge", async () => {
    const { computeTimeoutRefund } = await loadHelpers();
    expect(computeTimeoutRefund({ chargedCredits: 4, targetCredits: 10 })).toBe(
      0
    );
  });
});

describe("createTimedOutImageCreditOperation", () => {
  it("attributes a timeout refund to the original generation creation time", async () => {
    const { createTimedOutImageCreditOperation } = await loadHelpers();
    const generationCreatedAt = new Date("2026-07-20T23:30:00.000Z");

    expect(
      createTimedOutImageCreditOperation({
        generationId: "generation-1",
        generationCreatedAt,
      })
    ).toEqual({
      operationType: "image_generation",
      operationId: "generation-1",
      operationCreatedAt: generationCreatedAt,
    });
  });
});

describe("resolvePhotoRetentionWindow", () => {
  it("disables destruction when retention hours are non-positive", async () => {
    const { resolvePhotoRetentionWindow } = await loadHelpers();
    const now = new Date("2026-05-31T00:00:00.000Z");
    expect(resolvePhotoRetentionWindow(0, now)).toEqual({
      enabled: false,
      cutoff: null,
    });
    expect(resolvePhotoRetentionWindow(-5, now)).toEqual({
      enabled: false,
      cutoff: null,
    });
  });

  it("computes a cutoff offset by the retention hours", async () => {
    const { resolvePhotoRetentionWindow } = await loadHelpers();
    const now = new Date("2026-05-31T00:00:00.000Z");
    const result = resolvePhotoRetentionWindow(24, now);
    expect(result.enabled).toBe(true);
    expect(result.cutoff?.toISOString()).toBe("2026-05-30T00:00:00.000Z");
  });
});

describe("resolveMaxCountRetention", () => {
  it("disables cleanup when the max count is non-positive or not finite", async () => {
    const { resolveMaxCountRetention } = await loadHelpers();
    // 护栏：<=0 或非有限数绝不进入删除路径，防止"保留 0 张=删光全站"。
    expect(resolveMaxCountRetention(0)).toEqual({
      enabled: false,
      maxCount: 0,
    });
    expect(resolveMaxCountRetention(-1)).toEqual({
      enabled: false,
      maxCount: 0,
    });
    expect(resolveMaxCountRetention(Number.NaN)).toEqual({
      enabled: false,
      maxCount: 0,
    });
    expect(resolveMaxCountRetention(Number.POSITIVE_INFINITY)).toEqual({
      enabled: false,
      maxCount: 0,
    });
  });

  it("enables cleanup and floors the threshold to an integer offset", async () => {
    const { resolveMaxCountRetention } = await loadHelpers();
    expect(resolveMaxCountRetention(10000)).toEqual({
      enabled: true,
      maxCount: 10000,
    });
    // 小数阈值向下取整，避免传给 SQL OFFSET 的非整数。
    expect(resolveMaxCountRetention(5.9)).toEqual({
      enabled: true,
      maxCount: 5,
    });
  });
});

describe("shouldRunMaxCountCleanupOnSettingsChange", () => {
  it("triggers only when the retention mode was changed to count", async () => {
    const { shouldRunMaxCountCleanupOnSettingsChange } = await loadHelpers();
    const MODE = "GENERATION_IMAGE_RETENTION_MODE";
    expect(shouldRunMaxCountCleanupOnSettingsChange([MODE], "count")).toBe(
      true
    );
  });

  it("does not trigger for non-count values, clears, or unchanged mode", async () => {
    const { shouldRunMaxCountCleanupOnSettingsChange } = await loadHelpers();
    const MODE = "GENERATION_IMAGE_RETENTION_MODE";
    // 切到其他模式不触发。
    expect(shouldRunMaxCountCleanupOnSettingsChange([MODE], "time")).toBe(
      false
    );
    expect(shouldRunMaxCountCleanupOnSettingsChange([MODE], "off")).toBe(false);
    // 清空（回退默认）传 undefined，不误判为启用。
    expect(shouldRunMaxCountCleanupOnSettingsChange([MODE], undefined)).toBe(
      false
    );
    // 模式键本次未变更（仅改了张数）即使值恰为 count 也不触发。
    expect(
      shouldRunMaxCountCleanupOnSettingsChange(
        ["GENERATION_IMAGE_MAX_COUNT"],
        "count"
      )
    ).toBe(false);
  });
});
