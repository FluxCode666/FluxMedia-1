import { beforeAll, describe, expect, it } from "vitest";

let resolveImageUpstreamSizeParams: typeof import("./service")["resolveImageUpstreamSizeParams"];

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  ({ resolveImageUpstreamSizeParams } = await import("./service"));
});

describe("resolveImageUpstreamSizeParams", () => {
  it("passes aspect ratio and resolution through without a config", () => {
    expect(
      resolveImageUpstreamSizeParams({
        aspectRatio: "16:9",
        resolution: "2k",
      })
    ).toEqual({ aspectRatio: "16:9", resolution: "2k" });
  });

  it("maps aspect ratio and resolution to size with a config", () => {
    expect(
      resolveImageUpstreamSizeParams({
        adapter: {
          imageSizeConfig: {
            id: "cfg",
            name: "default",
            mappings: [
              { resolution: "2k", aspectRatio: "16:9", size: "1536x864" },
            ],
          },
        },
        aspectRatio: "16:9",
        resolution: "2k",
      })
    ).toEqual({ size: "1536x864" });
  });

  it("fails before upstream call when selected config cannot resolve", () => {
    expect(() =>
      resolveImageUpstreamSizeParams({
        adapter: {
          imageSizeConfig: { id: "cfg", name: "default", mappings: [] },
        },
        aspectRatio: "16:9",
        resolution: "2k",
      })
    ).toThrow();
  });

  it("prefers model-specific config and falls back to provider config", () => {
    const adapter = {
      imageSizeConfig: {
        id: "provider",
        name: "provider",
        mappings: [
          { resolution: "2k", aspectRatio: "16:9", size: "2000x1125" },
        ],
      },
      imageSizeConfigsByModel: {
        "nano-banana-pro": {
          id: "banana",
          name: "banana",
          mappings: [
            { resolution: "2k", aspectRatio: "16:9", size: "2752x1536" },
          ],
        },
      },
    };
    expect(
      resolveImageUpstreamSizeParams({
        adapter,
        platformModelId: "NANO-BANANA-PRO",
        aspectRatio: "16:9",
        resolution: "2k",
      })
    ).toEqual({ size: "2752x1536" });
    expect(
      resolveImageUpstreamSizeParams({
        adapter,
        platformModelId: "gpt-image-2",
        aspectRatio: "16:9",
        resolution: "2k",
      })
    ).toEqual({ size: "2000x1125" });
  });
});
