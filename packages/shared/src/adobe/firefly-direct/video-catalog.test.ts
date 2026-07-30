/**
 * Adobe 视频真实模型映射与像素尺寸回归测试。
 *
 * 使用方：共享 Adobe 适配器测试；确保供应商目录只保存真实模型到 Adobe 协议身份的
 * 映射，不重新承载公共参数、输入能力或历史复合 ID 兼容逻辑。
 */

import { describe, expect, it } from "vitest";
import { VIDEO_MODEL_IDS } from "../../video-generation";

import * as videoCatalog from "./video-catalog";
import {
  FIREFLY_VIDEO_PROVIDER_MODELS,
  fireflyVideoSize,
  resolveFireflyVideoProviderModel,
} from "./video-catalog";

describe("firefly video provider catalog", () => {
  it("只按 13 个真实模型 ID 注册 Adobe 协议身份", () => {
    expect(Object.keys(FIREFLY_VIDEO_PROVIDER_MODELS)).toEqual(VIDEO_MODEL_IDS);
    expect(resolveFireflyVideoProviderModel("seedance2")).toMatchObject({
      modelId: "seedance2",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0",
      engine: "seedance2",
      webApp: "firefly",
      authProfile: "firefly",
      sourceImageMode: "original",
    });
    expect(resolveFireflyVideoProviderModel("seedance2-fast")).toMatchObject({
      modelId: "seedance2-fast",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0_fast",
    });
  });

  it.each([
    "firefly-seedance2",
    "firefly-seedance2-15s-9x16-480p",
    "seedance2-15s-9x16-480p",
    "kling3-10s-16x9",
    "SEEDANCE2",
    " seedance2 ",
    "unknown-video-model",
  ])("拒绝前缀、复合 ID、别名和非精确真实 ID：%s", (modelId) => {
    expect(resolveFireflyVideoProviderModel(modelId)).toBeNull();
  });

  it("不再导出复合目录、家族投影和历史解析 API", () => {
    expect(videoCatalog).not.toHaveProperty("FIREFLY_VIDEO_MODEL_CATALOG");
    expect(videoCatalog).not.toHaveProperty("FIREFLY_VIDEO_FAMILIES");
    expect(videoCatalog).not.toHaveProperty("LEGACY_VIDEO_MODEL_SHAPES");
    expect(videoCatalog).not.toHaveProperty("resolveFireflyVideoModelId");
    expect(videoCatalog).not.toHaveProperty("resolveFireflyVideoModel");
    expect(videoCatalog).not.toHaveProperty("isFireflyVideoModelId");
    expect(videoCatalog).not.toHaveProperty("fireflyVideoMaxInputImages");
  });

  it("供应商映射不复制时长、比例、分辨率、声音或输入数量能力", () => {
    for (const provider of Object.values(FIREFLY_VIDEO_PROVIDER_MODELS)) {
      expect(provider).not.toHaveProperty("duration");
      expect(provider).not.toHaveProperty("durations");
      expect(provider).not.toHaveProperty("aspectRatio");
      expect(provider).not.toHaveProperty("ratios");
      expect(provider).not.toHaveProperty("outputResolution");
      expect(provider).not.toHaveProperty("resolutions");
      expect(provider).not.toHaveProperty("generateAudio");
      expect(provider).not.toHaveProperty("supportsAudio");
      expect(provider).not.toHaveProperty("maxInputImages");
      expect(provider).not.toHaveProperty("maxReferenceImages");
    }
  });

  it("保留各供应商已验证的上游版本和网页 Profile", () => {
    expect(FIREFLY_VIDEO_PROVIDER_MODELS.sora2).toMatchObject({
      upstreamModel: "openai:firefly:colligo:sora2",
      upstreamModelId: "sora",
      upstreamModelVersion: "sora-2",
      webApp: "express",
    });
    expect(FIREFLY_VIDEO_PROVIDER_MODELS["sora2-pro"]).toMatchObject({
      upstreamModel: "openai:firefly:colligo:sora2-pro",
      upstreamModelId: "sora",
      upstreamModelVersion: "sora-2",
    });
    expect(FIREFLY_VIDEO_PROVIDER_MODELS["veo31-fast"]).toMatchObject({
      upstreamModelId: "veo",
      upstreamModelVersion: "3.1-fast-generate",
      engine: "veo31-fast",
      webApp: "express",
    });
    expect(FIREFLY_VIDEO_PROVIDER_MODELS["kling3-omni"]).toMatchObject({
      upstreamModelId: "kling",
      upstreamModelVersion: "kling_v3_omni",
      webApp: "firefly",
      sourceImageMode: "original",
    });
    expect(FIREFLY_VIDEO_PROVIDER_MODELS.ray314).toMatchObject({
      upstreamModelId: "luma",
      upstreamModelVersion: "3.14-ray",
    });
  });

  it("按独立分辨率和比例解析 Adobe 像素尺寸", () => {
    expect(fireflyVideoSize("480p", "16:9")).toEqual({
      width: 854,
      height: 480,
    });
    expect(fireflyVideoSize("720p", "9:16")).toEqual({
      width: 720,
      height: 1280,
    });
    expect(fireflyVideoSize("1080p", "4:3")).toEqual({
      width: 1440,
      height: 1080,
    });
    expect(fireflyVideoSize("4k", "21:9")).toEqual({
      width: 5040,
      height: 2160,
    });
    expect(fireflyVideoSize("720p", "2:1")).toBeNull();
  });
});
