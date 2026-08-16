/**
 * 模型配置读取与保存的生产基础设施装配。
 *
 * 使用方是后续 UOL late binding；本模块连接 Drizzle 仓储、系统设置、运行时目录、
 * StorageProvider、Sharp、缓存、Pino、时钟、SHA-256 与审计 ID，同时把安全规则留在
 * DB-free read-service 和 service-core 中执行。
 */
import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { logger } from "@repo/shared/logger";
import {
  type ModelConfigurationListInput,
  type ModelConfigurationListOutput,
  type ModelConfigurationSnapshot,
  type ModelMarketplaceConfig,
  type ModelMarketplaceCoverRef,
  parseModelMarketplaceConfig,
  type UpdateModelConfigurationEntryOutput,
} from "@repo/shared/model-marketplace";
import type { StorageProvider } from "@repo/shared/storage";
import { getStorageProvider } from "@repo/shared/storage/providers";
import {
  getRuntimeSettingJson,
  getRuntimeSettingString,
  invalidateSystemSettingsCache,
} from "@repo/shared/system-settings";
import type { Principal } from "@repo/shared/uol";

import { loadPlatformModelCatalog } from "@/features/external-api/platform-model-catalog-service";
import {
  assertModelMarketplaceCoverReference,
  buildModelMarketplaceCoverUrl,
  parseModelMarketplaceAssetBucketName,
} from "@/features/model-marketplace/asset-reference";

import type {
  ModelConfigurationCoverUrl,
  RuntimeModelCatalog,
} from "./catalog";
import { processModelMarketplaceCoverImage } from "./cover-image";
import {
  readModelConfiguration,
  readModelConfigurationPage,
} from "./read-service";
import { defaultDatabaseModelConfigurationRepository } from "./repository";
import {
  assertModelConfigurationCoverBucket,
  createModelConfigurationService,
  type ModelConfigurationAuditPort,
  type ModelConfigurationRepository,
  type ModelConfigurationService,
  type ModelConfigurationServiceDependencies,
  ModelConfigurationServiceError,
  type ModelConfigurationStoragePort,
  type ModelConfigurationWarning,
} from "./service-core";

const DEFAULT_SYSTEM_ASSETS_BUCKET = "system";
const DEFAULT_GENERATIONS_BUCKET = "generations";

type ModelConfigurationBucketSettingKey =
  | "SYSTEM_ASSETS_BUCKET_NAME"
  | "GENERATIONS_BUCKET_NAME";

type ModelConfigurationJsonSettingKey =
  | "IMAGE_MODEL_CREDIT_PRICES"
  | "VIDEO_MODEL_CREDITS_PER_SECOND"
  | "VIDEO_MODEL_BILLING_MODES"
  | "VIDEO_MODEL_CREDITS_PER_ITEM"
  | "MODEL_MARKETPLACE_CONFIG"
  | "VIDEO_MODEL_CAPABILITY_OVERRIDES";

type ModelConfigurationRepositoryBundle = {
  repository: ModelConfigurationRepository;
  audit: ModelConfigurationAuditPort;
};

type ModelConfigurationBucketConfig = {
  assetBucket: string;
  generationsBucket: string;
};

/** 可注入的生产基础设施函数，测试可逐项替换且不会导入替代业务规则。 */
export type ProductionModelConfigurationDependencies = {
  createRepository: () => ModelConfigurationRepositoryBundle;
  loadSettingString: (
    key: ModelConfigurationBucketSettingKey
  ) => Promise<string | undefined>;
  loadSettingJson: (key: ModelConfigurationJsonSettingKey) => Promise<unknown>;
  loadRuntimeCatalog: () => Promise<RuntimeModelCatalog>;
  loadStorageProvider: () => Promise<StorageProvider>;
  processCoverImage: typeof processModelMarketplaceCoverImage;
  invalidateCache: () => Promise<void>;
  warn: (fields: ModelConfigurationWarning) => void;
  now: () => Date;
  sha256: (value: string | Uint8Array) => Promise<string>;
  createId: () => string;
  createCoreService: (
    dependencies: ModelConfigurationServiceDependencies
  ) => ModelConfigurationService;
};

/** 供 UOL binding 使用的生产读取与保存入口。 */
export type ProductionModelConfigurationService = {
  read(principal: Principal): Promise<ModelConfigurationSnapshot>;
  readPage(
    principal: Principal,
    input: ModelConfigurationListInput
  ): Promise<ModelConfigurationListOutput>;
  updateEntry(command: {
    actorUserId: string;
    input: unknown;
  }): Promise<UpdateModelConfigurationEntryOutput>;
};

const defaultDependencies: ProductionModelConfigurationDependencies = {
  createRepository: () => defaultDatabaseModelConfigurationRepository,
  loadSettingString: getRuntimeSettingString,
  loadSettingJson: getRuntimeSettingJson,
  loadRuntimeCatalog: loadPlatformModelCatalog,
  loadStorageProvider: getStorageProvider,
  processCoverImage: processModelMarketplaceCoverImage,
  invalidateCache: invalidateSystemSettingsCache,
  warn(fields) {
    logger.warn(fields, "模型配置后台副作用失败");
  },
  now: () => new Date(),
  sha256: async (value) => createHash("sha256").update(value).digest("hex"),
  createId: randomUUID,
  createCoreService: createModelConfigurationService,
};

