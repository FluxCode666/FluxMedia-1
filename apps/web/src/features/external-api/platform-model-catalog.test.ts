/**
 * 平台媒体模型目录纯构建器测试。
 *
 * 职责：覆盖显式模型能力、分组可达性、媒体分类、终态过滤、稳定去重与
 * 快速集成模型判断；旧 conversation 分类不得重新出现。
 */

import { createDefaultModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import { describe, expect, it } from "vitest";

import {
  buildPlatformModelCatalog,
  isConcretePlatformImageModelId,
  type PlatformModelCatalogSource,
} from "./platform-model-catalog";

/** 构造默认可达的统一媒体目录事实。 */
function source(
  overrides: Partial<PlatformModelCatalogSource> = {}
): PlatformModelCatalogSource {
  return {
    groups: [
      {
        id: "default-group",
        isEnabled: true,
        isDefault: true,
        isUserSelectable: false,
      },
    ],
    members: [
      {
        groupIds: ["default-group"],
        type: "adobe",
        adobeMode: "direct",
        supportedModelIds: [
          "gpt-image-2",
          "seedance2",
          "firefly-sora2-8s-16x9",
        ],
        isEnabled: true,
        status: "active",
      },
    ],
    ...overrides,
  };
}

describe("buildPlatformModelCatalog", () => {
  it("仅按统一成员显式能力输出图片与视频分类", () => {
    expect(buildPlatformModelCatalog(source())).toEqual({
      image: [{ id: "gpt-image-2" }],
      video: [{ id: "seedance2" }],
    });
  });

  it("稳定去重并排除停用、终态和不可达组成员", () => {
    const catalog = buildPlatformModelCatalog(
      source({
        groups: [
          ...source().groups,
          {
            id: "selectable-group",
            isEnabled: true,
            isDefault: false,
            isUserSelectable: true,
          },
          {
            id: "hidden-group",
            isEnabled: true,
            isDefault: false,
            isUserSelectable: false,
          },
        ],
        members: [
          {
            groupIds: ["default-group"],
            type: "api",
            adobeMode: null,
            supportedModelIds: ["Zeta-Image", "alpha-image"],
            isEnabled: true,
            status: "limited",
          },
          {
            groupIds: ["selectable-group"],
            type: "api",
            adobeMode: null,
            supportedModelIds: ["zeta-image", "beta-image"],
            isEnabled: true,
            status: "active",
          },
          {
            groupIds: ["hidden-group"],
            type: "api",
            adobeMode: null,
            supportedModelIds: ["hidden-image"],
            isEnabled: true,
            status: "active",
          },
          {
            groupIds: ["default-group"],
            type: "api",
            adobeMode: null,
            supportedModelIds: ["terminal-image"],
            isEnabled: true,
            status: "error",
          },
        ],
      })
    );

    expect(catalog.image).toEqual([
      { id: "alpha-image" },
      { id: "beta-image" },
      { id: "Zeta-Image" },
    ]);
  });

  it("停用的默认分组不会贡献静态兜底模型", () => {
    expect(
      buildPlatformModelCatalog(
        source({
          groups: [
            {
              id: "default-group",
              isEnabled: false,
              isDefault: true,
              isUserSelectable: false,
            },
          ],
        })
      )
    ).toEqual({ image: [], video: [] });
  });

  it("无成员时返回两个合法空分类", () => {
    expect(buildPlatformModelCatalog(source({ members: [] }))).toEqual({
      image: [],
      video: [],
    });
  });

  it("API 成员把真实视频 ID 发布到视频目录", () => {
    expect(
      buildPlatformModelCatalog(
        source({
          members: [
            {
              groupIds: ["default-group"],
              type: "api",
              adobeMode: null,
              supportedModelIds: ["seedance2"],
              isEnabled: true,
              status: "active",
            },
          ],
        })
      )
    ).toEqual({ image: [], video: [{ id: "seedance2" }] });
  });

  it("Adobe gateway 成员不能把真实视频 ID 发布到任一目录", () => {
    expect(
      buildPlatformModelCatalog(
        source({
          members: [
            {
              groupIds: ["default-group"],
              type: "adobe",
              adobeMode: "gateway",
              supportedModelIds: ["seedance2"],
              isEnabled: true,
              status: "active",
            },
          ],
        })
      )
    ).toEqual({ image: [], video: [] });
  });

  it("按自定义注册类型把 API 成员模型发布为视频而不是图像", () => {
    expect(
      buildPlatformModelCatalog(
        source({
          customModels: [{ modelId: "vendor-video-x", category: "video" }],
          members: [
            {
              groupIds: ["default-group"],
              type: "api",
              adobeMode: null,
              supportedModelIds: ["vendor-video-x"],
              isEnabled: true,
              status: "active",
            },
          ],
        })
      )
    ).toEqual({ image: [], video: [{ id: "vendor-video-x" }] });
  });

  it("显式停用的图片、内置视频与自定义视频均不返回", () => {
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
    marketplaceConfig.videoByFamily["vendor-video-x"] = disabledEntry;

    expect(
      buildPlatformModelCatalog(
        source({
          marketplaceConfig,
          customModels: [{ modelId: "vendor-video-x", category: "video" }],
          members: [
            {
              groupIds: ["default-group"],
              type: "api",
              adobeMode: null,
              supportedModelIds: [
                "gpt-image-2",
                "seedance2",
                "vendor-video-x",
                "nano-banana",
              ],
              isEnabled: true,
              status: "active",
            },
          ],
        })
      )
    ).toEqual({ image: [{ id: "nano-banana" }], video: [] });
  });
});

describe("isConcretePlatformImageModelId", () => {
  it.each(["", "auto", "default", "unknown"])("拒绝占位模型 %s", (id) => {
    expect(isConcretePlatformImageModelId(id)).toBe(false);
  });

  it("接受真实图片模型", () => {
    expect(isConcretePlatformImageModelId("gpt-image-2")).toBe(true);
  });
});
