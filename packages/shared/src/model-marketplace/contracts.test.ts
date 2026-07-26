/**
 * 模型广场共享契约测试。
 *
 * 覆盖持久化配置、管理 DTO、公开 DTO 与单模型写入输入的严格边界，确保 Web、UOL 和
 * 后续传输层不能各自放宽模型身份、封面地址或并发控制规则。
 */
import { describe, expect, it } from "vitest";

import {
  createDefaultModelMarketplaceConfig,
  MODEL_MARKETPLACE_CONFIG_VERSION,
  modelConfigurationSnapshotSchema,
  modelMarketplaceConfigSchema,
  modelMarketplacePublicItemSchema,
  parseModelMarketplaceConfig,
  updateModelConfigurationEntryInputSchema,
  updateModelConfigurationEntryOutputSchema,
} from "./contracts";

const IMAGE_PRICING = {
  base1024Credits: 1.27,
  base1kCredits: 1.27,
  base2kCredits: 5.07,
  base4kCredits: 10,
};
const IMAGE_COVER_KEY = `image/${"a".repeat(64)}/${"b".repeat(64)}.webp`;
const VIDEO_COVER_KEY = `video/${"a".repeat(64)}/${"b".repeat(64)}.webp`;

/** 构造一条满足公开图像 DTO 的基准数据，供字段边界测试按需覆盖。 */
function createPublicImageItem(): Record<string, unknown> {
  return {
    category: "image",
    configKey: "gpt-image-2",
    defaultModelId: "gpt-image-2",
    displayName: "GPT Image 2",
    iconKey: "openai",
    description: "适合高质量图像生成。",
    coverUrl: "/model-assets/image/gpt-image-2.webp",
    minimumCredits: 1.27,
    priceUnit: "per_image",
    pricing: IMAGE_PRICING,
  };
}

