/**
 * 模型运行时启用状态纯函数测试。
 *
 * 使用方是 Vitest；锁定旧配置默认启用、图片前缀规范化、视频真实 ID
 * 与自定义模型的显式停用语义。
 */
import { describe, expect, it } from "vitest";

import { createDefaultModelMarketplaceConfig } from "./contracts";
import {
  isModelMarketplaceEntryEnabled,
  isModelMarketplaceModelEnabled,
} from "./availability";

describe("model marketplace availability", () => {
  it("缺失条目和旧条目默认启用", () => {
    expect(isModelMarketplaceEntryEnabled(undefined)).toBe(true);
    expect(
      isModelMarketplaceEntryEnabled({
        revision: 1,
        visible: true,
        description: "",
        cover: null,
      })
    ).toBe(true);
  });

  it("图片前缀、真实视频 ID 和自定义模型共享显式停用语义", () => {
    const config = createDefaultModelMarketplaceConfig();
    const disabledEntry = {
      revision: 1,
      enabled: false,
      visible: false,
      homepageVisible: false,
      description: "",
      cover: null,
    };
    config.imageByModel["gpt-image-2"] = disabledEntry;
    config.videoByFamily.seedance2 = disabledEntry;
    config.videoByFamily["vendor-video"] = disabledEntry;

    expect(
      isModelMarketplaceModelEnabled(config, "image", "firefly-gpt-image-2")
    ).toBe(false);
    expect(
      isModelMarketplaceModelEnabled(config, "video", "seedance2")
    ).toBe(false);
    expect(
      isModelMarketplaceModelEnabled(config, "video", "vendor-video")
    ).toBe(false);
    expect(
      isModelMarketplaceModelEnabled(config, "image", "nano-banana")
    ).toBe(true);
  });

  it("拒绝空模型和图片 default 占位符", () => {
    const config = createDefaultModelMarketplaceConfig();
    expect(isModelMarketplaceModelEnabled(config, "image", " ")).toBe(false);
    expect(isModelMarketplaceModelEnabled(config, "image", "default")).toBe(
      false
    );
  });
});
