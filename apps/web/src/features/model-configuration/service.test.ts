/**
 * 模型配置生产服务装配测试。
 *
 * 使用方是 UOL late binding；测试验证 bucket 安全边界、封面 URL、底层存储错误分类和
 * 全部生产端口装配，不连接数据库、Redis、Sharp 或真实对象存储。
 */
import { DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND } from "@repo/shared/adobe";
import { createDefaultGlobalImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  createDefaultModelMarketplaceConfig,
  type ModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import type { StorageProvider } from "@repo/shared/storage";
import { createDefaultVideoModelCapabilityOverrides } from "@repo/shared/video-generation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductionModelConfigurationDependencies } from "./service";
import type {
  ModelConfigurationAuditPort,
  ModelConfigurationRepository,
} from "./service-core";

vi.mock("server-only", () => ({}));
vi.mock("@repo/shared/logger", () => ({
  logger: { warn: vi.fn() },
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: vi.fn(),
  getRuntimeSettingString: vi.fn(),
  invalidateSystemSettingsCache: vi.fn(),
}));
vi.mock("@/features/external-api/platform-model-catalog-service", () => ({
  loadPlatformModelCatalog: vi.fn(),
}));
vi.mock("./repository", () => ({
  defaultDatabaseModelConfigurationRepository: undefined,
}));

const ASSET_BUCKET = "model-marketplace";
const COVER_KEY = `image/${"a".repeat(64)}/${"b".repeat(64)}.webp`;

/**
 * 创建完整 StorageProvider 桩，并允许覆盖当前用例关心的方法。
 *
 * @param overrides - 对象读写方法的局部替换。
 * @returns 不访问本地文件或 S3 的存储 Provider。
 * @sideEffects 无；默认方法只返回固定值。
 * @failure 覆盖方法的异常由生产存储适配器分类或透传。
 */
function createStorageProvider(
  overrides: Partial<StorageProvider> = {}
): StorageProvider {
  return {
    getSignedUrl: async () => "/signed",
    getSignedUploadUrl: async () => "/upload",
    deleteObject: async () => undefined,
    getObject: async () => Buffer.from([1]),
    putObject: async () => undefined,
    ...overrides,
  };
}

/**
 * 创建不会实际开启事务的仓储与审计端口。
 *
 * @returns 可用于验证只读和装配流程的生产仓储 bundle。
 * @sideEffects 无；若测试意外执行真实事务会显式失败。
 * @failure transaction 被调用时抛出错误，防止测试误把空桩当成数据库。
 */
function createRepositoryBundle(): {
  repository: ModelConfigurationRepository;
  audit: ModelConfigurationAuditPort;
} {
  return {
    repository: {
      async transaction<T>(): Promise<T> {
        throw new Error("测试未提供事务实现");
      },
    },
    audit: {
      async record() {
        throw new Error("测试未提供审计实现");
      },
    },
  };
}

/**
 * 创建生产服务所需的合法可注入基础设施。
 *
 * @param marketplaceConfig - 可选展示配置，用于覆盖封面安全用例。
 * @returns 包含严格价格、运行时目录、bucket 和空副作用端口的依赖覆盖。
 * @sideEffects 无。
 * @failure 注入函数的显式错误由被测生产服务原样处理。
 */
async function createServiceHarness(
  marketplaceConfig: ModelMarketplaceConfig = createDefaultModelMarketplaceConfig()
) {
  const serviceModule = await import("./service");
  const repositoryBundle = createRepositoryBundle();
  const loadStorageProvider = vi.fn(async () => createStorageProvider());
  const processCoverImage = vi.fn(async (bytes: Uint8Array) => ({
    bytes: Uint8Array.from(bytes),
    sha256: "c".repeat(64),
    contentType: "image/webp" as const,
  }));
  const invalidateCache = vi.fn(async () => undefined);
  const warn = vi.fn();
  const service = serviceModule.createProductionModelConfigurationService({
    createRepository: () => repositoryBundle,
    loadSettingString: async (key) => {
      if (key === "MODEL_MARKETPLACE_ASSETS_BUCKET_NAME") return ASSET_BUCKET;
      if (key === "NEXT_PUBLIC_AVATARS_BUCKET_NAME") return "avatars";
      return "generations";
    },
    loadSettingJson: async (key) => {
      if (key === "IMAGE_MODEL_CREDIT_PRICES") {
        return createDefaultGlobalImageCreditOverrides();
      }
      if (key === "VIDEO_MODEL_CREDITS_PER_SECOND") {
        return { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND };
      }
      if (key === "VIDEO_MODEL_CAPABILITY_OVERRIDES") {
        return createDefaultVideoModelCapabilityOverrides();
      }
      return structuredClone(marketplaceConfig);
    },
    loadRuntimeCatalog: async () => ({ image: [], video: [] }),
    loadStorageProvider,
    processCoverImage,
    invalidateCache,
    warn,
  });
  return {
    serviceModule,
    service,
    repositoryBundle,
    loadStorageProvider,
    processCoverImage,
    invalidateCache,
    warn,
  };
}

describe("模型配置存储适配器", () => {
  it("写入时复制 Uint8Array 为 Buffer，并保持 key、bucket 与 MIME 参数顺序", async () => {
    const putObject = vi.fn<StorageProvider["putObject"]>(
      async () => undefined
    );
    const { createModelConfigurationStoragePort } = await import("./service");
    const storage = createModelConfigurationStoragePort(
      createStorageProvider({ putObject })
    );
    const source = new Uint8Array([1, 2, 3]);

    await storage.putObject(
      { bucket: ASSET_BUCKET, key: COVER_KEY },
      source,
      "image/webp"
    );
    source[0] = 9;

    expect(putObject).toHaveBeenCalledOnce();
    const [key, bucket, bytes, contentType] = putObject.mock.calls[0] ?? [];
    expect(key).toBe(COVER_KEY);
    expect(bucket).toBe(ASSET_BUCKET);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    if (!bytes) throw new Error("Provider 未收到封面字节");
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(contentType).toBe("image/webp");
  });

  it("读取时复制 Buffer 为 Uint8Array，删除时保持 Provider 参数顺序", async () => {
    const providerBytes = Buffer.from([4, 5, 6]);
    const getObject = vi.fn(async () => providerBytes);
    const deleteObject = vi.fn(async () => undefined);
    const { createModelConfigurationStoragePort } = await import("./service");
    const storage = createModelConfigurationStoragePort(
      createStorageProvider({ getObject, deleteObject })
    );
    const reference = { bucket: ASSET_BUCKET, key: COVER_KEY };

    const result = await storage.getObject(reference);
    providerBytes[0] = 9;
    await storage.deleteObject(reference);

    expect(result).toEqual({
      status: "found",
      bytes: new Uint8Array([4, 5, 6]),
    });
    expect(getObject).toHaveBeenCalledWith(COVER_KEY, ASSET_BUCKET);
    expect(deleteObject).toHaveBeenCalledWith(COVER_KEY, ASSET_BUCKET);
  });

  it.each([
    Object.assign(new Error("missing local object"), { code: "ENOENT" }),
    Object.assign(new Error("missing s3 object"), { name: "NoSuchKey" }),
    Object.assign(new Error("missing by status"), {
      $metadata: { httpStatusCode: 404 },
    }),
    new Error("File not found: cover.webp"),
  ])("只把明确不存在的对象错误映射为 not_found", async (failure) => {
    const { createModelConfigurationStoragePort } = await import("./service");
    const storage = createModelConfigurationStoragePort(
      createStorageProvider({
        getObject: async () => {
          throw failure;
        },
      })
    );

    await expect(
      storage.getObject({ bucket: ASSET_BUCKET, key: COVER_KEY })
    ).resolves.toEqual({ status: "not_found" });
  });

  it("基础设施读取错误保持原始异常并显式拒绝", async () => {
    const failure = new Error("storage credentials unavailable");
    const { createModelConfigurationStoragePort } = await import("./service");
    const storage = createModelConfigurationStoragePort(
      createStorageProvider({
        getObject: async () => {
          throw failure;
        },
      })
    );

    await expect(
      storage.getObject({ bucket: ASSET_BUCKET, key: COVER_KEY })
    ).rejects.toBe(failure);
  });
});

describe("生产模型配置服务", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["空资产桶", "", "avatars", "generations"],
    ["与生成桶冲突", "generations", "avatars", "generations"],
  ])("%s 时在加载 Provider、处理封面或调用保存内核前 fail-closed", async (_label, assetBucket, avatarsBucket, generationsBucket) => {
    const harness = await createServiceHarness();
    const createCoreService = vi.fn<
      ProductionModelConfigurationDependencies["createCoreService"]
    >(() => ({
      async updateEntry() {
        throw new Error("bucket 校验失败后不应创建保存内核");
      },
    }));
    const service =
      harness.serviceModule.createProductionModelConfigurationService({
        createRepository: () => harness.repositoryBundle,
        loadSettingString: async (key) => {
          if (key === "MODEL_MARKETPLACE_ASSETS_BUCKET_NAME") {
            return assetBucket;
          }
          if (key === "NEXT_PUBLIC_AVATARS_BUCKET_NAME") {
            return avatarsBucket;
          }
          return generationsBucket;
        },
        loadStorageProvider: harness.loadStorageProvider,
        createCoreService,
      });

    await expect(
      service.updateEntry({ actorUserId: "admin", input: {} })
    ).rejects.toMatchObject({ code: "invalid_dependency_result" });
    expect(harness.loadStorageProvider).not.toHaveBeenCalled();
    expect(harness.processCoverImage).not.toHaveBeenCalled();
    expect(createCoreService).not.toHaveBeenCalled();
  });

  it("模型资产允许与头像共用系统公开资产 bucket", async () => {
    const harness = await createServiceHarness();
    const output = {
      category: "image" as const,
      configKey: "gpt-image-2",
      revision: 1,
    };
    const updateEntry = vi.fn(async () => output);
    const createCoreService = vi.fn<
      ProductionModelConfigurationDependencies["createCoreService"]
    >(() => ({ updateEntry }));
    const service =
      harness.serviceModule.createProductionModelConfigurationService({
        createRepository: () => harness.repositoryBundle,
        loadSettingString: async (key) =>
          key === "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"
            ? "generations"
            : "system-assets",
        loadStorageProvider: harness.loadStorageProvider,
        createCoreService,
      });
    const command = { actorUserId: "admin", input: {} };

    await expect(service.updateEntry(command)).resolves.toEqual(output);
    expect(updateEntry).toHaveBeenCalledWith(command);
    expect(createCoreService.mock.calls[0]?.[0]).toMatchObject({
      assetBucket: "system-assets",
    });
  });

  it("读取前验证全部持久化封面引用都属于专用资产桶", async () => {
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: true,
      description: "非法跨桶引用",
      cover: { bucket: "avatars", key: COVER_KEY },
    };
    const harness = await createServiceHarness(marketplaceConfig);

    await expect(
      harness.service.read({
        type: "user",
        userId: "admin",
        role: "admin",
      })
    ).rejects.toMatchObject({ code: "invalid_dependency_result" });
  });

  it("合法封面转换为第一方相对 URL，且 DTO 不泄露存储引用", async () => {
    const marketplaceConfig = createDefaultModelMarketplaceConfig();
    marketplaceConfig.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: true,
      description: "合法封面",
      cover: { bucket: ASSET_BUCKET, key: COVER_KEY },
    };
    const harness = await createServiceHarness(marketplaceConfig);

    const snapshot = await harness.service.read({
      type: "user",
      userId: "admin",
      role: "admin",
    });
    const entry = snapshot.entries.find(
      (candidate) => candidate.configKey === "gpt-image-2"
    );

    expect(entry).toMatchObject({
      coverUrl: `/api/storage/${ASSET_BUCKET}/${COVER_KEY}`,
      usesDefaultCover: false,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/"bucket"|"key"/);
  });

  it("把仓储、审计、目录、封面、缓存、日志、时钟、哈希和 ID 端口交给保存内核", async () => {
    const harness = await createServiceHarness();
    const output = {
      category: "image" as const,
      configKey: "gpt-image-2",
      revision: 1,
    };
    const updateEntry = vi.fn(async () => output);
    const createCoreService = vi.fn<
      ProductionModelConfigurationDependencies["createCoreService"]
    >(() => ({ updateEntry }));
    const service =
      harness.serviceModule.createProductionModelConfigurationService({
        createRepository: () => harness.repositoryBundle,
        loadSettingString: async (key) => {
          if (key === "MODEL_MARKETPLACE_ASSETS_BUCKET_NAME") {
            return ASSET_BUCKET;
          }
          if (key === "NEXT_PUBLIC_AVATARS_BUCKET_NAME") return "avatars";
          return "generations";
        },
        loadSettingJson: async (key) => {
          if (key === "IMAGE_MODEL_CREDIT_PRICES") {
            return createDefaultGlobalImageCreditOverrides();
          }
          if (key === "VIDEO_MODEL_CREDITS_PER_SECOND") {
            return { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND };
          }
          if (key === "VIDEO_MODEL_CAPABILITY_OVERRIDES") {
            return createDefaultVideoModelCapabilityOverrides();
          }
          return createDefaultModelMarketplaceConfig();
        },
        loadRuntimeCatalog: async () => ({ image: [], video: [] }),
        loadStorageProvider: harness.loadStorageProvider,
        processCoverImage: harness.processCoverImage,
        invalidateCache: harness.invalidateCache,
        warn: harness.warn,
        createCoreService,
      });
    const command = { actorUserId: "admin", input: { canary: true } };

    await expect(service.updateEntry(command)).resolves.toEqual(output);
    expect(updateEntry).toHaveBeenCalledWith(command);
    const dependencies = createCoreService.mock.calls[0]?.[0];
    if (!dependencies) throw new Error("保存内核依赖未完成装配");
    expect(dependencies).toMatchObject({
      repository: harness.repositoryBundle.repository,
      audit: harness.repositoryBundle.audit,
      assetBucket: ASSET_BUCKET,
    });
    await expect(dependencies.catalogLoader.load()).resolves.toMatchObject({
      runtimeCatalogStatus: "ready",
    });
    await expect(
      dependencies.coverImageProcessor.process(new Uint8Array([7]))
    ).resolves.toMatchObject({ sha256: "c".repeat(64) });
    await expect(dependencies.cache.invalidate()).resolves.toBeUndefined();
    dependencies.logger.warn({
      event: "model_configuration_cache_invalidation_failed",
      category: "image",
      configKey: "gpt-image-2",
    });
    expect(harness.warn).toHaveBeenCalledOnce();
    expect(dependencies.clock.now()).toBeInstanceOf(Date);
    await expect(dependencies.hash.sha256("canary")).resolves.toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(dependencies.ids.create()).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  });
});
