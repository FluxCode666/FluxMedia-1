/**
 * 图片领域抠图回归测试。
 *
 * 使用方：Vitest；通过 Sharp 合成确定性 PNG，并验证 removeBackground 输出的尺寸、
 * alpha 通道与前景保留边界。关键依赖：Sharp 与本地抠图模型，测试不访问网络。
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { removeBackground } from "./matte";

/**
 * 合成纯蓝背景和中心红色圆形的 PNG 测试图。
 *
 * @param size 正方形边长；无效尺寸由 Sharp 拒绝。
 * @returns Sharp 异步编码得到的 PNG Buffer，不产生文件或网络副作用。
 */
function testImage(size: number): Promise<Buffer> {
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
