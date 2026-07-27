import { describe, expect, it } from "vitest";
import {
  FIREFLY_VIDEO_FAMILIES,
  fireflyVideoMaxInputImages,
  fireflyVideoSize,
  isFireflyVideoModelId,
  resolveFireflyVideoModel,
} from "./video-catalog";

describe("firefly video catalog", () => {
  it("注册 8 个视频族", () => {
    expect(FIREFLY_VIDEO_FAMILIES.map((f) => f.family)).toEqual([
      "sora2",
      "sora2-pro",
      "veo31",
      "veo31-ref",
      "veo31-fast",
      "kling-o3",
      "kling3",
      "seedance2",
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

  it("Seedance 2.0 只开放已抓包验证的精确组合", () => {
    const conf = resolveFireflyVideoModel("firefly-seedance2-15s-9x16-720p");
    expect(conf).toMatchObject({
      family: "seedance2",
      upstreamModel: "",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0",
      engine: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      outputResolution: "720p",
      size: { width: 480, height: 854 },
      generateAudio: false,
      sourceImageMode: "original",
    });
    expect(resolveFireflyVideoModel("seedance2-15s-9x16-720p")).toEqual(conf);
    expect(
      resolveFireflyVideoModel("firefly-seedance2-10s-9x16-720p")
    ).toBeNull();
    expect(
      resolveFireflyVideoModel("firefly-seedance2-15s-16x9-720p")
    ).toBeNull();
  });

  it("非法/未知 model id 返回 null", () => {
    expect(resolveFireflyVideoModel("firefly-sora2-3s-16x9")).toBeNull();
    expect(resolveFireflyVideoModel("firefly-gpt-image-2-2k-1x1")).toBeNull();
    expect(isFireflyVideoModelId("firefly-veo31-6s-16x9-1080p")).toBe(true);
    expect(isFireflyVideoModelId("nope")).toBe(false);
    expect(isFireflyVideoModelId("sora2-8s-16x9")).toBe(false);
  });

  it("size 映射", () => {
    expect(fireflyVideoSize("720p", "16:9")).toEqual({
      width: 1280,
      height: 720,
    });
    expect(fireflyVideoSize("1080p", "9:16")).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(fireflyVideoSize("720p", "1:1")).toBeNull();
    const seedance = resolveFireflyVideoModel(
      "firefly-seedance2-15s-9x16-720p"
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
      "firefly-seedance2-15s-9x16-720p"
    );
    expect(sora && fireflyVideoMaxInputImages(sora)).toBe(1);
    expect(veo && fireflyVideoMaxInputImages(veo)).toBe(2);
    expect(veoRef && fireflyVideoMaxInputImages(veoRef)).toBe(3);
    expect(kling && fireflyVideoMaxInputImages(kling)).toBe(2);
    expect(seedance && fireflyVideoMaxInputImages(seedance)).toBe(1);
  });
});
