/**
 * 媒体限制纯函数策略测试。
 *
 * 覆盖默认值、硬边界、脏配置安全回退与用户覆盖来源；不连接数据库。
 */

import { describe, expect, it } from "vitest";

import {
  MEDIA_LIMIT_DEFAULTS,
  MEDIA_LIMIT_HARD_MAX,
  MediaLimitPolicyError,
  parseMediaLimitPolicy,
  parseMediaLimitValue,
  resolveEffectiveUserConcurrency,
  resolveMediaLimitPolicy,
} from "./media-limit-policy";

describe("media limit policy", () => {
  it("缺失系统设置时返回固定默认值和字节值", () => {
    expect(resolveMediaLimitPolicy({})).toEqual({
      ...MEDIA_LIMIT_DEFAULTS,
      maxFileSizeBytes: 5 * 1024 * 1024,
      maxUploadSizeBytes: 75 * 1024 * 1024,
    });
  });

  it("接受全部硬边界值", () => {
    expect(
      resolveMediaLimitPolicy({
        defaultUserConcurrency: MEDIA_LIMIT_HARD_MAX.userConcurrency,
        maxFileSizeMb: MEDIA_LIMIT_HARD_MAX.fileSizeMb,
        maxUploadSizeMb: MEDIA_LIMIT_HARD_MAX.uploadSizeMb,
        maxEditReferenceImages: MEDIA_LIMIT_HARD_MAX.editReferenceImages,
      })
    ).toMatchObject({
      defaultUserConcurrency: 10_000,
      maxFileSizeMb: 200,
      maxUploadSizeMb: 512,
      maxEditReferenceImages: 256,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    10_001,
  ])("严格拒绝非法用户并发值 %s", (value) => {
    expect(() =>
      parseMediaLimitValue(value, {
        label: "用户生图并发",
        max: MEDIA_LIMIT_HARD_MAX.userConcurrency,
      })
    ).toThrow(MediaLimitPolicyError);
  });

  it("脏配置只回退对应字段，保留其他合法配置", () => {
    expect(
      resolveMediaLimitPolicy({
        defaultUserConcurrency: "20.5",
        maxFileSizeMb: 12,
        maxUploadSizeMb: 513,
        maxEditReferenceImages: 32,
      })
    ).toMatchObject({
      defaultUserConcurrency: 20,
      maxFileSizeMb: 12,
      maxUploadSizeMb: 75,
      maxEditReferenceImages: 32,
    });
  });

  it("严格策略解析拒绝缺字段和超过硬上限", () => {
    expect(() => parseMediaLimitPolicy({})).toThrow(MediaLimitPolicyError);
    expect(() =>
      parseMediaLimitPolicy({
        ...MEDIA_LIMIT_DEFAULTS,
        maxFileSizeMb: 201,
      })
    ).toThrow(MediaLimitPolicyError);
  });

  it("null 覆盖继承系统默认，合法覆盖优先", () => {
    expect(
      resolveEffectiveUserConcurrency({
        systemDefault: 20,
        userOverride: null,
      })
    ).toEqual({
      limit: 20,
      override: null,
      effectiveSource: "system_default",
      scope: "user",
    });
    expect(
      resolveEffectiveUserConcurrency({
        systemDefault: 20,
        userOverride: 64,
      })
    ).toEqual({
      limit: 64,
      override: 64,
      effectiveSource: "user_override",
      scope: "user",
    });
  });
});
