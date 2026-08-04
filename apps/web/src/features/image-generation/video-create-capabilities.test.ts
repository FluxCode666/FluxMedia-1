/**
 * 视频创作面板能力投影测试。
 *
 * 使用方：Vitest；验证动态 Seedance 上限、当前分组可达性和非法响应拒绝，确保
 * 客户端不会继续依赖静态上限或把不可达模型当成可提交选项。
 */

import { describe, expect, it } from "vitest";
import {
  createStaticVideoCreateModels,
  parseReachableVideoCreateModels,
  resolveDefaultVideoCreateInputMode,
  resolveVideoCreateInputLimits,
} from "./video-create-capabilities";

const limits = {
  maxMediaInputCount: 256,
  maxMediaInputBytes: 209_715_200,
} as const;

describe("parseReachableVideoCreateModels", () => {
  it("只投影当前可达模型并保留 Seedance 动态参考图上限", () => {
    const models = parseReachableVideoCreateModels({
      items: [
        {
          model: "sora2",
          displayName: "Sora 2",
          durations: [4],
          aspectRatios: ["16:9"],
          resolutions: ["720p"],
          input: {
            frames: "first-only",
            referenceImages: { maxCount: 0, configurable: false },
            framesAndReferencesMutuallyExclusive: true,
          },
          audio: { supported: false, defaultEnabled: false },
          configuredReachable: false,
        },
        {
          model: "seedance2",
          displayName: "Seedance 2.0",
          durations: [10],
          aspectRatios: ["16:9"],
          resolutions: ["1080p"],
          input: {
            frames: "first-and-optional-last",
            referenceImages: { maxCount: 300, configurable: true },
            framesAndReferencesMutuallyExclusive: true,
          },
          audio: { supported: true, defaultEnabled: false },
          configuredReachable: true,
        },
      ],
      limits,
    });

    expect(models).toEqual([
      expect.objectContaining({
        model: "seedance2",
        maxFrameImages: 2,
        maxReferenceImages: 300,
        maxMediaInputCount: 256,
        maxMediaInputBytes: 209_715_200,
        supportsAudio: true,
      }),
    ]);
    const seedance = models[0];
    if (!seedance) throw new Error("Seedance 能力缺失");
    expect(resolveVideoCreateInputLimits(seedance, "references")).toEqual({
      modelMax: 300,
      selectableMax: 256,
    });
  });

  it("严格拒绝未知字段和非法动态上限", () => {
    expect(() =>
      parseReachableVideoCreateModels({ items: [], limits, memberId: "secret" })
    ).toThrow("视频模型能力响应格式无效");
    expect(() =>
      parseReachableVideoCreateModels({
        items: [
          {
            model: "seedance2",
            displayName: "Seedance 2.0",
            durations: [10],
            aspectRatios: ["16:9"],
            resolutions: ["1080p"],
            input: {
              frames: "first-and-optional-last",
              referenceImages: { maxCount: -1, configurable: true },
              framesAndReferencesMutuallyExclusive: true,
            },
            audio: { supported: true, defaultEnabled: false },
            configuredReachable: true,
          },
        ],
        limits,
      })
    ).toThrow("视频模型能力响应格式无效");
  });
});

describe("createStaticVideoCreateModels", () => {
  it("仅作为能力请求完成前的静态占位目录", () => {
    expect(createStaticVideoCreateModels()).toHaveLength(13);
    expect(
      createStaticVideoCreateModels().find((item) => item.model === "seedance2")
    ).toMatchObject({ maxReferenceImages: 10 });
  });

  it("为支持参考图的模型选择 references，其余模型保持 frames", () => {
    const models = createStaticVideoCreateModels();

    expect(
      resolveDefaultVideoCreateInputMode(
        models.find((item) => item.model === "veo31-ref")
      )
    ).toBe("references");
    expect(
      resolveDefaultVideoCreateInputMode(
        models.find((item) => item.model === "seedance2")
      )
    ).toBe("references");
    expect(
      resolveDefaultVideoCreateInputMode(
        models.find((item) => item.model === "sora2")
      )
    ).toBe("frames");
    expect(resolveDefaultVideoCreateInputMode(undefined)).toBe("frames");
  });
});
