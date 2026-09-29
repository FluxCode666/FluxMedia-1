/**
 * 管理员 agent 令牌独立页面。
 *
 * 页面只负责会话、角色、时区和双语标题装配；令牌签发、列表与撤销由
 * admin-agent-tokens 面板和 Server Action 委托 Go 后端完成。仅 admin/super_admin
 * 可访问，observer_admin 不能签发全局管理员凭据。
 */
import { isAdminRole, normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { redirect } from "@repo/shared/platform/navigation";
import { getLocale, getTranslations } from "@repo/shared/platform/intl";

import { AdminAgentTokenPanel } from "@/features/admin-agent-tokens";

/**
 * 渲染 agent 令牌管理页，并在读取时区前完成服务端角色守卫。
 *
 * @returns 带本地化标题的令牌管理页面。
 * @sideEffects 读取会话、实时角色、翻译和用户时区；未授权时抛出重定向。
 * @failure 未登录跳转登录页，非 admin/super_admin 跳转 dashboard，依赖异常交给路由错误边界。
 */
export default async function DashboardAdminAgentTokensPage() {
  const [session, locale, t] = await Promise.all([
    getServerSession(),
    getLocale(),
    getTranslations("Dashboard.pages"),
  ]);
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = normalizeUserRole(
    (session.user as { role?: string | null }).role
  );
  if (!isAdminRole(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const timeZone = await getUserTimeZone(session.user.id);

  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("agentTokens")}
        </h1>
      </header>
      <AdminAgentTokenPanel timeZone={timeZone} />
    </main>
  );
}
