/**
 * 统一媒体调度请求模型的纯规范化边界。
 *
 * 使用方：runtime-service 在访问数据库前固定调度身份。图像保持既有任意真实模型 ID
 * 语义；视频只接受全局目录中的真实 ID，不解析供应商前缀、参数复合 ID或历史别名。
 */
import { normalizeVideoModelId } from "@repo/shared/video-generation";

/**
 * 规范一次运行时调度请求的模型 ID。
 *
 * @param input - 请求媒体类型和调用方提供的模型身份。
 * @returns 图像返回 trim 后 ID；视频返回规范小写真实 ID；非法或旧视频身份返回 null。
 * @sideEffects 无。
 * @failure 不抛错，调用方负责映射为稳定调度错误。
 */
export function normalizeRuntimeRequestedModelId(input: {
  requestKind: "image" | "video";
  modelId: string;
}): string | null {
  if (input.requestKind === "video") {
    return normalizeVideoModelId(input.modelId);
  }
  const modelId = input.modelId.trim();
  return modelId || null;
}
