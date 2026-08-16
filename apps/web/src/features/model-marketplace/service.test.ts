/**
 * 公开模型广场生产服务测试。
 *
 * 使用方是 UOL late binding；测试验证九项事实并行读取、资产 bucket 隔离、封面引用
 * 校验与第一方 URL 编码，以及依赖失败和不可达目录语义，不连接数据库或对象存储。
 */
import {
  DEFAULT_VIDEO_MODEL_BILLING_MODES,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
} from "@repo/shared/adobe";
import { createDefaultGlobalImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  createDefaultModelMarketplaceConfig,
  type ModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import { createDefaultVideoModelCapabilityOverrides } from "@repo/shared/video-generation";
import { describe, expect, it, vi } from "vitest";

import type { ProductionModelMarketplaceDependencies } from "./service";

vi.mock("server-only", () => ({}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: vi.fn(),
  getRuntimeSettingString: vi.fn(),
}));
vi.mock("@/features/external-api/platform-model-catalog-service", () => ({
  loadPlatformModelCatalog: vi.fn(),
}));

const ASSET_BUCKET = "system-assets";
const CONFIG_HASH = "a".repeat(64);
const CONTENT_HASH = "b".repeat(64);
const IMAGE_COVER_KEY = `image/${CONFIG_HASH}/${CONTENT_HASH}.webp`;

/**
 * 创建公开生产服务所需的合法可注入依赖。
 *
 * @param marketplaceConfig - 可选展示配置，用于覆盖封面和显示开关用例。
 * @returns 不访问数据库或外部服务的完整依赖集合。
 * @sideEffects 无；注入函数只创建并返回隔离的内存对象。
 * @failure 覆盖函数主动抛出的错误由被测生产服务原样拒绝。
 */
function createDependencies(
  marketplaceConfig: ModelMarketplaceConfig = createDefaultModelMarketplaceConfig()
): ProductionModelMarketplaceDependencies {
  return {
    loadRuntimeCatalog: async () => ({
      image: [{ id: "firefly-gpt-image-2" }],
      video: [],
    }),
    loadSettingJson: async (key) => {
      if (key === "IMAGE_MODEL_CREDIT_PRICES") {
        return createDefaultGlobalImageCreditOverrides();
      }
      if (key === "VIDEO_MODEL_CREDITS_PER_SECOND") {
        return { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND };
      }
      if (key === "VIDEO_MODEL_BILLING_MODES") {
        return { ...DEFAULT_VIDEO_MODEL_BILLING_MODES };
      }
      if (key === "VIDEO_MODEL_CREDITS_PER_ITEM") {
        return { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM };
      }
      if (key === "VIDEO_MODEL_CAPABILITY_OVERRIDES") {
        return createDefaultVideoModelCapabilityOverrides();
      }
      return structuredClone(marketplaceConfig);
    },
    loadSettingString: async (key) => {
      if (key === "SYSTEM_ASSETS_BUCKET_NAME") return ASSET_BUCKET;
      return "generations";
    },
    getDefaultCoverPath: (category) =>
      `/model-marketplace/default-${category}.webp`,
  };
}

