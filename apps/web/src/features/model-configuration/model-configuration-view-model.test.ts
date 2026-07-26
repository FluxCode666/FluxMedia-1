/**
 * 模型配置管理视图模型的 DB-free 单测。
 *
 * 覆盖搜索、筛选、稳定顺序、default 不适用、只读 Dialog 和封面单次回退。
 */
import type { ModelConfigurationEntry } from "@repo/shared/model-marketplace";
import { describe, expect, it } from "vitest";

import {
  filterModelConfigurationEntries,
  formatModelConfigurationMinimumCredits,
  getModelConfigurationCategoryLabel,
  getModelConfigurationCoverSource,
  getModelConfigurationDialogFields,
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
    description: "",
    coverUrl: "/custom/video.webp",
    usesDefaultCover: false,
    minimumCredits: 45,
    creditsPerSecond: 45,
  },
  {
    category: "fallback",
    configKey: "default",
    displayName: "其他或自定义图像模型",
    iconKey: "generic",
    revision: 2,
    marketplaceApplicable: false,
    minimumCredits: 1,
    pricing: {
      base1024Credits: 1,
      base1kCredits: 2,
      base2kCredits: 3,
      base4kCredits: 4,
    },
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
    ).toEqual(["gpt-image-2", "veo31", "default"]);
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

  it("图像与视频筛选排除 default", () => {
    expect(
      filterModelConfigurationEntries(ENTRIES, "", "image").map(
        (entry) => entry.category
      )
    ).toEqual(["image"]);
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
      "计费兜底",
    ]);
    expect(ENTRIES.map(getModelConfigurationVisibilityLabel)).toEqual([
      "已展示",
      "已隐藏",
      "不适用",
    ]);
    expect(formatModelConfigurationMinimumCredits(1.2700001)).toBe("1.27 积分");
  });

  it("只读权限隐藏保存和封面动作，default 不显示展示字段", () => {
    expect(getModelConfigurationDialogFields(getEntry(0), false)).toEqual({
      canSave: false,
      showMarketplaceFields: true,
      showImagePricing: true,
      showVideoPricing: false,
      showCoverActions: false,
    });
    expect(getModelConfigurationDialogFields(getEntry(2), true)).toEqual({
      canSave: true,
      showMarketplaceFields: false,
      showImagePricing: true,
      showVideoPricing: false,
      showCoverActions: false,
    });
  });

  it("封面失败只回退一次本地默认图，再失败则停止渲染", () => {
    expect(getModelConfigurationCoverSource(getEntry(0))).toBe(
      "/custom/image.webp"
    );
    expect(getModelConfigurationCoverSource(getEntry(2))).toBeNull();
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
});
