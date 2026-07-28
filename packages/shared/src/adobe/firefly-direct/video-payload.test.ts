import { describe, expect, it } from "vitest";
import { buildFireflyVideoPayload } from "./payloads";

const base = {
  prompt: "a cat surfing",
  upstreamModel: "openai:firefly:colligo:sora2",
  upstreamModelId: "sora",
  upstreamModelVersion: "sora-2",
  engine: "sora2",
  duration: 8,
  aspectRatio: "16:9",
  outputResolution: "720p",
  size: { width: 1280, height: 720 },
  generateAudio: false,
};

describe("buildFireflyVideoPayload", () => {
  it("Seedance 2.0 使用网页抓包中的最小字段集和 style 参考图", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0",
      engine: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      size: { width: 480, height: 854 },
      negativePrompt: "blurry",
      sourceImageIds: ["reference-image", "ignored"],
    });

    expect(payload).toEqual({
      modelId: "seedance",
      modelVersion: "seedance_2.0",
      size: { width: 480, height: 854 },
      seeds: [expect.any(Number)],
      referenceBlobs: [{ id: "reference-image", usage: "style" }],
      prompt: "a cat surfing",
      negativePrompt: "blurry",
      duration: 15,
      generateAudio: false,
      generationMetadata: {
        module: "text2video",
        submodule: "ff-video-generate",
      },
      generationSettings: { aspectRatio: "9:16" },
      output: { storeInputs: true },
    });
  });

  it("Seedance 2.0 将开启声音原样映射为 generateAudio=true", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0",
      engine: "seedance2",
      duration: 4,
      aspectRatio: "4:3",
      size: { width: 640, height: 480 },
      generateAudio: true,
    });

    expect(payload.generateAudio).toBe(true);
  });

  it("Seedance 2.0 Fast 只替换 modelVersion 并复用 Seedance 提交结构", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "seedance",
      upstreamModelVersion: "seedance_2.0_fast",
      engine: "seedance2",
      duration: 15,
      aspectRatio: "21:9",
      size: { width: 1680, height: 720 },
      sourceImageIds: ["reference-image"],
    });

    expect(payload).toMatchObject({
      modelId: "seedance",
      modelVersion: "seedance_2.0_fast",
      size: { width: 1680, height: 720 },
      referenceBlobs: [{ id: "reference-image", usage: "style" }],
      duration: 15,
      generateAudio: false,
      generationSettings: { aspectRatio: "21:9" },
    });
    expect(payload).not.toHaveProperty("model");
    expect(payload).not.toHaveProperty("engine");
  });

  it("Kling 3.0 Omni 使用 Firefly 网页端已验证的文本提交字段", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "kling",
      upstreamModelVersion: "kling_o3_standard_t2v",
      engine: "kling3-omni",
      duration: 10,
      aspectRatio: "16:9",
      size: { width: 1280, height: 720 },
    });

    expect(payload).toEqual({
      n: 1,
      seeds: [expect.any(Number)],
      modelId: "kling",
      modelVersion: "kling_o3_standard_t2v",
      output: { storeInputs: true },
      duration: 10,
      prompt: "a cat surfing",
      size: { width: 1280, height: 720 },
      generateAudio: false,
      generationMetadata: { module: "text2video" },
      generationSettings: { aspectRatio: "16:9" },
      referenceBlobs: [],
    });
  });

  it("Kling 3.0 Omni 复用单张 style 参考图并透传音频开关", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "kling",
      upstreamModelVersion: "kling_o3_standard_t2v",
      engine: "kling3-omni",
      duration: 3,
      aspectRatio: "9:16",
      size: { width: 720, height: 1280 },
      generateAudio: true,
      sourceImageIds: ["reference-image", "ignored"],
    });

    expect(payload).toMatchObject({
      generateAudio: true,
      generationMetadata: { module: "text2video" },
      referenceBlobs: [{ id: "reference-image", usage: "style" }],
    });
  });

  it("Kling 3.0 使用官网 v3 版本并发送首尾帧", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "kling",
      upstreamModelVersion: "kling_v3",
      engine: "kling3",
      duration: 15,
      aspectRatio: "9:16",
      size: { width: 720, height: 1280 },
      generateAudio: true,
      sourceImageIds: ["first-frame", "last-frame", "ignored"],
    });

    expect(payload).toMatchObject({
      n: 1,
      modelId: "kling",
      modelVersion: "kling_v3",
      duration: 15,
      size: { width: 720, height: 1280 },
      generateAudio: true,
      generationMetadata: { module: "image2video" },
      generationSettings: { aspectRatio: "9:16" },
      output: { storeInputs: true },
    });
    expect(payload.referenceBlobs).toEqual([
      { id: "first-frame", usage: "frame", order: 1 },
      { id: "last-frame", usage: "frame", order: 2 },
    ]);
  });

  it("Runway Gen-4.5 使用 Firefly 网页端已验证的纯文本字段", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "runway",
      upstreamModelVersion: "gen4.5",
      engine: "runway-gen45",
      duration: 5,
      aspectRatio: "16:9",
      size: { width: 1280, height: 720 },
      negativePrompt: "blurry",
      generateAudio: true,
      sourceImageIds: ["ignored-reference-image"],
    });

    expect(payload).toEqual({
      modelId: "runway",
      modelVersion: "gen4.5",
      size: { width: 1280, height: 720 },
      seeds: [expect.any(Number)],
      prompt: "a cat surfing",
      negativePrompt: "blurry",
      duration: 5,
      generationMetadata: {
        module: "text2video",
        submodule: "ff-video-generate",
      },
      output: { storeInputs: true },
    });
    for (const absentField of [
      "generateAudio",
      "n",
      "referenceBlobs",
      "generationSettings",
      "model",
      "engine",
    ]) {
      expect(payload).not.toHaveProperty(absentField);
    }
  });

  it("Ray 3.14 使用 Firefly 网页端已验证的 flex_2 和模型专属参数", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "luma",
      upstreamModelVersion: "3.14-ray",
      engine: "ray314",
      duration: 5,
      aspectRatio: "16:9",
      outputResolution: "4k",
      size: { width: 3840, height: 2160 },
      negativePrompt: "blurry",
      generateAudio: true,
      sourceImageIds: ["ignored-reference-image"],
    });

    expect(payload).toEqual({
      modelId: "luma",
      modelVersion: "3.14-ray",
      size: { width: 3840, height: 2160 },
      mode: "flex_2",
      prompt: "a cat surfing",
      negativePrompt: "blurry",
      duration: 5,
      generationMetadata: {
        module: "text2video",
        submodule: "ff-video-generate",
      },
      modelSpecificPayload: {
        resolution: "4k",
        aspect_ratio: "16:9",
      },
      output: { storeInputs: true },
    });
    for (const absentField of [
      "generateAudio",
      "n",
      "seeds",
      "referenceBlobs",
      "referenceFrames",
      "generationSettings",
      "model",
      "engine",
    ]) {
      expect(payload).not.toHaveProperty(absentField);
    }
  });

  it("Ray 3.14 HDR 使用模型专属参数且不发送 flex_2 mode", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      upstreamModel: "",
      upstreamModelId: "luma",
      upstreamModelVersion: "3.14-ray-hdr",
      engine: "ray314-hdr",
      duration: 5,
      aspectRatio: "16:9",
      outputResolution: "4k",
      size: { width: 3840, height: 2160 },
      negativePrompt: "blurry",
      generateAudio: true,
      sourceImageIds: ["ignored-reference-image"],
    });

    expect(payload).toEqual({
      modelId: "luma",
      modelVersion: "3.14-ray-hdr",
      size: { width: 3840, height: 2160 },
      prompt: "a cat surfing",
      negativePrompt: "blurry",
      duration: 5,
      generationMetadata: {
        module: "text2video",
        submodule: "ff-video-generate",
      },
      modelSpecificPayload: {
        resolution: "4k",
        aspect_ratio: "16:9",
      },
      output: { storeInputs: true },
    });
    for (const absentField of [
      "mode",
      "generateAudio",
      "n",
      "seeds",
      "referenceBlobs",
      "generationSettings",
      "model",
      "engine",
    ]) {
      expect(payload).not.toHaveProperty(absentField);
    }
  });

  it("构造上游 Sora 文生视频完整字段和 JSON prompt", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      negativePrompt: "blurry",
    });

    expect(payload).toMatchObject({
      modelId: "sora",
      model: "openai:firefly:colligo:sora2",
      modelVersion: "sora-2",
      duration: 8,
      fps: 24,
      size: { width: 1280, height: 720 },
      generateAudio: false,
      generationMetadata: { module: "text2video" },
      negativePrompt: "blurry",
      output: { storeInputs: true },
      referenceBlobs: [],
      referenceFrames: [],
    });
    expect(JSON.parse(String(payload.prompt))).toEqual({
      id: 1,
      duration_sec: 8,
      prompt_text: "a cat surfing",
      negative_prompt: "blurry",
    });
    expect(payload.engine).toBeUndefined();
  });

  it("Sora 图生视频只使用首帧并保留 text2video module", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      sourceImageIds: ["img-a", "img-b"],
    });

    expect(payload.generationMetadata).toEqual({ module: "text2video" });
    expect(payload.referenceBlobs).toEqual([
      { id: "img-a", usage: "general", promptReference: 1 },
    ]);
    expect(payload.referenceFrames).toEqual([{ localBlobRef: "img-a" }, null]);
  });

  it("Veo Standard 使用 modelSpecificPayload 和 general 参考图", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      engine: "veo31-standard",
      upstreamModelId: "veo",
      upstreamModelVersion: "3.1-generate",
      duration: 6,
      sourceImageIds: ["v1", "v2", "ignored"],
    });

    expect(payload).toMatchObject({
      modelId: "veo",
      modelVersion: "3.1-generate",
      output: { storeInputs: true },
      generationMetadata: { module: "text2video" },
      modelSpecificPayload: {
        parameters: {
          durationSeconds: 6,
          aspectRatio: "16:9",
          addWaterMark: false,
        },
      },
    });
    expect(payload.referenceBlobs).toEqual([
      { id: "v1", usage: "general", promptReference: 1 },
      { id: "v2", usage: "general", promptReference: 2 },
    ]);
    expect(payload.duration).toBeUndefined();
  });

  it("Veo Reference 最多使用三张 asset 参考图", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      engine: "veo31-standard",
      upstreamModelId: "veo",
      upstreamModelVersion: "3.1-generate",
      referenceMode: "image",
      sourceImageIds: ["v1", "v2", "v3", "ignored"],
    });

    expect(payload.referenceBlobs).toEqual([
      { id: "v1", usage: "asset" },
      { id: "v2", usage: "asset" },
      { id: "v3", usage: "asset" },
    ]);
    expect(payload.reference_mode).toBeUndefined();
  });

  it("Veo Fast 使用 fast modelVersion 和 general 参考图", () => {
    const payload = buildFireflyVideoPayload({
      ...base,
      engine: "veo31-fast",
      upstreamModelId: "veo",
      upstreamModelVersion: "3.1-fast-generate",
      sourceImageIds: ["first", "last"],
    });

    expect(payload.modelVersion).toBe("3.1-fast-generate");
    expect(payload.referenceBlobs).toEqual([
      { id: "first", usage: "general", promptReference: 1 },
      { id: "last", usage: "general", promptReference: 2 },
    ]);
  });

  it.each([
    ["kling-o3", "kling_o3_pro_reference_to_video"],
    ["kling3", "kling_v3"],
  ])("%s 帧序号从 1 开始", (engine, modelVersion) => {
    const payload = buildFireflyVideoPayload({
      ...base,
      engine,
      upstreamModelId: "kling",
      upstreamModelVersion: modelVersion,
      aspectRatio: "9:16",
      size: { width: 720, height: 1280 },
      sourceImageIds: ["k1", "k2", "ignored"],
    });

    expect(payload).toMatchObject({
      modelId: "kling",
      modelVersion,
      generationMetadata: { module: "image2video" },
      generationSettings: { aspectRatio: "9:16" },
      output: { storeInputs: true },
    });
    expect(payload.referenceBlobs).toEqual([
      { id: "k1", usage: "frame", order: 1 },
      { id: "k2", usage: "frame", order: 2 },
    ]);
  });
});
