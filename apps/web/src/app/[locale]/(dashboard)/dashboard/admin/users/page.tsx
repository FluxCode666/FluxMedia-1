/**
 * 管理后台用户管理入口。
 *
 * 职责：校验管理员会话，读取会话中的角色与用户时区，并把角色能力传给
 * 用户管理工作台。页面不直接执行用户管理或审核策略写入。
 */
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import {
  canAccessAdminArea,
  canManageUserPermissions,
  normalizeUserRole,
} from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { AdminUsersManagement } from "@repo/shared/support/components";
import { getUserTimeZone } from "@repo/shared/time-zone/server";

export default async function DashboardAdminUsersPage() {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = normalizeUserRole((session.user as { role?: string | null }).role);
  if (!canAccessAdminArea(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const timeZone = await getUserTimeZone(session.user.id);

  return (
    <AdminUsersManagement
      actorRole={role}
      canManageRoles={canManageUserPermissions(role)}
      timeZone={timeZone}
    />
  );
}
