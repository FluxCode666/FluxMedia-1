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
    modelId: "gpt-image-2",
    displayName: "GPT Image 2",
    iconKey: "openai",
    description: "适合高质量图像生成。",
    coverUrl: "/model-assets/image/gpt-image-2.webp",
    minimumCredits: 1.27,
    homepageVisible: true,
    homepagePriority: 5,
    priceUnit: "per_image",
    pricing: IMAGE_PRICING,
  };
}

describe("modelMarketplaceConfigSchema", () => {
  it("创建相互隔离的当前版本默认配置", () => {
    const first = createDefaultModelMarketplaceConfig();
    const second = createDefaultModelMarketplaceConfig();

    expect(first).toEqual({
      version: 2,
      imageByModel: {},
      videoByFamily: {},
      customModels: [],
      writeReceipts: {},
    });
    expect(first).not.toBe(second);
    expect(first.imageByModel).not.toBe(second.imageByModel);
    expect(first.videoByFamily).not.toBe(second.videoByFamily);
    expect(first.customModels).not.toBe(second.customModels);
    expect(first.writeReceipts).not.toBe(second.writeReceipts);
    expect(MODEL_MARKETPLACE_CONFIG_VERSION).toBe(2);
  });

  it("只在持久化值缺失时回退默认配置", () => {
    expect(parseModelMarketplaceConfig(undefined)).toEqual(
      createDefaultModelMarketplaceConfig()
    );
    expect(() => parseModelMarketplaceConfig({ version: 3 })).toThrow();
  });

  it("为当前版本缺键补空记录并裁剪简介首尾空白", () => {
    const parsed = modelMarketplaceConfigSchema.parse({
      version: MODEL_MARKETPLACE_CONFIG_VERSION,
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

  it("读取旧版 v1 时丢弃 default revision 与 fallback 写回执", () => {
    const imageReceiptKey = "c".repeat(64);
    const fallbackReceiptKey = "d".repeat(64);
    const parsed = parseModelMarketplaceConfig({
      version: 1,
      fallbackImagePricingRevision: 7,
      imageByModel: {},
      videoByFamily: {},
      writeReceipts: {
        [imageReceiptKey]: {
          requestHash: "a".repeat(64),
          category: "image",
          configKey: "gpt-image-2",
          resultingRevision: 2,
          completedAt: "2026-07-26T08:00:00.000Z",
        },
        [fallbackReceiptKey]: {
          requestHash: "b".repeat(64),
          category: "fallback",
          configKey: "default",
          resultingRevision: 8,
          completedAt: "2026-07-26T09:00:00.000Z",
        },
      },
    });

    expect(parsed).toEqual({
      version: MODEL_MARKETPLACE_CONFIG_VERSION,
      imageByModel: {},
      videoByFamily: {},
      customModels: [],
      writeReceipts: {
        [imageReceiptKey]: {
          requestHash: "a".repeat(64),
          category: "image",
          configKey: "gpt-image-2",
          resultingRevision: 2,
          completedAt: "2026-07-26T08:00:00.000Z",
        },
      },
    });
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...parsed,
        fallbackImagePricingRevision: 7,
      }).success
    ).toBe(false);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...parsed,
        customModels: [
          {
            modelId: "firefly-vendor-image-x",
            category: "image",
            supportedResolutions: ["2k"],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("严格保存自定义模型类型与分辨率并拒绝重复身份", () => {
    const parsed = modelMarketplaceConfigSchema.parse({
      version: MODEL_MARKETPLACE_CONFIG_VERSION,
      imageByModel: {},
      videoByFamily: {},
      customModels: [
        {
          modelId: "vendor-image-x",
          category: "image",
          supportedResolutions: ["1k", "2k", "4k"],
        },
        {
          modelId: "vendor-video-x",
          category: "video",
          supportedResolutions: ["720p", "1080p"],
        },
      ],
    });

    expect(parsed.customModels).toHaveLength(2);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...parsed,
        customModels: [
          parsed.customModels[0],
          { ...parsed.customModels[0], modelId: "VENDOR-IMAGE-X" },
        ],
      }).success
    ).toBe(false);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...parsed,
        customModels: [
          {
            modelId: "vendor-image-x",
            category: "image",
            supportedResolutions: ["2k", "2K"],
          },
        ],
      }).success
    ).toBe(false);
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
          imageByModel: {
            image: {
              revision,
              visible: true,
              description: "",
              cover: null,
            },
          },
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
          ["b".repeat(64)]: { ...receipt, category: "fallback" },
        },
      }).success
    ).toBe(false);
    expect(
      modelMarketplaceConfigSchema.safeParse({
        ...valid,
        writeReceipts: {
          ["b".repeat(64)]: { ...receipt, configKey: "default" },
        },
      }).success
    ).toBe(false);
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
  it("管理快照区分显式价格与尚未配置价格的图像模型", () => {
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
          homepageVisible: true,
          homepagePriority: 5,
          description: "",
          coverUrl: "/images/model-default.webp",
          usesDefaultCover: true,
          pricingSource: "explicit",
          pricing: IMAGE_PRICING,
          minimumCredits: 1.27,
        },
        {
          category: "image",
          configKey: "new-image-model",
          displayName: "New Image Model",
          iconKey: "generic",
          revision: 0,
          marketplaceApplicable: true,
          visible: false,
          homepageVisible: false,
          homepagePriority: 8,
          description: "",
          coverUrl: "/images/model-default.webp",
          usesDefaultCover: true,
          pricingSource: "unconfigured",
        },
      ],
    });

    expect(snapshot.entries[0]).toMatchObject({
      pricingSource: "explicit",
      pricing: IMAGE_PRICING,
    });
    expect(snapshot.entries[1]).toMatchObject({
      pricingSource: "unconfigured",
    });
    expect(snapshot.entries[1]).not.toHaveProperty("pricing");
    expect(snapshot.entries[1]).not.toHaveProperty("minimumCredits");
    expect(
      modelConfigurationSnapshotSchema.safeParse({
        ...snapshot,
        entries: [
          {
            ...snapshot.entries[1],
            pricing: IMAGE_PRICING,
          },
        ],
      }).success
    ).toBe(false);
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

  it("公开视频 DTO 固定使用定价模型 ID 并拒绝笛卡尔积路由 ID", () => {
    const parsed = modelMarketplacePublicItemSchema.parse({
      category: "video",
      configKey: "veo31",
      modelId: "veo31",
      displayName: "Veo 3.1",
      iconKey: "google",
      description: "适合高质量视频生成。",
      coverUrl: "/images/video-default.webp",
      minimumCredits: 3,
      homepageVisible: true,
      homepagePriority: 2,
      priceUnit: "per_second",
      creditsPerSecond: 3,
      creditsPerSecondByResolution: {
        "720p": 3,
        "1080p": 5,
      },
      supportedDurations: [4, 6, 8],
      supportedAspectRatios: ["16:9", "9:16"],
      supportedResolutions: ["720p", "1080p"],
      input: {
        frames: "first-and-optional-last",
        referenceImages: { maxCount: 0, configurable: false },
        framesAndReferencesMutuallyExclusive: true,
      },
      audio: { supported: false, defaultEnabled: false },
      configuredReachable: true,
      infrastructureLimits: {
        maxMediaInputCount: 256,
        maxMediaInputBytes: 209_715_200,
      },
    });

    expect(parsed).toMatchObject({
      category: "video",
      modelId: "veo31",
    });
    expect(
      modelMarketplacePublicItemSchema.safeParse({
        ...parsed,
        modelId: "veo31-4s-16x9-1080p",
      }).success
    ).toBe(false);
  });
});

