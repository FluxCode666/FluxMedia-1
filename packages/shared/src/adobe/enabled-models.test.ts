/**
 * Adobe 后端开放模型共享规则的单元测试。
 *
 * 使用方：Vitest；覆盖历史配置兼容、模型白名单与视频开关边界。
 * 关键依赖：enabled-models.ts；测试保持 DB-free。
 */
import { describe, expect, it } from "vitest";

import {
  adobeEnabledModelIdsSchema,
  canAdobeBackendServeModel,
  collectAdvertisedAdobeImageModelIds,
  normalizeAdobeEnabledModelIds,
  pickExplicitAdobeImageFamily,
  resolveAdobeImageFamily,
  resolveAdobeImageModelId,
} from "./enabled-models";

describe("Adobe 后端开放模型", () => {
  it("兼容历史裸模型族并去重为 Firefly 模型 ID", () => {
    expect(
      normalizeAdobeEnabledModelIds([
        " nano-banana-pro ",
        "FIREFLY-NANO-BANANA-PRO",
        "firefly-gpt-image-2",
      ])
    ).toEqual(["firefly-nano-banana-pro", "firefly-gpt-image-2"]);
  });

  it("保存 schema 拒绝未知模型，避免无效白名单静默落库", () => {
    expect(
      adobeEnabledModelIdsSchema.safeParse(["gpt-image-2", "unknown-model"])
        .success
    ).toBe(false);
    expect(adobeEnabledModelIdsSchema.parse(["gpt-image-2"])).toEqual([
      "firefly-gpt-image-2",
    ]);
  });

  it("只让已开放的图像模型进入该 Adobe 后端", () => {
    const input = {
      enabledModels: ["firefly-nano-banana-pro"],
      supportsVideo: false,
    };

    expect(
      canAdobeBackendServeModel({
        ...input,
        requestedModel: "firefly-nano-banana-pro-2k-16x9",
      })
    ).toBe(true);
    expect(
      canAdobeBackendServeModel({
        ...input,
        requestedModel: "firefly-gpt-image-2",
      })
    ).toBe(false);
  });

  it("普通模型实际落到 gpt-image-2，因此同样受白名单约束", () => {
    expect(resolveAdobeImageModelId("gpt-image-1")).toBe("firefly-gpt-image-2");
    expect(resolveAdobeImageModelId("gpt-image-1.5")).toBe(
      "firefly-gpt-image-2"
    );
    expect(
      canAdobeBackendServeModel({
        enabledModels: ["firefly-nano-banana"],
        supportsVideo: false,
        requestedModel: "gpt-image-1",
      })
    ).toBe(false);
  });

  it("裸 nano-banana 模型族与 Firefly 别名使用同一白名单", () => {
    expect(resolveAdobeImageModelId("nano-banana-pro")).toBe(
      "firefly-nano-banana-pro"
    );
    expect(resolveAdobeImageModelId("nano-banana2-2k-1x1")).toBe(
      "firefly-nano-banana2"
    );
    expect(
      canAdobeBackendServeModel({
        enabledModels: ["firefly-nano-banana-pro"],
        supportsVideo: false,
        requestedModel: "nano-banana-pro",
      })
    ).toBe(true);
  });

  it("按最长模型族匹配 Adobe 图片家族", () => {
    expect(resolveAdobeImageFamily("gpt-image-1")).toBe("gpt-image-2");
    expect(resolveAdobeImageFamily("firefly-gpt-image-1.5-2k")).toBe(
      "gpt-image-1.5"
    );
    expect(resolveAdobeImageFamily("firefly-nano-banana-pro-2k-16x9")).toBe(
      "nano-banana-pro"
    );
    expect(resolveAdobeImageFamily("firefly-nano-banana2-2k-1x1")).toBe(
      "nano-banana2"
    );
  });

  it("只把显式 Adobe 模型请求识别为指定家族", () => {
    expect(pickExplicitAdobeImageFamily("gpt-image-1")).toBeNull();
    expect(pickExplicitAdobeImageFamily("firefly-gpt-image-1.5")).toBe(
      "gpt-image-1.5"
    );
    expect(pickExplicitAdobeImageFamily("nano-banana-pro")).toBe(
      "nano-banana-pro"
    );
  });

  it("空白名单保持历史不限图像模型语义，视频仍须显式开启", () => {
    expect(
      canAdobeBackendServeModel({
        enabledModels: [],
        supportsVideo: false,
        requestedModel: "firefly-gpt-image-1.5",
      })
    ).toBe(true);
    expect(
      canAdobeBackendServeModel({
        enabledModels: [],
        supportsVideo: false,
        requestedModel: "firefly-sora2-8s-16x9",
      })
    ).toBe(false);
    expect(
      canAdobeBackendServeModel({
        enabledModels: [],
        supportsVideo: true,
        requestedModel: "firefly-sora2-8s-16x9",
      })
    ).toBe(true);
  });

  it("模型列表仅公布启用后端明确开放的图像模型", () => {
    expect(
      collectAdvertisedAdobeImageModelIds([
        { enabledModels: ["firefly-nano-banana-pro"] },
        { enabledModels: ["gpt-image-1.5"] },
      ])
    ).toEqual(["firefly-gpt-image-1.5", "firefly-nano-banana-pro"]);
  });

  it("任一历史不限配置会公布完整图像模型集合", () => {
    expect(
      collectAdvertisedAdobeImageModelIds([
        { enabledModels: ["firefly-nano-banana"] },
        { enabledModels: null },
      ])
    ).toContain("firefly-gpt-image-2");
  });
});
