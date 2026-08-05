/**
 * 媒体上传限制兼容服务测试。
 *
 * 验证旧套餐签名统一读取系统媒体策略，不再因套餐产生差异。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SUBSCRIPTION_PLANS } from "../../config/subscription-plan";

const BYTES_PER_MB = 1024 * 1024;

const mediaLimitMock = vi.hoisted(() => ({
  getMediaLimitDefaults: vi.fn(),
}));

vi.mock("../../image-generation/media-limit-service", () => ({
  getMediaLimitDefaults: mediaLimitMock.getMediaLimitDefaults,
}));

function megabytesToBytes(value: number) {
  return Math.floor(value * BYTES_PER_MB);
}

const limitsFor = (maxFileSizeMb: number, maxUploadSizeMb: number) => ({
  defaultUserConcurrency: 20,
  maxFileSizeMb,
  maxUploadSizeMb,
  maxEditReferenceImages: 16,
  maxFileSizeBytes: megabytesToBytes(maxFileSizeMb),
  maxUploadSizeBytes: megabytesToBytes(maxUploadSizeMb),
});

describe("getPlanUploadLimits", () => {
  beforeEach(() => {
    mediaLimitMock.getMediaLimitDefaults.mockReset();
  });

  it("returns system media limits regardless of the compatibility plan", async () => {
    mediaLimitMock.getMediaLimitDefaults.mockResolvedValue(limitsFor(5, 75));

    const { getPlanUploadLimits } = await import("./upload-limits");
    const starter = await getPlanUploadLimits("starter");
    const enterprise = await getPlanUploadLimits("enterprise");

    expect(starter).toEqual({
      maxFileSizeBytes: megabytesToBytes(5),
      maxUploadBytes: megabytesToBytes(75),
      maxEditImages: 16,
    });
    expect(enterprise).toEqual(starter);
  });
});

describe("getAllPlanUploadLimits", () => {
  beforeEach(() => {
    mediaLimitMock.getMediaLimitDefaults.mockReset();
  });

  it("returns upload limits for every SUBSCRIPTION_PLANS entry", async () => {
    mediaLimitMock.getMediaLimitDefaults.mockResolvedValue(limitsFor(10, 30));

    const { getAllPlanUploadLimits } = await import("./upload-limits");
    const all = await getAllPlanUploadLimits();

    // 键集合断言捕获硬编码套餐数组与 SUBSCRIPTION_PLANS 之间的漂移。
    expect(Object.keys(all).sort()).toEqual([...SUBSCRIPTION_PLANS].sort());
    for (const plan of SUBSCRIPTION_PLANS) {
      expect(all[plan]).toEqual({
        maxFileSizeBytes: megabytesToBytes(10),
        maxUploadBytes: megabytesToBytes(30),
        maxEditImages: 16,
      });
    }
  });
});
