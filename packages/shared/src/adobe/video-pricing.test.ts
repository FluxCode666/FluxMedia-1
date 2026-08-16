/**
 * 视频双模式计费纯函数测试。
 *
 * 覆盖旧按秒兼容、严格双矩阵解析、分组覆盖优先级和两种计费单位的舍入规则；测试
 * 不依赖数据库，确保配置、预估与任务创建可以共享同一个报价事实。
 */
import { describe, expect, it } from "vitest";
import { VIDEO_MODEL_CAPABILITIES } from "../video-generation";
import {
  ADOBE_VIDEO_PRICING_FAMILIES,
  convertLegacyVideoCreditsPerSecondToModelPricing,
  DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND,
  DEFAULT_VIDEO_MODEL_BILLING_MODES,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  getVideoCreditCost,
  getVideoPricingResolutionKey,
  getVideoPricingResolutions,
  globalVideoModelCreditsPerSecondSchema,
  resolveEffectiveVideoCreditsPerSecond,
  resolveVideoBillingQuote,
  resolveVideoCreditsPerSecond,
  resolveVideoCreditsPerSecondByResolution,
  videoModelBillingModesSchema,
} from "./video-pricing";

/** 为 Seedance 2 构造两套完整全局矩阵，单个测试只覆盖关心的差异。 */
function createStrictPricingInput(
  overrides: Partial<Parameters<typeof resolveVideoBillingQuote>[0]> = {}
): Parameters<typeof resolveVideoBillingQuote>[0] {
  return {
    modelId: "seedance2",
    resolution: "1080p",
    durationSeconds: 5,
    mode: "per_second",
    globalCreditsPerSecond: {
      "seedance2@480p": 1.111,
      "seedance2@720p": 1.222,
      "seedance2@1080p": 1.333,
    },
    globalCreditsPerItem: {
      "seedance2@480p": 2,
      "seedance2@720p": 3,
      "seedance2@1080p": 4,
    },
    ...overrides,
  };
}

describe("resolveVideoCreditsPerSecond", () => {
  it("从真实描述符的 billing family 与分辨率构造价格目录", () => {
    expect(ADOBE_VIDEO_PRICING_FAMILIES).toEqual(
      VIDEO_MODEL_CAPABILITIES.map((capability) => capability.billingFamily)
    );
    for (const capability of VIDEO_MODEL_CAPABILITIES) {
      expect(getVideoPricingResolutions(capability.billingFamily)).toEqual(
        capability.resolutions
      );
    }
  });

  it("全部真实模型与分辨率保持改造前的默认每秒积分", () => {
    const expectedByFamily = {
      sora2: 30,
      "sora2-pro": 60,
      veo31: 45,
      "veo31-fast": 30,
      "veo31-ref": 45,
      "kling-o3": 30,
      kling3: 30,
      "kling3-omni": 30,
      "runway-gen45": 30,
      ray314: 30,
      "ray314-hdr": 30,
      seedance2: 30,
      "seedance2-fast": 30,
    } as const;

    for (const capability of VIDEO_MODEL_CAPABILITIES) {
      const expected = expectedByFamily[capability.billingFamily];
      expect(
        DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND[capability.billingFamily]
      ).toBe(expected);
      for (const resolution of capability.resolutions) {
        expect(
          DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND[
            getVideoPricingResolutionKey(capability.billingFamily, resolution)
          ]
        ).toBe(expected);
      }
    }
  });

  it("新增视频族提供可由系统设置覆盖的默认每秒价格", () => {
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND["kling3-omni"]).toBe(30);
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND["runway-gen45"]).toBe(30);
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND.ray314).toBe(30);
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND["ray314-hdr"]).toBe(30);
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND.seedance2).toBe(30);
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND["seedance2-fast"]).toBe(30);
    expect(
      DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND[
        getVideoPricingResolutionKey("seedance2", "480p")
      ]
    ).toBe(30);
    expect(
      DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND[
        getVideoPricingResolutionKey("seedance2", "1080p")
      ]
    ).toBe(30);
  });

  it("全部内置模型默认按秒且每个分辨率按条默认 3 积分", () => {
    for (const capability of VIDEO_MODEL_CAPABILITIES) {
      expect(DEFAULT_VIDEO_MODEL_BILLING_MODES[capability.modelId]).toBe(
        "per_second"
      );
      for (const resolution of capability.resolutions) {
        expect(
          DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM[
            getVideoPricingResolutionKey(capability.modelId, resolution)
          ]
        ).toBe(3);
      }
    }
  });

  it("读取模型族配置的每秒积分", () => {
    const prices = { sora2: 42, "veo31-fast": 12.5 };
    expect(resolveVideoCreditsPerSecond("sora2", prices, 30)).toBe(42);
    expect(resolveVideoCreditsPerSecond("veo31-fast", prices, 30)).toBe(12.5);
  });

  it("未配置或非法模型族回退统一每秒基价", () => {
    const prices = { bad: -3, huge: 100_001, zero: 0 };
    expect(resolveVideoCreditsPerSecond("unknown", prices, 25)).toBe(25);
    expect(resolveVideoCreditsPerSecond("bad", prices, 25)).toBe(25);
    expect(resolveVideoCreditsPerSecond("zero", prices, 25)).toBe(25);
    expect(resolveVideoCreditsPerSecond("huge", prices, 25)).toBe(25);
    expect(resolveVideoCreditsPerSecond(null, prices, 25)).toBe(25);
    expect(resolveVideoCreditsPerSecond("sora2", null, 0)).toBe(
      DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND
    );
  });
});

