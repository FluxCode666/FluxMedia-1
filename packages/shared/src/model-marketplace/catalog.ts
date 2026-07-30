/**
 * 模型广场的 DB-free 目录规则。
 *
 * 使用方包括管理清单装配、公开目录和保存服务。本模块统一处理模型身份、初始条目、
 * 最低价、视频能力排序与写回执裁剪，不读取运行时设置或数据库。
 */
import {
  IMAGE_CREDIT_PRICE_FIELDS,
  normalizeImagePricingModelId,
} from "../image-backend/group-image-pricing";
import { normalizeVideoModelId } from "../video-generation";
import {
  DEFAULT_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY,
  MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS,
  type ModelMarketplaceConfigurationCategory,
  type ModelMarketplaceEntry,
  type ModelMarketplaceImagePricing,
  type ModelMarketplaceWriteReceipt,
} from "./contracts";

const WRITE_RECEIPT_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;
const PREFERRED_ASPECT_RATIOS = ["16:9", "9:16"] as const;

/**
 * 把图像运行时 ID 规范化为与全局计价一致的配置键。
 *
 * @param modelId - 完整图像模型 ID 或持久化价格键。
 * @returns 去空白、小写且移除 firefly- 前缀的键；空值返回 null。
 */
export function normalizeModelMarketplaceImageConfigKey(
  modelId: string | null | undefined
): string | null {
  return normalizeImagePricingModelId(modelId);
}

/**
 * 从运行时视频身份解析真实模型 ID。
 *
 * @param modelId - 账号池或运行时返回的真实模型 ID。
 * @returns 已知真实视频模型 ID；复合身份、前缀、别名和未知值返回 null。
 */
export function resolveModelMarketplaceVideoFamily(
  modelId: string | null | undefined
): string | null {
  return normalizeVideoModelId(modelId);
}

/**
 * 返回值在偏好数组中的稳定序号，未知值统一排在已知值之后。
 *
 * @param value - 需要排序的能力值。
 * @param preferredValues - 按优先级排列的只读数组。
 * @returns 从零开始的偏好序号；未知值返回数组长度。
 */
function getPreferenceIndex(
  value: string,
  preferredValues: readonly string[]
): number {
  const index = preferredValues.indexOf(value);
  return index === -1 ? preferredValues.length : index;
}

/**
 * 从分辨率字符串读取纵向像素，用于默认项和能力列表的数值排序。
 *
 * @param resolution - 例如 720p、1080p、4k 或未来未知标签。
 * @returns 可解析的正整数；未知格式返回零并由后续字典序兜底。
 */
function getResolutionNumber(resolution: string): number {
  if (resolution.trim().toLowerCase() === "4k") return 2160;
  const match = /^(\d+)p$/i.exec(resolution);
  return match ? Number(match[1]) : 0;
}

/**
 * 计算图像四档完整价格中的最低单张积分。
 *
 * @param pricing - 已由严格财务 schema 校验的完整四档价格。
 * @returns 四档价格的最小值。
 */
export function getMinimumImageCredits(
  pricing: ModelMarketplaceImagePricing
): number {
  return Math.min(...IMAGE_CREDIT_PRICE_FIELDS.map((field) => pricing[field]));
}

/**
 * 解析缺失展示配置时的默认模型条目。
 *
 * @param entry - 持久化的显式条目，缺失代表新模型。
 * @param category - 用于兼容默认值：图像延续首页展示，视频默认关闭首页展示。
 * @returns 与输入隔离并补齐首页字段的条目；首页优先级缺失时为 5。
 */
export function resolveModelMarketplaceEntry(
  entry: ModelMarketplaceEntry | undefined,
  category: ModelMarketplaceConfigurationCategory
): Omit<ModelMarketplaceEntry, "homepageVisible" | "homepagePriority"> & {
  homepageVisible: boolean;
  homepagePriority: number;
} {
  if (!entry) {
    return {
      revision: 0,
      visible: true,
      homepageVisible: category === "image",
      homepagePriority: DEFAULT_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY,
      description: "",
      cover: null,
    };
  }
  return {
    ...entry,
    homepageVisible:
      entry.visible && (entry.homepageVisible ?? category === "image"),
    homepagePriority:
      entry.homepagePriority ?? DEFAULT_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY,
    cover: entry.cover ? { ...entry.cover } : null,
  };
}

