/**
 * 管理员公告分页入口。
 *
 * 页面校验会话与管理权限，解析 URL 分页/发布筛选，并通过 human-only UOL 读取
 * 精确总数、当前页和独立全局统计；失败交由管理组件展示可重试错误态。
 */

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { AdminAnnouncementsManagement } from "@/features/announcements/admin-announcements-management";
import { loadAdminAnnouncementPage } from "@/features/announcements/announcement-page-data";
import {
  type AnnouncementSearchParams,
  buildAdminAnnouncementHref,
  parseAdminAnnouncementQuery,
} from "@/features/announcements/announcement-pagination";

type DashboardAdminAnnouncementsPageProps = {
  searchParams: Promise<AnnouncementSearchParams>;
};

/** 渲染 URL 驱动的管理公告分页。 */
export default async function DashboardAdminAnnouncementsPage({
  searchParams,
}: DashboardAdminAnnouncementsPageProps) {
  const [session, locale, rawSearchParams] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const query = parseAdminAnnouncementQuery(rawSearchParams);
  const [announcementResult, timeZoneResult] = await Promise.allSettled([
    loadAdminAnnouncementPage({ userId: session.user.id, role }, query),
    getUserTimeZone(session.user.id),
  ]);
  const announcementPage =
    announcementResult.status === "fulfilled" ? announcementResult.value : null;

  if (announcementPage && announcementPage.page !== query.page) {
    redirect(
      `/${locale}${buildAdminAnnouncementHref({
        ...query,
        page: announcementPage.page,
        pageSize: announcementPage.pageSize as 10 | 20 | 50,
      })}`
    );
  }

  return (
    <AdminAnnouncementsManagement
      data={announcementPage}
      query={query}
      retryHref={buildAdminAnnouncementHref(query)}
      timeZone={
        timeZoneResult.status === "fulfilled" ? timeZoneResult.value : "UTC"
      }
    />
  );
}
