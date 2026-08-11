/**
 * 管理端全局数据看板页面。
 *
 * 页面只负责 session、管理员角色和 URL 日期参数校验，再通过 UOL 装配器读取全站
 * 生图、生视频、积分及任务构成快照；数据库统计不在路由层重复实现。
 */
import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getServerSession } from "@repo/shared/auth/server";
import { logError } from "@repo/shared/logger";
import { OperationError } from "@repo/shared/uol";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { AdminDataDashboardPanel } from "@/features/data-dashboard/admin-data-dashboard-panel";
import { loadAdminDataDashboardPageData } from "@/features/data-dashboard/admin-data-dashboard-page-data";
import {
  parseAdminDataDashboardSearchParams,
  type AdminDataDashboardSearchParams,
} from "@/features/data-dashboard/admin-data-dashboard-query";
import type { DataDashboardFailureStatus } from "@/features/data-dashboard/data-dashboard-state";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin Data Dashboard | FluxMedia",
  description:
    "Review global image and video generation output by date across FluxMedia.",
};

type AdminDataDashboardPageProps = {
  searchParams: Promise<AdminDataDashboardSearchParams>;
};

/** 将首屏 operation 错误转换为客户端安全状态。 */
function getInitialFailureStatus(error: unknown): DataDashboardFailureStatus {
  if (!(error instanceof OperationError)) return "unavailable";
  switch (error.code) {
    case "validation_error":
    case "not_ready":
    case "rate_limited":
    case "timeout":
      return error.code;
    default:
      return "unavailable";
  }
}

/** 记录不含查询参数和管理员身份的首屏不可用事件。 */
function reportInitialLoadFailure(error: unknown): void {
  if (
    error instanceof OperationError &&
    (error.code === "not_ready" || error.code === "validation_error")
  ) {
    return;
  }
  logError(new Error("Admin data dashboard initial load failed"), {
    source: "admin-data-dashboard-page",
    category: getInitialFailureStatus(error),
  });
}

/** 渲染管理员全站日期范围指标和图表。 */
export default async function AdminDataDashboardPage({
  searchParams,
}: AdminDataDashboardPageProps) {
  const [session, locale, params] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);

  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) redirect(`/${locale}/dashboard`);

  const parsedQuery = parseAdminDataDashboardSearchParams(params);
  let snapshot: DataDashboardOutput | null = null;
  let failureStatus: DataDashboardFailureStatus = null;

  try {
    snapshot = await loadAdminDataDashboardPageData({
      userId: session.user.id,
      role,
      rangeInput: parsedQuery.input,
    });
  } catch (error) {
    failureStatus = getInitialFailureStatus(error);
    reportInitialLoadFailure(error);
  }

  return (
    <div className="mx-auto max-w-7xl px-1 py-2 sm:px-2">
      <AdminDataDashboardPanel
        initialFailureStatus={failureStatus}
        initialSnapshot={snapshot}
        invalidDeepLink={parsedQuery.invalidDeepLink}
      />
    </div>
  );
}
