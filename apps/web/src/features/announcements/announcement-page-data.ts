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
  const raw = await requestGoJson<{
    records?: UserAnnouncementListOutput["records"];
    items?: UserAnnouncementListOutput["records"];
    page?: number;
    pageSize?: number;
    totalCount?: number;
    totalPages?: number;
  }>(`/api/announcements?page=${input.page}&pageSize=${input.pageSize}`);
  const items = raw.records ?? raw.items ?? [];
  return {
    records: items,
    page: raw.page ?? input.page,
    pageSize: raw.pageSize ?? input.pageSize,
    totalCount: raw.totalCount ?? items.length,
    totalPages: raw.totalPages ?? Math.max(1, Math.ceil((raw.totalCount ?? items.length) / input.pageSize)),
  };
}

/** 打开用户公告页后独立标记全部活跃公告已读。 */
export async function markAllMyAnnouncementsRead(
  _principal: AnnouncementPrincipalInput
): Promise<number> {
  const result = await requestGoJson<{ count?: number }>(
    "/api/announcements/read-all",
    { method: "POST", body: "{}" }
  );
  return result.count ?? 0;
}

/** 读取管理员公告分页与独立全局统计。 */
export async function loadAdminAnnouncementPage(
  _principal: AnnouncementPrincipalInput,
  input: AdminAnnouncementListInput
): Promise<AdminAnnouncementListOutput> {
  const raw = await requestGoJson<{
    records?: AdminAnnouncementListOutput["records"];
    items?: AdminAnnouncementListOutput["records"];
    page?: number;
    pageSize?: number;
    totalCount?: number;
    totalPages?: number;
    stats?: AdminAnnouncementListOutput["stats"];
  }>(`/api/admin/announcements?page=${input.page}&pageSize=${input.pageSize}&published=${input.published}`);
  const items = raw.records ?? raw.items ?? [];
  return {
    records: items,
    page: raw.page ?? input.page,
    pageSize: raw.pageSize ?? input.pageSize,
    totalCount: raw.totalCount ?? items.length,
    totalPages: raw.totalPages ?? Math.max(1, Math.ceil((raw.totalCount ?? items.length) / input.pageSize)),
    stats: raw.stats ?? { active: 0, drafts: 0, pinned: 0 },
  };
}