/**
 * 判断条目是否允许进入公开模型目录。
 *
 * @param entry - 可选的显式展示配置。
 * @param _category - 模型配置类别；保留参数以约束调用方只能传真实模型类别。
 * @param configKey - 规范模型键。
 * @returns default 始终为 false；其余真实模型缺配置时默认 true。
 */
export function isModelMarketplaceEntryVisible(
  entry: ModelMarketplaceEntry | undefined,
  _category: ModelMarketplaceConfigurationCategory,
  configKey: string
): boolean {
  if (configKey.toLowerCase() === "default") return false;
  return entry?.visible ?? true;
}

/**
 * 对视频时长去重并按数值升序输出。
 *
 * @param durations - 一个或多个运行时目录提供的秒数。
 * @returns 只含有限正数的稳定升序新数组。
 */
export function sortUniqueDurations(durations: readonly number[]): number[] {
  return [
    ...new Set(
      durations.filter((value) => Number.isFinite(value) && value > 0)
    ),
  ].sort((left, right) => left - right);
}

/**
 * 对视频比例去空白、去重，并按常用横屏、竖屏、其他值的顺序输出。
 *
 * @param aspectRatios - 运行时目录提供的比例标签。
 * @returns 稳定排序的新数组，空字符串会被丢弃。
 */
export function sortUniqueAspectRatios(
  aspectRatios: readonly string[]
): string[] {
  return [
    ...new Set(aspectRatios.map((value) => value.trim()).filter(Boolean)),
  ].sort((left, right) => {
    const preferenceDifference =
      getPreferenceIndex(left, PREFERRED_ASPECT_RATIOS) -
      getPreferenceIndex(right, PREFERRED_ASPECT_RATIOS);
    return preferenceDifference || left.localeCompare(right);
  });
}

/**
 * 对视频分辨率去空白、去重，并按像素从低到高稳定输出。
 *
 * @param resolutions - 运行时目录提供的分辨率标签。
 * @returns 稳定排序的新数组，未知格式在已知数值后按字典序排列。
 */
export function sortUniqueVideoResolutions(
  resolutions: readonly string[]
): string[] {
  return [
    ...new Set(resolutions.map((value) => value.trim()).filter(Boolean)),
  ].sort((left, right) => {
    const leftNumber = getResolutionNumber(left);
    const rightNumber = getResolutionNumber(right);
    if (leftNumber === 0 && rightNumber !== 0) return 1;
    if (leftNumber !== 0 && rightNumber === 0) return -1;
    return leftNumber - rightNumber || left.localeCompare(right);
  });
}

/**
 * 按 24 小时与 256 条上限裁剪模型配置写回执。
 *
 * @param receipts - 当前事务锁定配置中的回执记录。
 * @param now - 服务注入的当前时间，避免测试依赖系统时钟。
 * @returns 先保留最新回执，再按完成时间与键稳定升序编码的新记录。
 */
export function pruneModelMarketplaceWriteReceipts(
  receipts: Readonly<Record<string, ModelMarketplaceWriteReceipt>>,
  now: Date
): Record<string, ModelMarketplaceWriteReceipt> {
  const cutoff = now.getTime() - WRITE_RECEIPT_RETENTION_MILLISECONDS;
  const retained = Object.entries(receipts)
    .map(([key, receipt]) => ({
      key,
      receipt,
      completedAt: Date.parse(receipt.completedAt),
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.completedAt) && entry.completedAt > cutoff
    )
    .sort(
      (left, right) =>
        right.completedAt - left.completedAt ||
        left.key.localeCompare(right.key)
    )
    .slice(0, MAX_MODEL_MARKETPLACE_WRITE_RECEIPTS)
    .sort(
      (left, right) =>
        left.completedAt - right.completedAt ||
        left.key.localeCompare(right.key)
    );

  return Object.fromEntries(
    retained.map(({ key, receipt }) => [key, { ...receipt }])
  );
}
