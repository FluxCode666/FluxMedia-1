import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  getVideoCreditCost,
  getVideoPricingResolutionKey,
  globalVideoModelCreditsPerSecondSchema,
  resolveEffectiveVideoCreditsPerSecond,
  resolveVideoCreditsPerSecond,
  resolveVideoCreditsPerSecondByResolution,
} from "./video-pricing";

describe("resolveVideoCreditsPerSecond", () => {
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
