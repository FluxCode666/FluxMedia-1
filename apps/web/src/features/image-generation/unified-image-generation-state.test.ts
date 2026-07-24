/**
 * 合并式页面生图状态规则的单元测试。
 *
 * 使用方：防止 UI 重构时让蒙版脱离主图、或将不兼容目录模型错误显示为可提交。
 */
import { describe, expect, it } from "vitest";
import type { ImageGenerationCatalogModel } from "@/features/image-backend-pool/image-generation-model-catalog";
import {
  canModelServeUnifiedImageGeneration,
  createUnifiedModelSelectionValue,
  getRequiredUnifiedModelCapability,
  getUnifiedImageGenerationMode,
  parseUnifiedModelSelectionValue,
} from "./unified-image-generation-state";

const fullyCapableModel: ImageGenerationCatalogModel = {
  id: "gpt-image-2",
  capabilities: { generate: true, edit: true, mask: true },
  modelListState: "declared",
};

describe("合并式页面生图状态", () => {
  it("以主参考图与蒙版唯一决定请求模式", () => {
    expect(
      getUnifiedImageGenerationMode({ hasReference: false, hasMask: false })
    ).toBe("text-to-image");
    expect(
      getUnifiedImageGenerationMode({ hasReference: true, hasMask: false })
    ).toBe("image-to-image");
    expect(
      getUnifiedImageGenerationMode({ hasReference: true, hasMask: true })
    ).toBe("masked-edit");
    expect(
      getUnifiedImageGenerationMode({ hasReference: false, hasMask: true })
    ).toBe("text-to-image");
  });

  it("按当前模式阻止不兼容模型提交", () => {
    const noMaskModel: ImageGenerationCatalogModel = {
      ...fullyCapableModel,
      capabilities: { generate: true, edit: true, mask: false },
    };

    expect(getRequiredUnifiedModelCapability("text-to-image")).toBe("generate");
    expect(getRequiredUnifiedModelCapability("image-to-image")).toBe("edit");
    expect(getRequiredUnifiedModelCapability("masked-edit")).toBe("mask");
    expect(
      canModelServeUnifiedImageGeneration(noMaskModel, "image-to-image")
    ).toBe(true);
    expect(
      canModelServeUnifiedImageGeneration(noMaskModel, "masked-edit")
    ).toBe(false);
    expect(canModelServeUnifiedImageGeneration(null, "text-to-image")).toBe(
      false
    );
  });

  it("以无歧义编码保存并拒绝错误模型选择值", () => {
    const value = createUnifiedModelSelectionValue(
      "preferred-group",
      "gpt-image-2"
    );

    expect(parseUnifiedModelSelectionValue(value)).toEqual({
      groupId: "preferred-group",
      modelId: "gpt-image-2",
    });
    expect(parseUnifiedModelSelectionValue("preferred-group:gpt-image-2")).toBe(
      null
    );
    expect(parseUnifiedModelSelectionValue('["group", ""]')).toBe(null);
  });
});
