/**
 * 外部媒体模型目录纯函数测试。
 *
 * 职责：锁定真实模型大小写无关去重，确保旧视频身份不再成为公开 API。
 */

import { createDefaultModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import { describe, expect, it } from "vitest";

import { filterExternalMemberModelIds, mergeExternalModelIds } from "./models";

describe("mergeExternalModelIds", () => {
  it("按首次出现顺序去重统一成员显式模型", () => {
    expect(
      mergeExternalModelIds(
        ["gpt-image-2"],
        ["seedance2", "firefly-sora2-8s-16x9", "GROK-IMAGINE-IMAGE"],
        ["grok-imagine-image", "  gpt-image-2  "]
      )
    ).toEqual(["gpt-image-2", "seedance2", "GROK-IMAGINE-IMAGE"]);
  });

  it("忽略空模型 ID", () => {
    expect(mergeExternalModelIds(["", "  "], ["gpt-image-2"])).toEqual([
      "gpt-image-2",
    ]);
  });
});

describe("filterExternalMemberModelIds", () => {
  it("/v1/models 发布 API 与 Adobe direct 成员声明的真实视频 ID", () => {
    const supportedModelIds = [
      "gpt-image-2",
      "seedance2",
      "firefly-seedance2-15s-9x16-480p",
      "seedance2-preview",
    ];
    expect(
      filterExternalMemberModelIds({
        memberType: "adobe",
        adobeMode: "direct",
        supportedModelIds,
      })
    ).toEqual(["gpt-image-2", "seedance2"]);
    expect(
      filterExternalMemberModelIds({
        memberType: "api",
        adobeMode: null,
        supportedModelIds,
      })
    ).toEqual(["gpt-image-2", "seedance2"]);
  });

  it("/v1/models 不发布 Adobe gateway 成员声明的真实视频 ID", () => {
    expect(
      filterExternalMemberModelIds({
        memberType: "adobe",
        adobeMode: "gateway",
        supportedModelIds: ["gpt-image-2", "seedance2"],
      })
    ).toEqual(["gpt-image-2"]);
  });

  it("API 成员只把注册的自定义视频模型发布到视频目录", () => {
    expect(
      filterExternalMemberModelIds({
        memberType: "api",
        adobeMode: null,
        supportedModelIds: ["vendor-video-x", "vendor-image-x"],
        customVideoModelIds: new Set(["vendor-video-x"]),
      })
    ).toEqual(["vendor-video-x", "vendor-image-x"]);
  });

  it("不发布模型配置中显式停用的图片和视频 ID", () => {
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    const disabledEntry = {
      revision: 1,
      enabled: false,
      visible: false,
      homepageVisible: false,
      description: "",
      cover: null,
    };
    marketplaceConfig.imageByModel["gpt-image-2"] = disabledEntry;
    marketplaceConfig.videoByFamily.seedance2 = disabledEntry;

    expect(
      filterExternalMemberModelIds({
        memberType: "api",
        adobeMode: null,
        supportedModelIds: ["gpt-image-2", "seedance2", "nano-banana"],
        marketplaceConfig,
      })
    ).toEqual(["nano-banana"]);
  });
});
