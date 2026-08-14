/**
 * 管理端模型配置清单的 DB-free 构建器。
 *
 * 使用方是读取服务与后续保存服务；本模块严格解析全局价格和展示配置，稳定合并内置、
 * 持久化与运行时模型，并输出共享 DTO。它不读取数据库、运行时服务或对象存储。
 */
import {
  ADOBE_VIDEO_PRICING_FAMILIES,
  getVideoPricingResolutions,
  globalVideoModelCreditsPerSecondSchema,
  isVideoPricingResolutionKey,
  resolveVideoCreditsPerSecondByResolution,
} from "@repo/shared/adobe";
import { ADOBE_IMAGE_MODEL_IDS } from "@repo/shared/adobe/enabled-models";
import { globalImageCreditOverridesSchema } from "@repo/shared/image-backend/group-image-pricing";
import {
  getMinimumImageCredits,
  type ModelConfigurationEntry,
  type ModelConfigurationSnapshot,
  type ModelMarketplaceCoverRef,
  type ModelMarketplaceCustomModel,
  type ModelMarketplaceEntry,
  type ModelMarketplaceIconKey,
  modelConfigurationSnapshotSchema,
  modelMarketplaceImagePricingSchema,
  normalizeModelMarketplaceImageConfigKey,
  parseModelMarketplaceConfig,
  resolveModelMarketplaceEntry,
  resolveModelMarketplaceVideoFamily,
} from "@repo/shared/model-marketplace";
import {
  normalizeVideoModelId,
  resolveEffectiveVideoModelCapabilities,
} from "@repo/shared/video-generation";

import { getBuiltinModelMarketplaceDescription } from "../model-marketplace/builtin-descriptions";

/** 运行时目录只暴露清单合并需要的模型标识。 */
export type RuntimeModelCatalog = {
  image: ReadonlyArray<{ id: string }>;
  video: ReadonlyArray<{ id: string }>;
};

/** 目录读取成功或失败的显式状态，失败分支不得携带不可信的半成品目录。 */
export type RuntimeModelCatalogResult =
  | { status: "ready"; catalog: RuntimeModelCatalog }
  | { status: "unavailable" };

/** 封面引用转换后的管理 DTO 字段，不泄露 bucket 或对象 key。 */
export type ModelConfigurationCoverUrl = {
  coverUrl: string | null;
  usesDefaultCover: boolean;
};

/** 管理清单纯构建器需要的完整事实输入。 */
export type ModelConfigurationCatalogInput = {
  imagePricing: unknown;
  videoPricing: unknown;
  marketplaceConfig: unknown;
  videoCapabilityOverrides: unknown;
  runtimeCatalog: RuntimeModelCatalogResult;
  canEdit: boolean;
  buildCoverUrl: (
    category: "image" | "video",
    configKey: string,
    cover: ModelMarketplaceCoverRef | null
  ) => ModelConfigurationCoverUrl;
};

const IMAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "gpt-image-2": "GPT Image 2",
  "gpt-image-1.5": "GPT Image 1.5",
  "nano-banana-pro": "Nano Banana Pro",
  "nano-banana": "Nano Banana",
  "nano-banana2": "Nano Banana 2",
};

const VIDEO_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  sora2: "Sora 2",
  "sora2-pro": "Sora 2 Pro",
  veo31: "Veo 3.1",
  "veo31-ref": "Veo 3.1 Reference",
  "veo31-fast": "Veo 3.1 Fast",
  "kling-o3": "Kling O3",
  kling3: "Kling 3.0",
  "kling3-omni": "Kling 3.0 Omni",
  "runway-gen45": "Runway Gen-4.5",
  ray314: "Ray 3.14",
  "ray314-hdr": "Ray 3.14 HDR",
  seedance2: "Seedance 2.0",
  "seedance2-fast": "Seedance 2.0 Fast",
};

