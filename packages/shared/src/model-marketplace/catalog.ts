/**
 * 模型广场的 DB-free 目录规则。
 *
 * 使用方包括管理清单装配、公开目录和保存服务。本模块统一处理模型身份、初始条目、
 * 最低价、视频默认完整 ID、能力排序与写回执裁剪，不读取运行时设置或数据库。
 */
import {
  FIREFLY_VIDEO_MODEL_CATALOG,
  resolveFireflyVideoModel,
} from "../adobe/firefly-direct/video-catalog";
import {
  IMAGE_CREDIT_PRICE_FIELDS,
  normalizeImagePricingModelId,
} from "../image-backend/group-image-pricing";
import {
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
 * 从可调用视频完整 ID 解析聚合后的模型族。
 *
 * @param modelId - Firefly 完整 ID，或现有目录兼容的裸 Veo/Kling ID。
 * @returns 已知视频模型族；不能由运行时视频目录解析时返回 null。
 */
export function resolveModelMarketplaceVideoFamily(
  modelId: string | null | undefined
): string | null {
  return resolveFireflyVideoModel(modelId)?.family ?? null;
}

/**
 * 比较两个已解析视频候选项，固定默认模型的时长、比例、分辨率和最终 ID 优先级。
 *
 * @param left - 左侧候选项。
 * @param right - 右侧候选项。
 * @returns 小于零时左侧优先；排序不依赖目录对象插入顺序。
 */
function compareVideoDefaultCandidates(
  left: VideoDefaultCandidate,
  right: VideoDefaultCandidate
): number {
  const durationDifference = left.duration - right.duration;
  if (durationDifference !== 0) return durationDifference;

  const ratioDifference =
    getPreferenceIndex(left.aspectRatio, PREFERRED_ASPECT_RATIOS) -
    getPreferenceIndex(right.aspectRatio, PREFERRED_ASPECT_RATIOS);
  if (ratioDifference !== 0) return ratioDifference;

  const resolutionDifference =
    getResolutionNumber(right.outputResolution) -
    getResolutionNumber(left.outputResolution);
  if (resolutionDifference !== 0) return resolutionDifference;
  return left.modelId.localeCompare(right.modelId);
}

type VideoDefaultCandidate = {
  modelId: string;
  duration: number;
  aspectRatio: string;
  outputResolution: string;
};

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
 * @param resolution - 例如 720p、1080p 或未来未知标签。
 * @returns 可解析的正整数；未知格式返回零并由后续字典序兜底。
 */
function getResolutionNumber(resolution: string): number {
  const match = /^(\d+)p$/i.exec(resolution);
  return match ? Number(match[1]) : 0;
}

/**
 * 把兼容裸 ID 转成 Firefly 目录中的规范完整 ID。
 *
 * @param modelId - 运行时提供的候选 ID。
 * @returns 可在内置目录中定位的规范 ID；未知 ID 返回 null。
 */
function normalizeVideoCatalogModelId(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return null;
  if (Object.hasOwn(FIREFLY_VIDEO_MODEL_CATALOG, normalized)) {
    return normalized;
  }
  const prefixed = `firefly-${normalized}`;
  return Object.hasOwn(FIREFLY_VIDEO_MODEL_CATALOG, prefixed) ? prefixed : null;
}

/**
 * 为视频模型族稳定选择可复制、可预选的默认完整 ID。
 *
 * @param family - 聚合后的视频模型族。
 * @param availableModelIds - 可选的运行时可达完整 ID；缺省时使用全部内置目录。
 * @returns 最短时长、优先横屏、优先高分辨率的规范完整 ID；没有候选时返回 null。
 */
export function getStableVideoDefaultModelId(
  family: string,
  availableModelIds: readonly string[] = Object.keys(
    FIREFLY_VIDEO_MODEL_CATALOG
  )
): string | null {
  const candidates = availableModelIds.flatMap((modelId) => {
    const normalizedModelId = normalizeVideoCatalogModelId(modelId);
    if (!normalizedModelId) return [];
    const configuration = FIREFLY_VIDEO_MODEL_CATALOG[normalizedModelId];
    if (!configuration || configuration.family !== family) return [];
    return [
      {
        modelId: normalizedModelId,
        duration: configuration.duration,
        aspectRatio: configuration.aspectRatio,
        outputResolution: configuration.outputResolution,
      },
    ];
  });

  candidates.sort(compareVideoDefaultCandidates);
  return candidates[0]?.modelId ?? null;
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
 * @returns 与输入隔离的条目；新模型 revision 为 0 且默认展示。
 */
export function resolveModelMarketplaceEntry(
  entry: ModelMarketplaceEntry | undefined
): ModelMarketplaceEntry {
  if (!entry) {
    return {
      revision: 0,
      visible: true,
      description: "",
      cover: null,
    };
  }
  return {
    ...entry,
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
