/**
 * 网站 Logo 原始文件校验测试。
 *
 * 覆盖真实格式识别、原字节保持、PNG/ICO 边界、SVG 主动内容拒绝和像素上限；测试不写
 * 数据库或对象存储。
 */
import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { validateSiteLogoFile } from "./site-logo-file";

/** 使用真实 PNG 帧构造最小 ICO，验证目录解析而不依赖 Sharp 的 ICO 支持。 */
async function createIco(): Promise<Uint8Array> {
  const png = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 20, g: 80, b: 180, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const result = new Uint8Array(6 + 16 + png.byteLength);
  const view = new DataView(result.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  result[6] = 32;
  result[7] = 32;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.byteLength, true);
  view.setUint32(18, 22, true);
  result.set(png, 22);
  return result;
}

/** 组装不触发外部资源的最小 SVG。 */
function createSvg(
  body = '<path d="M0 0h32v32H0z" fill="#123456"/>'
): Uint8Array {
  return new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      body +
      "</svg>"
  );
}

describe("validateSiteLogoFile", () => {
  it("保留合法 PNG 原始字节并返回内容哈希", async () => {
    const input = await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 4,
        background: { r: 20, g: 80, b: 180, alpha: 0.8 },
      },
    })
      .png()
      .toBuffer();
    const result = await validateSiteLogoFile({ bytes: input });

    expect(result.format).toBe("png");
    expect(result.contentType).toBe("image/png");
    expect(result.extension).toBe("png");
    expect(Buffer.from(result.bytes)).toEqual(input);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("保留合法 SVG 原始字节，并允许内部渐变引用", async () => {
    const input = createSvg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="32" height="32" fill="url(#g)"/>'
    );
    const result = await validateSiteLogoFile({ bytes: input });

    expect(result.format).toBe("svg");
    expect(result.contentType).toBe("image/svg+xml");
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(input));
  });

  it("校验 ICO 目录并保留原始多帧文件", async () => {
    const input = await createIco();
    const result = await validateSiteLogoFile({ bytes: input });

    expect(result.format).toBe("ico");
    expect(result.contentType).toBe("image/x-icon");
    expect(result.extension).toBe("ico");
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(input));
  });

  it("能够接受仓库中的多帧 PNG ICO", async () => {
    const input = await readFile(
      new URL("../../../public/favicon.ico", import.meta.url)
    );
    await expect(validateSiteLogoFile({ bytes: input })).resolves.toMatchObject(
      {
        format: "ico",
        extension: "ico",
      }
    );
  });

  it.each([
    "<script>alert(1)</script>",
    "<foreignObject><div>bad</div></foreignObject>",
    '<image href="data:image/png;base64,AA=="/>',
    '<image href="https://example.com/logo.png"/>',
    '<use href="https://example.com/#logo"/>',
    '<rect style="background:url(https://example.com/a)"/>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
  ])("拒绝危险 SVG：%s", async (body) => {
    await expect(
      validateSiteLogoFile({ bytes: createSvg(body) })
    ).rejects.toMatchObject({
      code: "unsafe_svg",
    });
  });

  it("拒绝损坏格式和像素过大的 PNG", async () => {
    await expect(
      validateSiteLogoFile({ bytes: new Uint8Array([1, 2, 3]) })
    ).rejects.toMatchObject({ code: "unsupported_format" });

    const large = await sharp({
      create: {
        width: 4_097,
        height: 4_097,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();
    await expect(validateSiteLogoFile({ bytes: large })).rejects.toMatchObject({
      code: "invalid_image",
    });
  });

  it("拒绝越界 ICO 和空文件", async () => {
    await expect(
      validateSiteLogoFile({ bytes: new Uint8Array() })
    ).rejects.toMatchObject({ code: "empty" });
    const invalid = new Uint8Array(22);
    invalid[2] = 1;
    invalid[4] = 1;
    invalid[6] = 16;
    invalid[7] = 16;
    new DataView(invalid.buffer).setUint32(12, 100, true);
    new DataView(invalid.buffer).setUint32(16, 22, true);
    await expect(
      validateSiteLogoFile({ bytes: invalid })
    ).rejects.toMatchObject({
      code: "invalid_ico",
    });
  });
});
