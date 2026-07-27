/**
 * 图片 UOL 的站内调用适配器。
 *
 * 职责：让 Web 与外部 HTTP 传输统一调用 `image.generate`，并把安全的 UOL URL
 * 输出还原为现有响应编码器使用的图片结果；不直接调用领域管线。
 * 使用方：站内 generate/edit 路由与外部 v1 generate/edit handlers。
 */

import { invokeOperation, type Principal } from "@repo/shared/uol";
import type {
  ImageGenerateOperationInput,
  ImageGenerateOperationOutput,
} from "@repo/shared/uol/operations/image-generation";

import { ensureUolInitialized } from "@/server/uol-init";

import type { ImageGenerationOperationResult } from "./operations";
import type { ImageGenerationCallbacks } from "./types";

/** 将不含内联 base64 的 UOL 输出映射回 HTTP 响应编码器的领域结果形状。 */
function toImageGenerationOperationResult(
  output: ImageGenerateOperationOutput
): ImageGenerationOperationResult {
  const primary =
    [...output.images]
      .reverse()
      .find((image) => image.outputRole === "final") ?? output.images.at(-1);
  return {
    generationId: output.generationId,
    ...(primary?.url ? { imageUrl: primary.url } : {}),
    imageOutputs: output.images.map((image) => ({
      imageUrl: image.url,
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      ...(image.size ? { size: image.size } : {}),
      ...(image.promptRepairNotice
        ? { promptRepairNotice: image.promptRepairNotice }
        : {}),
      ...(image.index !== undefined ? { index: image.index } : {}),
      ...(image.outputRole ? { outputRole: image.outputRole } : {}),
    })),
    ...(output.model ? { model: output.model } : {}),
    ...(output.size ? { size: output.size } : {}),
    ...(output.revisedPrompt ? { revisedPrompt: output.revisedPrompt } : {}),
    ...(output.promptRepairNotice
      ? { promptRepairNotice: output.promptRepairNotice }
      : {}),
    ...(output.creditsUsed !== undefined
      ? { creditsConsumed: output.creditsUsed }
      : {}),
  };
}

/**
 * 调用统一图片 operation。
 *
 * @param input 已由传输层解析为严格联合契约的领域输入。
 * @param principal 会话用户或外部 API Key 身份。
 * @param callbacks 仅在当前进程使用的 SSE 局部图回调，不进入持久输入。
 * @param requestId 可选请求关联 ID。
 * @returns 供既有 JSON/SSE 编码器消费的图片结果。
 * @throws UOL 权限、能力、幂等、领域或输出校验错误。
 */
export async function invokeImageGenerationOperation(
  input: ImageGenerateOperationInput,
  principal: Principal,
  callbacks?: ImageGenerationCallbacks,
  requestId?: string
): Promise<ImageGenerationOperationResult> {
  await ensureUolInitialized();
  const operationContext = {
    ...(requestId ? { requestId } : {}),
    ...(callbacks?.onPartialImage
      ? { callbacks: { onPartialImage: callbacks.onPartialImage } }
      : {}),
  };
  const output = await invokeOperation<ImageGenerateOperationOutput>(
    "image.generate",
    input,
    principal,
    operationContext
  );
  return toImageGenerationOperationResult(output);
}
