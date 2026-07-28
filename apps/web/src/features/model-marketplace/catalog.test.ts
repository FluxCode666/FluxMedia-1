/**
 * 公开模型广场 DB-free 目录构建器测试。
 *
 * 使用方是公开目录生产服务；测试确保只投影真实可达、显式定价且允许展示的模型，并
 * 严格处理视频族聚合、定价模型 ID、内置简介、品牌与第一方封面。
 */
import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  getVideoPricingResolutionKey,
} from "@repo/shared/adobe";
import { createDefaultGlobalImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  createDefaultModelMarketplaceConfig,
  type ModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import { describe, expect, it } from "vitest";

import {
  buildModelMarketplaceCatalog,
  type ModelMarketplaceCatalogInput,
} from "./catalog";

const EXPLICIT_IMAGE_PRICING = {
  base1024Credits: 2,
  base1kCredits: 3,
  base2kCredits: 4,
  base4kCredits: 5,
};

/**
 * 创建合法公开目录输入并允许单个用例覆盖事实源。
 *
 * @param overrides - 当前用例需要替换的运行时目录、价格、展示配置或封面构造器。
 * @returns 相互隔离且可直接交给纯目录构建器的完整输入。
 * @sideEffects 无；每次调用均创建新的价格和展示配置对象。
 * @failure 覆盖值非法时由被测构建器的严格 schema 显式抛错。
 */
function createInput(
  overrides: Partial<ModelMarketplaceCatalogInput> = {}
): ModelMarketplaceCatalogInput {
  return {
    runtimeCatalog: { image: [], video: [] },
    imagePricing: createDefaultGlobalImageCreditOverrides(),
    videoPricing: { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND },
    marketplaceConfig: createDefaultModelMarketplaceConfig(),
    buildCoverUrl: (category) => `/model-marketplace/default-${category}.webp`,
    ...overrides,
  };
}

describe("buildModelMarketplaceCatalog", () => {
  it("仅从真实且显式定价的图像 ID 生成卡片", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["gpt-image-2"] = { ...EXPLICIT_IMAGE_PRICING };

    const items = buildModelMarketplaceCatalog(
      createInput({
        imagePricing,
        runtimeCatalog: {
          image: [{ id: "vendor-image" }, { id: "firefly-gpt-image-2" }],
          video: [],
        },
      })
    );

    expect(items).toEqual([
      expect.objectContaining({
        category: "image",
        configKey: "gpt-image-2",
        modelId: "gpt-image-2",
        iconKey: "openai",
        description: expect.stringMatching(/图像|文字/),
        pricing: EXPLICIT_IMAGE_PRICING,
        minimumCredits: 2,
        homepageVisible: true,
        homepagePriority: 5,
        priceUnit: "per_image",
      }),
    ]);
  });

  it("稳定选择真实图像 ID，且不把 configKey 伪装成运行时完整 ID", () => {
    const items = buildModelMarketplaceCatalog(
      createInput({
        runtimeCatalog: {
          image: [{ id: "Firefly-GPT-Image-2" }, { id: "firefly-gpt-image-2" }],
          video: [],
        },
      })
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      configKey: "gpt-image-2",
      modelId: "gpt-image-2",
    });
  });

  it("应用展示开关，缺失配置默认展示且配置或价格不能凭空新增模型", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["priced-but-unreachable"] = {
      ...EXPLICIT_IMAGE_PRICING,
    };
    imagePricing.byModel["runtime-default-visible"] = {
      ...EXPLICIT_IMAGE_PRICING,
    };
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: false,
      description: "已关闭",
      cover: null,
    };
    marketplaceConfig.imageByModel["configured-but-unreachable"] = {
      revision: 1,
      visible: true,
      description: "不能凭空进入",
      cover: null,
    };

    const items = buildModelMarketplaceCatalog(
      createInput({
        imagePricing,
        marketplaceConfig,
        runtimeCatalog: {
          image: [
            { id: "firefly-gpt-image-2" },
            { id: "runtime-default-visible" },
            { id: "default" },
            { id: "auto" },
            { id: "unknown" },
            { id: "firefly-auto" },
          ],
          video: [],
        },
      })
    );

    expect(items.map((item) => item.configKey)).toEqual([
      "runtime-default-visible",
    ]);
  });

  it("把真实视频变体聚合成一张卡并只从可达 ID 归纳能力", () => {
    const items = buildModelMarketplaceCatalog(
      createInput({
        runtimeCatalog: {
          image: [],
          video: [
            { id: "firefly-veo31-8s-9x16-720p" },
            { id: "firefly-veo31-6s-16x9-720p" },
            { id: "firefly-veo31-6s-16x9-1080p" },
          ],
        },
      })
    );

    expect(items).toEqual([
      expect.objectContaining({
        category: "video",
        configKey: "veo31",
        modelId: "veo31",
        iconKey: "google",
        priceUnit: "per_second",
        creditsPerSecond: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND.veo31,
        creditsPerSecondByResolution: {
          "720p":
            DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND[
              getVideoPricingResolutionKey("veo31", "720p")
            ],
          "1080p":
            DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND[
              getVideoPricingResolutionKey("veo31", "1080p")
            ],
        },
        minimumCredits: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND.veo31,
        homepageVisible: false,
        homepagePriority: 5,
        supportedDurations: [6, 8],
        supportedAspectRatios: ["16:9", "9:16"],
        supportedResolutions: ["720p", "1080p"],
      }),
    ]);
  });

  it("Seedance 2.0 的全部变体只生成一个模型族条目", () => {
    const durations = Array.from({ length: 12 }, (_, index) => index + 4);
    const items = buildModelMarketplaceCatalog(
      createInput({
        videoPricing: {
          ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
          seedance2: 45,
          [getVideoPricingResolutionKey("seedance2", "480p")]: 12,
          [getVideoPricingResolutionKey("seedance2", "720p")]: 24,
          [getVideoPricingResolutionKey("seedance2", "1080p")]: 45,
        },
        runtimeCatalog: {
          image: [],
          video: durations.flatMap((duration) => [
            { id: `seedance2-${duration}s-16x9-480p` },
            { id: `seedance2-${duration}s-9x16-720p` },
            { id: `seedance2-${duration}s-16x9-1080p` },
          ]),
        },
      })
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      category: "video",
      configKey: "seedance2",
      modelId: "seedance2",
      iconKey: "bytedance",
      creditsPerSecond: 12,
      minimumCredits: 12,
      supportedDurations: durations,
      supportedResolutions: ["480p", "720p", "1080p"],
      creditsPerSecondByResolution: {
        "480p": 12,
        "720p": 24,
        "1080p": 45,
      },
    });
  });

  it("聚合 Kling 3.0 Omni 的逐秒时长、横竖比例和两档分辨率", () => {
    const items = buildModelMarketplaceCatalog(
      createInput({
        runtimeCatalog: {
          image: [],
          video: [
            { id: "firefly-kling3-omni-15s-9x16-720p" },
            { id: "firefly-kling3-omni-3s-16x9-1080p" },
            { id: "firefly-kling3-omni-3s-9x16-720p" },
          ],
        },
      })
    );

    expect(items).toEqual([
      expect.objectContaining({
        category: "video",
        configKey: "kling3-omni",
        displayName: "Kling 3.0 Omni",
        modelId: "kling3-omni",
        iconKey: "kling",
        creditsPerSecond: 30,
        supportedDurations: [3, 15],
        supportedAspectRatios: ["16:9", "9:16"],
        supportedResolutions: ["720p", "1080p"],
      }),
    ]);
  });

  it("聚合 Runway Gen-4.5 的三档时长与固定 720p 横屏能力", () => {
    const items = buildModelMarketplaceCatalog(
      createInput({
        runtimeCatalog: {
          image: [],
          video: [
            { id: "firefly-runway-gen45-10s-16x9" },
            { id: "firefly-runway-gen45-5s-16x9" },
            { id: "firefly-runway-gen45-8s-16x9" },
          ],
        },
      })
    );

    expect(items).toEqual([
      expect.objectContaining({
        category: "video",
        configKey: "runway-gen45",
        displayName: "Runway Gen-4.5",
        modelId: "runway-gen45",
        iconKey: "runway",
        description: expect.stringContaining("16:9"),
        creditsPerSecond: 30,
        supportedDurations: [5, 8, 10],
        supportedAspectRatios: ["16:9"],
        supportedResolutions: ["720p"],
      }),
    ]);
  });

  it("聚合 Ray 3.14 的多画幅、两档时长与三档分辨率", () => {
    const items = buildModelMarketplaceCatalog(
      createInput({
        runtimeCatalog: {
          image: [],
          video: [
            { id: "firefly-ray314-10s-9x16-720p" },
            { id: "firefly-ray314-5s-16x9-4k" },
            { id: "firefly-ray314-5s-1x1-1080p" },
          ],
        },
      })
    );

    expect(items).toEqual([
      expect.objectContaining({
        category: "video",
        configKey: "ray314",
        displayName: "Ray 3.14",
        modelId: "ray314",
        iconKey: "generic",
        description: expect.stringContaining("高分辨率"),
        creditsPerSecond: 30,
        supportedDurations: [5, 10],
        supportedAspectRatios: ["16:9", "9:16", "1:1"],
        supportedResolutions: ["720p", "1080p", "4k"],
      }),
    ]);
  });

  it("聚合 Ray 3.14 HDR 的固定 5 秒、多画幅和三档分辨率", () => {
    const items = buildModelMarketplaceCatalog(
      createInput({
        runtimeCatalog: {
          image: [],
          video: [
            { id: "firefly-ray314-hdr-5s-9x16-720p" },
            { id: "firefly-ray314-hdr-5s-16x9-4k" },
            { id: "firefly-ray314-hdr-5s-1x1-1080p" },
          ],
        },
      })
    );

    expect(items).toEqual([
      expect.objectContaining({
        category: "video",
        configKey: "ray314-hdr",
        displayName: "Ray 3.14 HDR",
        modelId: "ray314-hdr",
        iconKey: "generic",
        description: expect.stringContaining("高动态范围"),
        creditsPerSecond: 30,
        supportedDurations: [5],
        supportedAspectRatios: ["16:9", "9:16", "1:1"],
        supportedResolutions: ["720p", "1080p", "4k"],
      }),
    ]);
  });

  it("运行时视频目录复用后端完整模型 ID 上限", () => {
    const items = buildModelMarketplaceCatalog(
      createInput({
        runtimeCatalog: {
          image: [],
          video: Array.from({ length: 501 }, (_, index) => ({
            id: `unknown-video-${index}`,
          })),
        },
      })
    );

    expect(items).toEqual([]);
  });

  it("按已知供应商映射品牌，未知自定义图像保持 generic", () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["grok-imagine"] = { ...EXPLICIT_IMAGE_PRICING };
    imagePricing.byModel["private-renderer"] = { ...EXPLICIT_IMAGE_PRICING };
    const items = buildModelMarketplaceCatalog(
      createInput({
        imagePricing,
        runtimeCatalog: {
          image: [
            { id: "firefly-gpt-image-2" },
            { id: "firefly-nano-banana" },
            { id: "grok-imagine" },
            { id: "private-renderer" },
          ],
          video: [
            { id: "firefly-sora2-4s-16x9" },
            { id: "firefly-veo31-4s-16x9-1080p" },
            { id: "firefly-kling-o3-5s-16x9" },
            { id: "firefly-seedance2-4s-16x9-480p" },
            { id: "firefly-runway-gen45-5s-16x9" },
          ],
        },
      })
    );
    const icons = Object.fromEntries(
      items.map((item) => [item.configKey, item.iconKey])
    );

    expect(icons).toMatchObject({
      "gpt-image-2": "openai",
      "nano-banana": "google",
      "grok-imagine": "xai",
      "private-renderer": "generic",
      sora2: "openai",
      veo31: "google",
      "kling-o3": "kling",
      seedance2: "bytedance",
      "runway-gen45": "runway",
    });
  });

  it("只在完全缺少配置时使用内置简介，并保留管理员显式保存的空简介", () => {
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 2,
      visible: true,
      description: "",
      cover: null,
    };

    const items = buildModelMarketplaceCatalog(
      createInput({
        marketplaceConfig,
        runtimeCatalog: {
          image: [{ id: "firefly-gpt-image-2" }, { id: "firefly-nano-banana" }],
          video: [],
        },
      })
    );

    expect(
      items.find((item) => item.configKey === "gpt-image-2")?.description
    ).toBe("");
    expect(
      items.find((item) => item.configKey === "nano-banana")?.description
    ).not.toBe("");
  });

  it("透传自定义简介和封面，但由共享严格 DTO 拒绝外部封面 URL", () => {
    const marketplaceConfig: ModelMarketplaceConfig = {
      ...createDefaultModelMarketplaceConfig(),
      imageByModel: {
        "gpt-image-2": {
          revision: 1,
          visible: true,
          description: "管理员自定义简介",
          cover: {
            bucket: "models",
            key: `image/${"a".repeat(64)}/${"b".repeat(64)}.webp`,
          },
        },
      },
    };
    const runtimeCatalog = {
      image: [{ id: "firefly-gpt-image-2" }],
      video: [],
    };

    expect(
      buildModelMarketplaceCatalog(
        createInput({
          marketplaceConfig,
          runtimeCatalog,
          buildCoverUrl: () =>
            `/api/storage/models/image/${"a".repeat(64)}/${"b".repeat(64)}.webp`,
        })
      )[0]
    ).toMatchObject({
      description: "管理员自定义简介",
      coverUrl: `/api/storage/models/image/${"a".repeat(64)}/${"b".repeat(64)}.webp`,
    });
    expect(() =>
      buildModelMarketplaceCatalog(
        createInput({
          marketplaceConfig,
          runtimeCatalog,
          buildCoverUrl: () => "https://cdn.example.com/cover.webp",
        })
      )
    ).toThrow();
  });

  it.each([
    ["运行时目录", { runtimeCatalog: { image: [{ id: 1 }], video: [] } }],
    [
      "图像价格",
      {
        imagePricing: {
          ...createDefaultGlobalImageCreditOverrides(),
          unexpected: true,
        },
      },
    ],
    [
      "视频价格",
      {
        videoPricing: {
          ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
          veo31: 0,
        },
      },
    ],
    [
      "展示配置",
      {
        marketplaceConfig: {
          ...createDefaultModelMarketplaceConfig(),
          version: 99,
        },
      },
    ],
  ])("%s 为脏值时显式抛错", (_label, overrides) => {
    expect(() =>
      buildModelMarketplaceCatalog(createInput(overrides))
    ).toThrow();
  });
});
