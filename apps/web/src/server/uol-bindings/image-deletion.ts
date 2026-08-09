/**
 * 图片媒体删除 UOL bindings。
 *
 * 使用方：站内单项与批量删除 Server Action。binding 只从 Principal 取得用户身份并
 * 委托删除服务；服务按 user_id 查询，跨用户 ID 与不存在 ID 均不会产生副作用。
 */

import type { OperationContext } from "@repo/shared/uol";
import { bindExecute, OperationError, type Principal } from "@repo/shared/uol";
import {
  deleteGenerationMediaForUser,
  readGenerationOwnerId,
} from "@/features/image-generation/generation-deletion-service";

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
    const ownerId = await readGenerationOwnerId(input.generationId);
    if (!ownerId) return { success: true };
    context.assertOwnership("generation", ownerId);
    await deleteGenerationMediaForUser({
      userId: requireSessionUserId(principal),
      generationIds: [input.generationId],
    });
    return { success: true };
  }
);

/** 绑定批量媒体删除；返回本人实际命中的 generation 数。 */
bindExecute(
  "image.batchDelete",
  async (input: { generationIds: string[] }, principal: Principal) => {
    const result = await deleteGenerationMediaForUser({
      userId: requireSessionUserId(principal),
      generationIds: input.generationIds,
    });
    return { success: true, deletedCount: result.deletedCount };
  }
);
