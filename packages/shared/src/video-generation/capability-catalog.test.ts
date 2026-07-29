/**
 * 真实视频模型静态能力目录测试。
 *
 * 覆盖 13 个描述符的参数、输入、声音与计费身份，并锁定非法模型和非法参数组合的
 * 结构化失败结果，防止能力再次被编码进模型 ID。
 */
import { describe, expect, it } from "vitest";

import {
  resolveVideoModelCapability,
  VIDEO_MODEL_CAPABILITIES,
  validateVideoModelParameters,
} from "./capability-catalog";

const EXPECTED_PARAMETER_MATRIX = {
  sora2: {
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
  },
  "sora2-pro": {
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
  },
  veo31: {
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
  },
  "veo31-fast": {
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
  },
  "veo31-ref": {
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
  },
  "kling-o3": {
    durations: [5, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p"],
  },
  kling3: {
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
  },
  "kling3-omni": {
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
  },
  "runway-gen45": {
    durations: [5, 8, 10],
    aspectRatios: ["16:9"],
    resolutions: ["720p"],
  },
  ray314: {
    durations: [5, 10],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["4k", "1080p", "720p"],
  },
  "ray314-hdr": {
    durations: [5],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["4k", "1080p", "720p"],
  },
  seedance2: {
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["1080p", "720p", "480p"],
  },
  "seedance2-fast": {
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["720p", "480p"],
  },
} as const;

const EXPECTED_INPUT_AND_AUDIO_MATRIX = {
  sora2: ["first-only", 0, false, false, false],
  "sora2-pro": ["first-only", 0, false, false, false],
  veo31: ["first-and-optional-last", 0, false, false, false],
  "veo31-fast": ["first-and-optional-last", 0, false, false, false],
  "veo31-ref": ["none", 3, false, false, false],
  "kling-o3": ["first-and-optional-last", 0, false, false, false],
  kling3: ["first-and-optional-last", 0, true, true, false],
  "kling3-omni": ["first-and-optional-last", 3, true, false, true],
  "runway-gen45": ["none", 0, false, false, false],
  ray314: ["none", 0, false, false, false],
  "ray314-hdr": ["none", 0, false, false, false],
  seedance2: ["first-and-optional-last", 10, true, false, true],
  "seedance2-fast": ["first-and-optional-last", 10, true, false, true],
} as const;

describe("video model capability catalog", () => {
  it("以真实模型 ID 注册完整参数集合且计费身份不漂移", () => {
    expect(
      Object.fromEntries(
        VIDEO_MODEL_CAPABILITIES.map((capability) => [
          capability.modelId,
          {
            durations: capability.durations,
            aspectRatios: capability.aspectRatios,
            resolutions: capability.resolutions,
          },
        ])
      )
    ).toEqual(EXPECTED_PARAMETER_MATRIX);
    expect(
      VIDEO_MODEL_CAPABILITIES.map((capability) => capability.billingFamily)
    ).toEqual(VIDEO_MODEL_CAPABILITIES.map((capability) => capability.modelId));
  });

  it("输入与声音能力遵循产品矩阵", () => {
    expect(
      Object.fromEntries(
        VIDEO_MODEL_CAPABILITIES.map((capability) => [
          capability.modelId,
          [
            capability.input.frames,
            capability.input.referenceImages.maxCount,
            capability.audio.supported,
            capability.audio.defaultEnabled,
            capability.input.framesAndReferencesMutuallyExclusive,
          ],
        ])
      )
    ).toEqual(EXPECTED_INPUT_AND_AUDIO_MATRIX);
    expect(
      VIDEO_MODEL_CAPABILITIES.filter(
        (capability) => capability.input.referenceImages.configurable
      ).map((capability) => capability.modelId)
    ).toEqual(["seedance2", "seedance2-fast"]);
  });

  it("真实 Seedance ID 能解析能力，旧身份不能被兼容解析", () => {
    expect(resolveVideoModelCapability("seedance2")).toMatchObject({
      ok: true,
      capability: { modelId: "seedance2" },
    });
    expect(
      resolveVideoModelCapability("seedance2-15s-9x16-480p")
    ).toMatchObject({
      ok: false,
      error: { code: "unsupported_model", field: "model" },
    });
    expect(
      resolveVideoModelCapability("firefly-seedance2-15s-9x16-480p")
    ).toMatchObject({
      ok: false,
      error: { code: "unsupported_model", field: "model" },
    });
    expect(resolveVideoModelCapability("kling3-10s-16x9")).toMatchObject({
      ok: false,
      error: { code: "unsupported_model", field: "model" },
    });
  });

  it("返回合法组合或可定位的结构化参数错误", () => {
    expect(
      validateVideoModelParameters({
        model: "seedance2",
        duration: 15,
        aspectRatio: "9:16",
        resolution: "480p",
      })
    ).toMatchObject({ ok: true, capability: { modelId: "seedance2" } });
    expect(
      validateVideoModelParameters({
        model: "sora2",
        duration: 3,
        aspectRatio: "16:9",
        resolution: "720p",
      })
    ).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_duration",
        field: "duration",
        allowed: [4, 8, 12],
        received: 3,
      },
    });
    expect(
      validateVideoModelParameters({
        model: "sora2",
        duration: 4,
        aspectRatio: "1:1",
        resolution: "720p",
      })
    ).toMatchObject({
      ok: false,
      error: { code: "unsupported_aspect_ratio", field: "aspectRatio" },
    });
    expect(
      validateVideoModelParameters({
        model: "sora2",
        duration: 4,
        aspectRatio: "16:9",
        resolution: "1080p",
      })
    ).toMatchObject({
      ok: false,
      error: { code: "unsupported_resolution", field: "resolution" },
    });
  });
});
