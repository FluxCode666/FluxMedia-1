/**
 * 图片单一管线的模型启用保护测试。
 *
 * 使用方是 Vitest；只通过可注入设置读取器验证调用前拒绝语义，
 * 不连接数据库、存储、计费或上游图片服务。
 */
import { createDefaultModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import type { OperationError } from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";

import { assertImageModelEnabled } from "./model-availability";

describe("assertImageModelEnabled", () => {
  it("旧配置缺少条目时默认不接受质量与 auto 尺寸", async () => {
    const loadMarketplaceConfig = vi.fn(async () => null);

    await expect(
      assertImageModelEnabled("gpt-image-2", loadMarketplaceConfig)
    ).resolves.toEqual({ supportsQuality: false, supportsAutoSize: false });
    expect(loadMarketplaceConfig).toHaveBeenCalledTimes(1);
  });

  it("显式停用的图片模型在执行管线中返回稳定错误", async () => {
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 1,
      enabled: false,
      visible: false,
      homepageVisible: false,
      description: "",
      cover: null,
    };

    await expect(
      assertImageModelEnabled("firefly-gpt-image-2", async () => config)
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "图片模型当前未启用",
      details: { field: "model", reason: "model_disabled" },
    } satisfies Partial<OperationError>);
  });

  it("显式开启质量参数时返回对应能力，即使请求未指定分辨率", async () => {
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 1,
      enabled: true,
      visible: true,
      homepageVisible: true,
      description: "",
      cover: null,
      supportsQuality: true,
      supportsAutoSize: true,
    };

    await expect(
      assertImageModelEnabled("gpt-image-2", async () => config)
    ).resolves.toEqual({ supportsQuality: true, supportsAutoSize: true });
  });

  it("请求 auto 时拒绝未显式开启 auto 能力的模型", async () => {
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 1,
      enabled: true,
      visible: true,
      homepageVisible: false,
      description: "",
      cover: null,
    };

    await expect(
      assertImageModelEnabled(
        "gpt-image-2",
        async () => config,
        undefined,
        true
      )
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { field: "size", reason: "unsupported_auto_size" },
    } satisfies Partial<OperationError>);
  });
});
