/**
 * 供应商账号详情页。
 *
 * 页面只负责完成管理区权限守卫并装配详情客户端视图；账号读取、脱敏和保存继续由
 * image-backend-pool action/UOL 负责。
 */

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canViewImageBackendPool } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { BackendMemberDetailPage } from "@/features/image-backend-pool/member-detail-page";

/**
 * 渲染指定供应商账号详情。
 *
 * @param params Next.js 动态路由参数。
 * @returns 受权限保护的账号详情页面。
 * @sideEffects 读取会话与实时角色；未授权时抛出重定向。
 */
export default async function DashboardAdminSupplierDetailPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const [session, locale] = await Promise.all([
    getServerSession(),
    getLocale(),
  ]);
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canViewImageBackendPool(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const { memberId } = await params;
  const timeZone = await getUserTimeZone(session.user.id);
  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <BackendMemberDetailPage
        memberId={memberId}
        readOnly={role === "observer_admin"}
        timeZone={timeZone}
      />
    </main>
  );
}
