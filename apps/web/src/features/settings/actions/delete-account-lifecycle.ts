/**
 * 账号删除前的视频输入生命周期适配器。
 *
 * 职责：构造当前 session 的可信 user Principal，并经 UOL 幂等登记视频输入清理
 * 意图；不修改用户、会话或订阅状态。
 * 使用方：delete-account.ts 与 DB-free 顺序测试。
 */
import { invokeOperation, type Principal } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

const ACCOUNT_DELETE_VIDEO_CLEANUP_REQUEST_ID =
  "delete-account-video-inputs-v1";

/** 测试可替换的 UOL 初始化、角色读取和调用端口。 */
export interface DeleteAccountLifecycleDependencies {
  ensureInitialized(): Promise<void>;
  getRole(
    userId: string
  ): Promise<Extract<Principal, { type: "user" }>["role"]>;
  invoke(
    name: "video.requestAccountInputCleanup",
    input: { clientRequestId: string },
    principal: Extract<Principal, { type: "user" }>
  ): Promise<unknown>;
}

const defaultDependencies: DeleteAccountLifecycleDependencies = {
  ensureInitialized: ensureUolInitialized,
  async getRole(userId) {
    const { getUserRoleById } = await import("@repo/shared/auth/role-server");
    return getUserRoleById(userId);
  },
  async invoke(name, input, principal) {
    return invokeOperation(name, input, principal);
  },
};

/**
 * 在任何账号失效写入前登记视频输入清理意图。
 *
 * @param userId 当前受保护 session 的用户 ID。
 * @param dependencies UOL 调用依赖；生产默认使用真实网关。
 * @returns UOL 输出；调用方只关心成功或显式失败。
 * @sideEffects 初始化 UOL 并写入持久清理队列。
 * @throws 登记失败时原样抛出，调用方不得继续失效账号。
 */
export async function requestVideoInputCleanupBeforeAccountDeletion(
  userId: string,
  dependencies: DeleteAccountLifecycleDependencies = defaultDependencies
): Promise<unknown> {
  await dependencies.ensureInitialized();
  return dependencies.invoke(
    "video.requestAccountInputCleanup",
    { clientRequestId: ACCOUNT_DELETE_VIDEO_CLEANUP_REQUEST_ID },
    { type: "user", userId, role: await dependencies.getRole(userId) }
  );
}