/**
 * 规范化额外视频价格键，确保大小写不同的持久化键不会生成重复条目。
 *
 * @param configKey - 已通过全局视频价格 schema 的键。
 * @returns 去空白并转为小写的配置键；空键返回 null。
 * @sideEffects 无。
 * @failure 不抛错；键长度和空白约束已由上游严格 schema 负责。
 */
function normalizeVideoConfigKey(configKey: string): string | null {
  const normalized = configKey.trim().toLowerCase();
  return normalized || null;
}

/**
 * 将未知模型键转成稳定且可读的兜底名称。
 *
 * @param configKey - 已规范化的模型配置键。
 * @returns 按连字符和下划线分词后的标题形式名称。
 * @sideEffects 无。
 * @failure 不抛错；调用方只传入非空配置键。
 */
function formatFallbackDisplayName(configKey: string): string {
  return configKey
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const normalized = part.toLowerCase();
      if (normalized === "gpt" || normalized === "api") {
        return normalized.toUpperCase();
      }
      if (normalized === "xai") return "xAI";
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

/**
 * 解析图像或视频模型的稳定展示名称。
 *
 * @param category - 模型媒体类别。
 * @param configKey - 已规范化的模型配置键。
 * @returns 内置模型的产品名，或不猜测品牌的格式化兜底名称。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function getDisplayName(
  category: "image" | "video",
  configKey: string
): string {
  const displayNames =
    category === "image" ? IMAGE_DISPLAY_NAMES : VIDEO_DISPLAY_NAMES;
  return displayNames[configKey] ?? formatFallbackDisplayName(configKey);
}

/**
 * 根据已知产品族选择前端内置图标，未知供应商使用通用图标。
 *
 * @param configKey - 已规范化的图像模型或视频 family 键。
 * @returns 共享契约允许的图标键。
 * @sideEffects 无。
 * @failure 不抛错，未知模型返回 generic。
 */
function getIconKey(configKey: string): ModelMarketplaceIconKey {
  if (/xai|grok/.test(configKey)) return "xai";
  if (/seedance|bytedance|byte-dance/.test(configKey)) return "bytedance";
  if (/kling/.test(configKey)) return "kling";
  if (/runway/.test(configKey)) return "runway";
  if (/nano|veo|gemini|google/.test(configKey)) return "google";
  if (/gpt|sora|openai/.test(configKey)) return "openai";
  return "generic";
}

/**
 * 创建管理 DTO 共用的展示配置与封面字段。
 *
 * @param category - 封面默认图所属的媒体类别。
 * @param configKey - 已规范化的真实模型键。
 * @param entry - 显式展示配置；缺失时按默认展示规则补齐。
 * @param buildCoverUrl - 将私有存储引用转换为第一方相对 URL 的注入函数。
 * @returns 不含价格的共享管理 DTO 字段。
 * @sideEffects 仅调用注入的 URL 构建函数；不执行存储读写。
 * @failure URL 构建错误直接上抛，最终 URL 仍会由共享快照 schema 复核。
 */
function buildMarketplaceFields(
  category: "image" | "video",
  configKey: string,
  entry: ModelMarketplaceEntry | undefined,
  buildCoverUrl: ModelConfigurationCatalogInput["buildCoverUrl"]
) {
  const resolvedEntry = resolveModelMarketplaceEntry(entry, category);
  const cover = buildCoverUrl(category, configKey, resolvedEntry.cover);
  return {
    configKey,
    displayName: getDisplayName(category, configKey),
    iconKey: getIconKey(configKey),
    revision: resolvedEntry.revision,
    marketplaceApplicable: true as const,
    enabled: resolvedEntry.enabled,
    visible: resolvedEntry.visible,
    homepageVisible: resolvedEntry.homepageVisible,
    homepagePriority: resolvedEntry.homepagePriority,
    description:
      entry === undefined
        ? getBuiltinModelMarketplaceDescription(configKey)
        : resolvedEntry.description,
    coverUrl: cover.coverUrl,
    usesDefaultCover: cover.usesDefaultCover,
  };
}

/**
 * 收集图像模型键，并保持内置顺序与额外键字典序。
 *
 * @param persistedConfigKeys - 完整全局图像价格中已持久化的键。
 * @param runtimeCatalog - 可用时的运行时模型目录。
 * @returns 大小写无关去重且不含 default 的规范键数组。
 * @sideEffects 无。
 * @failure 不抛错；非法或空运行时 ID 会被忽略。
 */
function collectImageConfigKeys(
  persistedConfigKeys: readonly string[],
  runtimeCatalog: RuntimeModelCatalogResult,
  customModels: readonly ModelMarketplaceCustomModel[]
): string[] {
  const builtInKeys = ADOBE_IMAGE_MODEL_IDS.flatMap((modelId) => {
    const configKey = normalizeModelMarketplaceImageConfigKey(modelId);
    return configKey ? [configKey] : [];
  });
  const builtInSet = new Set(builtInKeys);
  const additionalKeys = new Set<string>();
  const candidates = [
    ...persistedConfigKeys,
    ...customModels
      .filter((model) => model.category === "image")
      .map((model) => model.modelId),
    ...(runtimeCatalog.status === "ready"
      ? runtimeCatalog.catalog.image.map((model) => model.id)
      : []),
  ];

  for (const modelId of candidates) {
    const configKey = normalizeModelMarketplaceImageConfigKey(modelId);
    if (!configKey || configKey === "default" || builtInSet.has(configKey)) {
      continue;
    }
    additionalKeys.add(configKey);
  }
  return [...builtInKeys, ...Array.from(additionalKeys).sort()];
}

/**
 * 收集视频 family，并保持内置顺序与额外持久化价格键字典序。
 *
 * @param persistedConfigKeys - 完整全局视频价格中已持久化的 family 键。
 * @param runtimeCatalog - 可用时的运行时完整视频模型目录。
 * @returns 去重后的规范 family 数组；不可解析的运行时视频 ID 被忽略。
 * @sideEffects 无。
 * @failure 不抛错；运行时目录不能凭未知完整 ID创建不可配置 family。
 */
function collectVideoConfigKeys(
  persistedConfigKeys: readonly string[],
  runtimeCatalog: RuntimeModelCatalogResult,
  customModels: readonly ModelMarketplaceCustomModel[]
): string[] {
  const builtInKeys = [...ADOBE_VIDEO_PRICING_FAMILIES];
  const builtInSet = new Set<string>(builtInKeys);
  const additionalKeys = new Set<string>();

  for (const candidate of persistedConfigKeys) {
    if (isVideoPricingResolutionKey(candidate)) continue;
    const configKey = normalizeVideoConfigKey(candidate);
    if (configKey && !builtInSet.has(configKey)) {
      additionalKeys.add(configKey);
    }
  }
  for (const model of customModels) {
    if (model.category !== "video" || builtInSet.has(model.modelId)) continue;
    additionalKeys.add(model.modelId);
  }
  if (runtimeCatalog.status === "ready") {
    for (const model of runtimeCatalog.catalog.video) {
      const family = resolveModelMarketplaceVideoFamily(model.id);
      if (family && !builtInSet.has(family)) additionalKeys.add(family);
    }
  }
  return [...builtInKeys, ...Array.from(additionalKeys).sort()];
}

/**
 * 从严格事实源构建完整管理端模型配置快照。
 *
 * @param input - 完整价格、展示配置、运行时目录状态、权限与封面 URL 构建器。
 * @returns 通过共享 schema 复核的稳定 DTO；缺少显式价格的运行时图像标记为未配置。
 * @sideEffects 仅同步调用注入的封面 URL 构建器，不读取或写入外部状态。
 * @failure 价格、展示配置、封面 URL 或最终 DTO 非法时显式抛出 ZodError；运行时不可用
 * 由输入状态表达，不导致构建失败。
 */
export function buildModelConfigurationSnapshot(
  input: ModelConfigurationCatalogInput
): ModelConfigurationSnapshot {
  const imagePricing = globalImageCreditOverridesSchema.parse(
    input.imagePricing
  );
  const videoPricing = globalVideoModelCreditsPerSecondSchema.parse(
    input.videoPricing
  );
  const marketplaceConfig = parseModelMarketplaceConfig(
    input.marketplaceConfig
  );
  const effectiveVideoCapabilities = new Map(
    resolveEffectiveVideoModelCapabilities(input.videoCapabilityOverrides).map(
      (capability) => [capability.modelId, capability]
    )
  );
  const entries: ModelConfigurationEntry[] = [];

  const imageConfigKeys = collectImageConfigKeys(
    Object.keys(imagePricing.byModel),
    input.runtimeCatalog,
    marketplaceConfig.customModels
  );
  const customModelsById = new Map(
    marketplaceConfig.customModels.map((model) => [
      model.modelId.toLowerCase(),
      model,
    ])
  );
  for (const configKey of imageConfigKeys) {
    const explicitPricing = imagePricing.byModel[configKey];
    const common = buildMarketplaceFields(
      "image",
      configKey,
      marketplaceConfig.imageByModel[configKey],
      input.buildCoverUrl
    );
    const customModel = customModelsById.get(configKey.toLowerCase());

    if (explicitPricing) {
      const pricing = modelMarketplaceImagePricingSchema.parse(explicitPricing);
      entries.push({
        ...common,
        category: "image",
        pricingSource: "explicit",
        pricing,
        minimumCredits: getMinimumImageCredits(pricing),
        ...(customModel
          ? { supportedResolutions: [...customModel.supportedResolutions] }
          : {}),
      });
    } else {
      entries.push({
        ...common,
        category: "image",
        pricingSource: "unconfigured",
        ...(customModel
          ? { supportedResolutions: [...customModel.supportedResolutions] }
          : {}),
      });
    }
  }

  const videoConfigKeys = collectVideoConfigKeys(
    Object.keys(videoPricing),
    input.runtimeCatalog,
    marketplaceConfig.customModels
  );
  for (const configKey of videoConfigKeys) {
    const creditsPerSecond = videoPricing[configKey];
    if (creditsPerSecond === undefined) continue;
    const customModel = customModelsById.get(configKey.toLowerCase());
    const supportedResolutions = customModel
      ? [...customModel.supportedResolutions]
      : getVideoPricingResolutions(configKey).length > 0
        ? getVideoPricingResolutions(configKey)
        : ["default"];
    const creditsPerSecondByResolution = Object.fromEntries(
      supportedResolutions.map((resolution) => [
        resolution,
        resolveVideoCreditsPerSecondByResolution(
          configKey,
          resolution,
          videoPricing,
          creditsPerSecond
        ),
      ])
    );
    const minimumCredits = Math.min(
      ...Object.values(creditsPerSecondByResolution)
    );
    const realModelId = normalizeVideoModelId(configKey);
    const capability = realModelId
      ? effectiveVideoCapabilities.get(realModelId)
      : undefined;
    entries.push({
      ...buildMarketplaceFields(
        "video",
        configKey,
        marketplaceConfig.videoByFamily[configKey],
        input.buildCoverUrl
      ),
      category: "video",
      creditsPerSecond: minimumCredits,
      creditsPerSecondByResolution,
      supportedResolutions,
      minimumCredits,
      ...(capability?.input.referenceImages.configurable
        ? {
            maxReferenceImages: capability.input.referenceImages.maxCount,
          }
        : {}),
    });
  }

  return modelConfigurationSnapshotSchema.parse({
    canEdit: input.canEdit,
    runtimeCatalogStatus: input.runtimeCatalog.status,
    entries,
  });
}
