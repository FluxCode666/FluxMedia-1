/** Pure persisted lease decoding; no Redis client or runtime dependency. */
import { createHash } from "node:crypto";
const USER_SLOT_KEY_PREFIX="fluxmedia:v1:image-generation:slots:{image-generation}:user:";
export type RedisImageGenerationAdmissionLease = {
  token: string;
  userKey: string;
  expiresAt: number;
};

/** 将外部用户 ID 散列为固定长度 Redis key，避免原始标识进入运维键空间。 */
export function getUserSlotKey(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex");
  return `${USER_SLOT_KEY_PREFIX}${digest}`;
}

/** 从持久 token 和用户身份重建不暴露原始用户 ID 的准入租约。 */
export function restoreImageGenerationAdmissionLease(input: {
  userId: string;
  token: string;
  expiresAt: Date | number;
}): RedisImageGenerationAdmissionLease {
  const expiresAt =
    input.expiresAt instanceof Date
      ? input.expiresAt.getTime()
      : input.expiresAt;
  if (
    !input.token.trim() ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    throw new Error("Invalid persisted image admission lease");
  }
  return {
    token: input.token,
    userKey: getUserSlotKey(input.userId),
    expiresAt,
  };
}