/**
 * 判断底层 StorageProvider 错误是否明确表示对象不存在。
 *
 * @param error - Local 或 S3 Provider 抛出的未知错误。
 * @returns 仅 ENOENT、ENOTDIR、NoSuchKey、NotFound、HTTP 404 和 Provider 明确的
 * File not found 错误返回 true。
 * @sideEffects 无。
 * @failure 不抛错；凭证、网络、权限及其他 I/O 错误返回 false 并由调用方透传。
 */
function isObjectNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
  const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata?.httpStatusCode;
  if (statusCode === 404) return true;
  return error.message.startsWith("File not found");
}

/**
 * 把共享 StorageProvider 适配为保存内核的引用式存储端口。
 *
 * @param provider - 已绑定当前运行时存储配置的 Local 或 S3 Provider。
 * @returns 正确转换 Buffer/Uint8Array 并区分对象缺失的存储端口。
 * @sideEffects 后续端口调用会执行真实对象读写；创建适配器本身无副作用。
 * @failure 除明确 not-found 外的 Provider 异常均保持原始对象向上抛出。
 */
export function createModelConfigurationStoragePort(
  provider: StorageProvider
): ModelConfigurationStoragePort {
  return {
    async putObject(reference, bytes, contentType) {
      await provider.putObject(
        reference.key,
        reference.bucket,
        Buffer.from(bytes),
        contentType
      );
    },
    async getObject(reference) {
      try {
        const bytes = await provider.getObject(reference.key, reference.bucket);
        return { status: "found", bytes: Uint8Array.from(bytes) };
      } catch (error) {
        if (isObjectNotFoundError(error)) return { status: "not_found" };
        throw error;
      }
    },
    async deleteObject(reference) {
      await provider.deleteObject(reference.key, reference.bucket);
    },
  };
}

/**
 * 读取并验证系统资产与生成内容 bucket 的安全关系。
 *
 * @param loadSettingString - 运行时系统设置字符串读取器。
 * @returns 去空白后的系统资产与生成内容 bucket。
 * @sideEffects 并发读取两项运行时设置，不写缓存或存储。
 * @failure 系统资产 bucket 非法，或与生成内容 bucket 冲突时 fail-closed。
 */
async function loadBucketConfig(
  loadSettingString: ProductionModelConfigurationDependencies["loadSettingString"]
): Promise<ModelConfigurationBucketConfig> {
  const [assetRaw, generationsRaw] = await Promise.all([
    loadSettingString("SYSTEM_ASSETS_BUCKET_NAME"),
    loadSettingString("GENERATIONS_BUCKET_NAME"),
  ]);
  let assetBucket: string;
  try {
    assetBucket = parseModelMarketplaceAssetBucketName(
      assetRaw ?? DEFAULT_SYSTEM_ASSETS_BUCKET
    );
  } catch {
    throw new ModelConfigurationServiceError(
      "invalid_dependency_result",
      "模型资产存储桶未配置或名称无效"
    );
  }
  const generationsBucket =
    generationsRaw?.trim() || DEFAULT_GENERATIONS_BUCKET;
  if (generationsBucket === assetBucket) {
    throw new ModelConfigurationServiceError(
      "invalid_dependency_result",
      "生成内容存储桶必须与系统通用资产存储桶隔离"
    );
  }
  return { assetBucket, generationsBucket };
}

/**
 * 严格解析展示配置，并在生成任一 URL 前验证所有非空封面引用的 bucket。
 *
 * @param value - MODEL_MARKETPLACE_CONFIG 的未知 JSON 值。
 * @param assetBucket - 已验证隔离关系的专用模型资产 bucket。
 * @returns 可直接交给目录构建器的严格版本化展示配置。
 * @sideEffects 无，不触达对象存储。
 * @failure JSON 脏值或任一引用跨 bucket 时显式拒绝，不生成部分 URL。
 */
function parseMarketplaceConfigForAssetBucket(
  value: unknown,
  assetBucket: string
): ModelMarketplaceConfig {
  const config = parseModelMarketplaceConfig(value);
  for (const entry of Object.values(config.imageByModel)) {
    if (!entry.cover) continue;
    assertModelConfigurationCoverBucket(entry.cover, assetBucket);
    assertModelMarketplaceCoverReference("image", entry.cover, assetBucket);
  }
  for (const entry of Object.values(config.videoByFamily)) {
    if (!entry.cover) continue;
    assertModelConfigurationCoverBucket(entry.cover, assetBucket);
    assertModelMarketplaceCoverReference("video", entry.cover, assetBucket);
  }
  return config;
}

/**
 * 把已验证的私有存储引用编码为第一方管理读取 URL。
 *
 * @param assetBucket - 已验证的专用模型资产 bucket。
 * @param cover - 显式自定义封面引用；null 代表使用默认封面。
 * @returns 自定义封面的 `/api/storage/...` URL，或默认封面的空 URL 标记。
 * @sideEffects 无。
 * @failure 防御性拒绝跨 bucket 引用；调用前已执行完整配置的全量 bucket 校验。
 */
