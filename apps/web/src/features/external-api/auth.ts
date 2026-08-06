/**
 * 外接 API Key 请求认证器。
 *
 * 仅返回身份与额度事实；审核和持久化策略由系统与管理员配置统一解析，
 * 不再从 API Key 读取或暴露用户可控治理字段。
 */

import { db } from "@repo/database";
import { externalApiKey, user } from "@repo/database/schema";
import { and, eq } from "drizzle-orm";

import { getBearerToken, hashApiKey, safeEqual } from "./auth-token";

/**
 * 验证请求中的 Bearer API Key 并加载所属用户状态。
 *
 * @param request 外接 API 请求。
 * @returns 有效 key 的认证上下文，无凭据、禁用 key 或封禁用户返回 null。
 * 成功时更新 key 的最后使用时间；数据库异常向上抛出。
 */
export async function authenticateExternalApiRequest(request: Request) {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  const keyHash = hashApiKey(token);
  const keys = await db
    .select({
      id: externalApiKey.id,
      userId: externalApiKey.userId,
      keyHash: externalApiKey.keyHash,
      creditLimit: externalApiKey.creditLimit,
      creditsUsed: externalApiKey.creditsUsed,
      userBanned: user.banned,
    })
    .from(externalApiKey)
    .innerJoin(user, eq(user.id, externalApiKey.userId))
    .where(
      and(
        eq(externalApiKey.keyHash, keyHash),
        eq(externalApiKey.isActive, true)
      )
    )
    .limit(1);

  const apiKey = keys[0];
  if (!apiKey || apiKey.userBanned || !safeEqual(keyHash, apiKey.keyHash)) {
    return null;
  }

  await db
    .update(externalApiKey)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(externalApiKey.id, apiKey.id));

  return {
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    creditLimit: apiKey.creditLimit ?? null,
    creditsUsed: Number(apiKey.creditsUsed || 0),
  };
}
