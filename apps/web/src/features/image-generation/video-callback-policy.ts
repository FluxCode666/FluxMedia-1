/**
 * 视频回调投递的 DB-free 策略。
 *
 * 职责：构造独立投递记录插入值，并计算有限指数退避；供生产 worker 与 Vitest 共用。
 */

import type { videoGenerationCallbackDelivery } from "@repo/database/schema";
import { nanoid } from "nanoid";

const CALLBACK_MAX_ATTEMPTS = 8;
const CALLBACK_BASE_RETRY_MS = 30_000;
const CALLBACK_MAX_RETRY_MS = 15 * 60_000;

/** 视频创建事务使用的回调记录插入值。 */
export function createVideoCallbackDeliveryValues(input: {
  videoGenerationId: string;
  callbackUrl: string;
  now?: Date;
}): typeof videoGenerationCallbackDelivery.$inferInsert {
  const now = input.now ?? new Date();
  return {
    id: nanoid(),
    videoGenerationId: input.videoGenerationId,
    callbackUrl: input.callbackUrl,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** 计算有限指数退避；达到上限时返回 null 并进入 dead。 */
export function getVideoCallbackRetryAt(
  attemptCount: number,
  now: Date
): Date | null {
  if (attemptCount >= CALLBACK_MAX_ATTEMPTS) return null;
  const delayMs = Math.min(
    CALLBACK_BASE_RETRY_MS * 2 ** Math.max(0, attemptCount - 1),
    CALLBACK_MAX_RETRY_MS
  );
  return new Date(now.getTime() + delayMs);
}
