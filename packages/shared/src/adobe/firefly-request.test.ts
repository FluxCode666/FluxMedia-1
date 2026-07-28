import { describe, expect, it } from "vitest";
import {
  buildAdobeImageRequestBody,
  composeAdobeImageModelId,
  mapSizeToAdobe,
  parseSizeWxH,
  toAdobeImageDataUrl,
} from "./firefly-request";

describe("parseSizeWxH", () => {
  it("解析合法 WxH", () => {
    expect(parseSizeWxH("1024x1536")).toEqual({ width: 1024, height: 1536 });
    expect(parseSizeWxH(" 1792 X 1024 ")).toEqual({ width: 1792, height: 1024 });
  });

  it("非法/auto/空 返回 null", () => {
    expect(parseSizeWxH("auto")).toBeNull();
    expect(parseSizeWxH("")).toBeNull();
    expect(parseSizeWxH(null)).toBeNull();
    expect(parseSizeWxH("0x100")).toBeNull();
  });
});

describe("mapSizeToAdobe", () => {
  it("正方形 → 1x1", () => {
    expect(mapSizeToAdobe("1024x1024").ratio).toBe("1x1");
  });

  it("宽屏 → 16x9", () => {
    expect(mapSizeToAdobe("1792x1024").ratio).toBe("16x9");
  });

  it("竖屏 → 9x16", () => {
    expect(mapSizeToAdobe("1024x1792").ratio).toBe("9x16");
  });

  it("4:3 与 3:4", () => {
    expect(mapSizeToAdobe("1024x768").ratio).toBe("4x3");
    expect(mapSizeToAdobe("768x1024").ratio).toBe("3x4");
  });

  it("分辨率按长边：1k/2k/4k", () => {
    expect(mapSizeToAdobe("1024x1024").resolution).toBe("1k");
    expect(mapSizeToAdobe("2048x2048").resolution).toBe("2k");
    expect(mapSizeToAdobe("4096x2048").resolution).toBe("4k");
  });

  it("非法尺寸回退到 fallback", () => {
    expect(mapSizeToAdobe("auto")).toEqual({ ratio: "1x1", resolution: "2k" });
    expect(mapSizeToAdobe(null, { ratio: "16x9", resolution: "4k" })).toEqual({
      ratio: "16x9",
      resolution: "4k",
    });
  });
});

describe("composeAdobeImageModelId", () => {
  it("拼装无 Firefly 前缀的公开完整模型 ID", () => {
    expect(
      composeAdobeImageModelId({
        family: "gpt-image-2",
        resolution: "2k",
        ratio: "16x9",
      })
    ).toBe("gpt-image-2-2k-16x9");
    expect(
      composeAdobeImageModelId({
        family: "nano-banana-pro",
        resolution: "4k",
        ratio: "1x1",
      })
    ).toBe("nano-banana-pro-4k-1x1");
  });
});

describe("toAdobeImageDataUrl", () => {
  it("编码为 data URL，缺省 mime 为 image/png", () => {
    const data = Buffer.from("hello");
    expect(toAdobeImageDataUrl({ data, type: "image/jpeg" })).toBe(
      `data:image/jpeg;base64,${data.toString("base64")}`
    );
    expect(toAdobeImageDataUrl({ data })).toBe(
      `data:image/png;base64,${data.toString("base64")}`
    );
  });
});

describe("buildAdobeImageRequestBody", () => {
  it("文生图：仅在 Adobe gateway 上游 model 补回 Firefly 前缀", () => {
    const body = buildAdobeImageRequestBody({
      family: "gpt-image-2",
      prompt: "a cat",
      size: "1792x1024",
    });
    expect(body.model).toBe("firefly-gpt-image-2-2k-16x9");
    expect(body.messages).toEqual([{ role: "user", content: "a cat" }]);
    expect(body.stream).toBeUndefined();
  });

  it("图生图：content 含 image_url data URL", () => {
    const body = buildAdobeImageRequestBody({
      family: "nano-banana-pro",
      prompt: "make it night",
      size: "1024x1024",
      images: [{ data: Buffer.from("img"), type: "image/png" }],
    });
    const content = (body.messages as Array<{ content: unknown }>)[0]
      ?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content[0]).toEqual({ type: "text", text: "make it night" });
    expect(content[1]?.type).toBe("image_url");
    expect(content[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("显式 ratio/resolution 覆盖 size 映射", () => {
    const body = buildAdobeImageRequestBody({
      family: "gpt-image-2",
      prompt: "x",
      size: "1024x1024",
      ratio: "9x16",
      resolution: "4k",
    });
    expect(body.model).toBe("firefly-gpt-image-2-4k-9x16");
  });

  it("stream 透传", () => {
    const body = buildAdobeImageRequestBody({
      family: "gpt-image-2",
      prompt: "x",
      stream: true,
    });
    expect(body.stream).toBe(true);
  });
});
