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
  type ModelMarketplaceCustomModel,
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
  VIDEO_ASPECT_RATIOS,
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

/** 内置与管理员注册视频模型在公开目录中共用的能力字段。 */
type MarketplaceVideoCapability = Omit<
  VideoModelCapabilityDescriptor,
  "modelId" | "billingFamily" | "aspectRatios" | "resolutions"
> & {
  readonly modelId: string;
  readonly billingFamily: string;
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
};

/**
 * 为管理员注册的自定义视频模型构建保守公开能力。
 *
 * @param customModels - 已经严格解析的自定义模型定义。
 * @returns 只包含视频模型的能力描述符；未知供应商不假设参考图或音频能力。
 * @sideEffects 无。
 * @failure 不抛错；输入在调用前已由共享配置契约校验。
 */
function buildCustomVideoCapabilities(
  customModels: readonly ModelMarketplaceCustomModel[]
): MarketplaceVideoCapability[] {
  return customModels
    .filter((model) => model.category === "video")
    .map((model) => ({
      modelId: model.modelId,
      displayName: model.modelId,
      billingFamily: model.modelId,
      // WHY：自定义供应商尚未声明精细时长能力时，只公开生成接口同样使用的安全默认范围。
      durations: [5, 10],
      aspectRatios: [...VIDEO_ASPECT_RATIOS],
      resolutions: [...model.supportedResolutions],
      input: {
        frames: "none" as const,
        referenceImages: { maxCount: 0, configurable: false },
        framesAndReferencesMutuallyExclusive: true,
      },
      audio: { supported: false, defaultEnabled: false },
    }));
}

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
 * @param capabilitiesByModel - 内置与已注册自定义视频模型的公开能力映射。
 * @returns 真实模型 ID 到时长、比例与分辨率候选项的映射。
 * @sideEffects 无。
 * @failure 不抛错；复合身份、前缀和未注册 ID 不会伪造成公开模型。
 */
function buildRuntimeVideoCandidates(
  runtimeCatalog: RuntimeCatalog,
  capabilitiesByModel: ReadonlyMap<string, MarketplaceVideoCapability>
): ReadonlyMap<string, VideoRuntimeCandidate[]> {
  const candidatesByFamily = new Map<string, VideoRuntimeCandidate[]>();
  for (const model of runtimeCatalog.video) {
    const family = resolveModelMarketplaceVideoFamily(model.id);
    const resolved = resolveVideoModelCapability(model.id);
    const configKey = family ?? model.id;
    const capability = resolved.ok
      ? resolved.capability
      : capabilitiesByModel.get(model.id);
    // WHY：运行时目录不可信；未知 ID 即使携带价格也不能被提升为公开模型。
    if (!capability || (!family && capability.modelId !== model.id)) continue;
    const candidates = candidatesByFamily.get(configKey) ?? [];
    for (const duration of capability.durations) {
      for (const aspectRatio of capability.aspectRatios) {
        for (const outputResolution of capability.resolutions) {
          candidates.push({ duration, aspectRatio, outputResolution });
        }
      }
    }
    candidatesByFamily.set(configKey, candidates);
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
  const customVideoCapabilities = buildCustomVideoCapabilities(
    marketplaceConfig.customModels
  );
  const effectiveVideoCapabilities = new Map<
    string,
    MarketplaceVideoCapability
  >(
    [
      ...resolveEffectiveVideoModelCapabilities(input.videoCapabilityOverrides),
      ...customVideoCapabilities,
    ].map((capability) => [capability.modelId, capability])
  );
  const runtimeImageModelIds = buildRuntimeImageModelIdMap(runtimeCatalog);
  const runtimeVideoCandidates = buildRuntimeVideoCandidates(
    runtimeCatalog,
    effectiveVideoCapabilities
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
          supportedResolutions: entry.supportedResolutions,
          ...(entry.supportsQuality === true ? { supportsQuality: true } : {}),
          ...(entry.supportsAutoSize === true
            ? { supportsAutoSize: true }
            : {}),
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
        ...(entry.supportedResolutions ?? capability.resolutions),
      ]);
      const effectivePricesByResolution = Object.fromEntries(
        supportedResolutions.map((resolution) => [
          resolution,
          entry.billingMode === "per_item"
            ? entry.creditsPerItemByResolution[resolution]
            : (entry.creditsPerSecondByResolution[resolution] ??
              entry.creditsPerSecond),
        ])
      ) as Record<string, number>;
      const minimumCredits = Math.min(
        ...Object.values(effectivePricesByResolution)
      );
      const videoCommon = {
        category: "video" as const,
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
      };
      items.push(
        modelMarketplacePublicItemSchema.parse(
          entry.billingMode === "per_item"
            ? {
                ...videoCommon,
                billingMode: "per_item",
                priceUnit: "per_item",
                creditsPerItem: minimumCredits,
                creditsPerItemByResolution: effectivePricesByResolution,
              }
            : {
                ...videoCommon,
                billingMode: "per_second",
                priceUnit: "per_second",
                creditsPerSecond: minimumCredits,
                creditsPerSecondByResolution: effectivePricesByResolution,
              }
        )
      );
    }
  }

  return publicCatalogItemsSchema.parse(items);
}
