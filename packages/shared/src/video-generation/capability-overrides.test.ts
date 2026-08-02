/**
 * 视频模型动态能力覆盖测试。
 *
 * 覆盖 Seedance 默认值、任意正安全整数、严格设置解析和有效能力投影，确保缺行可默认、
 * 脏行 fail closed，且账号池或其他模型不能拥有参数覆盖。
 */
import { describe, expect, it } from "vitest";

import {
  createDefaultVideoModelCapabilityOverrides,
  parseVideoModelCapabilityOverrides,
  resolveEffectiveVideoModelCapability,
  videoModelCapabilityOverridesSchema,
} from "./capability-overrides";

describe("video model capability overrides", () => {
  it("缺少设置行或缺少模型覆盖时使用相互隔离的默认配置", () => {
    const first = createDefaultVideoModelCapabilityOverrides();
    const second = createDefaultVideoModelCapabilityOverrides();

    expect(parseVideoModelCapabilityOverrides(undefined)).toEqual(first);
    expect(parseVideoModelCapabilityOverrides(null)).toEqual(first);
    expect(first).not.toBe(second);
    expect(first.byModel).not.toBe(second.byModel);
    expect(
      resolveEffectiveVideoModelCapability("seedance2", undefined).input
        .referenceImages.maxCount
    ).toBe(10);
  });

  it.each([
    1,
    20,
    257,
    Number.MAX_SAFE_INTEGER,
  ])("Seedance 原样保留正安全整数参考图上限：%s", (maxReferenceImages) => {
    const effective = resolveEffectiveVideoModelCapability("seedance2", {
      version: 1,
      byModel: { seedance2: { maxReferenceImages } },
    });

    expect(effective.input.referenceImages.maxCount).toBe(maxReferenceImages);
    expect(effective.durations).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it("两个 Seedance 真实模型可独立覆盖", () => {
    const overrides = {
      version: 1 as const,
      byModel: {
        seedance2: { maxReferenceImages: 20 },
        "seedance2-fast": { maxReferenceImages: 1 },
      },
    };

    expect(
      resolveEffectiveVideoModelCapability("seedance2", overrides).input
        .referenceImages.maxCount
    ).toBe(20);
    expect(
      resolveEffectiveVideoModelCapability("seedance2-fast", overrides).input
        .referenceImages.maxCount
    ).toBe(1);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("拒绝非法参考图上限：%s", (maxReferenceImages) => {
    expect(
      videoModelCapabilityOverridesSchema.safeParse({
        version: 1,
        byModel: { seedance2: { maxReferenceImages } },
      }).success
    ).toBe(false);
  });

  it("拒绝未知模型和不可配置模型覆盖", () => {
    expect(
      videoModelCapabilityOverridesSchema.safeParse({
        version: 1,
        byModel: { unknown: { maxReferenceImages: 20 } },
      }).success
    ).toBe(false);
    expect(
      videoModelCapabilityOverridesSchema.safeParse({
        version: 1,
        byModel: { "kling3-omni": { maxReferenceImages: 20 } },
      }).success
    ).toBe(false);
  });

  it("设置存在但结构损坏时抛错，不静默回退默认 10", () => {
    expect(() =>
      parseVideoModelCapabilityOverrides({
        version: 1,
        byModel: { seedance2: { maxReferenceImages: 0 } },
      })
    ).toThrow();
    expect(() =>
      resolveEffectiveVideoModelCapability("seedance2", {
        version: 2,
        byModel: {},
      })
    ).toThrow();
    expect(() =>
      parseVideoModelCapabilityOverrides({
        version: 1,
        byModel: {},
        unexpected: true,
      })
    ).toThrow();
  });
});
