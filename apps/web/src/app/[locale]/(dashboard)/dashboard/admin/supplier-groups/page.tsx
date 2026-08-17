/**
 * 分组管理独立页面。
 *
 * 页面只负责会话、角色、分页配置和双语标题装配；分组读取、筛选、计费覆盖与写入
 * 继续由既有 image-backend-pool Action/UOL 负责。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canViewImageBackendPool } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { BackendGroupAdminPanel } from "@/features/image-backend-pool/backend-group-admin-panel";
import { loadPaginationConfig } from "@/features/pagination/server";

/**
 * 渲染分组管理页，并在读取分页或装配面板前完成服务端角色守卫。
 *
 * @returns 带本地化标题和既有分组管理能力的页面。
 * @sideEffects 读取会话、实时角色、翻译和分页配置；未授权时抛出 Next.js 重定向。
 * @failure 未登录跳转登录页，普通用户跳转 dashboard，依赖异常交给路由错误边界。
 */
export default async function DashboardAdminSupplierGroupsPage() {
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

  const [paginationConfig, t] = await Promise.all([
    loadPaginationConfig(),
    getTranslations("Dashboard.pages"),
  ]);

  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("groupManagement")}
        </h1>
      </header>
      <BackendGroupAdminPanel
        paginationConfig={paginationConfig}
        readOnly={role === "observer_admin"}
        readOnlyNotice={t("groupReadOnlyNotice")}
        title={t("groupManagement")}
      />
    </main>
  );
}
