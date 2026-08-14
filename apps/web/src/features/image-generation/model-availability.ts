/**
 * 图片生成单一管线的模型启用保护。
 *
 * 使用方是 operations.ts 和 DB-free 单测；设置读取通过参数注入，
 * 本模块不导入数据库、存储、计费或上游图片服务。
 */
import {
  isModelMarketplaceModelEnabled,
  parseModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import { OperationError } from "@repo/shared/uol";

/**
 * 在准入、扣费或上游调用前校验图片模型运行时开关。
 *
 * @param modelId - 已清理首尾空白的图片模型能力键。
 * @param loadMarketplaceConfig - 读取 MODEL_MARKETPLACE_CONFIG 的可注入端口。
 * @returns 模型启用时完成，无返回值。
 * @sideEffects 调用一次设置读取端口。
 * @throws OperationError 模型显式停用时返回稳定 validation_error。
 */
export async function assertImageModelEnabled(
  modelId: string,
  loadMarketplaceConfig: () => Promise<unknown>
): Promise<void> {
  const marketplaceConfig = parseModelMarketplaceConfig(
    await loadMarketplaceConfig()
  );
  if (isModelMarketplaceModelEnabled(marketplaceConfig, "image", modelId)) {
    return;
  }
  throw new OperationError("validation_error", "图片模型当前未启用", {
    field: "model",
    reason: "model_disabled",
  });
}
