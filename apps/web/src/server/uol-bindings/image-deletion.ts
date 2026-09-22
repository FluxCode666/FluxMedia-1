/**
 * 图片媒体删除 UOL bindings。
 *
 * 使用方：站内单项与批量删除 Server Action。binding 只从 Principal 取得用户身份并
 * 委托删除服务；服务按 user_id 查询，跨用户 ID 与不存在 ID 均不会产生副作用。
 */

import type { OperationContext } from "@repo/shared/uol";
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";
import { requestGoJson, GoBackendRequestError } from "@/server/go-backend-client";

/** 从站内会话 Principal 读取用户 ID，拒绝 API Key 与系统身份调用画廊删除。 */
function requireSessionUserId(principal: Principal): string {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  return principal.userId;
}

/** 绑定单项媒体删除；重复删除保持成功。 */
bindExecute(
  "image.delete",
  async (
    input: { generationId: string },
    principal: Principal,
    context: OperationContext
  ) => {
    // The Go history endpoint owns the row lookup, object deletion and
    // tombstone update. Keep the UOL ownership assertion at the principal
    // boundary while avoiding a second Next.js database read.
    requireSessionUserId(principal);
    void context;
    try {
      return await requestGoJson<{ success: boolean }>(
        "/api/image-generation/delete",
        { method: "POST", body: JSON.stringify(input) }
      );
    } catch (error) {
      if (error instanceof GoBackendRequestError && error.status === 404) {
        return { success: true };
      }
      throw error;
    }
  }
);

/** 绑定批量媒体删除；返回本人实际命中的 generation 数。 */
bindExecute(
  "image.batchDelete",
  async (input: { generationIds: string[] }, principal: Principal) => {
    requireSessionUserId(principal);
    return await requestGoJson<{ success: boolean; deletedCount: number }>(
      "/api/image-generation/batch-delete",
      { method: "POST", body: JSON.stringify(input) }
    );
  }
);