describe("modelMarketplaceConfigSchema", () => {
  it("创建相互隔离的版本 1 默认配置", () => {
    const first = createDefaultModelMarketplaceConfig();
    const second = createDefaultModelMarketplaceConfig();

    expect(first).toEqual({
      version: MODEL_MARKETPLACE_CONFIG_VERSION,
      fallbackImagePricingRevision: 0,
      imageByModel: {},
      videoByFamily: {},
      writeReceipts: {},
    });
    expect(first).not.toBe(second);
    expect(first.imageByModel).not.toBe(second.imageByModel);
    expect(first.videoByFamily).not.toBe(second.videoByFamily);
    expect(first.writeReceipts).not.toBe(second.writeReceipts);
  });

  it("只在持久化值缺失时回退默认配置", () => {
    expect(parseModelMarketplaceConfig(undefined)).toEqual(
      createDefaultModelMarketplaceConfig()
    );
    expect(() => parseModelMarketplaceConfig({ version: 2 })).toThrow();
  });

  it("为历史缺键补空记录并裁剪简介首尾空白", () => {
    const parsed = modelMarketplaceConfigSchema.parse({
      version: 1,
      fallbackImagePricingRevision: 3,
      imageByModel: {
        "gpt-image-2": {
          revision: 2,
          visible: true,
          description: `  ${"模".repeat(200)}  `,
          cover: {
            bucket: "model-marketplace",
            key: IMAGE_COVER_KEY,
          },
        },
      },
      videoByFamily: {},
    });

    expect(parsed.imageByModel["gpt-image-2"]?.description).toHaveLength(200);
    expect(parsed.writeReceipts).toEqual({});
  });

  it("拒绝 default 展示条目、超长键、未知字段和非法 revision", () => {
    const base = createDefaultModelMarketplaceConfig();

    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...base,
        imageByModel: {
          default: {
            revision: 0,
            visible: true,
            description: "",
            cover: null,
          },
        },
      }).success
    ).toBe(false);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...base,
        imageByModel: {
          ["m".repeat(121)]: {
            revision: 0,
            visible: true,
            description: "",
            cover: null,
          },
        },
      }).success
    ).toBe(false);
    expect(
      modelMarketplaceConfigSchema.safeParse({ ...base, unexpected: true })
        .success
    ).toBe(false);

    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        modelMarketplaceConfigSchema.safeParse({
          ...base,
          fallbackImagePricingRevision: revision,
        }).success
      ).toBe(false);
    }
  });

  it("只接受内容寻址封面 key 并保持图像与视频命名空间隔离", () => {
    const createEntry = (key: string) => ({
      revision: 0,
      visible: true,
      description: "",
      cover: { bucket: "model-marketplace", key },
    });

    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...createDefaultModelMarketplaceConfig(),
        imageByModel: { image: createEntry(IMAGE_COVER_KEY) },
        videoByFamily: { video: createEntry(VIDEO_COVER_KEY) },
      }).success
    ).toBe(true);
    for (const key of [
      "image/../generations/private.webp",
      "image/custom/cover.webp",
      VIDEO_COVER_KEY,
    ]) {
      expect(
        modelMarketplaceConfigSchema.safeParse({
          ...createDefaultModelMarketplaceConfig(),
          imageByModel: { image: createEntry(key) },
        }).success
      ).toBe(false);
    }
  });

  it("严格校验写回执哈希、数量和完成时间", () => {
    const receipt = {
      requestHash: "a".repeat(64),
      category: "image",
      configKey: "gpt-image-2",
      resultingRevision: 1,
      completedAt: "2026-07-26T08:00:00.000Z",
    };
    const valid = {
      ...createDefaultModelMarketplaceConfig(),
      writeReceipts: { ["b".repeat(64)]: receipt },
    };

    expect(modelMarketplaceConfigSchema.safeParse(valid).success).toBe(true);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...valid,
        writeReceipts: {
          ["b".repeat(64)]: { ...receipt, requestHash: "not-a-hash" },
        },
      }).success
    ).toBe(false);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...valid,
        writeReceipts: { invalid: receipt },
      }).success
    ).toBe(false);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...valid,
        writeReceipts: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [
            index.toString(16).padStart(64, "0"),
            receipt,
          ])
        ),
      }).success
    ).toBe(false);
  });
});

describe("管理与公开 DTO", () => {
  it("管理快照携带真实权限、运行时状态和图像价格来源", () => {
    const snapshot = modelConfigurationSnapshotSchema.parse({
      canEdit: true,
      runtimeCatalogStatus: "ready",
      entries: [
        {
          category: "image",
          configKey: "custom-image-model",
          displayName: "Custom Image Model",
          iconKey: "generic",
          revision: 0,
          marketplaceApplicable: true,
          visible: true,
          description: "",
          coverUrl: "/images/model-default.webp",
          usesDefaultCover: true,
          pricingSource: "fallback",
          fallbackPricingRevision: 4,
          pricing: IMAGE_PRICING,
          minimumCredits: 1.27,
        },
      ],
    });

    expect(snapshot.entries[0]).toMatchObject({
      pricingSource: "fallback",
      fallbackPricingRevision: 4,
    });
  });

  it("公开 DTO 仅接受第一方相对封面 URL 并拒绝存储引用", () => {
    expect(
      modelMarketplacePublicItemSchema.safeParse(createPublicImageItem())
        .success
    ).toBe(true);

    for (const coverUrl of [
      "https://cdn.example.com/cover.webp",
      "//cdn.example.com/cover.webp",
      "\\\\cdn.example.com\\cover.webp",
    ]) {
      expect(
        modelMarketplacePublicItemSchema.safeParse({
          ...createPublicImageItem(),
          coverUrl,
        }).success
      ).toBe(false);
    }

    expect(
      modelMarketplacePublicItemSchema.safeParse({
        ...createPublicImageItem(),
        bucket: "model-marketplace",
        key: "image/config/content.webp",
      }).success
    ).toBe(false);
  });

  it("公开视频 DTO 固定返回 category 与可调用 defaultModelId", () => {
    const parsed = modelMarketplacePublicItemSchema.parse({
      category: "video",
      configKey: "veo31",
      defaultModelId: "firefly-veo31-4s-16x9-1080p",
      displayName: "Veo 3.1",
      iconKey: "google",
      description: "适合高质量视频生成。",
      coverUrl: "/images/video-default.webp",
      minimumCredits: 45,
      priceUnit: "per_second",
      creditsPerSecond: 45,
      supportedDurations: [4, 6, 8],
      supportedAspectRatios: ["16:9", "9:16"],
      supportedResolutions: ["720p", "1080p"],
    });

    expect(parsed).toMatchObject({
      category: "video",
      defaultModelId: "firefly-veo31-4s-16x9-1080p",
    });
  });
});

