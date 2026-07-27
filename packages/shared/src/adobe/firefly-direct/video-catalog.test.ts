import { describe, expect, it } from "vitest";
import {
  FIREFLY_VIDEO_FAMILIES,
  FIREFLY_VIDEO_MODEL_CATALOG,
  fireflyVideoMaxInputImages,
  fireflyVideoSize,
  isFireflyVideoModelId,
  resolveFireflyVideoModel,
} from "./video-catalog";

describe("firefly video catalog", () => {
  it("注册 9 个视频族", () => {
    expect(FIREFLY_VIDEO_FAMILIES.map((f) => f.family)).toEqual([
      "sora2",
      "sora2-pro",
      "veo31",
      "veo31-ref",
      "veo31-fast",
      "kling-o3",
      "kling3",
      "seedance2",
      "seedance2-fast",
    ]);
  });

  it("sora2 不拼分辨率,固定 720p,带 sora 上游", () => {
    const conf = resolveFireflyVideoModel("firefly-sora2-8s-16x9");
    expect(conf).toMatchObject({
      family: "sora2",
      upstreamModel: "openai:firefly:colligo:sora2",
      upstreamModelId: "sora",
      upstreamModelVersion: "sora-2",
      duration: 8,
      aspectRatio: "16:9",
      outputResolution: "720p",
      generateAudio: false,
    });
  });

  it("veo31 拼分辨率,veo31-fast 走 fast 版本", () => {
    expect(
      resolveFireflyVideoModel("firefly-veo31-6s-16x9-1080p")
    ).toMatchObject({
      family: "veo31",
      upstreamModelVersion: "3.1-generate",
      engine: "veo31-standard",
      duration: 6,
      outputResolution: "1080p",
    });
    expect(
      resolveFireflyVideoModel("firefly-veo31-fast-4s-9x16-720p")
    ).toMatchObject({
      family: "veo31-fast",
      upstreamModelVersion: "3.1-fast-generate",
      engine: "veo31-fast",
    });
  });

  it("裸 Veo/Kling 模型族兼容解析为同一 Firefly 目录", () => {
    expect(resolveFireflyVideoModel("veo31-6s-16x9-1080p")).toMatchObject({
      family: "veo31",
      upstreamModelId: "veo",
    });
    expect(resolveFireflyVideoModel("kling3-10s-16x9")).toMatchObject({
      family: "kling3",
      upstreamModelId: "kling",
    });
    expect(isFireflyVideoModelId("kling-o3-15s-9x16")).toBe(true);
  });

  it("veo31-ref 带 referenceMode=image", () => {
    expect(
      resolveFireflyVideoModel("firefly-veo31-ref-8s-16x9-1080p")?.referenceMode
    ).toBe("image");
  });

  it("kling3 默认生成音频,kling-o3 固定 1080p", () => {
    expect(
      resolveFireflyVideoModel("firefly-kling3-10s-16x9")?.generateAudio
    ).toBe(true);
    expect(
      resolveFireflyVideoModel("firefly-kling-o3-15s-9x16")?.outputResolution
    ).toBe("1080p");
  });

  it("Seedance 2.0 开放 4 至 15 秒、三档分辨率和六种比例", () => {
    const family = FIREFLY_VIDEO_FAMILIES.find(
      (item) => item.family === "seedance2"
    );
    expect(family).toEqual({
      family: "seedance2",
      label: "Seedance 2.0",
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
      resolutions: ["1080p", "720p", "480p"],
      resolutionInId: true,
      generateAudio: false,
      supportsAudio: true,
    });
    expect(
      Object.values(FIREFLY_VIDEO_MODEL_CATALOG).filter(
        (item) => item.family === "seedance2"
      )
    ).toHaveLength(216);

    const conf = resolveFireflyVideoModel("firefly-seedance2-15s-9x16-480p");
    expect(conf).toMatchObject({
      family: "seedance2",
      upstreamModel: "",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0",
      engine: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      outputResolution: "480p",
      size: { width: 480, height: 854 },
      generateAudio: false,
      supportsAudio: true,
      sourceImageMode: "original",
    });
    expect(resolveFireflyVideoModel("seedance2-15s-9x16-480p")).toEqual(conf);
    expect(
      resolveFireflyVideoModel("firefly-seedance2-3s-9x16-480p")
    ).toBeNull();
    expect(
      resolveFireflyVideoModel("firefly-seedance2-16s-9x16-480p")
    ).toBeNull();
  });

  it("Seedance 2.0 Fast 复用完整参数矩阵但只开放 480p 和 720p", () => {
    const family = FIREFLY_VIDEO_FAMILIES.find(
      (item) => item.family === "seedance2-fast"
    );
    expect(family).toEqual({
      family: "seedance2-fast",
      label: "Seedance 2.0 Fast",
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
      resolutions: ["720p", "480p"],
      resolutionInId: true,
      generateAudio: false,
      supportsAudio: true,
    });
    expect(
      Object.values(FIREFLY_VIDEO_MODEL_CATALOG).filter(
        (item) => item.family === "seedance2-fast"
      )
    ).toHaveLength(144);

    const conf = resolveFireflyVideoModel("firefly-seedance2-fast-4s-4x3-480p");
    expect(conf).toMatchObject({
      family: "seedance2-fast",
      upstreamModel: "",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0_fast",
      engine: "seedance2",
      duration: 4,
      aspectRatio: "4:3",
      outputResolution: "480p",
      size: { width: 640, height: 480 },
      generateAudio: false,
      supportsAudio: true,
      sourceImageMode: "original",
    });
    expect(resolveFireflyVideoModel("seedance2-fast-4s-4x3-480p")).toEqual(
      conf
    );
    expect(
      resolveFireflyVideoModel("firefly-seedance2-fast-4s-4x3-1080p")
    ).toBeNull();
  });

  it("非法/未知 model id 返回 null", () => {
    expect(resolveFireflyVideoModel("firefly-sora2-3s-16x9")).toBeNull();
    expect(resolveFireflyVideoModel("firefly-gpt-image-2-2k-1x1")).toBeNull();
    expect(isFireflyVideoModelId("firefly-veo31-6s-16x9-1080p")).toBe(true);
    expect(isFireflyVideoModelId("nope")).toBe(false);
    expect(isFireflyVideoModelId("sora2-8s-16x9")).toBe(false);
  });

  it("Seedance 尺寸以短边分辨率映射全部比例", () => {
    const expected = {
      "480p": {
        "1:1": { width: 480, height: 480 },
        "4:3": { width: 640, height: 480 },
        "3:4": { width: 480, height: 640 },
        "16:9": { width: 854, height: 480 },
        "9:16": { width: 480, height: 854 },
        "21:9": { width: 1120, height: 480 },
      },
      "720p": {
        "1:1": { width: 720, height: 720 },
        "4:3": { width: 960, height: 720 },
        "3:4": { width: 720, height: 960 },
        "16:9": { width: 1280, height: 720 },
        "9:16": { width: 720, height: 1280 },
        "21:9": { width: 1680, height: 720 },
      },
      "1080p": {
        "1:1": { width: 1080, height: 1080 },
        "4:3": { width: 1440, height: 1080 },
        "3:4": { width: 1080, height: 1440 },
        "16:9": { width: 1920, height: 1080 },
        "9:16": { width: 1080, height: 1920 },
        "21:9": { width: 2520, height: 1080 },
      },
    } as const;

    for (const [resolution, ratios] of Object.entries(expected)) {
      for (const [ratio, size] of Object.entries(ratios)) {
        expect(
          resolveFireflyVideoModel(
            `firefly-seedance2-4s-${ratio.replace(":", "x")}-${resolution}`
          )?.size
        ).toEqual(size);
      }
    }
    expect(fireflyVideoSize("720p", "16:9")).toEqual({
      width: 1280,
      height: 720,
    });
    expect(fireflyVideoSize("1080p", "9:16")).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(fireflyVideoSize("480p", "4:3")).toEqual({
      width: 640,
      height: 480,
    });
    expect(fireflyVideoSize("720p", "2:1")).toBeNull();
    const seedance = resolveFireflyVideoModel(
      "firefly-seedance2-15s-9x16-480p"
    );
    expect(seedance && fireflyVideoSize(seedance)).toEqual({
      width: 480,
      height: 854,
    });
  });

  it("按模型限制输入图数量", () => {
    const sora = resolveFireflyVideoModel("firefly-sora2-8s-16x9");
    const veo = resolveFireflyVideoModel("firefly-veo31-6s-16x9-1080p");
    const veoRef = resolveFireflyVideoModel("firefly-veo31-ref-6s-16x9-1080p");
    const kling = resolveFireflyVideoModel("firefly-kling3-10s-16x9");
    const seedance = resolveFireflyVideoModel(
      "firefly-seedance2-15s-9x16-480p"
    );
    const seedanceFast = resolveFireflyVideoModel(
      "firefly-seedance2-fast-15s-9x16-480p"
    );
    expect(sora && fireflyVideoMaxInputImages(sora)).toBe(1);
    expect(veo && fireflyVideoMaxInputImages(veo)).toBe(2);
    expect(veoRef && fireflyVideoMaxInputImages(veoRef)).toBe(3);
    expect(kling && fireflyVideoMaxInputImages(kling)).toBe(2);
    expect(seedance && fireflyVideoMaxInputImages(seedance)).toBe(1);
    expect(seedanceFast && fireflyVideoMaxInputImages(seedanceFast)).toBe(1);
  });
});
