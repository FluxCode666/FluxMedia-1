/**
 * 图片生成单一管线的模型启用保护。
 *
 * 使用方是 operations.ts 和 DB-free 单测；设置读取通过参数注入，
 * 本模块不导入数据库、存储、计费或上游图片服务。
 */
import {
  isModelMarketplaceModelEnabled,
  normalizeModelMarketplaceImageConfigKey,
  parseModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import { OperationError } from "@repo/shared/uol";

/**
 * 在准入、扣费或上游调用前校验图片模型运行时开关。
 *
 * @param modelId - 已清理首尾空白的图片模型能力键。
 * @param loadMarketplaceConfig - 读取 MODEL_MARKETPLACE_CONFIG 的可注入端口。
 * @returns 模型启用时返回质量与 auto 尺寸能力；未配置时默认都不接受。
 * @sideEffects 调用一次设置读取端口。
 * @throws OperationError 模型显式停用时返回稳定 validation_error。
 */
export type ImageModelRuntimeCapabilities = {
  supportsQuality: boolean;
  supportsAutoSize: boolean;
};

export async function assertImageModelEnabled(
  modelId: string,
  loadMarketplaceConfig: () => Promise<unknown>,
  requestedResolution?: string,
  requestedAutoSize = false
): Promise<ImageModelRuntimeCapabilities> {
  const marketplaceConfig = parseModelMarketplaceConfig(
    await loadMarketplaceConfig()
  );
  if (isModelMarketplaceModelEnabled(marketplaceConfig, "image", modelId)) {
    const configKey =
      normalizeModelMarketplaceImageConfigKey(modelId) ?? modelId.toLowerCase();
    const configuredEntry = marketplaceConfig.imageByModel[configKey];
    const customEntry = marketplaceConfig.customModels.find(
      (model) =>
        model.category === "image" &&
        model.modelId.toLowerCase() === modelId.toLowerCase()
    );
    if (requestedResolution) {
      const configured = configuredEntry?.supportedResolutions;
      const custom = customEntry?.supportedResolutions;
      const supported = configured ?? custom ?? ["1k", "2k", "4k", "8k"];
      if (!supported.includes(requestedResolution)) {
        throw new OperationError(
          "validation_error",
          "图片模型不支持所请求的分辨率",
          {
            field: "size",
            reason: "unsupported_resolution",
          }
        );
      }
    }
    const supportsAutoSize =
      (configuredEntry?.supportsAutoSize ?? customEntry?.supportsAutoSize) ===
      true;
    if (requestedAutoSize && !supportsAutoSize) {
      throw new OperationError(
        "validation_error",
        "当前图片模型不支持传递 auto 尺寸，请选择明确尺寸",
        {
          field: "size",
          reason: "unsupported_auto_size",
        }
      );
    }
    return {
      supportsQuality:
        (configuredEntry?.supportsQuality ?? customEntry?.supportsQuality) ===
        true,
      supportsAutoSize,
    };
  }
  throw new OperationError("validation_error", "图片模型当前未启用", {
    field: "model",
    reason: "model_disabled",
  });
}
