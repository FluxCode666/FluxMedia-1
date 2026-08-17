/**
 * 模型配置独立管理页面。
 *
 * 页面只负责会话、角色、分页配置和双语标题装配；模型读取、编辑能力和 UOL 权限继续
 * 由 `ModelConfigurationPanel` 及其 Server Action 负责，避免路由层复制领域逻辑。
 */
import { canViewImageBackendPool } from "@repo/shared/auth/roles";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ModelConfigurationPanel } from "@/features/model-configuration";
import { loadPaginationConfig } from "@/features/pagination/server";

/**
 * 渲染模型配置管理页，并在读取面板依赖前完成服务端角色守卫。
 *
 * @returns 带本地化标题和现有模型配置面板的管理页面。
 * @sideEffects 读取会话、实时角色、翻译和分页配置；未授权时抛出 Next.js 重定向。
 * @failure 未登录跳转登录页，普通用户跳转 dashboard，分页配置异常交给路由错误边界。
 */
export default async function DashboardAdminModelConfigurationPage() {
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

  const paginationConfig = await loadPaginationConfig();

  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("modelConfiguration")}
        </h1>
      </header>
      <ModelConfigurationPanel
        paginationConfig={paginationConfig}
        title={t("modelConfiguration")}
        readOnlyNotice={t("readOnlyNotice")}
      />
    </main>
  );
}
