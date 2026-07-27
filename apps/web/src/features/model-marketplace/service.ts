/**
 * 公开模型广场的生产基础设施装配。
 *
 * 使用方是 UOL late binding；本模块并行读取真实运行时目录、两类价格、展示配置和三个
 * bucket 设置，先完成存储隔离与全量封面引用校验，再调用 DB-free 目录构建器输出公开 DTO。
 */
import "server-only";

import {
  type ModelMarketplaceConfig,
  type ModelMarketplaceCoverRef,
  parseModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import {
  getRuntimeSettingJson,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import type { ModelMarketplacePublicCatalogOutput } from "@repo/shared/uol/operations";

import { loadPlatformModelCatalog } from "@/features/external-api/platform-model-catalog-service";
import {
  assertModelConfigurationCoverBucket,
  ModelConfigurationServiceError,
} from "@/features/model-configuration/service-core";

import {
  assertModelMarketplaceCoverReference,
  buildModelMarketplaceCoverUrl,
  parseModelMarketplaceAssetBucketName,
} from "./asset-reference";
import { getDefaultModelMarketplaceCoverPath } from "./assets";
import { buildModelMarketplaceCatalog } from "./catalog";

const DEFAULT_AVATARS_BUCKET = "avatars";
const DEFAULT_GENERATIONS_BUCKET = "generations";

type ModelMarketplaceJsonSettingKey =
  | "IMAGE_MODEL_CREDIT_PRICES"
  | "VIDEO_MODEL_CREDITS_PER_SECOND"
  | "MODEL_MARKETPLACE_CONFIG";

type ModelMarketplaceBucketSettingKey =
  | "MODEL_MARKETPLACE_ASSETS_BUCKET_NAME"
  | "NEXT_PUBLIC_AVATARS_BUCKET_NAME"
  | "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME";

type ModelMarketplaceBucketConfig = {
  assetBucket: string;
  avatarsBucket: string;
  generationsBucket: string;
};

/** 可注入的公开目录生产依赖，测试可替换事实读取但不能替换目录业务规则。 */
export type ProductionModelMarketplaceDependencies = {
  loadRuntimeCatalog: () => Promise<unknown>;
  loadSettingJson: (key: ModelMarketplaceJsonSettingKey) => Promise<unknown>;
  loadSettingString: (
    key: ModelMarketplaceBucketSettingKey
  ) => Promise<string | undefined>;
  getDefaultCoverPath: typeof getDefaultModelMarketplaceCoverPath;
};

/** 供 UOL binding 使用的公开目录生产入口。 */
export type ProductionModelMarketplaceService = {
  listPublicModels(): Promise<ModelMarketplacePublicCatalogOutput>;
};

const defaultDependencies: ProductionModelMarketplaceDependencies = {
  loadRuntimeCatalog: loadPlatformModelCatalog,
  loadSettingJson: getRuntimeSettingJson,
  loadSettingString: getRuntimeSettingString,
  getDefaultCoverPath: getDefaultModelMarketplaceCoverPath,
};

/**
 * 规范化并验证模型资产、头像与生成内容 bucket 的隔离关系。
 *
 * @param assetRaw - 专用模型资产 bucket 的未知可选设置值。
 * @param avatarsRaw - 头像 bucket 的未知可选设置值。
 * @param generationsRaw - 生成内容 bucket 的未知可选设置值。
 * @returns 去空白后的专用资产 bucket 与两个受保护 bucket。
 * @sideEffects 无。
 * @failure 资产 bucket 缺失、为空或与头像/生成内容冲突时抛出稳定依赖错误。
 */
function parseBucketConfig(
  assetRaw: string | undefined,
  avatarsRaw: string | undefined,
  generationsRaw: string | undefined
): ModelMarketplaceBucketConfig {
  let assetBucket: string;
  try {
    assetBucket = parseModelMarketplaceAssetBucketName(assetRaw);
  } catch {
    throw new ModelConfigurationServiceError(
      "invalid_dependency_result",
      "模型资产存储桶未配置或名称无效"
    );
  }
  const avatarsBucket = avatarsRaw?.trim() || DEFAULT_AVATARS_BUCKET;
  const generationsBucket =
    generationsRaw?.trim() || DEFAULT_GENERATIONS_BUCKET;
  if (assetBucket === avatarsBucket || assetBucket === generationsBucket) {
    throw new ModelConfigurationServiceError(
      "invalid_dependency_result",
      "模型资产存储桶必须与头像和生成内容存储桶隔离"
    );
  }
  return { assetBucket, avatarsBucket, generationsBucket };
}

/**
 * 严格解析展示配置并全量验证所有非空封面引用属于专用资产 bucket。
 *
 * @param value - MODEL_MARKETPLACE_CONFIG 的未知 JSON 读取结果。
 * @param assetBucket - 已完成非空与受保护 bucket 隔离校验的资产 bucket。
 * @returns 可直接交给目录构建器的严格版本化展示配置。
 * @sideEffects 无，不触达对象存储，也不生成任何公开 URL。
 * @failure 配置脏值或任一历史引用跨 bucket 时显式抛错。
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
 * 把严格封面引用转换为第一方公开 URL，缺少自定义引用时使用随应用部署的默认封面。
 *
 * @param category - 当前公开模型的图像或视频类别。
 * @param assetBucket - 已验证隔离关系的专用模型资产 bucket。
 * @param cover - 显式自定义封面引用；null 代表使用内置默认封面。
 * @param getDefaultCoverPath - 类别到本地第一方默认封面的唯一资产映射。
 * @returns 自定义引用逐段编码后的 `/api/storage/...` URL 或本地默认路径。
 * @sideEffects 仅同步调用注入的默认资产路径函数，不读取对象存储。
 * @failure 防御性拒绝跨 bucket 引用；默认资产路径仍由最终公开 DTO schema 复核。
 */
function buildCoverUrl(
  category: "image" | "video",
  assetBucket: string,
  cover: ModelMarketplaceCoverRef | null,
  getDefaultCoverPath: ProductionModelMarketplaceDependencies["getDefaultCoverPath"]
): string {
  if (!cover) return getDefaultCoverPath(category);
  assertModelConfigurationCoverBucket(cover, assetBucket);
  return buildModelMarketplaceCoverUrl(category, cover, assetBucket);
}

/**
 * 创建连接全部生产事实源的公开模型广场服务。
 *
 * @param overrides - 测试或替代部署需要覆盖的基础设施函数。
 * @returns 每次调用均读取最新运行时目录、价格、展示配置与 bucket 设置的只读服务。
 * @sideEffects listPublicModels 会并行读取七项运行时事实，但不写数据库、缓存或存储。
 * @failure 任一读取、严格解析、bucket 隔离、封面引用或公开 DTO 校验失败时显式拒绝，
 * 不返回不可信半成品目录。
 */
export function createProductionModelMarketplaceService(
  overrides: Partial<ProductionModelMarketplaceDependencies> = {}
): ProductionModelMarketplaceService {
  const dependencies: ProductionModelMarketplaceDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return {
    async listPublicModels() {
      const [
        runtimeCatalog,
        imagePricing,
        videoPricing,
        marketplaceConfigRaw,
        assetBucketRaw,
        avatarsBucketRaw,
        generationsBucketRaw,
      ] = await Promise.all([
        dependencies.loadRuntimeCatalog(),
        dependencies.loadSettingJson("IMAGE_MODEL_CREDIT_PRICES"),
        dependencies.loadSettingJson("VIDEO_MODEL_CREDITS_PER_SECOND"),
        dependencies.loadSettingJson("MODEL_MARKETPLACE_CONFIG"),
        dependencies.loadSettingString("MODEL_MARKETPLACE_ASSETS_BUCKET_NAME"),
        dependencies.loadSettingString("NEXT_PUBLIC_AVATARS_BUCKET_NAME"),
        dependencies.loadSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"),
      ]);
      const bucketConfig = parseBucketConfig(
        assetBucketRaw,
        avatarsBucketRaw,
        generationsBucketRaw
      );
      const marketplaceConfig = parseMarketplaceConfigForAssetBucket(
        marketplaceConfigRaw,
        bucketConfig.assetBucket
      );
      const items = buildModelMarketplaceCatalog({
        runtimeCatalog,
        imagePricing,
        videoPricing,
        marketplaceConfig,
        buildCoverUrl: (category, _configKey, cover) =>
          buildCoverUrl(
            category,
            bucketConfig.assetBucket,
            cover,
            dependencies.getDefaultCoverPath
          ),
      });
      return { items };
    },
  };
}

/** 使用真实运行时事实源的公开模型广场生产单例。 */
export const productionModelMarketplaceService =
  createProductionModelMarketplaceService();
