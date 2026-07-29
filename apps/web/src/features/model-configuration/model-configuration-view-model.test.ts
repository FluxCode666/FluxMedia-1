/**
 * 模型配置管理视图模型的 DB-free 单测。
 *
 * 覆盖搜索、筛选、稳定顺序、未配置价格、只读 Dialog 和封面单次回退。
 */
import type { ModelConfigurationEntry } from "@repo/shared/model-marketplace";
import { describe, expect, it } from "vitest";

import {
  filterModelConfigurationEntries,
  formatModelConfigurationMinimumCredits,
  getModelConfigurationCategoryLabel,
  getModelConfigurationCoverSource,
  getModelConfigurationDialogFields,
  getModelConfigurationHomepageLabel,
  getModelConfigurationSaveErrorMessage,
  getModelConfigurationVisibilityLabel,
  resolveModelConfigurationCoverAfterError,
} from "./model-configuration-view-model";

const ENTRIES: ModelConfigurationEntry[] = [
  {
    category: "image",
    configKey: "gpt-image-2",
    displayName: "GPT Image 2",
    iconKey: "openai",
    revision: 0,
    marketplaceApplicable: true,
    visible: true,
    homepageVisible: true,
    homepagePriority: 3,
    description: "",
    coverUrl: "/custom/image.webp",
    usesDefaultCover: false,
    minimumCredits: 1.27,
    pricingSource: "explicit",
    pricing: {
      base1024Credits: 1.27,
      base1kCredits: 1.27,
      base2kCredits: 5.07,
      base4kCredits: 10,
    },
  },
  {
    category: "video",
    configKey: "veo31",
    displayName: "Veo 3.1",
    iconKey: "google",
    revision: 1,
    marketplaceApplicable: true,
    visible: false,
    homepageVisible: false,
    homepagePriority: 8,
    description: "",
    coverUrl: "/custom/video.webp",
    usesDefaultCover: false,
    minimumCredits: 45,
    creditsPerSecond: 45,
    creditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
    supportedResolutions: ["720p", "1080p"],
  },
  {
    category: "image",
    configKey: "vendor-canvas",
    displayName: "Vendor Canvas",
    iconKey: "generic",
    revision: 2,
    marketplaceApplicable: true,
    visible: true,
    homepageVisible: true,
    homepagePriority: 5,
    description: "",
    coverUrl: "/model-marketplace/default-image.webp",
    usesDefaultCover: true,
    pricingSource: "unconfigured",
  },
];

/** 取得固定测试条目，并让越界成为可定位的测试夹具错误。 */
function getEntry(index: number): ModelConfigurationEntry {
  const entry = ENTRIES[index];
  if (!entry) throw new Error(`缺少索引 ${index} 的模型配置测试条目`);
  return entry;
}

describe("模型配置视图模型", () => {
  it("按 ID 或名称搜索且保持服务端稳定顺序", () => {
    expect(
      filterModelConfigurationEntries(ENTRIES, "", "all").map(
        (entry) => entry.configKey
      )
    ).toEqual(["gpt-image-2", "veo31", "vendor-canvas"]);
    expect(
      filterModelConfigurationEntries(ENTRIES, " IMAGE ", "all").map(
        (entry) => entry.configKey
      )
    ).toEqual(["gpt-image-2"]);
    expect(
      filterModelConfigurationEntries(ENTRIES, "VEO31", "all").map(
        (entry) => entry.configKey
      )
    ).toEqual(["veo31"]);
  });

  it("图像与视频筛选保留对应真实模型", () => {
    expect(
      filterModelConfigurationEntries(ENTRIES, "", "image").map(
        (entry) => entry.category
      )
    ).toEqual(["image", "image"]);
    expect(
      filterModelConfigurationEntries(ENTRIES, "", "video").map(
        (entry) => entry.category
      )
    ).toEqual(["video"]);
  });

  it("生成类别、展示状态和最低价格文案", () => {
    expect(ENTRIES.map(getModelConfigurationCategoryLabel)).toEqual([
      "图像",
      "视频",
      "图像",
    ]);
    expect(ENTRIES.map(getModelConfigurationVisibilityLabel)).toEqual([
      "已展示",
      "已隐藏",
      "未配置价格",
    ]);
    expect(ENTRIES.map(getModelConfigurationHomepageLabel)).toEqual([
      "已展示 · P3",
      "未展示",
      "已展示 · P5",
    ]);
    expect(formatModelConfigurationMinimumCredits(1.2700001)).toBe("1.27 积分");
  });

  it("只读权限隐藏保存和封面动作，未配置图像仍显示完整字段", () => {
    expect(getModelConfigurationDialogFields(getEntry(0), false)).toEqual({
      canSave: false,
      showMarketplaceFields: true,
      showImagePricing: true,
      showVideoPricing: false,
      showCoverActions: false,
    });
    expect(getModelConfigurationDialogFields(getEntry(2), true)).toEqual({
      canSave: true,
      showMarketplaceFields: true,
      showImagePricing: true,
      showVideoPricing: false,
      showCoverActions: true,
    });
  });

  it("封面失败只回退一次本地默认图，再失败则停止渲染", () => {
    expect(getModelConfigurationCoverSource(getEntry(0))).toBe(
      "/custom/image.webp"
    );
    expect(getModelConfigurationCoverSource(getEntry(2))).toBe(
      "/model-marketplace/default-image.webp"
    );
    expect(
      resolveModelConfigurationCoverAfterError("/custom/image.webp", "image")
    ).toBe("/model-marketplace/default-image.webp");
    expect(
      resolveModelConfigurationCoverAfterError(
        "/model-marketplace/default-image.webp",
        "image"
      )
    ).toBeNull();
  });

  it("按稳定保存错误码提供可执行提示且不显示服务端原文", () => {
    expect(getModelConfigurationSaveErrorMessage("invalid_cover")).toContain(
      "静态 JPEG、PNG 或 WebP"
    );
    expect(
      getModelConfigurationSaveErrorMessage("idempotency_conflict")
    ).toContain("保存标识");
    expect(getModelConfigurationSaveErrorMessage("validation_error")).toContain(
      "模型配置内容无效"
    );
    expect(getModelConfigurationSaveErrorMessage("database-secret")).toBe(
      "保存模型配置失败，请稍后重试"
    );
  });
});
