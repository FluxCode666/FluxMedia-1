/**
 * Adobe 模型 ID 的展示格式化。
 *
 * 使用方：站内用户与管理端界面。新运行时目录已经使用裸 ID；本模块继续兼容展示历史
 * 记录中带有 `firefly-` 的旧模型 ID。
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
