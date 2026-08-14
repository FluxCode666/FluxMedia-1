/**
 * UOL 媒体策略错误映射。
 *
 * 职责：把共享媒体领域的安全校验错误转换为稳定 validation_error，供图片同步、
 * 图片异步和视频 binding 共用；未知错误由调用方保持原样上抛。
 */
import { MediaInputPolicyValidationError } from "@repo/shared/image-generation/media-contract";
import { OperationError } from "@repo/shared/uol";

/**
 * 将媒体策略领域错误转换为 UOL 错误。
 *
 * @param error - binding 捕获的未知异常。
 * @returns 已知媒体策略错误对应的 validation_error；其他异常返回 null。
 * @sideEffects 无。
 */
export function getMediaInputPolicyOperationError(
  error: unknown
): OperationError | null {
  if (!(error instanceof MediaInputPolicyValidationError)) return null;
  return new OperationError("validation_error", error.message, {
    maxFileSizeMb: error.maxFileSizeMb,
    maxInputCount: error.maxInputCount,
    maxUploadSizeMb: error.maxUploadSizeMb,
  });
}
