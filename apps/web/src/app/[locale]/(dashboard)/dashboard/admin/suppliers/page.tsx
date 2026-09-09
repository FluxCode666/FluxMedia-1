/**
 * 供应商管理独立页面。
 *
 * 页面只负责会话、角色、时区、分页配置和双语标题装配；供应商读取、写入、脱敏与
 * image-backend-pool operation 继续由既有面板和 Server Action 负责。
 */
import { canViewImageBackendPool } from "@repo/shared/auth/roles";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getServerSession } from "@repo/shared/auth/server";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ImageBackendPoolAdminPanel } from "@/features/image-backend-pool";
import { loadPaginationConfig } from "@/features/pagination/server";

/**
 * 渲染供应商管理页，并在读取分页、时区和面板数据前完成服务端角色守卫。
 *
 * @returns 带本地化标题和现有供应商面板的管理页面。
 * @sideEffects 读取会话、实时角色、翻译、分页配置和用户时区；未授权时抛出重定向。
 * @failure 未登录跳转登录页，普通用户跳转 dashboard，依赖读取异常交给路由错误边界。
 */
export default async function DashboardAdminSuppliersPage() {
  const [session, locale, t] = await Promise.all([
    getServerSession(),
    getLocale(),
    getTranslations("Dashboard.pages"),
  ]);
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canViewImageBackendPool(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const [paginationConfig, timeZone] = await Promise.all([
    loadPaginationConfig(),
    getUserTimeZone(session.user.id),
  ]);

  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("supplierManagement")}
        </h1>
        <a
          className="text-sm underline underline-offset-4"
          href="/dashboard/admin/image-size-configs"
        >
          图片尺寸配置
        </a>
      </header>
      <ImageBackendPoolAdminPanel
        paginationConfig={paginationConfig}
        readOnly={role === "observer_admin"}
        readOnlyNotice={t("readOnlyNotice")}
        timeZone={timeZone}
        title={t("supplierManagement")}
      />
    </main>
  );
}
