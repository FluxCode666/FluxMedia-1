/**
 * 生成业务的稳定计费操作上下文构造器。
 *
 * 图片与视频管线在任务 ID 分配时各调用一次，并将返回值复用给该任务的
 * 初扣、补扣和退款。sourceRef 不参与构造。
 */

import type { CreditOperationContext } from "@repo/shared/credits/usage-read-model";

/** 校验业务任务 ID 和创建时间，并返回防御性时间副本。 */
function createGenerationCreditOperation(
  operationType: string,
  operationId: string,
  operationCreatedAt: Date
): CreditOperationContext {
  if (!operationId.trim()) {
    throw new RangeError("operationId must not be empty");
  }
  if (Number.isNaN(operationCreatedAt.getTime())) {
    throw new RangeError("operationCreatedAt must be a valid date");
  }
  return {
    operationType,
    operationId: operationId.trim(),
    operationCreatedAt: new Date(operationCreatedAt),
  };
}

/** 创建统一的图片生成与编辑计费操作。 */
export function createImageCreditOperation(
  generationId: string,
  operationCreatedAt: Date
): CreditOperationContext {
  return createGenerationCreditOperation(
    "image_generation",
    generationId,
    operationCreatedAt
  );
}

/** 创建与 video_generation 权威行共用 ID/时间的计费操作。 */
export function createVideoCreditOperation(
  videoGenerationId: string,
  operationCreatedAt: Date
): CreditOperationContext {
  return createGenerationCreditOperation(
    "video_generation",
    videoGenerationId,
    operationCreatedAt
  );
}
