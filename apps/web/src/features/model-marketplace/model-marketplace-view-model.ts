/**
 * 模型广场客户端的 DB-free 视图模型函数。
 *
 * 使用方是模型浏览器、详情 CTA 与 Vitest；集中搜索、类别收窄、Clipboard 结果和创作
 * 链接规则，使纯逻辑测试无需加载 React、next-intl 或 Radix UI。
 */
import type { ModelMarketplacePublicItem } from "@repo/shared/model-marketplace";

/** 模型广场允许的本地类别筛选。 */
export type ModelMarketplaceCategoryFilter = "all" | "image" | "video";

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
 * 按类别和自然语言查询过滤公开模型。
 *
 * @param models - 服务端公开 operation 返回的严格 DTO。
 * @param query - 用户输入，可匹配展示名、完整 ID、配置键或简介。
 * @param category - all、image 或 video。
 * @returns 保持服务端目录顺序的新数组，不修改输入。
 * @sideEffects 无。
 */
export function filterModelMarketplaceModels(
  models: readonly ModelMarketplacePublicItem[],
  query: string,
  category: ModelMarketplaceCategoryFilter
): ModelMarketplacePublicItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return models.filter((model) => {
    if (category !== "all" && model.category !== category) return false;
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