describe("resolveVideoCreditsPerSecondByResolution", () => {
  it("优先读取模型族对应分辨率的每秒价格", () => {
    const prices = {
      seedance2: 60,
      [getVideoPricingResolutionKey("seedance2", "480p")]: 20,
      [getVideoPricingResolutionKey("seedance2", "720p")]: 35,
      [getVideoPricingResolutionKey("seedance2", "1080p")]: 60,
    };

    expect(
      resolveVideoCreditsPerSecondByResolution("seedance2", "480p", prices)
    ).toBe(20);
    expect(
      resolveVideoCreditsPerSecondByResolution("seedance2", "1080p", prices)
    ).toBe(60);
  });

  it("旧模型族价格兼容全部分辨率", () => {
    expect(
      resolveVideoCreditsPerSecondByResolution("seedance2", "4k", {
        seedance2: 42,
      })
    ).toBe(42);
  });

  it("旧全局配置会补齐内置模型的全部分辨率价格", () => {
    const parsed = globalVideoModelCreditsPerSecondSchema.parse(
      Object.fromEntries(
        Object.entries(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND).filter(
          ([key]) => !key.includes("@")
        )
      )
    );

    expect(parsed[getVideoPricingResolutionKey("seedance2", "480p")]).toBe(
      parsed.seedance2
    );
    expect(parsed[getVideoPricingResolutionKey("seedance2", "1080p")]).toBe(
      parsed.seedance2
    );
  });
});

describe("resolveEffectiveVideoCreditsPerSecond", () => {
  it("分组覆盖优先于全局模型每秒价格", () => {
    expect(
      resolveEffectiveVideoCreditsPerSecond({
        family: "sora2",
        global: { sora2: 30 },
        group: { sora2: 42 },
      })
    ).toBe(42);
    expect(
      resolveEffectiveVideoCreditsPerSecond({
        family: "sora2",
        global: { sora2: 30 },
        group: {},
      })
    ).toBe(30);
  });

  it("按分组分辨率、分组模型族、全局分辨率的顺序解析", () => {
    const global = {
      seedance2: 60,
      [getVideoPricingResolutionKey("seedance2", "480p")]: 20,
      [getVideoPricingResolutionKey("seedance2", "1080p")]: 60,
    };

    expect(
      resolveEffectiveVideoCreditsPerSecond({
        family: "seedance2",
        resolution: "480p",
        global,
        group: {
          seedance2: 50,
          [getVideoPricingResolutionKey("seedance2", "480p")]: 15,
        },
      })
    ).toBe(15);
    expect(
      resolveEffectiveVideoCreditsPerSecond({
        family: "seedance2",
        resolution: "1080p",
        global,
        group: { seedance2: 50 },
      })
    ).toBe(50);
    expect(
      resolveEffectiveVideoCreditsPerSecond({
        family: "seedance2",
        resolution: "1080p",
        global,
        group: {},
      })
    ).toBe(60);
  });
});

describe("getVideoCreditCost", () => {
  it("按模型族每秒价格乘时长", () => {
    expect(
      getVideoCreditCost({ durationSeconds: 8, creditsPerSecond: 42 })
    ).toBe(336);
    expect(
      getVideoCreditCost({ durationSeconds: 4, creditsPerSecond: 12.5 })
    ).toBe(50);
  });

  it("向上取两位小数并回退默认价格", () => {
    expect(
      getVideoCreditCost({ durationSeconds: 5, creditsPerSecond: 1.333 })
    ).toBe(6.67);
    expect(
      getVideoCreditCost({ durationSeconds: 8, creditsPerSecond: 0 })
    ).toBe(240);
    expect(
      getVideoCreditCost({ durationSeconds: 8, creditsPerSecond: 100_001 })
    ).toBe(240);
    expect(getVideoCreditCost({ durationSeconds: 0 })).toBe(0);
  });
});

