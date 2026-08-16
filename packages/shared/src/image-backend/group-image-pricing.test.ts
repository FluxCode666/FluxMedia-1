/**
 * 图像模型固定价格与分组媒体价格覆盖契约测试。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  resolveVideoBillingQuote,
} from "../adobe/video-pricing";

import {
  createDefaultGlobalImageCreditOverrides,
  getGroupImageCreditOverrides,
  getGroupVideoCreditOverrides,
  getGroupVideoCreditsPerItemOverrides,
  getImageModelCreditPricing,
  globalImageCreditOverridesSchema,
  imageCreditOverridesSchema,
  MissingGlobalImagePricingError,
  parseImageCreditOverrides,
  resolveImageCreditPricing,
} from "./group-image-pricing";

describe("group image pricing", () => {
  it("按分组、全局模型的顺序逐档继承", () => {
    expect(
      resolveImageCreditPricing({
        model: "firefly-nano-banana-pro-2k-1x1",
        global: {
          version: 1,
          byModel: {
            "nano-banana-pro": {
              base1024Credits: 1,
              base1kCredits: 3,
              base2kCredits: 6,
              base4kCredits: 8,
            },
          },
        },
        group: {
          version: 1,
          byModel: { "nano-banana-pro": { base2kCredits: 5 } },
        },
      })
    ).toEqual({
      base1024Credits: 1,
      base1kCredits: 3,
      base2kCredits: 5,
      base4kCredits: 8,
    });
  });

  it("模型匹配忽略大小写和 Firefly 前缀并优先最长前缀", () => {
    expect(
      getImageModelCreditPricing("FIREFLY-NANO-BANANA-PRO-4K-1X1", {
        "nano-banana": { base4kCredits: 7 },
        "Firefly-Nano-Banana-Pro": { base4kCredits: 9 },
      })
    ).toEqual({ base4kCredits: 9 });
  });

  it("允许未预置模型使用固定价格", () => {
    expect(
      getImageModelCreditPricing("custom-image-v3", {
        "custom-image-v3": { base1024Credits: 2.5 },
      })
    ).toEqual({ base1024Credits: 2.5 });
  });

  it("新建全局配置只包含真实内置模型", () => {
    const global = createDefaultGlobalImageCreditOverrides();

    expect(global.byModel).not.toHaveProperty("default");
    expect(Object.keys(global.byModel).length).toBeGreaterThan(0);
  });

  it("兼容读取旧 default 键但从规范结果和价格匹配中忽略", () => {
    const legacy = {
      ...createDefaultGlobalImageCreditOverrides(),
      byModel: {
        ...createDefaultGlobalImageCreditOverrides().byModel,
        default: {
          base1024Credits: 2,
          base1kCredits: 3,
          base2kCredits: 6,
          base4kCredits: 11,
        },
      },
    };

    expect(
      globalImageCreditOverridesSchema.parse(legacy).byModel
    ).not.toHaveProperty("default");
    expect(parseImageCreditOverrides(legacy).byModel).not.toHaveProperty(
      "default"
    );
    expect(getImageModelCreditPricing("default", legacy.byModel)).toEqual({});
  });

  it("自定义 API 模型只按分组覆盖和显式全局模型价格逐档继承", () => {
    const global = {
      version: 1 as const,
      byModel: {
        "vendor-custom-image-v3": {
          base1024Credits: 2,
          base1kCredits: 3,
          base2kCredits: 6,
          base4kCredits: 11,
        },
      },
    };

    expect(
      resolveImageCreditPricing({
        model: "vendor-custom-image-v3",
        global,
        group: {
          version: 1,
          byModel: {
            "vendor-custom-image-v3": { base2kCredits: 4.5 },
          },
        },
      })
    ).toEqual({
      base1024Credits: 2,
      base1kCredits: 3,
      base2kCredits: 4.5,
      base4kCredits: 11,
    });
  });

  it("缺少完整显式全局模型价格时 fail-closed", () => {
    const legacyDefault = {
      version: 1 as const,
      byModel: {
        default: {
          base1024Credits: 2,
          base1kCredits: 3,
          base2kCredits: 6,
          base4kCredits: 11,
        },
      },
    };

    for (const global of [
      legacyDefault,
      {
        version: 1 as const,
        byModel: {
          "vendor-custom-image-v3": {
            base1024Credits: 2,
            base1kCredits: 3,
          },
        },
      },
    ]) {
      expect(() =>
        resolveImageCreditPricing({
          model: "vendor-custom-image-v3",
          global,
          group: {
            version: 1,
            byModel: {
              "vendor-custom-image-v3": {
                base2kCredits: 4.5,
                base4kCredits: 9,
              },
            },
          },
        })
      ).toThrow(MissingGlobalImagePricingError);
    }
  });

  it("拒绝零、负数、超大价格和空模型配置", () => {
    for (const pricing of [
      { base1024Credits: 0 },
      { base1kCredits: -1 },
      { base2kCredits: 100_001 },
      {},
    ]) {
      expect(
        imageCreditOverridesSchema.safeParse({
          version: 1,
          byModel: { "gpt-image-2": pricing },
        }).success
      ).toBe(false);
    }
  });

  it("非法持久化值安全回退为空配置", () => {
    expect(
      parseImageCreditOverrides({ version: 1, byModel: { bad: {} } })
    ).toEqual({ version: 1, byModel: {} });
  });

  it("从分组 metadata 读取版本化覆盖", () => {
    expect(
      getGroupImageCreditOverrides({
        imageCreditOverrides: {
          version: 1,
          byModel: { "GPT-IMAGE-2": { base1kCredits: 3 } },
        },
      })
    ).toEqual({
      version: 1,
      byModel: { "gpt-image-2": { base1kCredits: 3 } },
    });
  });

  it("独立读取双视频价格并复用统一解析器的分辨率优先级", () => {
    const metadata = {
      videoCreditOverrides: {
        veo31: 35,
        "veo31@1080p": 45,
      },
      videoCreditsPerItemOverrides: {
        veo31: 4,
        "veo31@1080p": 5,
      },
    };

    expect(
      resolveVideoBillingQuote({
        modelId: "veo31",
        resolution: "1080p",
        durationSeconds: 8,
        mode: "per_item",
        globalCreditsPerSecond: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
        globalCreditsPerItem: DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
        groupCreditsPerSecond: getGroupVideoCreditOverrides(metadata),
        groupCreditsPerItem: getGroupVideoCreditsPerItemOverrides(metadata),
      })
    ).toMatchObject({
      mode: "per_item",
      unitPrice: 5,
      priceSource: "group_resolution",
    });

    expect(
      resolveVideoBillingQuote({
        modelId: "veo31",
        resolution: "720p",
        durationSeconds: 4,
        mode: "per_item",
        globalCreditsPerSecond: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
        globalCreditsPerItem: DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
        groupCreditsPerSecond: getGroupVideoCreditOverrides(metadata),
        groupCreditsPerItem: getGroupVideoCreditsPerItemOverrides(metadata),
      })
    ).toMatchObject({
      mode: "per_item",
      unitPrice: 4,
      priceSource: "group_model",
    });

    expect(
      resolveVideoBillingQuote({
        modelId: "sora2",
        resolution: "720p",
        durationSeconds: 8,
        mode: "per_item",
        globalCreditsPerSecond: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
        globalCreditsPerItem: DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
        groupCreditsPerSecond: getGroupVideoCreditOverrides(metadata),
        groupCreditsPerItem: getGroupVideoCreditsPerItemOverrides(metadata),
      })
    ).toMatchObject({
      mode: "per_item",
      unitPrice: 3,
      priceSource: "global_resolution",
    });
  });
});
