/**
 * 公开模型广场的 DB-free 目录构建器。
 *
 * 使用方是公开目录生产服务；本模块严格解析运行时目录、价格与展示配置，只输出真实可达
 * 且允许展示的图像模型和视频模型族，并复用管理目录与共享纯函数避免身份和价格规则漂移。
 */
import { MAX_SUPPORTED_MODEL_IDS } from "@repo/shared/image-backend/supported-models";
import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
} from "@repo/shared/image-generation/media-contract";
import {
  type ModelMarketplaceCoverRef,
  type ModelMarketplacePublicItem,
  modelMarketplacePublicItemSchema,
  normalizeModelMarketplaceImageConfigKey,
  parseModelMarketplaceConfig,
  resolveModelMarketplaceVideoFamily,
  sortUniqueAspectRatios,
  sortUniqueDurations,
  sortUniqueVideoResolutions,
} from "@repo/shared/model-marketplace";
import {
  resolveEffectiveVideoModelCapabilities,
  resolveVideoModelCapability,
  type VideoModelCapabilityDescriptor,
} from "@repo/shared/video-generation";
import { z } from "zod";
import { isConcretePlatformImageModelId } from "../external-api/platform-model-catalog";
import { buildModelConfigurationSnapshot } from "../model-configuration/catalog";
import { getBuiltinModelMarketplaceDescription } from "./builtin-descriptions";

const runtimeModelItemSchema = z
  .object({ id: z.string().trim().min(1).max(255) })
  .strict();
const runtimeModelCatalogSchema = z
  .object({
    image: z.array(runtimeModelItemSchema).max(500),
    video: z.array(runtimeModelItemSchema).max(MAX_SUPPORTED_MODEL_IDS),
  })
  .strict();
const publicCatalogItemsSchema = z
  .array(modelMarketplacePublicItemSchema)
  .max(500);

/** 公开目录构建器需要的完整事实输入。 */
export type ModelMarketplaceCatalogInput = {
  runtimeCatalog: unknown;
  imagePricing: unknown;
  videoPricing: unknown;
  videoBillingModes: unknown;
  videoCreditsPerItem: unknown;
  marketplaceConfig: unknown;
  videoCapabilityOverrides: unknown;
  buildCoverUrl: (
    category: "image" | "video",
    configKey: string,
    cover: ModelMarketplaceCoverRef | null
  ) => string;
};

type RuntimeCatalog = z.infer<typeof runtimeModelCatalogSchema>;

type VideoRuntimeCandidate = {
  duration: number;
  aspectRatio: string;
  outputResolution: string;
};

/**
 * 比较同一图像配置键的真实运行时 ID，优先规范小写形式并以字典序兜底。
 *
 * @param left - 左侧已去空白的真实运行时 ID。
 * @param right - 右侧已去空白的真实运行时 ID。
 * @returns 小于零时左侧优先；结果不依赖运行时目录插入顺序。
 * @sideEffects 无。
 * @failure 不抛错；输入已由严格运行时 schema 校验。
 */
function compareRuntimeModelIds(left: string, right: string): number {
  const lowercaseDifference =
    Number(left !== left.toLowerCase()) - Number(right !== right.toLowerCase());
  return lowercaseDifference || left.localeCompare(right);
}

/**
 * 为每个图像配置键稳定选择一个真实可达的完整 ID。
 *
 * @param runtimeCatalog - 已严格解析的运行时图像与视频目录。
 * @returns 不含 default 的配置键到真实运行时 ID 映射。
 * @sideEffects 无。
 * @failure 不抛错；无法规范化的图像 ID 不具备公开身份并被忽略。
 */
function buildRuntimeImageModelIdMap(
  runtimeCatalog: RuntimeCatalog
): ReadonlyMap<string, string> {
  const candidates = new Map<string, string[]>();
  for (const model of runtimeCatalog.image) {
    const configKey = normalizeModelMarketplaceImageConfigKey(model.id);
    if (
      !configKey ||
      !isConcretePlatformImageModelId(model.id) ||
      !isConcretePlatformImageModelId(configKey)
    ) {
      continue;
    }
    const modelIds = candidates.get(configKey) ?? [];
    modelIds.push(model.id);
    candidates.set(configKey, modelIds);
  }

  const result = new Map<string, string>();
  for (const [configKey, modelIds] of candidates) {
    const modelId = [...new Set(modelIds)].sort(compareRuntimeModelIds)[0];
    if (modelId) result.set(configKey, modelId);
  }
  return result;
}