describe("updateModelConfigurationEntryInputSchema", () => {
  const common = {
    clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
    configKey: "gpt-image-2",
    expectedRevision: 2,
    visible: true,
    description: "  新简介  ",
    coverChange: { action: "keep" },
    pricing: IMAGE_PRICING,
  };

  it("要求继承 default 的图像保存携带 fallback revision", () => {
    const parsed = updateModelConfigurationEntryInputSchema.parse({
      ...common,
      category: "image",
      pricingSource: "fallback",
      expectedFallbackRevision: 5,
    });

    if (parsed.category !== "image" || parsed.pricingSource !== "fallback") {
      throw new Error("应解析为继承 default 的图像配置输入");
    }
    expect(parsed.description).toBe("新简介");
    expect(parsed.expectedFallbackRevision).toBe(5);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricingSource: "fallback",
      }).success
    ).toBe(false);
  });

  it("显式价格图像不接受无关 fallback revision", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricingSource: "explicit",
      }).success
    ).toBe(true);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricingSource: "explicit",
        expectedFallbackRevision: 5,
      }).success
    ).toBe(false);
  });

  it("封面替换只接受字节并拒绝 URL、bucket、key 与未知字段", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricingSource: "explicit",
        coverChange: {
          action: "replace",
          bytes: new Uint8Array([1, 2, 3]),
        },
      }).success
    ).toBe(true);

    for (const field of ["url", "bucket", "key"] as const) {
      expect(
        updateModelConfigurationEntryInputSchema.safeParse({
          ...common,
          category: "image",
          pricingSource: "explicit",
          coverChange: {
            action: "replace",
            bytes: new Uint8Array([1]),
            [field]: "forbidden",
          },
        }).success
      ).toBe(false);
    }
  });

  it("default 只接受图像价格与并发 revision", () => {
    const valid = {
      clientRequestId: common.clientRequestId,
      category: "fallback",
      configKey: "default",
      expectedRevision: 3,
      pricing: IMAGE_PRICING,
    };

    expect(
      updateModelConfigurationEntryInputSchema.safeParse(valid).success
    ).toBe(true);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...valid,
        visible: true,
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        configKey: "default",
        pricingSource: "explicit",
      }).success
    ).toBe(false);
  });

  it("拒绝非 UUID 请求键、超长简介和非法 revision", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricingSource: "explicit",
        clientRequestId: "retry-1",
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricingSource: "explicit",
        description: "模".repeat(201),
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricingSource: "explicit",
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success
    ).toBe(false);
  });
});

describe("updateModelConfigurationEntryOutputSchema", () => {
  it("只返回条目身份与最新 revision", () => {
    const output = {
      category: "video",
      configKey: "veo31",
      revision: 4,
    };

    expect(
      updateModelConfigurationEntryOutputSchema.safeParse(output).success
    ).toBe(true);
    expect(
      updateModelConfigurationEntryOutputSchema.safeParse({
        ...output,
        coverUrl: "/unexpected.webp",
      }).success
    ).toBe(false);
  });
});
