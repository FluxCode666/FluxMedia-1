/**
 * 模型广场“立即使用”查询意图的 DB-free 测试。
 *
 * 使用方是图片与视频创作页客户端接入层；测试锁定参数边界、当前授权图片目录的跨组
 * 优先级，以及一次性参数清理不会破坏 ref、sendRef、mode 或 hash。
 */

import { describe, expect, it } from "vitest";
import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";

import {
  parseModelPreselectionIntent,
  removePreselectionParams,
  resolveAuthorizedImageSelection,
} from "./model-preselection";

/** 构造覆盖当前组、默认组和普通组优先级的授权图片目录。 */
function createCatalog(): ImageGenerationModelCatalog {
  return {
    groups: [
      {
        id: "group-current",
        name: "当前组",
        isDefault: false,
        models: [
          {
            id: "shared/model v2",
            capabilities: { generate: true, edit: true, mask: false },
          },
          {
            id: "disabled-model",
            capabilities: { generate: false, edit: true, mask: true },
          },
        ],
      },
      {
        id: "group-default",
        name: "默认组",
        isDefault: true,
        models: [
          {
            id: "shared/model v2",
            capabilities: { generate: true, edit: true, mask: true },
          },
          {
            id: "default-only",
            capabilities: { generate: true, edit: false, mask: false },
          },
        ],
      },
      {
        id: "group-first-capable",
        name: "首个可生成组",
        isDefault: false,
        models: [
          {
            id: "later-only",
            capabilities: { generate: true, edit: false, mask: false },
          },
          {
            id: "disabled-model",
            capabilities: { generate: true, edit: false, mask: false },
          },
        ],
      },
    ],
  };
}

describe("parseModelPreselectionIntent", () => {
  it("解析 image/video 与 URL 解码后的非空模型 ID", () => {
    expect(
      parseModelPreselectionIntent(
        new URLSearchParams("category=image&model=shared%2Fmodel+v2")
      )
    ).toEqual({ category: "image", modelId: "shared/model v2" });
    expect(
      parseModelPreselectionIntent(
        new URLSearchParams("category=video&model=firefly-veo31-6s-9x16-1080p")
      )
    ).toEqual({
      category: "video",
      modelId: "firefly-veo31-6s-9x16-1080p",
    });
  });

  it("修剪模型 ID 并接受最多 160 字符", () => {
    const modelId = "模".repeat(160);

    expect(
      parseModelPreselectionIntent(
        new URLSearchParams({ category: "image", model: `  ${modelId}  ` })
      )
    ).toEqual({ category: "image", modelId });
  });

  it.each([
    "category=audio&model=gpt-image-2",
    "category=image",
    "model=gpt-image-2",
    "category=image&model=%20%20",
    `category=image&model=${"x".repeat(161)}`,
    "category=image&category=video&model=gpt-image-2",
    "category=image&model=first&model=second",
  ])("拒绝非法或有歧义的预选参数：%s", (query) => {
    expect(parseModelPreselectionIntent(new URLSearchParams(query))).toBeNull();
  });
});

describe("resolveAuthorizedImageSelection", () => {
  it("同一模型跨组出现时优先选择当前组", () => {
    expect(
      resolveAuthorizedImageSelection({
        catalog: createCatalog(),
        currentGroupId: "group-current",
        modelId: "shared/model v2",
      })
    ).toEqual({ groupId: "group-current", modelId: "shared/model v2" });
  });

  it("当前组不可用时优先选择 isDefault 组", () => {
    expect(
      resolveAuthorizedImageSelection({
        catalog: createCatalog(),
        currentGroupId: "missing-current-group",
        modelId: "shared/model v2",
      })
    ).toEqual({ groupId: "group-default", modelId: "shared/model v2" });
  });

  it("默认组不含模型时选择目录中的首个可生成组", () => {
    expect(
      resolveAuthorizedImageSelection({
        catalog: createCatalog(),
        currentGroupId: "group-current",
        modelId: "later-only",
      })
    ).toEqual({
      groupId: "group-first-capable",
      modelId: "later-only",
    });
  });

  it("跳过存在但没有 generate 能力的模型", () => {
    expect(
      resolveAuthorizedImageSelection({
        catalog: createCatalog(),
        currentGroupId: "group-current",
        modelId: "disabled-model",
      })
    ).toEqual({
      groupId: "group-first-capable",
      modelId: "disabled-model",
    });
  });

  it("模型不在当前用户目录时返回 null 并由接入层保留安全默认值", () => {
    expect(
      resolveAuthorizedImageSelection({
        catalog: createCatalog(),
        currentGroupId: "group-current",
        modelId: "private-model",
      })
    ).toBeNull();
  });
});

describe("removePreselectionParams", () => {
  it("只移除 category/model 并保留 ref、sendRef、mode、编码值与 hash", () => {
    const currentUrl = new URL(
      "https://flux.example/zh/dashboard/generate?category=image&ref=gallery%2F1&model=gpt-image-2&sendRef=asset-2&mode=edit#workspace"
    );

    expect(removePreselectionParams(currentUrl)).toBe(
      "/zh/dashboard/generate?ref=gallery%2F1&sendRef=asset-2&mode=edit#workspace"
    );
    expect(currentUrl.searchParams.get("category")).toBe("image");
    expect(currentUrl.searchParams.get("model")).toBe("gpt-image-2");
  });

  it("清理后再次解析为空，刷新不会重复应用旧意图", () => {
    const currentUrl = new URL(
      "https://flux.example/dashboard/generate?category=image&model=gpt-image-2&ref=gallery-1"
    );
    const intent = parseModelPreselectionIntent(currentUrl.searchParams);
    const cleanedHref = removePreselectionParams(currentUrl);
    const refreshedUrl = new URL(cleanedHref, currentUrl.origin);

    expect(intent).toEqual({ category: "image", modelId: "gpt-image-2" });
    expect(cleanedHref).toBe("/dashboard/generate?ref=gallery-1");
    expect(parseModelPreselectionIntent(refreshedUrl.searchParams)).toBeNull();
  });
});
