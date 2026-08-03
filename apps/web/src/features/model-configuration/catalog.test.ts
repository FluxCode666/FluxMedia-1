/**
 * 管理端模型配置目录构建器测试。
 *
 * 使用方是模型配置读取与保存服务；测试确保多事实源合并、未配置价格、展示配置和严格
 * 数据校验始终生成共享契约允许的稳定快照，且不连接数据库或运行时服务。
 */
import {
  ADOBE_VIDEO_PRICING_FAMILIES,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  getVideoPricingResolutionKey,
} from "@repo/shared/adobe";
import { ADOBE_IMAGE_MODEL_IDS } from "@repo/shared/adobe/enabled-models";
import { createDefaultGlobalImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  createDefaultModelMarketplaceConfig,
  type ModelMarketplaceConfig,
  modelConfigurationSnapshotSchema,
} from "@repo/shared/model-marketplace";
import { createDefaultVideoModelCapabilityOverrides } from "@repo/shared/video-generation";
import { describe, expect, it } from "vitest";

import {
  buildModelConfigurationSnapshot,
  type ModelConfigurationCatalogInput,
} from "./catalog";

const EXTRA_IMAGE_PRICING = {
  base1024Credits: 2,
  base1kCredits: 3,
  base2kCredits: 4,
  base4kCredits: 5,
};

/**
 * 创建合法目录输入并允许测试覆盖单个事实源。
 *
 * @param overrides - 当前用例需要替换的读取结果或封面 URL 构造器。
 * @returns 相互隔离且可直接交给纯目录构建器的输入。
 * @sideEffects 无；每次调用均创建新的价格与展示配置对象。
 * @failure 覆盖值不合法时由被测构建器的严格 schema 显式抛错。
 */
function createInput(
  overrides: Partial<ModelConfigurationCatalogInput> = {}
): ModelConfigurationCatalogInput {
  return {
    imagePricing: createDefaultGlobalImageCreditOverrides(),
    videoPricing: { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND },
    marketplaceConfig: createDefaultModelMarketplaceConfig(),
    videoCapabilityOverrides: createDefaultVideoModelCapabilityOverrides(),
    runtimeCatalog: {
      status: "ready",
      catalog: { image: [], video: [] },
    },
    canEdit: false,
    buildCoverUrl: () => ({
      coverUrl: "/model-marketplace/default.webp",
      usesDefaultCover: true,
    }),
    ...overrides,
  };
}

