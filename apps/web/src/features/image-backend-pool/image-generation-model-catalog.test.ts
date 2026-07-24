/**
 * 图像生成模型目录的纯函数测试。
 *
 * 使用方：后端池服务在向创作页返回授权分组与模型前调用目录构建器；本文件固定
 * 默认回退、声明模型和 Adobe 蒙版能力的边界，避免前端静态候选绕过服务端授权。
 */
import { describe, expect, it } from "vitest";

import {
  buildImageGenerationCatalogMemberGroupMap,
  buildImageGenerationModelCatalog,
  type ImageGenerationCatalogSource,
  isImageGenerationCatalogMemberAvailable,
} from "./image-generation-model-catalog";

/** 构造最小分组来源，保持各测试只表达所需的授权和成员差异。 */
function createSource(
  overrides: Partial<ImageGenerationCatalogSource> = {}
): ImageGenerationCatalogSource {
  return {
    groups: [
      {
        id: "default-group",
        name: "默认分组",
        isDefault: true,
        routingMode: "implicit-default",
      },
    ],
    members: [
      {
        groupId: "default-group",
        type: "api",
        defaultModel: "gpt-image-2",
        supportedModelIds: [],
      },
    ],
    ...overrides,
  };
}

describe("buildImageGenerationModelCatalog", () => {
  it("保留未声明完整模型清单的默认回退组", () => {
    const catalog = buildImageGenerationModelCatalog(createSource());

    expect(catalog.groups).toEqual([
      {
        id: "default-group",
        name: "默认分组",
        isDefault: true,
        routingMode: "implicit-default",
        models: [
          {
            id: "gpt-image-2",
            capabilities: {
              generate: true,
              edit: true,
              mask: true,
            },
            modelListState: "undeclared",
          },
        ],
      },
    ]);
  });

  it("把目录分组价格覆盖传给创作页预估", () => {
    const imageCreditOverrides = {
      version: 1 as const,
      byModel: { "gpt-image-2": { base2kCredits: 7.5 } },
    };
    const catalog = buildImageGenerationModelCatalog(
      createSource({
        groups: [
          {
            id: "default-group",
            name: "默认分组",
            isDefault: true,
            imageCreditOverrides,
            routingMode: "implicit-default",
          },
        ],
      })
    );

    expect(catalog.groups[0]?.imageCreditOverrides).toEqual(
      imageCreditOverrides
    );
  });

  it("按分组聚合模型且不把 Adobe 蒙版能力伪装为可用", () => {
    const catalog = buildImageGenerationModelCatalog(
      createSource({
        groups: [
          {
            id: "default-group",
            name: "默认分组",
            isDefault: true,
            routingMode: "implicit-default",
          },
          {
            id: "firefly-group",
            name: "Firefly 分组",
            isDefault: false,
            routingMode: "explicit-selectable",
          },
        ],
        members: [
          {
            groupId: "default-group",
            type: "api",
            defaultModel: "gpt-image-2",
            supportedModelIds: ["gpt-image-2", "gpt-image-1.5"],
          },
          {
            groupId: "firefly-group",
            type: "adobe",
            enabledModels: ["gpt-image-2", "nano-banana-pro"],
          },
        ],
      })
    );

    expect(catalog.groups[0]?.models.map((model) => model.id)).toEqual([
      "gpt-image-2",
      "gpt-image-1.5",
    ]);
    expect(catalog.groups[1]?.models).toEqual([
      {
        id: "firefly-gpt-image-2",
        capabilities: { generate: true, edit: true, mask: false },
        modelListState: "declared",
      },
      {
        id: "firefly-nano-banana-pro",
        capabilities: { generate: true, edit: true, mask: false },
        modelListState: "declared",
      },
    ]);
  });

  it("将账号收敛为安全的 default 图片选项，不泄露顶层对话模型", () => {
    const catalog = buildImageGenerationModelCatalog(
      createSource({
        members: [
          {
            groupId: "default-group",
            type: "account",
            accountBackend: "web",
            defaultModel: "gpt-5.4",
            capabilities: { generate: true, edit: true, mask: true },
          },
        ],
      })
    );

    expect(catalog.groups[0]?.models).toEqual([
      {
        id: "default",
        capabilities: { generate: true, edit: true, mask: false },
        modelListState: "undeclared",
      },
    ]);
  });

  it("仅将 Responses 账号列为支持蒙版的 default 图片选项", () => {
    const catalog = buildImageGenerationModelCatalog(
      createSource({
        members: [
          {
            groupId: "default-group",
            type: "account",
            accountBackend: "responses",
            defaultModel: "gpt-5.4",
          },
        ],
      })
    );

    expect(catalog.groups[0]?.models).toEqual([
      {
        id: "default",
        capabilities: { generate: true, edit: true, mask: true },
        modelListState: "undeclared",
      },
    ]);
  });

  it("不让普通 API 的 Firefly 声明给 Adobe 模型伪造蒙版能力", () => {
    const catalog = buildImageGenerationModelCatalog(
      createSource({
        members: [
          {
            groupId: "default-group",
            type: "api",
            defaultModel: "gpt-image-2",
            supportedModelIds: ["firefly-gpt-image-2"],
            adobeSourced: false,
            capabilities: { generate: true, edit: true, mask: true },
          },
          {
            groupId: "default-group",
            type: "adobe",
            enabledModels: ["firefly-gpt-image-2"],
          },
        ],
      })
    );

    expect(catalog.groups[0]?.models).toEqual([
      {
        id: "firefly-gpt-image-2",
        capabilities: { generate: true, edit: true, mask: false },
        modelListState: "declared",
      },
    ]);
  });

  it("把规范化后为空的 API 模型列表视为未声明", () => {
    const catalog = buildImageGenerationModelCatalog(
      createSource({
        members: [
          {
            groupId: "default-group",
            type: "api",
            defaultModel: "gpt-image-2",
            supportedModelIds: ["  ", 1],
          },
        ],
      })
    );

    expect(catalog.groups[0]?.models).toEqual([
      {
        id: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true },
        modelListState: "undeclared",
      },
    ]);
  });

  it("按调度器的一层 mixed 规则将子组成员映射回父组目录", () => {
    const memberships = buildImageGenerationCatalogMemberGroupMap({
      catalogGroupIds: ["mixed-parent"],
      groups: [
        {
          id: "mixed-parent",
          backendType: "mixed",
          childGroupIds: ["web-child", "responses-child", "invalid-child"],
        },
        {
          id: "web-child",
          backendType: "web",
          childGroupIds: [],
        },
        {
          id: "responses-child",
          backendType: "responses",
          childGroupIds: [],
        },
        {
          id: "invalid-child",
          backendType: "web",
          childGroupIds: ["nested"],
        },
      ],
    });

    expect(memberships.get("mixed-parent")).toEqual(["mixed-parent"]);
    expect(memberships.get("web-child")).toEqual(["mixed-parent"]);
    expect(memberships.get("responses-child")).toEqual(["mixed-parent"]);
    expect(memberships.has("invalid-child")).toBe(false);
  });

  it("仅展示调度器当前会选择的非冷却成员", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const activeMember = {
      isEnabled: true,
      alwaysActive: false,
      status: "active",
    };

    expect(isImageGenerationCatalogMemberAvailable(activeMember, now)).toBe(
      true
    );
    expect(
      isImageGenerationCatalogMemberAvailable(
        {
          ...activeMember,
          cooldownUntil: new Date("2026-07-23T12:01:00.000Z"),
        },
        now
      )
    ).toBe(false);
    expect(
      isImageGenerationCatalogMemberAvailable(
        {
          ...activeMember,
          status: "limited",
          cooldownUntil: new Date("2026-07-23T11:59:00.000Z"),
        },
        now
      )
    ).toBe(true);
    expect(
      isImageGenerationCatalogMemberAvailable(
        { ...activeMember, status: "limited" },
        now
      )
    ).toBe(false);
    expect(
      isImageGenerationCatalogMemberAvailable(
        {
          ...activeMember,
          alwaysActive: true,
          status: "limited",
          cooldownUntil: new Date("2026-07-23T12:01:00.000Z"),
        },
        now
      )
    ).toBe(true);
  });
});