function buildCoverUrl(
  category: "image" | "video",
  assetBucket: string,
  cover: ModelMarketplaceCoverRef | null
): ModelConfigurationCoverUrl {
  if (!cover) return { coverUrl: null, usesDefaultCover: true };
  assertModelConfigurationCoverBucket(cover, assetBucket);
  return {
    coverUrl: buildModelMarketplaceCoverUrl(category, cover, assetBucket),
    usesDefaultCover: false,
  };
}

/**
 * 为一次读取或保存构造共享管理快照依赖。
 *
 * @param dependencies - 已合并默认值与测试覆盖的生产基础设施。
 * @param bucketConfig - 已完成非空和隔离校验的 bucket 配置。
 * @returns 严格读取三项 JSON、运行时目录和安全封面 URL 的依赖集合。
 * @sideEffects 后续调用会读取系统设置与运行时目录；构造本身无副作用。
 * @failure 展示配置会在目录构建前全量验证 bucket，其他读取异常不被吞掉。
 */
function createReadDependencies(
  dependencies: ProductionModelConfigurationDependencies,
  bucketConfig: ModelConfigurationBucketConfig
) {
  return {
    loadImagePricing: () =>
      dependencies.loadSettingJson("IMAGE_MODEL_CREDIT_PRICES"),
    loadVideoPricing: () =>
      dependencies.loadSettingJson("VIDEO_MODEL_CREDITS_PER_SECOND"),
    loadVideoBillingModes: () =>
      dependencies.loadSettingJson("VIDEO_MODEL_BILLING_MODES"),
    loadVideoCreditsPerItem: () =>
      dependencies.loadSettingJson("VIDEO_MODEL_CREDITS_PER_ITEM"),
    loadMarketplaceConfig: async () =>
      parseMarketplaceConfigForAssetBucket(
        await dependencies.loadSettingJson("MODEL_MARKETPLACE_CONFIG"),
        bucketConfig.assetBucket
      ),
    loadVideoCapabilityOverrides: () =>
      dependencies.loadSettingJson("VIDEO_MODEL_CAPABILITY_OVERRIDES"),
    loadRuntimeCatalog: dependencies.loadRuntimeCatalog,
    buildCoverUrl: (
      category: "image" | "video",
      _configKey: string,
      cover: ModelMarketplaceCoverRef | null
    ) => buildCoverUrl(category, bucketConfig.assetBucket, cover),
  };
}

/**
 * 创建连接全部生产端口的模型配置服务。
 *
 * @param overrides - 测试或替代部署需要覆盖的基础设施函数。
 * @returns 读取管理快照与保存单条模型配置的服务；每次调用读取最新 bucket 设置。
 * @sideEffects read 读取设置与运行时目录；updateEntry 还可能执行数据库、存储、缓存和
 * 审计副作用，具体顺序由 service-core 保证。
 * @failure bucket 配置先于 Provider 和保存内核 fail-closed；其余基础设施及领域异常不吞掉。
 */
export function createProductionModelConfigurationService(
  overrides: Partial<ProductionModelConfigurationDependencies> = {}
): ProductionModelConfigurationService {
  const dependencies: ProductionModelConfigurationDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return {
    async read(principal) {
      const bucketConfig = await loadBucketConfig(
        dependencies.loadSettingString
      );
      return readModelConfiguration(
        principal,
        createReadDependencies(dependencies, bucketConfig)
      );
    },
    async readPage(principal, input) {
      const bucketConfig = await loadBucketConfig(
        dependencies.loadSettingString
      );
      return readModelConfigurationPage(
        principal,
        input,
        createReadDependencies(dependencies, bucketConfig)
      );
    },
    async updateEntry(command) {
      const bucketConfig = await loadBucketConfig(
        dependencies.loadSettingString
      );
      const provider = await dependencies.loadStorageProvider();
      const repositoryBundle = dependencies.createRepository();
      const readDependencies = createReadDependencies(
        dependencies,
        bucketConfig
      );
      const coreService = dependencies.createCoreService({
        repository: repositoryBundle.repository,
        audit: repositoryBundle.audit,
        storage: createModelConfigurationStoragePort(provider),
        catalogLoader: {
          load: () =>
            readModelConfiguration(
              { type: "system", reason: "model-configuration-save-catalog" },
              readDependencies
            ),
        },
        coverImageProcessor: { process: dependencies.processCoverImage },
        cache: { invalidate: dependencies.invalidateCache },
        logger: { warn: dependencies.warn },
        clock: { now: dependencies.now },
        hash: { sha256: dependencies.sha256 },
        ids: { create: dependencies.createId },
        assetBucket: bucketConfig.assetBucket,
      });
      return coreService.updateEntry(command);
    },
  };
}

/** 延迟生产单例不会在模块加载期读取设置、创建 Provider 或开启数据库事务。 */
export const productionModelConfigurationService =
  createProductionModelConfigurationService();
