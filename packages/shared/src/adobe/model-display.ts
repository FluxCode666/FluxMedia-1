/**
 * Adobe 模型 ID 的展示格式化。
 *
 * 使用方：站内用户与管理端界面。运行时路由、持久化和外部 API 必须继续使用完整模型 ID，
 * 因为 `firefly-` 仍是 Adobe 兼容协议的一部分；本模块只负责移除界面上的技术前缀。
 */

const ADOBE_MODEL_DISPLAY_PREFIX = /^firefly-/i;

/**
 * 将内部 Adobe 模型 ID 转换为无技术前缀的界面名称。
 *
 * @param modelId - 原始模型 ID，可以是图像或视频模型 ID。
 * @returns 仅剥离开头 `firefly-` 后的名称；其他 ID 与空字符串保持不变。
 * @sideEffects 无。
 */
export function formatAdobeModelIdForDisplay(modelId: string): string {
  return modelId.replace(ADOBE_MODEL_DISPLAY_PREFIX, "");
}
