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
import { requestGoJson } from "@/server/go-backend-client";

type AnnouncementPrincipalInput = {
  userId: string;
  role: AppUserRole;
};

/** 读取当前用户的完整公告分页。 */
export async function loadMyAnnouncementPage(
  _principal: AnnouncementPrincipalInput,
  input: UserAnnouncementListInput
): Promise<UserAnnouncementListOutput> {
  const raw = await requestGoJson<{ items: UserAnnouncementListOutput["records"] }>("/api/announcements");
  const items = raw.items ?? [];
  const start = (input.page - 1) * input.pageSize;
  return { records: items.slice(start, start + input.pageSize), page: input.page, pageSize: input.pageSize, totalCount: items.length, totalPages: Math.max(1, Math.ceil(items.length / input.pageSize)) };
}

/** 打开用户公告页后独立标记全部活跃公告已读。 */
export async function markAllMyAnnouncementsRead(
  _principal: AnnouncementPrincipalInput
): Promise<number> {
  const result = await requestGoJson<{ count?: number }>("/api/announcements/read-all", { method: "POST", body: "{}" });
  return result.count ?? 0;
}

/** 读取管理员公告分页与独立全局统计。 */
export async function loadAdminAnnouncementPage(
  _principal: AnnouncementPrincipalInput,
  input: AdminAnnouncementListInput
): Promise<AdminAnnouncementListOutput> {
  const raw = await requestGoJson<{ items: AdminAnnouncementListOutput["records"] }>("/api/admin/announcements");
  let items = raw.items ?? [];
  if (input.published === "published") items = items.filter((item) => item.isPublished);
  if (input.published === "unpublished") items = items.filter((item) => !item.isPublished);
  const start = (input.page - 1) * input.pageSize;
  const active = (raw.items ?? []).filter((item) => item.isPublished).length;
  const pinned = (raw.items ?? []).filter((item) => item.isPinned).length;
  return { records: items.slice(start, start + input.pageSize), page: input.page, pageSize: input.pageSize, totalCount: items.length, totalPages: Math.max(1, Math.ceil(items.length / input.pageSize)), stats: { active, drafts: (raw.items ?? []).length - active, pinned } };
}