describe("updateModelConfigurationEntryInputSchema", () => {
  const common = {
    clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
    configKey: "gpt-image-2",
    expectedRevision: 2,
    visible: true,
    homepageVisible: true,
    homepagePriority: 5,
    description: "  新简介  ",
    coverChange: { action: "keep" },
    pricing: IMAGE_PRICING,
  };

  it("图像保存统一写入显式四档价格", () => {
    const parsed = updateModelConfigurationEntryInputSchema.parse({
      ...common,
      category: "image",
    });

    if (parsed.category !== "image") {
      throw new Error("应解析为图像配置输入");
    }
    expect(parsed.description).toBe("新简介");
    expect(parsed.pricing).toEqual(IMAGE_PRICING);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        pricing: undefined,
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        configKey: "firefly-vendor-image-x",
        expectedRevision: 0,
        isCustom: true,
        supportedResolutions: ["2k"],
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        configKey: "vendor-image-x",
        expectedRevision: 0,
        isCustom: true,
        supportedResolutions: undefined,
      }).success
    ).toBe(false);
  });

  it("自定义图像创建输入携带严格分辨率定义", () => {
    const parsed = updateModelConfigurationEntryInputSchema.parse({
      ...common,
      category: "image",
      configKey: "vendor-image-x",
      expectedRevision: 0,
      isCustom: true,
      supportedResolutions: ["1k", "2k", "4k"],
    });

    expect(parsed).toMatchObject({
      category: "image",
      configKey: "vendor-image-x",
      isCustom: true,
      supportedResolutions: ["1k", "2k", "4k"],
    });
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        isCustom: true,
        supportedResolutions: ["2k", "2K"],
      }).success
    ).toBe(false);
  });

  it("图像输入不接受已删除的价格来源与 fallback revision", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
      }).success
    ).toBe(true);
    for (const extra of [
      { pricingSource: "explicit" },
      { expectedFallbackRevision: 5 },
    ]) {
      expect(
        updateModelConfigurationEntryInputSchema.safeParse({
          ...common,
          category: "image",
          ...extra,
        }).success
      ).toBe(false);
    }
  });

  it("封面替换只接受字节并拒绝 URL、bucket、key 与未知字段", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
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
          coverChange: {
            action: "replace",
            bytes: new Uint8Array([1]),
            [field]: "forbidden",
          },
        }).success
      ).toBe(false);
    }
  });

  it("拒绝 fallback 类别与 default 模型键", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "fallback",
        configKey: "default",
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        configKey: "default",
      }).success
    ).toBe(false);
  });

  it("拒绝非 UUID 请求键、超长简介和非法 revision", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        clientRequestId: "retry-1",
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        description: "模".repeat(201),
      }).success
    ).toBe(false);
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success
    ).toBe(false);
  });

  it("拒绝首页展示与模型广场状态矛盾及越界优先级", () => {
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...common,
        category: "image",
        visible: false,
        homepageVisible: true,
      }).success
    ).toBe(false);
    for (const homepagePriority of [-1, 1.5, 10_001]) {
      expect(
        updateModelConfigurationEntryInputSchema.safeParse({
          ...common,
          category: "image",
          homepagePriority,
        }).success
      ).toBe(false);
    }
  });

  it("视频保存输入要求至少一个合法分辨率每秒价格", () => {
    const videoCommon = {
      clientRequestId: common.clientRequestId,
      configKey: "veo31",
      expectedRevision: 2,
      visible: true,
      homepageVisible: true,
      homepagePriority: 5,
      description: "视频模型",
      coverChange: { action: "keep" as const },
      category: "video" as const,
    };
    expect(
      updateModelConfigurationEntryInputSchema.safeParse({
        ...videoCommon,
        creditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
      }).success
    ).toBe(true);
    for (const creditsPerSecondByResolution of [
      {},
      { "720p": 0 },
      { "720p": Number.POSITIVE_INFINITY },
    ]) {
      expect(
        updateModelConfigurationEntryInputSchema.safeParse({
          ...videoCommon,
          creditsPerSecondByResolution,
        }).success
      ).toBe(false);
    }
  });

  it("视频保存输入允许 Seedance 携带正安全整数参考图上限", () => {
    const seedanceInput = {
      clientRequestId: common.clientRequestId,
      configKey: "seedance2",
      expectedRevision: 2,
      visible: true,
      homepageVisible: false,
      homepagePriority: 5,
      description: "Seedance 视频模型",
      coverChange: { action: "keep" as const },
      category: "video" as const,
      creditsPerSecondByResolution: { "1080p": 45 },
      maxReferenceImages: 20,
    };

    expect(
      updateModelConfigurationEntryInputSchema.safeParse(seedanceInput).success
    ).toBe(true);
    for (const maxReferenceImages of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        updateModelConfigurationEntryInputSchema.safeParse({
          ...seedanceInput,
          maxReferenceImages,
        }).success
      ).toBe(false);
    }
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
    expect(
      updateModelConfigurationEntryOutputSchema.safeParse({
        category: "fallback",
        configKey: "default",
        revision: 1,
      }).success
    ).toBe(false);
  });
});
