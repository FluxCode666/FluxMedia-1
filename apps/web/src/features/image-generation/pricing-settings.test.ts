/**
 * 生图全局模型与分组覆盖运行时价格测试。
 *
 * 验证系统设置键不会在并行读取和结构化返回时串到错误的价格档位。
 */

import {
  createDefaultGlobalImageCreditOverrides,
  MissingGlobalImagePricingError,
} from "@repo/shared/image-backend/group-image-pricing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeSettingNumber:
    vi.fn<
      (
        key: string,
        fallback: number,
        options?: { positive?: boolean; nonNegative?: boolean }
      ) => Promise<number>
    >(),
  getRuntimeSettingJson: vi.fn<(key: string) => Promise<unknown>>(),
}));

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: mocks.getRuntimeSettingJson,
  getRuntimeSettingNumber: mocks.getRuntimeSettingNumber,
}));

import { getRuntimeImageCreditPricing } from "./pricing-settings";

describe("runtime image model credit pricing", () => {
  beforeEach(() => {
    mocks.getRuntimeSettingNumber.mockReset();
    mocks.getRuntimeSettingJson.mockReset();
  });

  it("merges group and global model prices and keeps zero moderation fees", async () => {
    const values: Record<string, number> = {
      IMAGE_TEXT_MODERATION_CREDITS: 0,
      IMAGE_INPUT_MODERATION_CREDITS: 0,
    };
    mocks.getRuntimeSettingNumber.mockImplementation(
      async (key, fallback) => values[key] ?? fallback
    );
    const globalPricing = createDefaultGlobalImageCreditOverrides();
    globalPricing.byModel["gpt-image-2"] = {
      base1024Credits: 1.27,
      base1kCredits: 1.27,
      base2kCredits: 6,
      base4kCredits: 10,
    };
    mocks.getRuntimeSettingJson.mockResolvedValue(globalPricing);

    await expect(
      getRuntimeImageCreditPricing("gpt-image-2", {
        version: 1,
        byModel: { "gpt-image-2": { base4kCredits: 7 } },
      })
    ).resolves.toEqual({
      basePricing: {
        base1024Credits: 1.27,
        base1kCredits: 1.27,
        base2kCredits: 6,
        base4kCredits: 7,
      },
      moderationPricing: {
        textModerationCredits: 0,
        imageModerationCredits: 0,
      },
    });
    expect(mocks.getRuntimeSettingNumber).toHaveBeenCalledWith(
      "IMAGE_TEXT_MODERATION_CREDITS",
      expect.any(Number),
      { nonNegative: true }
    );
    expect(mocks.getRuntimeSettingNumber).toHaveBeenCalledWith(
      "IMAGE_INPUT_MODERATION_CREDITS",
      expect.any(Number),
      { nonNegative: true }
    );
  });

  it("未显式配置价格的运行时模型拒绝计费", async () => {
    const globalPricing = createDefaultGlobalImageCreditOverrides();
    mocks.getRuntimeSettingJson.mockResolvedValue(globalPricing);
    mocks.getRuntimeSettingNumber.mockImplementation(
      async (_key, fallback) => fallback
    );

    await expect(
      getRuntimeImageCreditPricing("vendor-custom-image")
    ).rejects.toBeInstanceOf(MissingGlobalImagePricingError);
  });
});
