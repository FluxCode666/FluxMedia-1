import { describe, expect, it } from "vitest";
import {
  FIREFLY_DEFAULT_IMAGE_MODEL_ID,
  FIREFLY_IMAGE_MODEL_CATALOG,
  ratioFromSize,
  resolveFireflyImageModel,
} from "./catalog";

describe("FIREFLY_IMAGE_MODEL_CATALOG", () => {
  it("注册 gpt-image 2/1.5 / nano-banana 家族", () => {
    expect(FIREFLY_IMAGE_MODEL_CATALOG["gpt-image-2-2k-16x9"]).toEqual({
      upstreamModel: "openai:firefly:gpt-image",
      upstreamModelId: "gpt-image",
      upstreamModelVersion: "2",
      outputResolution: "2K",
      aspectRatio: "16:9",
      description: "Firefly GPT Image 2 (2K 16:9)",
    });
    expect(
      FIREFLY_IMAGE_MODEL_CATALOG["gpt-image-1.5-2k-16x9"]
    ).toEqual({
      upstreamModel: "openai:firefly:gpt-image",
      upstreamModelId: "gpt-image",
      upstreamModelVersion: "1.5",
      outputResolution: "2K",
      aspectRatio: "16:9",
      description: "Firefly GPT Image 1.5 (2K 16:9)",
    });
    const nano = FIREFLY_IMAGE_MODEL_CATALOG["nano-banana-pro-4k-1x1"];
    expect(nano?.upstreamModelId).toBe("gemini-flash");
    expect(nano?.upstreamModelVersion).toBe("nano-banana-2");
    expect(nano?.outputResolution).toBe("4K");
    expect(nano?.aspectRatio).toBe("1:1");
  });

  it("nano-banana2 支持扩展比例 1x8/4x1", () => {
    expect(
      FIREFLY_IMAGE_MODEL_CATALOG["nano-banana2-2k-1x8"]?.aspectRatio
    ).toBe("1:8");
    expect(
      FIREFLY_IMAGE_MODEL_CATALOG["nano-banana2-2k-4x1"]?.aspectRatio
    ).toBe("4:1");
    expect(
      FIREFLY_IMAGE_MODEL_CATALOG["nano-banana-pro-2k-1x8"]
    ).toBeUndefined();
  });
});

describe("resolveFireflyImageModel", () => {
  it("空 id 回退默认模型", () => {
    expect(resolveFireflyImageModel(null)).toBe(
      FIREFLY_IMAGE_MODEL_CATALOG[FIREFLY_DEFAULT_IMAGE_MODEL_ID]
    );
    expect(resolveFireflyImageModel("")).toBe(
      FIREFLY_IMAGE_MODEL_CATALOG[FIREFLY_DEFAULT_IMAGE_MODEL_ID]
    );
  });

  it("裸 ID 是规范键且兼容历史 Firefly 前缀", () => {
    expect(FIREFLY_DEFAULT_IMAGE_MODEL_ID).toBe(
      "nano-banana-pro-2k-16x9"
    );
    expect(
      resolveFireflyImageModel("firefly-gpt-image-2-2k-16x9")
    ).toBe(FIREFLY_IMAGE_MODEL_CATALOG["gpt-image-2-2k-16x9"]);
    expect(
      Object.keys(FIREFLY_IMAGE_MODEL_CATALOG).every(
        (modelId) => !modelId.startsWith("firefly-")
      )
    ).toBe(true);
  });

  it("未知 id 返回 null", () => {
    expect(resolveFireflyImageModel("firefly-unknown-9k-1x1")).toBeNull();
  });
});

describe("ratioFromSize", () => {
  it("已知尺寸映射", () => {
    expect(ratioFromSize("1792x1024")).toBe("16:9");
    expect(ratioFromSize("1024x1792")).toBe("9:16");
    expect(ratioFromSize("2048x1536")).toBe("4:3");
  });
  it("未知尺寸回退 1:1", () => {
    expect(ratioFromSize("999x999")).toBe("1:1");
    expect(ratioFromSize(null)).toBe("1:1");
  });
});
