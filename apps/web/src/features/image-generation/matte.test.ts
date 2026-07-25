import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { removeBackground } from "./matte";

// 合成测试图：纯蓝背景 + 中心红色实心圆。验证抠图输出带 alpha、背景透明、前景保留。
// 注:纯色块上 saliency 模型边缘会有少量噪点,故阈值取宽松值。
function testImage(size: number) {
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#2244aa"/><circle cx="${size / 2}" cy="${size / 2}" r="${size / 3}" fill="#dd3322"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("removeBackground (ISNet 抠图)", () => {
  it("输出带 alpha 的 PNG:背景四角透明、前景中心保留", async () => {
    const input = await testImage(512);
    const out = await removeBackground(input);

    const meta = await sharp(out).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);

    const { data, info } = await sharp(out)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) =>
      data[(y * info.width + x) * 4 + 3] ?? 0;
    const corner = Math.max(
      alphaAt(2, 2),
      alphaAt(info.width - 3, 2),
      alphaAt(2, info.height - 3),
      alphaAt(info.width - 3, info.height - 3)
    );
    const center = alphaAt(
      Math.floor(info.width / 2),
      Math.floor(info.height / 2)
    );
    expect(center).toBeGreaterThan(200);
    expect(corner).toBeLessThan(80);
  }, 30000);
});
