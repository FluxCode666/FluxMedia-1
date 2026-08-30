/** 将模型 ID 转换为用户可读名称，同时兼容历史 Firefly 前缀数据。 */
export function formatModelIdForDisplay(modelId: string): string {
  return modelId.replace(/^firefly-/i, "");
}
