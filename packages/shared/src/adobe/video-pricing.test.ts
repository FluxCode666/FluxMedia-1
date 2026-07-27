import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND,
  getVideoCreditCost,
  resolveEffectiveVideoCreditsPerSecond,
  resolveVideoCreditsPerSecond,
} from "./video-pricing";

describe("resolveVideoCreditsPerSecond", () => {
  it("Seedance 2.0 及 Fast 提供可由系统设置覆盖的默认每秒价格", () => {
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND.seedance2).toBe(30);
    expect(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND["seedance2-fast"]).toBe(30);
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
