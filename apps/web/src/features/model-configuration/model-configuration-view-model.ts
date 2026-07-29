/**
 * 模型配置列表与 Dialog 条件展示的 DB-free 视图模型。
 *
 * 使用方是管理面板、列表和编辑弹窗；本模块只投影共享 DTO，不读取 React 状态、会话、
 * 网络或浏览器 API，保证搜索、筛选、状态文案和封面失败回退可由 Node Vitest 锁定。
 */
import type { ModelConfigurationEntry } from "@repo/shared/model-marketplace";

import { getDefaultModelMarketplaceCoverPath } from "@/features/model-marketplace/assets";

/** 管理列表支持的媒体筛选值。 */
export type ModelConfigurationCategoryFilter = "all" | "image" | "video";

/** 编辑弹窗根据条目类型与权限显示的字段能力。 */
export type ModelConfigurationDialogFields = {
  canSave: boolean;
  showMarketplaceFields: boolean;
  showImagePricing: boolean;
  showVideoPricing: boolean;
  showCoverActions: boolean;
};

/**
 * 把 Route 的稳定失败码转换为管理员可执行的保存提示。
 *
 * @param code - 响应 JSON 中经过服务端白名单收窄的机器码；解析失败时为 null。
 * @returns 不包含服务端内部消息的简体中文提示。
 * @sideEffects 无。
 * @failure 未知码统一返回可安全重试的通用提示。
 */
export function getModelConfigurationSaveErrorMessage(
  code: string | null
): string {
  if (code === "invalid_cover") {
    return "封面图片无法处理，请确认文件是有效的静态 JPEG、PNG 或 WebP，且不超过 5 MB";
  }
  if (code === "idempotency_conflict") {
    return "当前保存标识已用于其他内容，请修改草稿后重试";
  }
  if (code === "validation_error") {
    return "模型配置内容无效，请检查价格、展示选项和封面后重试";
  }
  return "保存模型配置失败，请稍后重试";
}

/**
 * 取得列表类别中文标签。
 *
 * @param entry - 管理快照中的规范条目。
 * @returns 图像或视频。
 * @sideEffects 无。
 * @failure 判别联合穷尽，不抛错。
 */
export function getModelConfigurationCategoryLabel(
  entry: ModelConfigurationEntry
): string {
  if (entry.category === "image") return "图像";
  return "视频";
}

/**
 * 取得模型广场展示状态中文标签。
 *
 * @param entry - 管理快照中的规范条目。
 * @returns 未定价图像返回未配置价格，其余模型按 visible 返回已展示或已隐藏。
 * @sideEffects 无。
 * @failure 判别联合穷尽，不抛错。
 */
export function getModelConfigurationVisibilityLabel(
  entry: ModelConfigurationEntry
): "已展示" | "已隐藏" | "未配置价格" {
  if (entry.category === "image" && entry.pricingSource === "unconfigured") {
    return "未配置价格";
  }
  return entry.visible ? "已展示" : "已隐藏";
}

/**
 * 取得官网首页展示状态与排序优先级文案。
 *
 * @param entry - 管理快照中的规范条目。
 * @returns 关闭时返回未展示；开启时返回包含数值优先级的稳定文案。
 * @sideEffects 无。
 * @failure 共享 DTO 已校验开关与优先级，不抛错。
 */
export function getModelConfigurationHomepageLabel(
  entry: ModelConfigurationEntry
): string {
  return entry.homepageVisible
    ? `已展示 · P${entry.homepagePriority}`
    : "未展示";
}

/**
 * 格式化列表最低积分，避免浮点尾数污染管理界面。
 *
 * @param credits - 共享 DTO 已校验的正有限积分。
 * @returns 最多四位小数并移除无意义尾零的中文积分文本。
 * @sideEffects 无。
 * @failure DTO 类型边界保证输入合法，不抛错。
 */
export function formatModelConfigurationMinimumCredits(
  credits: number
): string {
  return `${Number(credits.toFixed(4))} 积分`;
}

/**
 * 按 ID/名称搜索并应用媒体筛选，保持服务端目录的稳定顺序。
 *
 * @param entries - 管理快照原始顺序的条目。
 * @param query - 管理员输入的 ID 或名称片段。
 * @param category - all、image 或 video。
 * @returns 保持服务端顺序的新数组。
 * @sideEffects 无。
 * @failure 不抛错；空白查询按未搜索处理。
 */
export function filterModelConfigurationEntries(
  entries: readonly ModelConfigurationEntry[],
  query: string,
  category: ModelConfigurationCategoryFilter
): ModelConfigurationEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (category !== "all" && entry.category !== category) return false;
    if (!normalizedQuery) return true;
    return [entry.configKey, entry.displayName].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    );
  });
}

/**
 * 计算编辑弹窗的字段与操作能力。
 *
 * @param entry - 当前选中的管理条目。
 * @param canEdit - 服务端按真实 Principal 计算的快照权限。
 * @returns 图像/视频显示对应价格与展示字段；只读时无保存和封面操作。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function getModelConfigurationDialogFields(
  entry: ModelConfigurationEntry,
  canEdit: boolean
): ModelConfigurationDialogFields {
  return {
    canSave: canEdit,
    showMarketplaceFields: true,
    showImagePricing: entry.category === "image",
    showVideoPricing: entry.category === "video",
    showCoverActions: canEdit,
  };
}

/**
 * 取得列表或 Dialog 封面的初始来源。
 *
 * @param entry - 当前条目。
 * @returns 服务端交付的封面 URL。
 * @sideEffects 无。
 * @failure DTO 保证真实模型 coverUrl 非空；防御性保留 null。
 */
export function getModelConfigurationCoverSource(
  entry: ModelConfigurationEntry
): string | null {
  return entry.coverUrl;
}

/**
 * 封面加载失败后只执行一次本地类别兜底。
 *
 * @param currentSource - 当前 img src。
 * @param category - 只允许有封面的 image 或 video。
 * @returns 自定义封面失败时返回本地默认封面；默认封面也失败时返回 null，调用方隐藏 img，
 * 防止 onError 无限重试。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function resolveModelConfigurationCoverAfterError(
  currentSource: string,
  category: "image" | "video"
): string | null {
  const fallback = getDefaultModelMarketplaceCoverPath(category);
  return currentSource === fallback ? null : fallback;
}
