/**
 * Adobe 视频具名供应商载荷契约测试。
 *
 * 使用方：共享 Adobe 适配器；锁定真实模型、独立参数、有效声音和具名素材 ID 到各家
 * 上游协议的映射，尤其防止 Seedance 参考图被截断或按上传时序重排。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import seedance2FrameFixture from "./fixtures/seedance2-frame-request.json";
import seedance2ReferenceFixture from "./fixtures/seedance2-reference-request.json";
import { buildFireflyVideoPayload } from "./payloads";

const BASE_REQUEST = {
  prompt: "<prompt>",
  model: "sora2" as const,
  duration: 8,
  aspectRatio: "16:9" as const,
  resolution: "720p" as const,
  size: { width: 1280, height: 720 },
  effectiveAudio: false,
};

/** 创建可重复断言的有序参考图占位符。 */
function createReferenceIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `<reference-${String(index + 1).padStart(2, "0")}>`
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildFireflyVideoPayload", () => {
  it("Seedance 2.0 首尾帧精确匹配脱敏协议夹具", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "seedance2",
      duration: 4,
      resolution: "480p",
      size: { width: 854, height: 480 },
      negativePrompt: "<negative-prompt>",
      firstFrameId: "<first-frame>",
      lastFrameId: "<last-frame>",
    });

    expect(payload).toEqual(seedance2FrameFixture);
    expect(payload).not.toHaveProperty("referenceFrames");
  });

  it("Seedance 2.0 十张参考图精确匹配脱敏协议夹具", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "seedance2",
      duration: 4,
      resolution: "480p",
      size: { width: 854, height: 480 },
      negativePrompt: "<negative-prompt>",
      referenceImageIds: createReferenceIds(10),
    });

    expect(payload).toEqual(seedance2ReferenceFixture);
    expect(payload).not.toHaveProperty("referenceFrames");
  });

  it("Seedance 2.0 原样保留二十张参考图的调用者顺序", () => {
    const referenceImageIds = createReferenceIds(20);
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      size: { width: 480, height: 854 },
      referenceImageIds,
    });

    expect(payload.referenceBlobs).toEqual(
      referenceImageIds.map((id) => ({ id, usage: "style" }))
    );
    expect(payload.generationMetadata).toEqual({
      module: "text2video",
      submodule: "ff-video-generate",
    });
  });

  it("Seedance 2.0 Fast 只替换已验证的 modelVersion", () => {
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "seedance2-fast",
      duration: 4,
      resolution: "480p",
      size: { width: 854, height: 480 },
      firstFrameId: "<first-frame>",
      lastFrameId: "<last-frame>",
    });

    expect(payload).toMatchObject({
      ...seedance2FrameFixture,
      seeds: [expect.any(Number)],
      modelVersion: "seedance_2.0_fast",
      negativePrompt: "",
    });
  });

  it("Seedance 2.0 Fast 原样保留二十张有序参考图", () => {
    const referenceImageIds = createReferenceIds(20);
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "seedance2-fast",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      size: { width: 480, height: 854 },
      referenceImageIds,
    });

    expect(payload).toMatchObject({
      modelId: "seedance",
      modelVersion: "seedance_2.0_fast",
      referenceBlobs: referenceImageIds.map((id) => ({
        id,
        usage: "style",
      })),
      generationMetadata: {
        module: "text2video",
        submodule: "ff-video-generate",
      },
    });
    expect(payload).not.toHaveProperty("referenceFrames");
  });

  it("Seedance 帧模式与参考图模式不能混合", () => {
    expect(() =>
      buildFireflyVideoPayload({
        ...BASE_REQUEST,
        model: "seedance2",
        firstFrameId: "first-frame",
        referenceImageIds: ["reference-1"],
      })
    ).toThrow("首尾帧和参考图不能同时提交");
  });

  it("Sora 只把 firstFrame 映射为 general 和 referenceFrames", () => {
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      firstFrameId: "first-frame",
    });

    expect(payload.referenceBlobs).toEqual([
      { id: "first-frame", usage: "general", promptReference: 1 },
    ]);
    expect(payload.referenceFrames).toEqual([
      { localBlobRef: "first-frame" },
      null,
    ]);
  });

  it.each([
    ["veo31", "3.1-generate"],
    ["veo31-fast", "3.1-fast-generate"],
  ] as const)("%s 按具名首尾帧生成 general 参考图", (model, version) => {
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model,
      duration: 6,
      resolution: "1080p",
      size: { width: 1920, height: 1080 },
      firstFrameId: "first-frame",
      lastFrameId: "last-frame",
    });

    expect(payload.modelVersion).toBe(version);
    expect(payload.referenceBlobs).toEqual([
      { id: "first-frame", usage: "general", promptReference: 1 },
      { id: "last-frame", usage: "general", promptReference: 2 },
    ]);
    expect(payload.modelSpecificPayload).toEqual({
      parameters: {
        durationSeconds: 6,
        aspectRatio: "16:9",
        addWaterMark: false,
      },
    });
  });

  it("Veo Reference 按调用者顺序映射一至三张 asset 参考图", () => {
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "veo31-ref",
      duration: 6,
      resolution: "1080p",
      size: { width: 1920, height: 1080 },
      referenceImageIds: ["reference-2", "reference-1", "reference-3"],
    });

    expect(payload.referenceBlobs).toEqual([
      { id: "reference-2", usage: "asset" },
      { id: "reference-1", usage: "asset" },
      { id: "reference-3", usage: "asset" },
    ]);
  });

  it.each([
    ["kling-o3", "kling_o3_pro_reference_to_video"],
    ["kling3", "kling_v3"],
  ] as const)("%s 按具名首尾帧生成从 1 开始的 frame 顺序", (model, version) => {
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model,
      duration: model === "kling-o3" ? 5 : 3,
      resolution: "1080p",
      size: { width: 1920, height: 1080 },
      effectiveAudio: model === "kling3",
      firstFrameId: "first-frame",
      lastFrameId: "last-frame",
    });

    expect(payload).toMatchObject({
      modelId: "kling",
      modelVersion: version,
      generationMetadata: { module: "image2video" },
      referenceBlobs: [
        { id: "first-frame", usage: "frame", order: 1 },
        { id: "last-frame", usage: "frame", order: 2 },
      ],
    });
  });

  it("Kling 3.0 Omni 的帧模式与参考图模式使用互斥字段", () => {
    const framePayload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "kling3-omni",
      duration: 3,
      resolution: "1080p",
      size: { width: 1920, height: 1080 },
      firstFrameId: "first-frame",
      lastFrameId: "last-frame",
    });
    const referencePayload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "kling3-omni",
      duration: 3,
      resolution: "1080p",
      size: { width: 1920, height: 1080 },
      referenceImageIds: ["reference-1", "reference-2", "reference-3"],
    });

    expect(framePayload).toMatchObject({
      generationMetadata: { module: "image2video" },
      referenceBlobs: [
        { id: "first-frame", usage: "frame", order: 1 },
        { id: "last-frame", usage: "frame", order: 2 },
      ],
    });
    expect(referencePayload).toMatchObject({
      generationMetadata: { module: "text2video" },
      referenceBlobs: [
        { id: "reference-1", usage: "asset" },
        { id: "reference-2", usage: "asset" },
        { id: "reference-3", usage: "asset" },
      ],
    });
    expect(() =>
      buildFireflyVideoPayload({
        ...BASE_REQUEST,
        model: "kling3-omni",
        firstFrameId: "first-frame",
        referenceImageIds: ["reference-1"],
      })
    ).toThrow("首尾帧和参考图不能同时提交");
  });

  it.each([
    "runway-gen45",
    "ray314",
    "ray314-hdr",
  ] as const)("%s 拒绝输入图片而不是静默忽略", (model) => {
    expect(() =>
      buildFireflyVideoPayload({
        ...BASE_REQUEST,
        model,
        duration: 5,
        resolution: model === "runway-gen45" ? "720p" : "4k",
        size:
          model === "runway-gen45"
            ? { width: 1280, height: 720 }
            : { width: 3840, height: 2160 },
        firstFrameId: "unsupported-frame",
      })
    ).toThrow("该视频模型不支持输入图片");
  });

  it("不支持声音的模型即使收到 true 也不会生成开启声音载荷", () => {
    const payload = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "veo31",
      duration: 6,
      effectiveAudio: true,
    });

    expect(payload.generateAudio).toBe(false);
  });

  it("Runway 与 Ray 保持各自已验证的纯文本协议字段", () => {
    const runway = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "runway-gen45",
      duration: 5,
      negativePrompt: "blurry",
    });
    const ray = buildFireflyVideoPayload({
      ...BASE_REQUEST,
      model: "ray314",
      duration: 5,
      resolution: "4k",
      size: { width: 3840, height: 2160 },
      negativePrompt: "blurry",
    });

    expect(runway).toEqual({
      modelId: "runway",
      modelVersion: "gen4.5",
      size: { width: 1280, height: 720 },
      seeds: [expect.any(Number)],
      prompt: "<prompt>",
      negativePrompt: "blurry",
      duration: 5,
      generationMetadata: {
        module: "text2video",
        submodule: "ff-video-generate",
      },
      output: { storeInputs: true },
    });
    expect(ray).toMatchObject({
      modelId: "luma",
      modelVersion: "3.14-ray",
      mode: "flex_2",
      modelSpecificPayload: {
        resolution: "4k",
        aspect_ratio: "16:9",
      },
    });
    expect(runway).not.toHaveProperty("generateAudio");
    expect(ray).not.toHaveProperty("generateAudio");
  });
});
