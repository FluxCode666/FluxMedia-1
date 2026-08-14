/**
 * 视频生成调用的模型启用保护。
 *
 * 使用方是 video.generate UOL binding；本模块只解释已验证的
 * MODEL_MARKETPLACE_CONFIG 并抛出稳定 UOL 错误，不读数据库或创建任务。
 */
import {
  isModelMarketplaceModelEnabled,
  type ModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import { OperationError } from "@repo/shared/uol";

/**
 * 在视频输入转存、任务创建与计费前拒绝停用模型。
 *
 * @param config - 已由 parseModelMarketplaceConfig 严格验证的完整配置。
 * @param modelId - 内置真实视频 ID 或自定义视频 ID。
 * @returns 模型启用时完成，无返回值。
 * @sideEffects 无。
 * @throws OperationError 模型显式停用时返回稳定 validation_error。
 */
export function assertVideoModelEnabled(
  config: ModelMarketplaceConfig,
  modelId: string
): void {
  if (isModelMarketplaceModelEnabled(config, "video", modelId)) return;
  throw new OperationError("validation_error", "视频模型当前未启用", {
    field: "model",
    reason: "model_disabled",
  });
}
