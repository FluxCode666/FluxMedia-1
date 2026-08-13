/**
 * 模型运行时启用状态的 DB-free 判定规则。
 *
 * 使用方包括图片与视频生成管线、公开模型目录和站内创作页目录。
 * 本模块只解释已严格解析的 MODEL_MARKETPLACE_CONFIG，不读取数据库或运行时设置。
 */
import {
  type ModelMarketplaceConfig,
  type ModelMarketplaceConfigurationCategory,
  type ModelMarketplaceEntry,
} from "./contracts";
import {
  normalizeModelMarketplaceImageConfigKey,
  resolveModelMarketplaceVideoFamily,
} from "./catalog";

/**
 * 判断单条模型配置是否允许运行时暴露和调用。
 *
 * @param entry - 可选的持久化模型条目；缺失表示尚未由管理员显式配置。
 * @returns 旧配置缺少 enabled 时默认 true，仅显式 false 停用。
 * @sideEffects 无。
 * @failure 不抛错；严格配置解析由上游负责。
 */
export function isModelMarketplaceEntryEnabled(
  entry: ModelMarketplaceEntry | undefined
): boolean {
  return entry?.enabled ?? true;
}

/**
 * 按媒体类别和运行时模型 ID 判断模型是否启用。
 *
 * @param config - 已经 parseModelMarketplaceConfig 验证的完整配置。
 * @param category - 图片或视频。
 * @param modelId - 请求、成员目录或公开目录中的模型 ID。
 * @returns 命中显式停用条目时为 false；缺少条目与旧配置默认 true。
 * @sideEffects 无。
 * @failure 空或无法规范化的模型 ID 安全返回 false。
 */
export function isModelMarketplaceModelEnabled(
  config: ModelMarketplaceConfig,
  category: ModelMarketplaceConfigurationCategory,
  modelId: string
): boolean {
  const normalizedId =
    category === "image"
      ? normalizeModelMarketplaceImageConfigKey(modelId)
      : (resolveModelMarketplaceVideoFamily(modelId) ??
        modelId.trim().toLowerCase());
  if (!normalizedId || normalizedId === "default") return false;
  const entry =
    category === "image"
      ? config.imageByModel[normalizedId]
      : config.videoByFamily[normalizedId];
  return isModelMarketplaceEntryEnabled(entry);
}
