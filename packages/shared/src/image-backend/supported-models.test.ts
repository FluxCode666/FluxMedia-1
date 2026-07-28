/**
 * API 后端支持模型列表共享规则的单元测试。
 *
 * 使用方：Vitest；覆盖管理端配置标准化、调度匹配和 `/v1/models` 公布回退语义。
 * 关键依赖：supported-models.ts；测试保持 DB-free。
 */
import { describe, expect, it } from "vitest";

import {
  collectAdvertisedModelIds,
  MAX_SUPPORTED_MODEL_IDS,
  normalizeSupportedModelIds,
  supportedModelIdsSchema,
  supportsRequestedModel,
} from "./supported-models";

describe("API 后端支持模型列表", () => {
  it("去除空白并按大小写去重，同时保留首次配置的展示形式", () => {
    expect(
      normalizeSupportedModelIds([
        " nano-banana-pro ",
        "GROK-IMAGINE-IMAGE",
        "grok-imagine-image",
        "",
      ])
    ).toEqual(["nano-banana-pro", "GROK-IMAGINE-IMAGE"]);
  });

  it("移除所有模型 ID 的历史 Firefly 前缀", () => {
    expect(
      normalizeSupportedModelIds([
        "firefly-gpt-image-2",
        "FIREFLY-SORA2-4s-16x9",
        "sora2-4s-16x9",
      ])
    ).toEqual(["gpt-image-2", "SORA2-4s-16x9"]);
    expect(
      supportsRequestedModel(
        ["firefly-sora2-4s-16x9"],
        "sora2-4s-16x9"
      )
    ).toBe(true);
  });

  it("仅在配置非空时把支持列表作为调度约束", () => {
    expect(supportsRequestedModel([], "grok-imagine-image")).toBe(true);
    expect(supportsRequestedModel(["nano-banana-pro"], "NANO-BANANA-PRO")).toBe(
      true
    );
    expect(
      supportsRequestedModel(["nano-banana-pro"], "grok-imagine-image")
    ).toBe(false);
  });

  it("允许完整视频目录并在共享上限处同时约束 schema 与标准化", () => {
    const values = Array.from(
      { length: MAX_SUPPORTED_MODEL_IDS + 1 },
      (_, index) => `model-${index}`
    );

    expect(
      supportedModelIdsSchema.safeParse(
        values.slice(0, MAX_SUPPORTED_MODEL_IDS)
      ).success
    ).toBe(true);
    expect(supportedModelIdsSchema.safeParse(values).success).toBe(false);
    expect(normalizeSupportedModelIds(values)).toHaveLength(
      MAX_SUPPORTED_MODEL_IDS
    );
  });

  it("优先公布显式列表，并为旧后端回退到默认模型", () => {
    expect(
      collectAdvertisedModelIds([
        {
          model: "legacy-image-model",
          supportedModelIds: [],
        },
        {
          model: "ignored-default",
          supportedModelIds: ["nano-banana-pro", "grok-imagine-image"],
        },
        {
          model: "unused",
          supportedModelIds: ["GROK-IMAGINE-IMAGE", "firefly-gpt-image-2"],
        },
      ])
    ).toEqual([
      "legacy-image-model",
      "nano-banana-pro",
      "grok-imagine-image",
      "gpt-image-2",
    ]);
  });
});
