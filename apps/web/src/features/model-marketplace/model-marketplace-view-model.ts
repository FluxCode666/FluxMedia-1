/**
 * 模型广场客户端的 DB-free 视图模型函数。
 *
 * 使用方是模型浏览器、详情 CTA 与 Vitest；集中搜索、类别与厂商收窄、Clipboard 结果
 * 和创作链接规则，使纯逻辑测试无需加载 React、next-intl 或 Radix UI。
 */
import type {
  ModelMarketplaceIconKey,
  ModelMarketplacePublicItem,
} from "@repo/shared/model-marketplace";

/** 模型广场允许的本地类别筛选。 */
export type ModelMarketplaceCategoryFilter = "all" | "image" | "video";

/** 模型广场允许的本地厂商筛选；品牌事实来自公开 DTO 的 iconKey。 */
export type ModelMarketplaceProviderFilter = "all" | ModelMarketplaceIconKey;

/** 厂商选项的稳定展示顺序；不存在于当前目录的厂商不会显示。 */
const MODEL_MARKETPLACE_PROVIDER_ORDER: readonly ModelMarketplaceIconKey[] = [
  "openai",
  "google",
  "kling",
  "xai",
  "generic",
];

/**
 * 收窄 RadioGroup 交付的类别值。
 *
 * @param value - 客户端组件交付的任意字符串。
 * @returns image、video 原样保留，其他值回退 all。
 * @sideEffects 无。
 */
export function parseModelMarketplaceCategoryFilter(
  value: string
): ModelMarketplaceCategoryFilter {
  return value === "image" || value === "video" ? value : "all";
}

/**
 * 收窄 RadioGroup 交付的厂商值。
 *
 * @param value - 客户端组件交付的任意字符串。
 * @returns 已知品牌键原样保留，其他值回退 all。
 * @sideEffects 无。
 */
export function parseModelMarketplaceProviderFilter(
  value: string
): ModelMarketplaceProviderFilter {
  return MODEL_MARKETPLACE_PROVIDER_ORDER.includes(
    value as ModelMarketplaceIconKey
  )
    ? (value as ModelMarketplaceIconKey)
    : "all";
}

/**
 * 从当前公开目录提取真实可选厂商。
 *
 * @param models - 服务端公开 operation 返回的严格 DTO。
 * @returns 按稳定品牌顺序排列且去重的厂商键，不伪造目录中不存在的选项。
 * @sideEffects 无。
 */
export function getAvailableModelMarketplaceProviders(
  models: readonly ModelMarketplacePublicItem[]
): ModelMarketplaceIconKey[] {
  const availableProviders = new Set(models.map((model) => model.iconKey));
  return MODEL_MARKETPLACE_PROVIDER_ORDER.filter((provider) =>
    availableProviders.has(provider)
  );
}

/**
 * 把视频支持时长转换为详情页紧凑标签。
 *
 * @param durations - 公开 DTO 提供的正整数秒数。
 * @returns 全部取值逐秒连续时压缩为单个区间，否则返回逐项秒数标签。
 * @sideEffects 无。
 * @failure 非法值会被丢弃；空输入返回空数组。
 */
export function formatSupportedVideoDurations(
  durations: readonly number[]
): string[] {
  const sorted = [
    ...new Set(
      durations.filter(
        (duration) =>
          Number.isFinite(duration) &&
          Number.isInteger(duration) &&
          duration > 0
      )
    ),
  ].sort((left, right) => left - right);
  if (sorted.length > 1) {
    const isContinuous = sorted.every(
      (duration, index) =>
        index === 0 || duration === (sorted[index - 1] ?? Number.NaN) + 1
    );
    if (isContinuous) return [`${sorted[0]}–${sorted.at(-1)}s`];
  }
  return sorted.map((duration) => `${duration}s`);
}

/**
 * 按类别、厂商和自然语言查询过滤公开模型。
 *
 * @param models - 服务端公开 operation 返回的严格 DTO。
 * @param query - 用户输入，可匹配展示名、完整 ID、配置键或简介。
 * @param category - all、image 或 video。
 * @param provider - all 或公开 DTO 中已收窄的品牌键。
 * @returns 保持服务端目录顺序的新数组，不修改输入。
 * @sideEffects 无。
 */
export function filterModelMarketplaceModels(
  models: readonly ModelMarketplacePublicItem[],
  query: string,
  category: ModelMarketplaceCategoryFilter,
  provider: ModelMarketplaceProviderFilter
): ModelMarketplacePublicItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return models.filter((model) => {
    if (category !== "all" && model.category !== category) return false;
    if (provider !== "all" && model.iconKey !== provider) return false;
    if (!normalizedQuery) return true;
    return [
      model.displayName,
      model.defaultModelId,
      model.configKey,
      model.description,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}

/**
 * 尝试把完整模型 ID 写入系统剪贴板。
 *
 * @param modelId - 公开 DTO 中的完整默认模型 ID。
 * @param writeText - 浏览器 Clipboard 写入函数；缺失时表示环境不支持复制。
 * @returns 成功返回 true，API 缺失或拒绝返回 false。
 * @sideEffects 成功时写系统剪贴板。
 * @failure 捕获 Clipboard 权限和平台错误，不向 React 事件边界抛出。
 */
export async function copyModelMarketplaceId(
  modelId: string,
  writeText: ((value: string) => Promise<void>) | null | undefined
): Promise<boolean> {
  if (!writeText) return false;
  try {
    await writeText(modelId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构建模型广场“立即使用”站内路径。
 *
 * @param model - 公开目录已验证的图片或视频模型。
 * @returns 图片进入简易生图并携带完整模型 ID；视频在页面移除后进入 API 文档。
 * @sideEffects 无。
 * @failure DTO 已限制模型 ID 非空且有界，函数不会抛错。
 */
export function getModelMarketplaceUsageHref(
  model: ModelMarketplacePublicItem
): string {
  if (model.category === "video") return "/dashboard/api-docs";
  const searchParams = new URLSearchParams({
    category: model.category,
    model: model.defaultModelId,
  });
  return `/dashboard/generate?${searchParams.toString()}`;
}
