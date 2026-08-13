/**
 * 视频生成模型启用保护测试。
 *
 * 使用方是 Vitest；锁定旧配置默认允许和内置、自定义模型显式停用拒绝。
 */
import { createDefaultModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import type { OperationError } from "@repo/shared/uol";
import { describe, expect, it } from "vitest";

import { assertVideoModelEnabled } from "./video-model-availability";

describe("assertVideoModelEnabled", () => {
  it("缺少显式条目时保持旧配置默认启用", () => {
    expect(() =>
      assertVideoModelEnabled(createDefaultModelMarketplaceConfig(), "sora2")
    ).not.toThrow();
  });

  it.each([
    "seedance2",
    "vendor-video",
  ])("显式停用视频模型 %s 时在生成前拒绝", (modelId) => {
    const config = createDefaultModelMarketplaceConfig();
    config.videoByFamily[modelId] = {
      revision: 1,
      enabled: false,
      visible: false,
      homepageVisible: false,
      description: "",
      cover: null,
    };

    expect(() => assertVideoModelEnabled(config, modelId)).toThrowError(
      expect.objectContaining({
        code: "validation_error",
        message: "视频模型当前未启用",
        details: { field: "model", reason: "model_disabled" },
      }) satisfies Partial<OperationError>
    );
  });
});
