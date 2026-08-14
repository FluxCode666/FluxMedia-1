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
  it("旧配置缺少条目时保持允许调用", async () => {
    const loadMarketplaceConfig = vi.fn(async () => null);

    await expect(
      assertImageModelEnabled("gpt-image-2", loadMarketplaceConfig)
    ).resolves.toBeUndefined();
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
});
