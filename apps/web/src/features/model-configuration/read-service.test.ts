/**
 * 管理端模型配置读取服务测试。
 *
 * 使用方是 UOL 读取绑定；测试验证严格事实源与可降级运行时目录的故障边界，以及编辑
 * 权限必须从完整 Principal 精确计算，全部依赖均以内存函数注入。
 */
import { DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND } from "@repo/shared/adobe";
import { createDefaultGlobalImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import { createDefaultModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import type { Principal } from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";

import {
  type ModelConfigurationReadDependencies,
  readModelConfiguration,
} from "./read-service";

/**
 * 创建合法且完全可注入的读取依赖。
 *
 * @param overrides - 当前用例要替换的事实读取器或封面 URL 构造器。
 * @returns 不访问数据库、网络或对象存储的依赖集合。
 * @sideEffects 无；默认读取器每次返回新的配置对象。
 * @failure 覆盖读取器的异常由被测服务按对应故障边界处理。
 */
function createDependencies(
  overrides: Partial<ModelConfigurationReadDependencies> = {}
): ModelConfigurationReadDependencies {
  return {
    loadImagePricing: async () => createDefaultGlobalImageCreditOverrides(),
    loadVideoPricing: async () => ({
      ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    }),
    loadMarketplaceConfig: async () => createDefaultModelMarketplaceConfig(),
    loadRuntimeCatalog: async () => ({ image: [], video: [] }),
    buildCoverUrl: () => ({
      coverUrl: "/model-marketplace/default.webp",
      usesDefaultCover: true,
    }),
    ...overrides,
  };
}

const SUPER_ADMIN: Principal = {
  type: "user",
  userId: "super-admin",
  role: "super_admin",
};

describe("readModelConfiguration", () => {
  it("启动全部事实读取器并返回运行时可用快照", async () => {
    const loadImagePricing = vi
      .fn()
      .mockResolvedValue(createDefaultGlobalImageCreditOverrides());
    const loadVideoPricing = vi
      .fn()
      .mockResolvedValue({ ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND });
    const loadMarketplaceConfig = vi
      .fn()
      .mockResolvedValue(createDefaultModelMarketplaceConfig());
    const loadRuntimeCatalog = vi.fn().mockResolvedValue({
      image: [{ id: "runtime-image" }],
      video: [],
    });

    const snapshot = await readModelConfiguration(
      SUPER_ADMIN,
      createDependencies({
        loadImagePricing,
        loadVideoPricing,
        loadMarketplaceConfig,
        loadRuntimeCatalog,
      })
    );

    expect(loadImagePricing).toHaveBeenCalledTimes(1);
    expect(loadVideoPricing).toHaveBeenCalledTimes(1);
    expect(loadMarketplaceConfig).toHaveBeenCalledTimes(1);
    expect(loadRuntimeCatalog).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      canEdit: true,
      runtimeCatalogStatus: "ready",
    });
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ configKey: "runtime-image" }),
      ])
    );
  });

  it("运行时目录失败时降级为内置与已持久化模型", async () => {
    const imagePricing = createDefaultGlobalImageCreditOverrides();
    imagePricing.byModel["persisted-image"] = {
      base1024Credits: 2,
      base1kCredits: 3,
      base2kCredits: 4,
      base4kCredits: 5,
    };

    const snapshot = await readModelConfiguration(
      SUPER_ADMIN,
      createDependencies({
        loadImagePricing: async () => imagePricing,
        loadRuntimeCatalog: async () => {
          throw new Error("runtime unavailable");
        },
      })
    );

    expect(snapshot.runtimeCatalogStatus).toBe("unavailable");
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ configKey: "gpt-image-2" }),
        expect.objectContaining({ configKey: "persisted-image" }),
        expect.objectContaining({ configKey: "sora2" }),
      ])
    );
  });

  it("图像、视频或展示配置读取失败时透传原始异常", async () => {
    const imageFailure = new Error("image pricing unavailable");
    const videoFailure = new Error("video pricing unavailable");
    const marketplaceFailure = new Error("marketplace config unavailable");

    await expect(
      readModelConfiguration(
        SUPER_ADMIN,
        createDependencies({
          loadImagePricing: async () => {
            throw imageFailure;
          },
        })
      )
    ).rejects.toBe(imageFailure);
    await expect(
      readModelConfiguration(
        SUPER_ADMIN,
        createDependencies({
          loadVideoPricing: async () => {
            throw videoFailure;
          },
        })
      )
    ).rejects.toBe(videoFailure);
    await expect(
      readModelConfiguration(
        SUPER_ADMIN,
        createDependencies({
          loadMarketplaceConfig: async () => {
            throw marketplaceFailure;
          },
        })
      )
    ).rejects.toBe(marketplaceFailure);
  });

  it("运行时目录与严格事实源同时失败时仍拒绝严格事实错误", async () => {
    const pricingFailure = new Error("strict image pricing failure");

    await expect(
      readModelConfiguration(
        SUPER_ADMIN,
        createDependencies({
          loadImagePricing: async () => {
            throw pricingFailure;
          },
          loadRuntimeCatalog: async () => {
            throw new Error("runtime failure");
          },
        })
      )
    ).rejects.toBe(pricingFailure);
  });

  it("只有会话超级管理员拥有编辑权限", async () => {
    const readOnlyPrincipals: Principal[] = [
      { type: "user", userId: "admin", role: "admin" },
      {
        type: "user",
        userId: "observer-admin",
        role: "observer_admin",
      },
      { type: "system", reason: "background-read" },
      {
        type: "apiKey",
        credentialKind: "mcp",
        userId: "api-user",
        apiKeyId: "api-key",
        plan: "pro",
      },
    ];

    await expect(
      readModelConfiguration(SUPER_ADMIN, createDependencies())
    ).resolves.toMatchObject({ canEdit: true });
    for (const principal of readOnlyPrincipals) {
      await expect(
        readModelConfiguration(principal, createDependencies())
      ).resolves.toMatchObject({ canEdit: false });
    }
  });
});
