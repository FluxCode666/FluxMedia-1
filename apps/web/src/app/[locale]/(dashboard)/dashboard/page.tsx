/**
 * 用户控制台首页的服务端入口。
 *
 * 本页只负责会话鉴权、本人 Principal 和首屏快照装配；刷新状态与模型占比图表拆包由
 * dashboard feature 承担。摘要固定为滚动近 24 小时与累计口径，并附带当前积分余额。
 */
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { logError } from "@repo/shared/logger";
import { getAvatarUrl } from "@repo/shared/storage";
import {
  type DashboardSupportConfig,
  DEFAULT_DASHBOARD_SUPPORT_CONFIG,
} from "@repo/shared/support/dashboard-config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { DashboardAccountSupport } from "@/features/dashboard/components/dashboard-account-support";
import { DashboardAnalyticsPanel } from "@/features/dashboard/components/dashboard-analytics-panel";
import { DashboardAnalyticsUnavailable } from "@/features/dashboard/components/dashboard-analytics-pending";
import {
  type DashboardSnapshot,
  loadDashboardSnapshot,
} from "@/features/dashboard/dashboard-data";
import {
  type DashboardLoadFailureReason,
  getDashboardLoadFailureReason,
} from "@/features/dashboard/dashboard-load-error";
import {
  type DashboardAnnouncement,
  loadDashboardAnnouncements,
  loadDashboardSupportConfiguration,
} from "@/features/dashboard/dashboard-support-data";

/** 记录不含 SQL、参数、用户 ID 和会话信息的 Dashboard 降级事件。 */
function logDashboardLoadFailure(
  reason: Exclude<DashboardLoadFailureReason, "not_ready">,
  phase: "session" | "analytics"
): void {
  const isTimeout = reason === "query_timeout";
  logError(
    new Error(
      isTimeout
        ? "Dashboard database query timed out"
        : "Dashboard data is temporarily unavailable"
    ),
    {
      source: "dashboard-page",
      phase,
      category: isTimeout ? "database-timeout" : "auth-session-unavailable",
    }
  );
}

/**
 * 渲染已登录用户的分析优先控制台。
 *
 * @returns 近 24 小时/累计摘要、模型分布和近期创作；暂不可查询时返回安全状态卡。
 */
export default async function DashboardPage() {
  const locale = await getLocale();
  const isZh = locale === "zh";
  let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;

  try {
    session = await auth.api.getSession({ headers: await headers() });
  } catch (error) {
    const reason = getDashboardLoadFailureReason(error);
    if (reason !== "query_timeout" && reason !== "query_unavailable") {
      throw error;
    }
    logDashboardLoadFailure(reason, "session");
    return <DashboardAnalyticsUnavailable isZh={isZh} reason={reason} />;
  }

  if (!session?.user) redirect(`/${locale}/sign-in`);

  let supportConfigurationPromise: Promise<DashboardSupportConfig> =
    Promise.resolve(DEFAULT_DASHBOARD_SUPPORT_CONFIG);
  let announcementsPromise: Promise<DashboardAnnouncement[]> = Promise.resolve(
    []
  );

  try {
    const role = await getUserRoleById(session.user.id);
    supportConfigurationPromise = loadDashboardSupportConfiguration({
      userId: session.user.id,
      role,
    });
    announcementsPromise = loadDashboardAnnouncements({
      userId: session.user.id,
      role,
    });
    const [snapshot, supportConfiguration, announcements]: [
      DashboardSnapshot,
      DashboardSupportConfig,
      DashboardAnnouncement[],
    ] = await Promise.all([
      loadDashboardSnapshot({ userId: session.user.id, role }),
      supportConfigurationPromise,
      announcementsPromise,
    ]);

    return (
      <div className="container mx-auto px-4 py-6 md:px-6">
        <DashboardAnalyticsPanel
          accountSupport={
            <DashboardAccountSupport
              announcements={announcements}
              configuration={supportConfiguration}
              isZh={isZh}
              user={{
                name: session.user.name,
                email: session.user.email,
                imageUrl: getAvatarUrl(session.user.image),
              }}
            />
          }
          initialSnapshot={snapshot}
          isZh={isZh}
        />
      </div>
    );
  } catch (error) {
    const reason = getDashboardLoadFailureReason(error);
    if (reason === null) throw error;
    if (reason !== "not_ready") {
      logDashboardLoadFailure(reason, "analytics");
    }
    const [supportConfiguration, announcements] = await Promise.all([
      supportConfigurationPromise,
      announcementsPromise,
    ]);
    // 读模型准备中不能伪造零值；可重试查询故障也不能暴露服务端堆栈。
    return (
      <DashboardAnalyticsUnavailable
        accountSupport={
          <DashboardAccountSupport
            announcements={announcements}
            configuration={supportConfiguration}
            isZh={isZh}
            user={{
              name: session.user.name,
              email: session.user.email,
              imageUrl: getAvatarUrl(session.user.image),
            }}
          />
        }
        isZh={isZh}
        reason={reason}
      />
    );
  }
}