describe("resolveVideoBillingQuote", () => {
  it("模式映射只接受模型级公开 ID，不能按分辨率混用模式", () => {
    expect(
      videoModelBillingModesSchema.parse({ seedance2: "per_item" })
    ).toEqual({ seedance2: "per_item" });
    expect(
      videoModelBillingModesSchema.safeParse({
        "seedance2@1080p": "per_item",
      }).success
    ).toBe(false);
  });

  it("按秒费用随时长变化并保持向上两位，按条费用不随时长变化", () => {
    const perSecondFive = resolveVideoBillingQuote(createStrictPricingInput());
    const perSecondEight = resolveVideoBillingQuote(
      createStrictPricingInput({ durationSeconds: 8 })
    );
    const perItemFive = resolveVideoBillingQuote(
      createStrictPricingInput({ mode: "per_item" })
    );
    const perItemEight = resolveVideoBillingQuote(
      createStrictPricingInput({ mode: "per_item", durationSeconds: 8 })
    );

    expect(perSecondFive).toMatchObject({
      mode: "per_second",
      unit: "second",
      unitPrice: 1.333,
      quotedCredits: 6.67,
    });
    expect(perSecondEight.quotedCredits).toBe(10.67);
    expect(perItemFive).toMatchObject({
      mode: "per_item",
      unit: "item",
      unitPrice: 4,
      quotedCredits: 4,
    });
    expect(perItemEight.quotedCredits).toBe(4);
  });

  it("按分组精确分辨率、分组模型级兼容、全局精确价的顺序解析", () => {
    expect(
      resolveVideoBillingQuote(
        createStrictPricingInput({
          groupCreditsPerSecond: {
            seedance2: 8,
            "seedance2@1080p": 9,
          },
        })
      )
    ).toMatchObject({ priceSource: "group_resolution", unitPrice: 9 });
    expect(
      resolveVideoBillingQuote(
        createStrictPricingInput({
          groupCreditsPerSecond: { seedance2: 8 },
        })
      )
    ).toMatchObject({ priceSource: "group_model", unitPrice: 8 });
    expect(resolveVideoBillingQuote(createStrictPricingInput())).toMatchObject({
      priceSource: "global_resolution",
      unitPrice: 1.333,
    });
  });

  it("按条缺少分组覆盖时只继承全局按条价格", () => {
    const quote = resolveVideoBillingQuote(
      createStrictPricingInput({
        mode: "per_item",
        groupCreditsPerSecond: { "seedance2@1080p": 99 },
        groupCreditsPerItem: {},
      })
    );

    expect(quote).toMatchObject({
      mode: "per_item",
      priceSource: "global_resolution",
      unitPrice: 4,
      quotedCredits: 4,
    });
  });

  it("旧 family 与 family@resolution 每秒键只经兼容边界转换", () => {
    const familyOnly = convertLegacyVideoCreditsPerSecondToModelPricing({
      seedance2: 7,
    });
    const resolutionOverride = convertLegacyVideoCreditsPerSecondToModelPricing(
      {
        seedance2: 7,
        "seedance2@1080p": 11,
      }
    );

    expect(familyOnly).toEqual({
      "seedance2@1080p": 7,
      "seedance2@720p": 7,
      "seedance2@480p": 7,
    });
    expect(resolutionOverride["seedance2@1080p"]).toBe(11);
    expect(resolutionOverride).not.toHaveProperty("seedance2");
  });

  it.each([
    {
      name: "非法模式",
      overrides: { mode: "hourly" },
    },
    {
      name: "非正全局价格",
      overrides: {
        globalCreditsPerItem: {
          "seedance2@480p": 2,
          "seedance2@720p": 3,
          "seedance2@1080p": 0,
        },
      },
    },
    {
      name: "非正分组价格",
      overrides: { groupCreditsPerSecond: { seedance2: -1 } },
    },
    {
      name: "缺少全局分辨率价格",
      overrides: {
        globalCreditsPerSecond: {
          "seedance2@480p": 1,
          "seedance2@1080p": 2,
        },
      },
    },
    {
      name: "只提供全局模型级兜底",
      overrides: {
        globalCreditsPerSecond: { seedance2: 2 },
      },
    },
    {
      name: "未知模型",
      overrides: { modelId: "unknown-model" },
    },
  ])("严格拒绝$name", ({ overrides }) => {
    expect(() =>
      resolveVideoBillingQuote(
        createStrictPricingInput(
          overrides as Partial<Parameters<typeof resolveVideoBillingQuote>[0]>
        )
      )
    ).toThrow();
  });
});
