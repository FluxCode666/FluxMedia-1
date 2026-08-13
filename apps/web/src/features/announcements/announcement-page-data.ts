/**
 * 公告页面的 UOL 数据适配器。
 *
 * 使用方：用户公告 Server Component 与管理员公告 Server Component。模块只负责
 * 初始化 UOL、构造真实 session Principal，并返回严格分页 DTO。
 */

import type {
  AdminAnnouncementListInput,
  AdminAnnouncementListOutput,
  UserAnnouncementListInput,
  UserAnnouncementListOutput,
} from "@repo/shared/announcements/list-contract";
import type { AppUserRole } from "@repo/shared/auth/roles";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

type AnnouncementPrincipalInput = {
  userId: string;
  role: AppUserRole;
};

/** 读取当前用户的完整公告分页。 */
export async function loadMyAnnouncementPage(
  principal: AnnouncementPrincipalInput,
  input: UserAnnouncementListInput
): Promise<UserAnnouncementListOutput> {
  await ensureUolInitialized();
  return invokeOperation<UserAnnouncementListOutput>(
    "support.listMyAnnouncementPage",
    input,
    { type: "user", ...principal }
  );
}

/** 打开用户公告页后独立标记全部活跃公告已读。 */
export async function markAllMyAnnouncementsRead(
  principal: AnnouncementPrincipalInput
): Promise<number> {
  await ensureUolInitialized();
  const result = await invokeOperation<{
    success: boolean;
    markedCount: number;
  }>("support.markAllAnnouncementsRead", {}, { type: "user", ...principal });
  return result.markedCount;
}

/** 读取管理员公告分页与独立全局统计。 */
export async function loadAdminAnnouncementPage(
  principal: AnnouncementPrincipalInput,
  input: AdminAnnouncementListInput
): Promise<AdminAnnouncementListOutput> {
  await ensureUolInitialized();
  return invokeOperation<AdminAnnouncementListOutput>(
    "support.listAdminAnnouncementPage",
    input,
    { type: "user", ...principal }
  );
}
