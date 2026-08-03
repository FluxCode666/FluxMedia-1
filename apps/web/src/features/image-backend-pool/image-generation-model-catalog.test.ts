/**
 * 统一成员图片目录的纯逻辑测试。
 *
 * 覆盖跨 `api | adobe` 能力合并、模型前缀无类型分流和视频能力排除。
 */
import { describe, expect, it } from "vitest";

import { buildImageGenerationModelCatalog } from "./image-generation-model-catalog";

const group = {
  id: "group-main",
  name: "主分组",
  isDefault: true,
};

describe("buildImageGenerationModelCatalog", () => {
  it("合并同组 API 与 Adobe 的相同模型能力", () => {
    const result = buildImageGenerationModelCatalog({
      groups: [group],
      members: [
        {
          groupId: group.id,
          type: "adobe",
          supportedModelIds: ["gpt-image-2"],
        },
        {
          groupId: group.id,
          type: "api",
          supportedModelIds: ["GPT-IMAGE-2"],
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
          type: "adobe",
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
});
