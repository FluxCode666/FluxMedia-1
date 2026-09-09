import { describe, expect, it } from "vitest";
import {
  imageSizeConfigMappingsSchema,
  resolveImageSizeConfigMapping,
} from "./image-size-config";

describe("image size config", () => {
  it("resolves resolution and aspect ratio case-insensitively", () => {
    const config = {
      id: "cfg",
      name: "default",
      mappings: [{ resolution: "2K", aspectRatio: "16:9", size: "1536x864" }],
    };
    expect(resolveImageSizeConfigMapping(config, "2k", "16:9")?.size).toBe(
      "1536x864"
    );
  });

  it("rejects duplicate resolution and aspect ratio pairs", () => {
    expect(
      imageSizeConfigMappingsSchema.safeParse([
        { resolution: "1k", aspectRatio: "1:1", size: "1024x1024" },
        { resolution: "1K", aspectRatio: "1:1", size: "512x512" },
      ]).success
    ).toBe(false);
  });
});