describe("buildModelConfigurationSnapshot", () => {
  it("稳定合并内置、持久化与运行时目录并按类别去重排序", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["z-persisted"] = { ...EXTRA_IMAGE_PRICING };
    imagePricing.byModel["a-persisted"] = { ...EXTRA_IMAGE_PRICING };
    const videoPricing = {
      ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
      "custom-video": 12,
    };

    const snapshot = buildModelConfigurationSnapshot(
      createInput({
        imagePricing,
        videoPricing,
        runtimeCatalog: {
          status: "ready",
          catalog: {
            image: [
              { id: "firefly-gpt-image-2" },
              { id: "runtime-image" },
              { id: "Runtime-Image" },
            ],
            video: [
              { id: "firefly-veo31-4s-16x9-1080p" },
              { id: "firefly-veo31-6s-9x16-720p" },
              { id: "unknown-video" },
            ],
          },
        },
      })
    );
    const identities = snapshot.entries.map(
      (entry) => `${entry.category}:${entry.configKey}`
    );
    const builtInImages = ADOBE_IMAGE_MODEL_IDS.map(
      (modelId) => `image:${modelId}`
    );
    const builtInVideos = ADOBE_VIDEO_PRICING_FAMILIES.map(
      (family) => `video:${family}`
    );

    expect(identities).toEqual([
      ...builtInImages,
      "image:a-persisted",
      "image:runtime-image",
      "image:z-persisted",
      ...builtInVideos,
      "video:custom-video",
    ]);
    expect(new Set(identities).size).toBe(identities.length);
    expect(snapshot.runtimeCatalogStatus).toBe("ready");
    expect(
      snapshot.entries.find((entry) => entry.configKey === "kling3-omni")
    ).toMatchObject({
      category: "video",
      displayName: "Kling 3.0 Omni",
      creditsPerSecond: 30,
    });
    expect(
      snapshot.entries.find((entry) => entry.configKey === "runway-gen45")
    ).toMatchObject({
      category: "video",
      displayName: "Runway Gen-4.5",
      creditsPerSecond: 30,
    });
    expect(
      snapshot.entries.find((entry) => entry.configKey === "ray314")
    ).toMatchObject({
      category: "video",
      displayName: "Ray 3.14",
      creditsPerSecond: 30,
    });
    expect(
      snapshot.entries.find((entry) => entry.configKey === "ray314-hdr")
    ).toMatchObject({
      category: "video",
      displayName: "Ray 3.14 HDR",
      creditsPerSecond: 30,
    });
  });

  it("运行时额外图像缺少显式价格时标记为未配置", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();

    const snapshot = buildModelConfigurationSnapshot(
      createInput({
        imagePricing,
        runtimeCatalog: {
          status: "ready",
          catalog: {
            image: [{ id: "vendor-image" }],
            video: [],
          },
        },
      })
    );
    const entry = snapshot.entries.find(
      (candidate) => candidate.configKey === "vendor-image"
    );

    expect(entry).toMatchObject({
      category: "image",
      pricingSource: "unconfigured",
    });
    expect(entry).not.toHaveProperty("pricing");
    expect(entry).not.toHaveProperty("minimumCredits");
  });

  it("无运行时成员时仍从自定义注册表返回媒体类型与分辨率", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["vendor-image-x"] = { ...EXTRA_IMAGE_PRICING };
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.customModels = [
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
    ];
    const videoPricing = {
      ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
      "vendor-video-x": 45,
      [getVideoPricingResolutionKey("vendor-video-x", "720p")]: 30,
      [getVideoPricingResolutionKey("vendor-video-x", "1080p")]: 45,
    };

    const snapshot = buildModelConfigurationSnapshot(
      createInput({ imagePricing, marketplaceConfig, videoPricing })
    );

    expect(
      snapshot.entries.find((entry) => entry.configKey === "vendor-image-x")
    ).toMatchObject({
      category: "image",
      supportedResolutions: ["1k", "2k", "4k"],
    });
    expect(
      snapshot.entries.find((entry) => entry.configKey === "vendor-video-x")
    ).toMatchObject({
      category: "video",
      supportedResolutions: ["720p", "1080p"],
      creditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
    });
  });

  it("管理快照按视频分辨率返回价格，并用最低价兼容旧列表字段", () => {
    const videoPricing = {
      ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
      [getVideoPricingResolutionKey("veo31", "720p")]: 12,
      [getVideoPricingResolutionKey("veo31", "1080p")]: 28,
      veo31: 28,
    };
    const snapshot = buildModelConfigurationSnapshot(
      createInput({ videoPricing })
    );
    expect(
      snapshot.entries.find(
        (entry) => entry.category === "video" && entry.configKey === "veo31"
      )
    ).toMatchObject({
      creditsPerSecond: 12,
      minimumCredits: 12,
      creditsPerSecondByResolution: { "720p": 12, "1080p": 28 },
      supportedResolutions: ["1080p", "720p"],
    });
  });

  it("仅为可配置 Seedance 条目返回当前参考图上限", () => {
    const defaults = buildModelConfigurationSnapshot(createInput());
    expect(
      defaults.entries.find(
        (entry) => entry.category === "video" && entry.configKey === "seedance2"
      )
    ).toMatchObject({ maxReferenceImages: 10 });
    expect(
      defaults.entries.find(
        (entry) => entry.category === "video" && entry.configKey === "veo31"
      )
    ).not.toHaveProperty("maxReferenceImages");

    const overridden = buildModelConfigurationSnapshot(
      createInput({
        videoCapabilityOverrides: {
          version: 1,
          byModel: { seedance2: { maxReferenceImages: 20 } },
        },
      })
    );
    expect(
      overridden.entries.find(
        (entry) => entry.category === "video" && entry.configKey === "seedance2"
      )
    ).toMatchObject({ maxReferenceImages: 20 });
  });

  it("未保存展示配置时复用内置简介，避免只改参考图上限时清空文案", () => {
    const snapshot = buildModelConfigurationSnapshot(createInput());

    expect(
      snapshot.entries.find(
        (entry) => entry.category === "video" && entry.configKey === "seedance2"
      )
    ).toMatchObject({
      revision: 0,
      description: "适合使用参考图生成长时竖屏视频并保持视觉风格一致。",
      maxReferenceImages: 10,
    });
  });

  it("持久化额外图像保持显式价格且不携带兜底 revision", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["vendor-image"] = { ...EXTRA_IMAGE_PRICING };

    const snapshot = buildModelConfigurationSnapshot(
      createInput({ imagePricing })
    );
    const entry = snapshot.entries.find(
      (candidate) => candidate.configKey === "vendor-image"
    );

    expect(entry).toMatchObject({
      category: "image",
      pricingSource: "explicit",
      pricing: EXTRA_IMAGE_PRICING,
      minimumCredits: 2,
    });
    expect(entry).not.toHaveProperty("fallbackPricingRevision");
  });

  it("兼容读取旧 default 价格但不输出模型条目", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel.default = { ...EXTRA_IMAGE_PRICING };

    const snapshot = buildModelConfigurationSnapshot(
      createInput({ imagePricing })
    );

    expect(snapshot.entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ configKey: "default" }),
      ])
    );
  });

  it("缺失展示配置默认展示，显式配置则透传描述和封面结果", () => {
    const marketplaceConfig: ModelMarketplaceConfig = {
      ...createDefaultModelMarketplaceConfig(),
      imageByModel: {
        "gpt-image-2": {
          revision: 3,
          visible: false,
          description: "适合精细文字渲染",
          cover: {
            bucket: "models",
            key: `image/${"a".repeat(64)}/${"b".repeat(64)}.webp`,
          },
        },
      },
    };

    const snapshot = buildModelConfigurationSnapshot(
      createInput({
        marketplaceConfig,
        buildCoverUrl: (_category, _configKey, cover) => ({
          coverUrl: cover
            ? "/api/model-marketplace/covers/gpt-image-2"
            : "/model-marketplace/default.webp",
          usesDefaultCover: cover === null,
        }),
      })
    );
    const configured = snapshot.entries.find(
      (entry) => entry.configKey === "gpt-image-2"
    );
    const defaulted = snapshot.entries.find(
      (entry) => entry.configKey === "nano-banana"
    );
    const defaultedVideo = snapshot.entries.find(
      (entry) => entry.configKey === "sora2"
    );

    expect(configured).toMatchObject({
      revision: 3,
      visible: false,
      homepageVisible: false,
      homepagePriority: 5,
      description: "适合精细文字渲染",
      coverUrl: "/api/model-marketplace/covers/gpt-image-2",
      usesDefaultCover: false,
    });
    expect(defaulted).toMatchObject({
      revision: 0,
      visible: true,
      homepageVisible: true,
      homepagePriority: 5,
      description: "适合快速图像生成、编辑与日常创意探索。",
      coverUrl: "/model-marketplace/default.webp",
      usesDefaultCover: true,
    });
    expect(defaultedVideo).toMatchObject({
      category: "video",
      visible: true,
      homepageVisible: false,
      homepagePriority: 5,
      description: "适合生成具有连贯运动和电影感构图的视频。",
    });
  });

  it("运行时不可用时仅改变状态并继续输出内置与持久化项", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["persisted-image"] = { ...EXTRA_IMAGE_PRICING };

    const snapshot = buildModelConfigurationSnapshot(
      createInput({
        imagePricing,
        runtimeCatalog: { status: "unavailable" },
      })
    );

    expect(snapshot.runtimeCatalogStatus).toBe("unavailable");
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ configKey: "gpt-image-2" }),
        expect.objectContaining({ configKey: "persisted-image" }),
        expect.objectContaining({ configKey: "sora2" }),
      ])
    );
  });

  it("展示配置、图像价格、视频价格或能力覆盖为脏值时显式抛错", () => {
    const validMarketplace = createDefaultModelMarketplaceConfig();
    const validImagePricing = createDefaultGlobalImageCreditOverrides();
    const validVideoPricing = { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND };

    expect(() =>
      buildModelConfigurationSnapshot(
        createInput({
          marketplaceConfig: { ...validMarketplace, version: 99 },
        })
      )
    ).toThrow();
    expect(() =>
      buildModelConfigurationSnapshot(
        createInput({
          imagePricing: {
            ...validImagePricing,
            byModel: {
              ...validImagePricing.byModel,
              "vendor-image": { base1024Credits: 1 },
            },
          },
        })
      )
    ).toThrow();
    expect(() =>
      buildModelConfigurationSnapshot(
        createInput({
          videoPricing: { ...validVideoPricing, sora2: 0 },
        })
      )
    ).toThrow();
    expect(() =>
      buildModelConfigurationSnapshot(
        createInput({
          videoCapabilityOverrides: {
            version: 1,
            byModel: { seedance2: { maxReferenceImages: 0 } },
          },
        })
      )
    ).toThrow();
  });

  it("最终输出通过共享管理快照契约", () => {
    const snapshot = buildModelConfigurationSnapshot(createInput());

    expect(modelConfigurationSnapshotSchema.safeParse(snapshot).success).toBe(
      true
    );
  });
});
