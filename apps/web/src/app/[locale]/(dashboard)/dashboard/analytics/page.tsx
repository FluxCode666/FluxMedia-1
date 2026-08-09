/**
 * 用户数据看板的服务端入口。
 *
 * 页面只读取 session、角色和白名单日期 query，再通过 UOL 首屏装配器加载本人原子快照；
 * 非法自定义深链回退动态默认七天，其他失败交给客户端完整不可用状态恢复。
 */
import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { getServerSession } from "@repo/shared/auth/server";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { logError } from "@repo/shared/logger";
import { OperationError } from "@repo/shared/uol";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import {
  DataDashboardPanel,
} from "@/features/data-dashboard/data-dashboard-panel";
import { loadDataDashboardPageData } from "@/features/data-dashboard/data-dashboard-page-data";
import {
  type DataDashboardSearchParams,
  parseDataDashboardSearchParams,
} from "@/features/data-dashboard/data-dashboard-query";
import type { DataDashboardFailureStatus } from "@/features/data-dashboard/data-dashboard-state";

export const metadata = {
  title: "Data Dashboard | FluxMedia",
  description: "Review your successful media output and credit usage by date.",
};

type DataDashboardPageProps = {
  searchParams: Promise<DataDashboardSearchParams>;
};

/** 将首屏 UOL 失败转换为客户端安全状态，未知错误统一 unavailable。 */
function getInitialFailureStatus(error: unknown): DataDashboardFailureStatus {
  if (!(error instanceof OperationError)) return "unavailable";
  switch (error.code) {
    case "validation_error":
    case "not_ready":
    case "rate_limited":
    case "timeout":
    case "unauthenticated":
      return error.code;
    default:
      return "unavailable";
  }
}

/** 记录不含 SQL、参数、会话或用户身份的首屏不可用事件。 */
function reportInitialLoadFailure(error: unknown): void {
  if (
    error instanceof OperationError &&
    (error.code === "not_ready" || error.code === "validation_error")
  ) {
    return;
  }
  logError(new Error("Data dashboard initial load failed"), {
    source: "data-dashboard-page",
    category: getInitialFailureStatus(error),
  });
}

/** 渲染本人日期范围指标和图表；无会话时回到当前 locale 登录页。 */
export default async function DataDashboardPage({
  searchParams,
}: DataDashboardPageProps) {
  const [session, locale, params] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);

  const role = await getUserRoleById(session.user.id);
  const parsedQuery = parseDataDashboardSearchParams(params);
  let invalidDeepLink = parsedQuery.invalidDeepLink;
  let snapshot: DataDashboardOutput | null = null;
  let failureStatus: DataDashboardFailureStatus = null;

  try {
    snapshot = await loadDataDashboardPageData({
      userId: session.user.id,
      role,
      rangeInput: parsedQuery.input,
    });
  } catch (error) {
    const canFallbackToDefault =
      error instanceof OperationError &&
      error.code === "validation_error" &&
      "startDate" in parsedQuery.input;
    if (canFallbackToDefault) {
      invalidDeepLink = true;
      try {
        snapshot = await loadDataDashboardPageData({
          userId: session.user.id,
          role,
          rangeInput: {},
        });
      } catch (fallbackError) {
        failureStatus = getInitialFailureStatus(fallbackError);
        reportInitialLoadFailure(fallbackError);
      }
    } else {
      failureStatus = getInitialFailureStatus(error);
      reportInitialLoadFailure(error);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-1 py-2 sm:px-2">
      <DataDashboardPanel
        initialFailureStatus={failureStatus}
        initialSnapshot={snapshot}
        invalidDeepLink={invalidDeepLink}
      />
    </div>
  );
}
