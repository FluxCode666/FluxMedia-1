import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  prepareAdobeVideoSourceImage,
  prepareAndUploadAdobeVideoSourceInputs,
} from "./adobe-video-source";

describe("prepareAdobeVideoSourceImage", () => {
  it("按目标尺寸 cover 居中裁剪并输出 PNG", async () => {
    const source = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 4,
        background: { r: 20, g: 80, b: 160, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

    const result = await prepareAdobeVideoSourceImage(source, {
      width: 1280,
      height: 720,
    });
    const metadata = await sharp(result.data).metadata();

    expect(result.type).toBe("image/png");
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(720);
    expect(metadata.hasAlpha).toBe(false);
  });

  it("Seedance 原图模式只校验格式并保持上传字节不变", async () => {
    const source = await sharp({
      create: {
        width: 1254,
        height: 1254,
        channels: 3,
        background: { r: 20, g: 80, b: 160 },
      },
    })
      .png()
      .toBuffer();

    const result = await prepareAdobeVideoSourceImage(
      source,
      { width: 480, height: 854 },
      "original"
    );

    expect(result.type).toBe("image/png");
    expect(result.data).toEqual(source);
  });

  it("拒绝空图片", async () => {
    await expect(
      prepareAdobeVideoSourceImage(Buffer.alloc(0), {
        width: 1280,
        height: 720,
      })
    ).rejects.toThrow("video source image is empty");
  });

  it("拒绝非法目标尺寸", async () => {
    await expect(
      prepareAdobeVideoSourceImage(Buffer.from("not-an-image"), {
        width: 0,
        height: 720,
      })
    ).rejects.toThrow("invalid Adobe video target size");
  });

  it("将无法解码的输入图归类为无效输入图", async () => {
    await expect(
      prepareAdobeVideoSourceImage(Buffer.from("not-an-image"), {
        width: 1280,
        height: 720,
      })
    ).rejects.toThrow("invalid image for Adobe video");
  });
});

describe("prepareAndUploadAdobeVideoSourceInputs", () => {
  it("按 firstFrame 和 lastFrame 语义上传并返回具名 ID", async () => {
    const source = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 20, g: 80, b: 160 },
      },
    })
      .png()
      .toBuffer();
    const uploaded: string[] = [];

    const result = await prepareAndUploadAdobeVideoSourceInputs({
      inputs: {
        firstFrame: { data: source, type: "image/png" },
        lastFrame: { data: source, type: "image/png" },
      },
      frameCapability: "first-and-optional-last",
      maxReferenceImages: 0,
      size: { width: 854, height: 480 },
      mode: "original",
      async uploadImage(_data, type) {
        uploaded.push(type);
        return uploaded.length === 1 ? "first-frame-id" : "last-frame-id";
      },
    });

    expect(result).toEqual({
      firstFrameId: "first-frame-id",
      lastFrameId: "last-frame-id",
    });
    expect(uploaded).toEqual(["image/png", "image/png"]);
  });

  it("按调用者顺序上传二十张 Seedance 参考图且不截断", async () => {
    const source = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 20, g: 80, b: 160 },
      },
    })
      .png()
      .toBuffer();
    const referenceImages = Array.from({ length: 20 }, () => ({
      data: source,
      type: "image/png",
    }));
    let uploadCount = 0;

    const result = await prepareAndUploadAdobeVideoSourceInputs({
      inputs: { referenceImages },
      frameCapability: "first-and-optional-last",
      maxReferenceImages: 20,
      size: { width: 854, height: 480 },
      mode: "original",
      async uploadImage() {
        uploadCount += 1;
        return `reference-${String(uploadCount).padStart(2, "0")}`;
      },
    });

    expect(result.referenceImageIds).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `reference-${String(index + 1).padStart(2, "0")}`
      )
    );
    expect(uploadCount).toBe(20);
  });

  it("创建快照上限为十时在任何上传前拒绝二十张参考图", async () => {
    const uploadImage = vi.fn(async () => "unexpected");

    await expect(
      prepareAndUploadAdobeVideoSourceInputs({
        inputs: {
          referenceImages: Array.from({ length: 20 }, () => ({
            data: Buffer.from("not-read"),
          })),
        },
        frameCapability: "first-and-optional-last",
        maxReferenceImages: 10,
        size: { width: 854, height: 480 },
        mode: "original",
        uploadImage,
      })
    ).rejects.toThrow("该视频模型最多支持 10 张参考图");
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it.each([
    "runway-gen45",
    "ray314",
  ])("%s 不支持输入时在任何上传前失败", async () => {
    const uploadImage = vi.fn(async () => "unexpected");

    await expect(
      prepareAndUploadAdobeVideoSourceInputs({
        inputs: { firstFrame: { data: Buffer.from("not-read") } },
        frameCapability: "none",
        maxReferenceImages: 0,
        size: { width: 1280, height: 720 },
        mode: "target-cover",
        uploadImage,
      })
    ).rejects.toThrow("该视频模型不支持首尾帧输入");
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it("首尾帧和参考图互斥且尾帧不能脱离首帧", async () => {
    const uploadImage = vi.fn(async () => "unexpected");
    const common = {
      frameCapability: "first-and-optional-last" as const,
      maxReferenceImages: 20,
      size: { width: 854, height: 480 },
      mode: "original" as const,
      uploadImage,
    };

    await expect(
      prepareAndUploadAdobeVideoSourceInputs({
        ...common,
        inputs: {
          firstFrame: { data: Buffer.from("not-read") },
          referenceImages: [{ data: Buffer.from("not-read") }],
        },
      })
    ).rejects.toThrow("首尾帧和参考图不能同时提交");
    await expect(
      prepareAndUploadAdobeVideoSourceInputs({
        ...common,
        inputs: { lastFrame: { data: Buffer.from("not-read") } },
      })
    ).rejects.toThrow("尾帧必须与首帧一起提交");
    expect(uploadImage).not.toHaveBeenCalled();
  });
});
