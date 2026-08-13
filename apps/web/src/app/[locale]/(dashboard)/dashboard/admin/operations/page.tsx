/**
 * 管理端运营总览 Server Component 入口。
 *
 * 页面负责 session、admin/super_admin 角色、URL 白名单和 UOL 首屏读取，并把完整
 * 快照、导出记录及安全失败状态交给客户端 Panel；页面本身不读取运营数据库。
 */

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { loadOperationsDashboardPageData } from "@/features/operations-dashboard/operations-dashboard-page-data";
import { OperationsDashboardPanel } from "@/features/operations-dashboard/operations-dashboard-panel";
import {
  type OperationsDashboardSearchParams,
  parseOperationsDashboardSearchParams,
} from "@/features/operations-dashboard/operations-dashboard-query";

export const dynamic = "force-dynamic";

/** 生成当前语言的运营总览 Metadata。 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "OperationsDashboard" });
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
  };
}

type OperationsDashboardPageProps = {
  searchParams: Promise<OperationsDashboardSearchParams>;
};

/** 渲染管理员运营总览；observer_admin 与普通用户均重定向回 dashboard。 */
export default async function OperationsDashboardPage({
  searchParams,
}: OperationsDashboardPageProps) {
  const [session, locale, params] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);

  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) redirect(`/${locale}/dashboard`);

  const parsedQuery = parseOperationsDashboardSearchParams(params);
  const pageData = await loadOperationsDashboardPageData({
    userId: session.user.id,
    role,
    query: parsedQuery.input,
  });

  return (
    <main className="container mx-auto px-4 py-6 md:px-6">
      <OperationsDashboardPanel
        currentUserId={session.user.id}
        initialExports={pageData.exports}
        initialExportsLoadFailed={pageData.exportsLoadError !== null}
        initialExportsNextCursor={pageData.exportsNextCursor}
        initialFailureStatus={pageData.loadError}
        initialQuery={parsedQuery.input}
        initialSnapshot={pageData.overview}
        invalidDeepLinkHref={
          parsedQuery.invalidDeepLink ? parsedQuery.canonicalHref : null
        }
      />
    </main>
  );
}