/**
 * 按真实视频模型聚合全局能力事实。
 *
 * @param runtimeCatalog - 已严格解析的运行时图像与视频目录。
 * @returns 真实模型 ID 到时长、比例与分辨率候选项的映射。
 * @sideEffects 无。
 * @failure 不抛错；复合身份、前缀和未知 ID 不会伪造成公开模型。
 */
function buildRuntimeVideoCandidates(
  runtimeCatalog: RuntimeCatalog
): ReadonlyMap<string, VideoRuntimeCandidate[]> {
  const candidatesByFamily = new Map<string, VideoRuntimeCandidate[]>();
  for (const model of runtimeCatalog.video) {
    const family = resolveModelMarketplaceVideoFamily(model.id);
    const resolved = resolveVideoModelCapability(model.id);
    if (!family || !resolved.ok) continue;
    const candidates = candidatesByFamily.get(family) ?? [];
    for (const duration of resolved.capability.durations) {
      for (const aspectRatio of resolved.capability.aspectRatios) {
        for (const outputResolution of resolved.capability.resolutions) {
          candidates.push({ duration, aspectRatio, outputResolution });
        }
      }
    }
    candidatesByFamily.set(family, candidates);
  }
  return candidatesByFamily;
}

/**
 * 解析公开简介，区分缺少配置与管理员显式保存空字符串两种语义。
 *
 * @param configKey - 已规范化的图像模型键或视频 family。
 * @param hasPersistedEntry - 当前模型是否存在显式展示配置。
 * @param persistedDescription - 严格配置中保存的简介，允许显式为空。
 * @returns 显式配置原值；完全缺项时返回内置简介或未知模型的空字符串。
 * @sideEffects 无。
 * @failure 不抛错；最终长度仍由公开 DTO schema 复核。
 */
function getPublicDescription(
  configKey: string,
  hasPersistedEntry: boolean,
  persistedDescription: string | undefined
): string {
  if (hasPersistedEntry) return persistedDescription ?? "";
  return getBuiltinModelMarketplaceDescription(configKey);
}

/**
 * 从严格事实源构建公开模型广场目录。
 *
 * @param input - 运行时真实目录、两类全局价格、视频能力覆盖、展示配置与安全封面 URL 构造器。
 * @returns 可公开且 visible 的严格 DTO 数组；图像仅含真实可达模型，视频含全部全局能力并
 * 独立标记当前配置可达性。
 * @sideEffects 仅同步调用注入的封面 URL 构造器，不读取或写入外部状态。
 * @failure 运行时目录、价格、配置、封面 URL 或最终 DTO 非法时显式抛出 ZodError；
 * 注入的封面构造错误保持原样上抛。
 */
