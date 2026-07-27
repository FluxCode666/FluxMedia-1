/**
 * 公开模型广场的 DB-free 目录构建器。
 *
 * 使用方是公开目录生产服务；本模块严格解析运行时目录、价格与展示配置，只输出真实可达
 * 且允许展示的图像模型和视频模型族，并复用管理目录与共享纯函数避免身份和价格规则漂移。
 */
import { resolveFireflyVideoModel } from "@repo/shared/adobe/firefly-direct/video-catalog";
import {
  getStableVideoDefaultModelId,
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
import { z } from "zod";
import { isConcretePlatformImageModelId } from "../external-api/platform-model-catalog";
import { buildModelConfigurationSnapshot } from "../model-configuration/catalog";

const runtimeModelItemSchema = z
  .object({ id: z.string().trim().min(1).max(255) })
  .strict();
const runtimeModelCatalogSchema = z
  .object({
    image: z.array(runtimeModelItemSchema).max(500),
    video: z.array(runtimeModelItemSchema).max(500),
  })
  .strict();
const publicCatalogItemsSchema = z
  .array(modelMarketplacePublicItemSchema)
  .max(500);

const BUILTIN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "gpt-image-2": "适合高质量图像生成、精细文字渲染与复杂指令遵循。",
  "gpt-image-1.5": "兼顾图像质量、编辑能力与稳定指令遵循。",
  "nano-banana-pro": "适合高质量图像创作、编辑与多元素一致性处理。",
  "nano-banana": "适合快速图像生成、编辑与日常创意探索。",
  "nano-banana2": "适合快速生成并保持稳定的视觉与提示词一致性。",
  sora2: "适合生成具有连贯运动和电影感构图的视频。",
  "sora2-pro": "适合对画面质量、运动细节与叙事一致性要求更高的视频。",
  veo31: "适合高质量视频生成与多种时长、比例和分辨率组合。",
  "veo31-ref": "适合基于参考图保持主体与视觉风格一致的视频生成。",
  "veo31-fast": "适合需要更快反馈的高质量视频创作。",
  "kling-o3": "适合强调动作表现、镜头运动与参考一致性的视频生成。",
  kling3: "适合多场景视频创作与稳定的运动表现。",
};

/** 公开目录构建器需要的完整事实输入。 */
export type ModelMarketplaceCatalogInput = {
  runtimeCatalog: unknown;
  imagePricing: unknown;
  videoPricing: unknown;
  marketplaceConfig: unknown;
  buildCoverUrl: (
    category: "image" | "video",
    configKey: string,
    cover: ModelMarketplaceCoverRef | null
  ) => string;
};

type RuntimeCatalog = z.infer<typeof runtimeModelCatalogSchema>;

type VideoRuntimeCandidate = {
  id: string;
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
 * 按视频 family 聚合真实可达完整 ID 及其能力事实。
 *
 * @param runtimeCatalog - 已严格解析的运行时图像与视频目录。
 * @returns family 到真实完整 ID、时长、比例与分辨率候选项的映射。
 * @sideEffects 无。
 * @failure 不抛错；不能由共享 Firefly 目录解析的视频 ID 不会伪造成公开 family。
 */
function buildRuntimeVideoCandidates(
  runtimeCatalog: RuntimeCatalog
): ReadonlyMap<string, VideoRuntimeCandidate[]> {
  const candidatesByFamily = new Map<string, VideoRuntimeCandidate[]>();
  for (const model of runtimeCatalog.video) {
    const family = resolveModelMarketplaceVideoFamily(model.id);
    const configuration = resolveFireflyVideoModel(model.id);
    if (!family || !configuration) continue;
    const candidates = candidatesByFamily.get(family) ?? [];
    candidates.push({
      id: model.id,
      duration: configuration.duration,
      aspectRatio: configuration.aspectRatio,
      outputResolution: configuration.outputResolution,
    });
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
  return BUILTIN_DESCRIPTIONS[configKey] ?? "";
}

/**
 * 从严格事实源构建公开模型广场目录。
 *
 * @param input - 运行时真实目录、两类全局价格、展示配置与安全封面 URL 构造器。
 * @returns 只含真实可达且 visible 的严格公开 DTO 数组；全部关闭时返回空数组。
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
  const snapshot = buildModelConfigurationSnapshot({
    imagePricing: input.imagePricing,
    videoPricing: input.videoPricing,
    marketplaceConfig,
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
    if (!entry.visible) continue;

    if (entry.category === "image") {
      // WHY：展示开关不能把未定价模型公开；价格缺失必须先由管理员显式配置。
      if (entry.pricingSource === "unconfigured") continue;
      const defaultModelId = runtimeImageModelIds.get(entry.configKey);
      if (!defaultModelId) continue;
      const persistedEntry = marketplaceConfig.imageByModel[entry.configKey];
      items.push(
        modelMarketplacePublicItemSchema.parse({
          category: "image",
          configKey: entry.configKey,
          defaultModelId,
          displayName: entry.displayName,
          iconKey: entry.iconKey,
          description: getPublicDescription(
            entry.configKey,
            Object.hasOwn(marketplaceConfig.imageByModel, entry.configKey),
            persistedEntry?.description
          ),
          coverUrl: entry.coverUrl,
          minimumCredits: entry.minimumCredits,
          priceUnit: "per_image",
          pricing: entry.pricing,
        })
      );
      continue;
    }

    if (entry.category === "video") {
      const candidates = runtimeVideoCandidates.get(entry.configKey);
      if (!candidates?.length) continue;
      const defaultModelId = getStableVideoDefaultModelId(
        entry.configKey,
        candidates.map((candidate) => candidate.id)
      );
      if (!defaultModelId) continue;
      const persistedEntry = marketplaceConfig.videoByFamily[entry.configKey];
      items.push(
        modelMarketplacePublicItemSchema.parse({
          category: "video",
          configKey: entry.configKey,
          defaultModelId,
          displayName: entry.displayName,
          iconKey: entry.iconKey,
          description: getPublicDescription(
            entry.configKey,
            Object.hasOwn(marketplaceConfig.videoByFamily, entry.configKey),
            persistedEntry?.description
          ),
          coverUrl: entry.coverUrl,
          minimumCredits: entry.minimumCredits,
          priceUnit: "per_second",
          creditsPerSecond: entry.creditsPerSecond,
          supportedDurations: sortUniqueDurations(
            candidates.map((candidate) => candidate.duration)
          ),
          supportedAspectRatios: sortUniqueAspectRatios(
            candidates.map((candidate) => candidate.aspectRatio)
          ),
          supportedResolutions: sortUniqueVideoResolutions(
            candidates.map((candidate) => candidate.outputResolution)
          ),
        })
      );
    }
  }

  return publicCatalogItemsSchema.parse(items);
}
