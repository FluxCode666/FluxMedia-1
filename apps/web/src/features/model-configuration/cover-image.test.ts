/**
 * 模型广场封面处理测试。
 *
 * 使用 Sharp 在内存中构造输入，锁定不可信图片的体积、格式、像素、动画与元数据边界，
 * 同时验证输出尺寸、编码、内容哈希和不泄露模型 ID 的对象 key。
 */
import { createHash } from "node:crypto";

import {
  MAX_MODEL_MARKETPLACE_COVER_BYTES,
  type ModelMarketplacePublicCategory,
} from "@repo/shared/model-marketplace";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  buildModelMarketplaceCoverObjectKey,
  processModelMarketplaceCoverImage,
} from "./cover-image";

type StaticInputFormat = "jpeg" | "png" | "webp";

/**
 * 创建指定编码的静态测试图。
 *
 * @param format - 需要实际编码进字节流的 JPEG、PNG 或 WebP 格式。
 * @param width - 原图宽度。
 * @param height - 原图高度。
 * @returns 可交给被测函数的真实图片字节。
 */
async function createStaticImage(
  format: StaticInputFormat,
  width = 900,
  height = 600
): Promise<Uint8Array> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 30, g: 120, b: 220, alpha: 0.8 },
    },
  });

  switch (format) {
    case "jpeg":
      return image.jpeg().toBuffer();
    case "png":
      return image.png().toBuffer();
    case "webp":
      return image.webp().toBuffer();
  }
}

/**
 * 创建包含两个画面的动画 WebP。
 *
 * @returns metadata.pages 为 2 的动画字节，避免依赖二进制 fixture。
 */
async function createAnimatedWebp(): Promise<Uint8Array> {
  const firstFrame = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const secondFrame = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  return sharp([firstFrame, secondFrame], { join: { animated: true } })
    .webp({ delay: [100, 100], loop: 0 })
    .toBuffer();
}

describe("processModelMarketplaceCoverImage", () => {
  it.each<StaticInputFormat>([
    "jpeg",
    "png",
    "webp",
  ])("安全解码静态 %s 并统一输出 WebP、SHA-256 与固定内容类型", async (format) => {
    const input = await createStaticImage(format);
    const result = await processModelMarketplaceCoverImage(input);
    const metadata = await sharp(result.bytes).metadata();

    expect(result.contentType).toBe("image/webp");
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sha256).toBe(
      createHash("sha256").update(result.bytes).digest("hex")
    );
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(900);
    expect(metadata.height).toBe(600);
    expect(metadata.pages ?? 1).toBe(1);
  });

  it("自动旋转、居中裁成 3:2，并移除 EXIF 与方向元数据", async () => {
    const input = await sharp({
      create: {
        width: 900,
        height: 600,
        channels: 3,
        background: { r: 40, g: 100, b: 160 },
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await processModelMarketplaceCoverImage(input);
    const metadata = await sharp(result.bytes).metadata();

    // 方向 6 会先把 900×600 旋成 600×900，再从中心裁出横向 3:2。
    expect(metadata.width).toBe(600);
    expect(metadata.height).toBe(400);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it("把大图限制为 1200×800，同时不放大小图", async () => {
    const large = await processModelMarketplaceCoverImage(
      await createStaticImage("png", 2400, 1600)
    );
    const small = await processModelMarketplaceCoverImage(
      await createStaticImage("png", 300, 300)
    );

    await expect(sharp(large.bytes).metadata()).resolves.toMatchObject({
      width: 1200,
      height: 800,
      format: "webp",
    });
    await expect(sharp(small.bytes).metadata()).resolves.toMatchObject({
      width: 300,
      height: 200,
      format: "webp",
    });
  });

  it("在解码前拒绝空文件与超过 5 MB 的原始字节", async () => {
    await expect(
      processModelMarketplaceCoverImage(new Uint8Array())
    ).rejects.toMatchObject({ code: "empty" });
    await expect(
      processModelMarketplaceCoverImage(
        new Uint8Array(MAX_MODEL_MARKETPLACE_COVER_BYTES + 1)
      )
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("拒绝损坏图片以及 JPEG、PNG、WebP 以外的实际格式", async () => {
    const gif = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .gif()
      .toBuffer();
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" />'
    );
    const jpeg = await createStaticImage("jpeg", 64, 64);
    const truncatedJpeg = jpeg.slice(0, Math.max(1, jpeg.byteLength - 50));

    await expect(
      processModelMarketplaceCoverImage(new Uint8Array([1, 2, 3]))
    ).rejects.toMatchObject({ code: "invalid_image" });
    await expect(
      processModelMarketplaceCoverImage(truncatedJpeg)
    ).rejects.toMatchObject({ code: "invalid_image" });
    await expect(processModelMarketplaceCoverImage(gif)).rejects.toMatchObject({
      code: "unsupported_format",
    });
    await expect(processModelMarketplaceCoverImage(svg)).rejects.toMatchObject({
      code: "unsupported_format",
    });
  });

  it("用 40,000,000 像素解码上限拒绝像素炸弹", async () => {
    const oversizedPixels = await sharp({
      create: {
        width: 8_000,
        height: 5_001,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();

    await expect(
      processModelMarketplaceCoverImage(oversizedPixels)
    ).rejects.toMatchObject({ code: "invalid_image" });
  });

  it("显式拒绝多页或动画 WebP", async () => {
    const animated = await createAnimatedWebp();
    await expect(
      processModelMarketplaceCoverImage(animated)
    ).rejects.toMatchObject({ code: "animated_image" });
  });
});

describe("buildModelMarketplaceCoverObjectKey", () => {
  it.each<ModelMarketplacePublicCategory>([
    "image",
    "video",
  ])("为 %s 使用类别、模型键哈希与内容哈希构造稳定 key", (category) => {
    const configKey = "gpt-image-2";
    const contentSha256 = "a".repeat(64);
    const expectedConfigKeyHash = createHash("sha256")
      .update(configKey)
      .digest("hex");

    const key = buildModelMarketplaceCoverObjectKey(
      category,
      configKey,
      contentSha256
    );

    expect(key).toBe(
      `${category}/${expectedConfigKeyHash}/${contentSha256}.webp`
    );
    expect(key).not.toContain(configKey);
    expect(key).not.toContain("..");
  });

  it("拒绝空模型键、非规范模型键与非法内容哈希", () => {
    expect(() =>
      buildModelMarketplaceCoverObjectKey("image", "", "a".repeat(64))
    ).toThrow(/模型配置键/);
    expect(() =>
      buildModelMarketplaceCoverObjectKey("image", " model-id ", "a".repeat(64))
    ).toThrow(/模型配置键/);
    expect(() =>
      buildModelMarketplaceCoverObjectKey("image", "model-id", "../unsafe")
    ).toThrow(/内容哈希/);
  });
});