export function buildModelMarketplaceCatalog(
  input: ModelMarketplaceCatalogInput
): ModelMarketplacePublicItem[] {
  const runtimeCatalog = runtimeModelCatalogSchema.parse(input.runtimeCatalog);
  const marketplaceConfig = parseModelMarketplaceConfig(
    input.marketplaceConfig
  );
  const runtimeImageModelIds = buildRuntimeImageModelIdMap(runtimeCatalog);
  const runtimeVideoCandidates = buildRuntimeVideoCandidates(runtimeCatalog);
  const effectiveVideoCapabilities = new Map<
    string,
    VideoModelCapabilityDescriptor
  >(
    resolveEffectiveVideoModelCapabilities(input.videoCapabilityOverrides).map(
      (capability) => [capability.modelId, capability]
    )
  );
  const snapshot = buildModelConfigurationSnapshot({
    imagePricing: input.imagePricing,
    videoPricing: input.videoPricing,
    videoBillingModes: input.videoBillingModes,
    videoCreditsPerItem: input.videoCreditsPerItem,
    marketplaceConfig,
    videoCapabilityOverrides: input.videoCapabilityOverrides,
    runtimeCatalog: { status: "ready", catalog: runtimeCatalog },
    canEdit: false,
    buildCoverUrl(category, configKey, cover) {
      return {
        coverUrl: input.buildCoverUrl(category, configKey, cover),
        usesDefaultCover: cover === null,
      };
    },
  });
  const items: ModelMarketplacePublicItem[] = [];

  for (const entry of snapshot.entries) {
    if (!entry.enabled || !entry.visible) continue;

    if (entry.category === "image") {
      // WHY：展示开关不能把未定价模型公开；价格缺失必须先由管理员显式配置。
      if (entry.pricingSource === "unconfigured") continue;
      const modelId = runtimeImageModelIds.get(entry.configKey);
      if (!modelId) continue;
      const persistedEntry = marketplaceConfig.imageByModel[entry.configKey];
      items.push(
        modelMarketplacePublicItemSchema.parse({
          category: "image",
          configKey: entry.configKey,
          modelId,
          displayName: entry.displayName,
          iconKey: entry.iconKey,
          description: getPublicDescription(
            entry.configKey,
            Object.hasOwn(marketplaceConfig.imageByModel, entry.configKey),
            persistedEntry?.description
          ),
          coverUrl: entry.coverUrl,
          minimumCredits: entry.minimumCredits,
          homepageVisible: entry.homepageVisible,
          homepagePriority: entry.homepagePriority,
          priceUnit: "per_image",
          pricing: entry.pricing,
        })
      );
      continue;
    }

    if (entry.category === "video") {
      const candidates = runtimeVideoCandidates.get(entry.configKey);
      const capability = effectiveVideoCapabilities.get(entry.configKey);
      if (!capability) continue;
      const persistedEntry = marketplaceConfig.videoByFamily[entry.configKey];
      const supportedResolutions = sortUniqueVideoResolutions([
        ...capability.resolutions,
      ]);
      const creditsPerSecondByResolution = Object.fromEntries(
        supportedResolutions.map((resolution) => [
          resolution,
          entry.creditsPerSecondByResolution[resolution] ??
            entry.creditsPerSecond,
        ])
      );
      const minimumCredits = Math.min(
        ...Object.values(creditsPerSecondByResolution)
      );
      items.push(
        modelMarketplacePublicItemSchema.parse({
          category: "video",
          configKey: entry.configKey,
          // WHY：组合路由 ID 只服务于请求解析；模型广场展示定价配置中的单一模型 ID。
          modelId: entry.configKey,
          displayName: entry.displayName,
          iconKey: entry.iconKey,
          description: getPublicDescription(
            entry.configKey,
            Object.hasOwn(marketplaceConfig.videoByFamily, entry.configKey),
            persistedEntry?.description
          ),
          coverUrl: entry.coverUrl,
          minimumCredits,
          homepageVisible: entry.homepageVisible,
          homepagePriority: entry.homepagePriority,
          priceUnit: "per_second",
          creditsPerSecond: minimumCredits,
          creditsPerSecondByResolution,
          supportedDurations: sortUniqueDurations([...capability.durations]),
          supportedAspectRatios: sortUniqueAspectRatios([
            ...capability.aspectRatios,
          ]),
          supportedResolutions,
          input: {
            frames: capability.input.frames,
            referenceImages: {
              maxCount: capability.input.referenceImages.maxCount,
              configurable: capability.input.referenceImages.configurable,
            },
            framesAndReferencesMutuallyExclusive:
              capability.input.framesAndReferencesMutuallyExclusive,
          },
          audio: { ...capability.audio },
          configuredReachable: Boolean(candidates?.length),
          infrastructureLimits: {
            maxMediaInputCount: MAX_MEDIA_INPUT_COUNT,
            maxMediaInputBytes: MAX_MEDIA_INPUT_BYTES,
          },
        })
      );
    }
  }

  return publicCatalogItemsSchema.parse(items);
}
