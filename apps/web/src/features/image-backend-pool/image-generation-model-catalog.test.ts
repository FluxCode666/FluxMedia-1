/**
 * 统一成员图片目录的纯逻辑测试。
 *
 * 覆盖 API 成员能力合并、模型前缀无类型分流和视频能力排除。
 */
import { describe, expect, it } from "vitest";

import { buildImageGenerationModelCatalog } from "./image-generation-model-catalog";

const group = {
  id: "group-main",
  name: "主分组",
  isDefault: true,
};

describe("buildImageGenerationModelCatalog", () => {
  it("合并同组 API 成员的相同模型能力", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      members: [
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: ["gpt-image-2"],
        },
      ],
    });

    expect(result.groups[0]?.models).toEqual([
      {
        id: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true },
      },
    ]);
  });

  it("兼容成员历史前缀但目录只输出裸 ID", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      members: [
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: ["firefly-gpt-image-2"],
        },
      ],
    });

    expect(result.groups[0]?.models).toEqual([
      {
        id: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true },
      },
    ]);
  });

  it("不把视频模型暴露到图片面板", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      members: [
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: [
            "veo31",
            "firefly-veo31-6s-16x9-1080p",
            "gpt-image-2",
          ],
        },
      ],
    });

    expect(result.groups[0]?.models.map((model) => model.id)).toEqual([
      "gpt-image-2",
    ]);
  });

  it("不把自定义视频模型误分类到图片面板", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      videoModelIds: ["vendor-video-x"],
      members: [
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: ["vendor-video-x", "vendor-image-x"],
        },
      ],
    });

    expect(result.groups[0]?.models.map((model) => model.id)).toEqual([
      "vendor-image-x",
    ]);
  });

  it("传播模型配置中显式开启的质量能力", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      members: [
        { groupId: group.id, type: "api", supportedModelIds: ["gpt-image-2"] },
      ],
      supportsQualityByModel: { "gpt-image-2": true },
    });

    expect(result.groups[0]?.models[0]).toMatchObject({
      id: "gpt-image-2",
      supportsQuality: true,
    });
  });

  it("传播模型配置中的参考图数量上限且保留显式 0", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      members: [
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: ["gpt-image-2", "nano-banana-pro"],
        },
      ],
      maxReferenceImagesByModel: {
        "gpt-image-2": 4,
        "nano-banana-pro": 0,
      },
    });

    expect(result.groups[0]?.models).toEqual([
      {
        id: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true },
        maxReferenceImages: 4,
      },
      {
        id: "nano-banana-pro",
        capabilities: { generate: true, edit: true, mask: true },
        maxReferenceImages: 0,
      },
    ]);
  });

  it("按账号下模型、账号、全局模型和系统策略顺序汇总可用参考图上限", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      fallbackMaxReferenceImages: 16,
      maxReferenceImagesByModel: { "gpt-image-2": 2 },
      members: [
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: ["gpt-image-2"],
          imageMaxReferenceImages: 5,
          imageMaxReferenceImagesByModel: { "gpt-image-2": 3 },
        },
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: ["gpt-image-2"],
          imageMaxReferenceImages: 6,
        },
      ],
    });

    // 同一分组可调度多个账号，前端展示不会预先拒绝任一可用账号支持的数量；
    // 提交时仍由服务端按最终获租账号做权威过滤。
    expect(result.groups[0]?.models[0]?.maxReferenceImages).toBe(6);
  });
});
