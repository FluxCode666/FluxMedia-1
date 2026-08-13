/**
 * 管理端运营总览只读首屏。
 *
 * 页面负责 session、admin/super_admin 角色、URL 白名单和 UOL 首屏读取。完整交互面板
 * 由后续 U7 子任务接入；本页先保证路由、权限、canonical 提示和安全失败状态可用。
 */

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { loadOperationsDashboardPageData } from "@/features/operations-dashboard/operations-dashboard-page-data";
import {
  type OperationsDashboardSearchParams,
  parseOperationsDashboardSearchParams,
} from "@/features/operations-dashboard/operations-dashboard-query";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "运营总览 | FluxMedia",
  description: "按日期范围核对用户增长、商业化、内容生产和系统健康。",
};

type OperationsDashboardPageProps = {
  searchParams: Promise<OperationsDashboardSearchParams>;
};

/** 渲染管理员运营总览首屏；observer_admin 与普通用户均重定向回 dashboard。 */
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
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header className="space-y-2">
        <h1 className="font-serif text-3xl font-medium tracking-tight">
          运营总览
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          按统一日期范围核对用户增长、商业化、内容生产和系统健康数据。
        </p>
      </header>

      {parsedQuery.invalidDeepLink ? (
        <div
          className="rounded-lg border bg-muted/30 px-4 py-3 text-sm"
          data-canonical-href={parsedQuery.canonicalHref}
          role="status"
        >
          部分链接参数无效，已回退为默认近 30 个自然日和日粒度。
        </div>
      ) : null}

      {pageData.loadError ? (
        <section className="rounded-xl border p-6" role="alert">
          <h2 className="font-serif text-xl font-medium">运营数据暂不可用</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            请稍后刷新页面。当前页面不会展示过期或不完整快照。
          </p>
          <span className="sr-only">{pageData.loadError}</span>
        </section>
      ) : (
        <section
          className="min-h-64 rounded-xl border p-6"
          data-operations-snapshot-ready={pageData.overview !== null}
        >
          <h2 className="font-serif text-xl font-medium">运营数据已加载</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            指标、图表、明细与导出组件正在接入该一致快照。
          </p>
        </section>
      )}
    </main>
  );
}
