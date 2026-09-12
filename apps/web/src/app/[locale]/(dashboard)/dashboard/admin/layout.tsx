import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { canViewImageBackendPool, normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";

/**
 * Admin 段集中式守卫布局（审计 M-H5）。
 *
 * 职责：作为 /dashboard/admin 下所有子页的统一前置门，未登录跳登录、
 * 无权限跳 dashboard。使新增 admin 子页默认受守卫，杜绝因忘记复制
 * 页内守卫样板而越权暴露（M-H5 残留：守卫逻辑此前散落各 page、无集中兜底）。
 *
 * 关于粗粒度门的选择（WHY）：本布局只做"是否可进 admin 区"的粗粒度判定，
 * 细粒度能力（如 settings 仅超管可写、users 角色管理等）仍由各 page 自行判定，
 * 保留为双重保险，本单元不删除 page 内守卫以避免回归。
 *
 * 为何用 canViewImageBackendPool 而非 canAccessAdminArea：
 * status 与 settings 子页当前对 observer_admin 开放（经 canViewImageBackendPool，
 * settings 对 observer_admin 降级为只读面板）。若布局改用更严的 canAccessAdminArea
 * （仅 admin/super_admin），会把 observer_admin 从这两个合法页面挡在门外，破坏既有行为。
 * 因此这里取"所有 admin 子页准入角色的并集"作为粗门——它能挡住普通 user，
 * 又不收紧任何子页现有的合法访问；真正的细粒度收紧仍在各 page 内执行。
 *
 * 副作用：未登录或越权时 redirect（抛出，渲染不会继续）。
 */
export default async function DashboardAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = normalizeUserRole((session.user as { role?: string | null }).role);
  if (!canViewImageBackendPool(role)) {
    redirect(`/${locale}/dashboard`);
  }

  // 需 UI 实测：普通用户/未登录访问各 admin 路由仍被拦截，
  // observer_admin 仍可进 status/settings，admin/super_admin 正常进入。
  return <>{children}</>;
}