/**
 * 创建可由测试在外部完成的 Promise。
 *
 * @returns Promise 及其 resolve/reject 控制函数。
 * @sideEffects 无；只有调用返回的控制函数才会改变 Promise 状态。
 * @failure reject 会让 Promise 按传入原因拒绝。
 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("Promise resolve 尚未初始化");
      resolvePromise(value);
    },
    reject(reason) {
      if (!rejectPromise) throw new Error("Promise reject 尚未初始化");
      rejectPromise(reason);
    },
  };
}

describe("公开模型广场生产服务", () => {
  it("同一轮并行启动运行时、六项 JSON 与两个 bucket 读取", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const dependencies = createDependencies();
    const started: string[] = [];
    const deferredByKey = new Map<string, { resolve: () => void }>();
    const read = <T>(key: string, value: T): Promise<T> => {
      started.push(key);
      const deferred = createDeferred<void>();
      deferredByKey.set(key, { resolve: () => deferred.resolve(undefined) });
      return deferred.promise.then(() => value);
    };
    const service = createProductionModelMarketplaceService({
      ...dependencies,
      loadRuntimeCatalog: () =>
        read("runtime", {
          image: [{ id: "firefly-gpt-image-2" }],
          video: [],
        }),
      loadSettingJson: (key) => {
        if (key === "IMAGE_MODEL_CREDIT_PRICES") {
          return read(key, createDefaultGlobalImageCreditOverrides());
        }
        if (key === "VIDEO_MODEL_CREDITS_PER_SECOND") {
          return read(key, { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND });
        }
        if (key === "VIDEO_MODEL_BILLING_MODES") {
          return read(key, { ...DEFAULT_VIDEO_MODEL_BILLING_MODES });
        }
        if (key === "VIDEO_MODEL_CREDITS_PER_ITEM") {
          return read(key, { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM });
        }
        if (key === "VIDEO_MODEL_CAPABILITY_OVERRIDES") {
          return read(key, createDefaultVideoModelCapabilityOverrides());
        }
        return read(key, createDefaultModelMarketplaceConfig());
      },
      loadSettingString: (key) => {
        const value =
          key === "SYSTEM_ASSETS_BUCKET_NAME" ? ASSET_BUCKET : "generations";
        return read(key, value);
      },
    });

    const outputPromise = service.listPublicModels();
    expect(started).toHaveLength(9);
    expect(new Set(started).size).toBe(9);
    for (const deferred of deferredByKey.values()) deferred.resolve();

    const output = await outputPromise;
    expect(
      output.items.find((item) => item.configKey === "gpt-image-2")
    ).toBeDefined();
  });

  it("返回严格的 items 包装且不暴露运行时或存储内部字段", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const output = await createProductionModelMarketplaceService(
      createDependencies()
    ).listPublicModels();

    expect(Object.keys(output)).toEqual(["items"]);
    expect(
      output.items.filter((item) => item.category === "image")
    ).toHaveLength(1);
    expect(
      output.items.filter((item) => item.category === "video")
    ).toHaveLength(13);
    expect(JSON.stringify(output)).not.toMatch(
      /"bucket"|"key"|"members"|"credentials"/
    );
  });

  it.each([
    "runtime",
    "imagePricing",
    "videoPricing",
    "videoCapabilities",
    "marketplaceConfig",
  ] as const)("%s 读取失败时保持原始异常并拒绝", async (failureSource) => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const failure = new Error(`${failureSource} unavailable`);
    const dependencies = createDependencies();
    const service = createProductionModelMarketplaceService({
      ...dependencies,
      loadRuntimeCatalog:
        failureSource === "runtime"
          ? async () => {
              throw failure;
            }
          : dependencies.loadRuntimeCatalog,
      loadSettingJson: async (key) => {
        const shouldFail =
          (failureSource === "imagePricing" &&
            key === "IMAGE_MODEL_CREDIT_PRICES") ||
          (failureSource === "videoPricing" &&
            key === "VIDEO_MODEL_CREDITS_PER_SECOND") ||
          (failureSource === "videoCapabilities" &&
            key === "VIDEO_MODEL_CAPABILITY_OVERRIDES") ||
          (failureSource === "marketplaceConfig" &&
            key === "MODEL_MARKETPLACE_CONFIG");
        if (shouldFail) throw failure;
        return dependencies.loadSettingJson(key);
      },
    });

    await expect(service.listPublicModels()).rejects.toBe(failure);
  });

  it.each([
    ["空资产桶", "", "generations"],
    ["与生成内容桶冲突", "generations", "generations"],
  ])("%s 时 fail-closed", async (_label, asset, generations) => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const service = createProductionModelMarketplaceService({
      ...createDependencies(),
      loadSettingString: async (key) => {
        if (key === "SYSTEM_ASSETS_BUCKET_NAME") return asset;
        return generations;
      },
    });

    await expect(service.listPublicModels()).rejects.toMatchObject({
      code: "invalid_dependency_result",
    });
  });

  it("模型资产读取统一系统公开资产 bucket", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const service = createProductionModelMarketplaceService({
      ...createDependencies(),
      loadSettingString: async (key) =>
        key === "GENERATIONS_BUCKET_NAME" ? "generations" : "system-assets",
    });

    const output = await service.listPublicModels();
    expect(
      output.items.find((item) => item.configKey === "gpt-image-2")
    ).toBeDefined();
  });

  it("在生成任一公开 URL 前拒绝历史跨 bucket 封面引用", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: true,
      description: "非法历史引用",
      cover: { bucket: "avatars", key: IMAGE_COVER_KEY },
    };
    const getDefaultCoverPath = vi.fn(
      (category: "image" | "video") =>
        `/model-marketplace/default-${category}.webp`
    );
    const service = createProductionModelMarketplaceService({
      ...createDependencies(marketplaceConfig),
      getDefaultCoverPath,
    });

    await expect(service.listPublicModels()).rejects.toMatchObject({
      code: "invalid_dependency_result",
    });
    expect(getDefaultCoverPath).not.toHaveBeenCalled();
  });

  it("把合法内容寻址封面转换为第一方 URL 且不泄露引用", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: true,
      description: "自定义封面",
      cover: {
        bucket: ASSET_BUCKET,
        key: IMAGE_COVER_KEY,
      },
    };
    const output = await createProductionModelMarketplaceService(
      createDependencies(marketplaceConfig)
    ).listPublicModels();

    expect(
      output.items.find((item) => item.category === "image")?.coverUrl
    ).toBe(`/api/storage/${ASSET_BUCKET}/${IMAGE_COVER_KEY}`);
    expect(JSON.stringify(output)).not.toMatch(/"bucket"|"key"/);
  });

  it("拒绝可能被 URL 规范化的历史封面 key", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: true,
      description: "非法历史路径",
      cover: {
        bucket: ASSET_BUCKET,
        key: "image/../generations/private.webp",
      },
    };

    await expect(
      createProductionModelMarketplaceService(
        createDependencies(marketplaceConfig)
      ).listPublicModels()
    ).rejects.toThrow(/内容寻址/);
  });

  it("无自定义封面时使用资产模块提供的类别默认路径", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const getDefaultCoverPath = vi.fn(
      (category: "image" | "video") => `/defaults/${category}.webp`
    );
    const output = await createProductionModelMarketplaceService({
      ...createDependencies(),
      getDefaultCoverPath,
    }).listPublicModels();

    expect(
      output.items.find((item) => item.category === "image")?.coverUrl
    ).toBe("/defaults/image.webp");
    expect(getDefaultCoverPath).toHaveBeenCalledWith("image");
  });

  it("图像模型关闭后仍返回全局视频能力并标记不可达", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: false,
      description: "",
      cover: null,
    };
    const output = await createProductionModelMarketplaceService(
      createDependencies(marketplaceConfig)
    ).listPublicModels();

    expect(output.items).toHaveLength(13);
    expect(
      output.items.every(
        (item) => item.category === "video" && !item.configuredReachable
      )
    ).toBe(true);
  });

  it("读取动态视频能力覆盖并传入公开目录", async () => {
    const { createProductionModelMarketplaceService } = await import(
      "./service"
    );
    const dependencies = createDependencies();
    const output = await createProductionModelMarketplaceService({
      ...dependencies,
      loadRuntimeCatalog: async () => ({
        image: [],
        video: [{ id: "seedance2" }],
      }),
      loadSettingJson: async (key) => {
        if (key === "VIDEO_MODEL_CAPABILITY_OVERRIDES") {
          return {
            version: 1,
            byModel: { seedance2: { maxReferenceImages: 20 } },
          };
        }
        return dependencies.loadSettingJson(key);
      },
    }).listPublicModels();

    expect(
      output.items.find((item) => item.modelId === "seedance2")
    ).toMatchObject({
      configuredReachable: true,
      input: {
        referenceImages: { maxCount: 20, configurable: true },
      },
    });
  });
});
