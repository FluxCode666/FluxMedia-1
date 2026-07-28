/**
 * 模型广场客户端纯交互测试。
 *
 * 使用方是 Vitest；锁定搜索、类别与厂商筛选、模型 ID 复制结果和“立即使用”查询契约，
 * 不依赖浏览器 DOM 或真实 Clipboard。
 */
import type { ModelMarketplacePublicItem } from "@repo/shared/model-marketplace";
import { describe, expect, it, vi } from "vitest";
import {
  copyModelMarketplaceId,
  filterModelMarketplaceModels,
  formatSupportedVideoDurations,
  getAvailableModelMarketplaceProviders,
  getModelMarketplaceUsageHref,
  parseModelMarketplaceCategoryFilter,
  parseModelMarketplaceProviderFilter,
} from "./model-marketplace-view-model";

const IMAGE_MODEL: ModelMarketplacePublicItem = {
  category: "image",
  configKey: "gpt-image-2",
  modelId: "gpt-image-2",
  displayName: "GPT Image 2",
  iconKey: "openai",
  description: "High quality image generation",
  coverUrl: "/model-marketplace/default-image.webp",
  minimumCredits: 1.27,
  homepageVisible: true,
  homepagePriority: 3,
  priceUnit: "per_image",
  pricing: {
    base1024Credits: 1.27,
    base1kCredits: 1.5,
    base2kCredits: 2.5,
    base4kCredits: 5,
  },
};

const VIDEO_MODEL: ModelMarketplacePublicItem = {
  category: "video",
  configKey: "veo31",
  modelId: "veo31",
  displayName: "Veo 3.1",
  iconKey: "google",
  description: "Reference-aware video generation",
  coverUrl: "/model-marketplace/default-video.webp",
  minimumCredits: 3,
  homepageVisible: true,
  homepagePriority: 2,
  priceUnit: "per_second",
  creditsPerSecond: 3,
  creditsPerSecondByResolution: { "720p": 3, "1080p": 5 },
  supportedDurations: [4, 6, 8],
  supportedAspectRatios: ["16:9", "9:16"],
  supportedResolutions: ["720p", "1080p"],
};

describe("filterModelMarketplaceModels", () => {
  it("按模型 ID、展示名、配置键或简介搜索并保持服务端顺序", () => {
    const models = [IMAGE_MODEL, VIDEO_MODEL];

    expect(
      filterModelMarketplaceModels(models, "veo31", "all", "all")
    ).toEqual([VIDEO_MODEL]);
    expect(
      filterModelMarketplaceModels(models, "veo31-6s", "all", "all")
    ).toEqual([]);
    expect(
      filterModelMarketplaceModels(models, "GPT IMAGE", "all", "all")
    ).toEqual([IMAGE_MODEL]);
    expect(
      filterModelMarketplaceModels(models, "reference-aware", "all", "all")
    ).toEqual([VIDEO_MODEL]);
    expect(filterModelMarketplaceModels(models, "", "all", "all")).toEqual(
      models
    );
  });

  it("类别、厂商与查询同时生效", () => {
    const models = [IMAGE_MODEL, VIDEO_MODEL];

    expect(
      filterModelMarketplaceModels(models, "generation", "image", "openai")
    ).toEqual([IMAGE_MODEL]);
    expect(
      filterModelMarketplaceModels(models, "generation", "video", "google")
    ).toEqual([VIDEO_MODEL]);
    expect(
      filterModelMarketplaceModels(models, "generation", "image", "google")
    ).toEqual([]);
  });

  it("把未知类别值安全回退为 all", () => {
    expect(parseModelMarketplaceCategoryFilter("image")).toBe("image");
    expect(parseModelMarketplaceCategoryFilter("video")).toBe("video");
    expect(parseModelMarketplaceCategoryFilter("conversation")).toBe("all");
  });

  it("从真实目录提取厂商并安全收窄未知值", () => {
    const seedanceModel = {
      ...VIDEO_MODEL,
      configKey: "seedance2",
      modelId: "seedance2",
      displayName: "Seedance 2.0",
      iconKey: "bytedance" as const,
    };
    const runwayModel = {
      ...VIDEO_MODEL,
      configKey: "runway-gen45",
      modelId: "runway-gen45",
      displayName: "Runway Gen-4.5",
      iconKey: "runway" as const,
    };
    expect(
      getAvailableModelMarketplaceProviders([
        runwayModel,
        VIDEO_MODEL,
        seedanceModel,
        IMAGE_MODEL,
      ])
    ).toEqual(["openai", "google", "bytedance", "runway"]);
    expect(parseModelMarketplaceProviderFilter("google")).toBe("google");
    expect(parseModelMarketplaceProviderFilter("bytedance")).toBe("bytedance");
    expect(parseModelMarketplaceProviderFilter("runway")).toBe("runway");
    expect(parseModelMarketplaceProviderFilter("unknown-vendor")).toBe("all");
  });
});

describe("copyModelMarketplaceId", () => {
  it("完整写入单一模型 ID 并报告成功", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(
      copyModelMarketplaceId(VIDEO_MODEL.modelId, writeText)
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(VIDEO_MODEL.modelId);
  });

  it("Clipboard 缺失或拒绝时报告失败且不抛错", async () => {
    await expect(
      copyModelMarketplaceId(IMAGE_MODEL.modelId, null)
    ).resolves.toBe(false);
    await expect(
      copyModelMarketplaceId(IMAGE_MODEL.modelId, async () => {
        throw new Error("permission denied");
      })
    ).resolves.toBe(false);
  });
});

describe("getModelMarketplaceUsageHref", () => {
  it("图片进入简易生图并预选模型，视频进入 API 文档", () => {
    expect(getModelMarketplaceUsageHref(IMAGE_MODEL)).toBe(
      "/dashboard/generate?category=image&model=gpt-image-2"
    );
    expect(getModelMarketplaceUsageHref(VIDEO_MODEL)).toBe(
      "/dashboard/api-docs"
    );
  });
});

describe("formatSupportedVideoDurations", () => {
  it("连续逐秒时长压缩为区间", () => {
    expect(
      formatSupportedVideoDurations([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    ).toEqual(["4–15s"]);
  });

  it("非连续时长保持逐项展示", () => {
    expect(formatSupportedVideoDurations([5, 8, 10])).toEqual([
      "5s",
      "8s",
      "10s",
    ]);
  });
});
