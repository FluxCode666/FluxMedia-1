/**
 * 控制台内的管理员系统文档入口。
 *
 * 与 /docs 共享同一份 SystemDocsContent，必须使用数据库真实角色重复守卫，防止普通
 * 控制台用户绕过 /docs 布局直接读取内部架构与扩展接口说明。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getCurrentDocumentationBaseUrl } from "@/features/docs/documentation-base-url-server";
import { SystemDocsContent } from "@/features/docs/system-docs";

/** 渲染仅 admin 与 super_admin 可见的控制台系统文档。 */
export default async function BackendHelpPage() {
  const [locale, session, baseUrl] = await Promise.all([
    getLocale(),
    getServerSession(),
    getCurrentDocumentationBaseUrl(),
  ]);

  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) {
    redirect(`/${locale}/dashboard/api-docs`);
  }

  return <SystemDocsContent baseUrl={baseUrl} locale={locale} />;
}
